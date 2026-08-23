/**
 * The single source of ssh options and the single remote-command runner.
 * `sshArgs` is the only place in the codebase that emits `-o` options
 * (security invariant 14); `runRemote` is the only way a remote command is
 * executed (quoted by the single quoter, classified by the single classifier,
 * wrapped in the control-path transient retry).
 */

import { exec, minimalEnv, type ExecResult } from "../exec/exec.js";
import { SshError } from "../shared/errors.js";
import { formatDuration } from "../shared/format.js";
import type { Logger } from "../shared/logger.js";
import { CONTROL_RETRY_POLICY, withTransientRetry, type RetryPolicy } from "../shared/retry.js";
import { sanitize } from "../shared/sanitize.js";
import type { ResolvedRemote } from "../shared/types.js";
import {
    describeTransientSshStderr,
    isPermanentSshStderr,
    matchPermanentSshPattern,
    SSH_NO_ANSWER_MESSAGE,
    sshStderrTail,
} from "./classify.js";
import { diagnoseAliasAuth } from "./internal/keydiag.js";
import { bareShellArg, quoteShellArg } from "./internal/quote.js";

/** An alias-kind resolved remote. */
type AliasRemote = Extract<ResolvedRemote, { kind: "alias" }>;

/**
 * Invocation context deciding the StrictHostKeyChecking policy: "unattended"
 * (run/daemon, any non-TTY invocation) pins strictly; "interactive" (`check`
 * on a TTY) allows TOFU via accept-new while a human watches. There is no
 * third value - `StrictHostKeyChecking=no` is unrepresentable.
 */
export type SshContext = "unattended" | "interactive";

/**
 * Build the complete ssh option argv for one remote (spec section 4) - the
 * SINGLE source of ssh options; no other module adds `-o` options.
 *
 * Explicit remotes carry the full set: the no-hang baseline, the contextual
 * StrictHostKeyChecking, the dedicated known_hosts file, IdentitiesOnly,
 * PreferredAuthentications=publickey, `-p <port>` and `-i <identityFile>`.
 *
 * Alias remotes carry exactly the non-negotiable baseline plus the contextual
 * StrictHostKeyChecking and LogLevel=ERROR - NO identity, port, or
 * known_hosts options: those are the ssh_config entry's business. The
 * injected `-o` options win over any ssh_config setting by OpenSSH's own
 * precedence rules, so the no-hang and host-key guarantees survive a lax
 * user config.
 *
 * The baseline also pins the forwarding options OFF for BOTH remote kinds and
 * for the rsync `-e` transport that reuses these tokens. ssh reads
 * ~/.ssh/config for every remote kind, so a `Host * / ForwardAgent yes` line
 * would forward backupkit's own agent - which holds the archive private key,
 * added with no lifetime and no confirmation - into whatever host backupkit
 * dials, including a possibly compromised pull source. ForwardAgent=no,
 * ForwardX11=no and ForwardX11Trusted=no override that config by ssh's
 * first-value-wins precedence, and backupkit needs none of the three.
 */
export function sshArgs(remote: ResolvedRemote, context: SshContext): string[] {
    const strict = context === "interactive" ? "accept-new" : "yes";
    const baseline = [
        "-o", "BatchMode=yes",
        "-o", "ConnectTimeout=15",
        "-o", "ServerAliveInterval=15",
        "-o", "ServerAliveCountMax=4",
        "-o", `StrictHostKeyChecking=${strict}`,
        "-o", "ForwardAgent=no",
        "-o", "ForwardX11=no",
        "-o", "ForwardX11Trusted=no",
    ];
    if (remote.kind === "alias") {
        return [...baseline, "-o", "LogLevel=ERROR"];
    }
    return [
        ...baseline,
        "-o", `UserKnownHostsFile=${remote.knownHostsFile}`,
        "-o", "IdentitiesOnly=yes",
        "-o", "PreferredAuthentications=publickey",
        "-o", "LogLevel=ERROR",
        "-p", String(remote.port),
        "-i", remote.identityFile,
    ];
}

/**
 * The destination token ssh receives: `user@host` for explicit remotes, the
 * bare alias for alias remotes (its charset excludes every character that
 * could confuse option parsing or host:path splitting).
 */
export function sshDestination(remote: ResolvedRemote): string {
    return remote.kind === "alias" ? remote.alias : `${remote.user}@${remote.host}`;
}

/** Options for one `runRemote` invocation. */
export interface RunRemoteOptions {
    /** Absolute path (or PATH-resolvable name) of the local ssh binary. */
    sshBin: string;
    /** Invocation context deciding the StrictHostKeyChecking policy. */
    context: SshContext;
    /** Logger for the retry helper's per-attempt warnings. */
    log: Logger;
    /**
     * SSH_AUTH_SOCK for the spawned ssh, or null to spawn without one.
     * Explicit remotes: the backupkit agent socket. Alias remotes: the
     * inherited process value verbatim (the user's own agent setup is
     * authoritative), or null when the environment has none.
     */
    authSock: string | null;
    /** Kill the ssh child after this many milliseconds. Default 60000. */
    timeoutMs?: number;
    /** Complete base child environment (default `minimalEnv()`); SSH_AUTH_SOCK is layered on top per `authSock`. */
    env?: Record<string, string>;
    /** Retry policy override for tests ONLY - production callers always use the control policy. */
    retryPolicy?: RetryPolicy;
    /**
     * Graceful-shutdown signal. On abort the ssh child is SIGTERMed (then
     * SIGKILLed by exec/ if it lingers), no further retry attempt starts, and
     * any pending backoff wakes immediately - so a stop is bounded by the
     * child's own death, not by this call's 60 s timeout times its attempts.
     * The service unit's `TimeoutStopSec` is unmeetable without this.
     */
    signal?: AbortSignal;
}

/**
 * The actionable failure message for an ssh transport error, shaped by the
 * matched permanent pattern (spec section 4's messages) or the transient
 * default. `tail` must already be sanitized.
 *
 * ONE SHORT SENTENCE, then `Fix: <command>` when there is a command. These are
 * read off a terminal by someone who wants to know what to type next; the
 * paragraph explaining why `ssh <alias>` works by hand while an unattended run
 * cannot is true and belongs in the docs, not on the failure line.
 *
 * An alias auth-failure additionally asks `diagnoseAliasAuth` for the CAUSE -
 * "authentication failed" is a symptom, and the usual cause is a
 * passphrase-protected ssh_config key that no reachable agent holds. The
 * diagnosis is best-effort and never throws; when it cannot establish a cause
 * the generic message stands.
 */
async function sshFailureMessage(
    remote: ResolvedRemote,
    tail: string,
    options: { sshBin: string; env: Record<string, string> },
): Promise<string> {
    const dest = sshDestination(remote);
    const pattern = matchPermanentSshPattern(tail);
    if (pattern === "auth-failure") {
        if (remote.kind === "alias") {
            const cause = await diagnoseAliasAuth(remote.alias, { sshBin: options.sshBin, env: options.env });
            if (cause !== null) {
                return cause;
            }
            const euid = process.geteuid?.() ?? process.getuid?.() ?? -1;
            return (
                `${dest} refused backupkit's SSH key (backupkit does not manage keys for ssh_config aliases). ` +
                `Fix: make "ssh ${dest}" work with no prompt as uid ${euid}`
            );
        }
        return `${dest} refused the SSH key ${remote.identityFile}. Fix: backupkit check`;
    }
    if (pattern === "host-key-verification") {
        return `${dest}'s host key is not pinned yet. Fix: run backupkit check in a terminal to pin it`;
    }
    if (pattern === "host-key-changed") {
        const where = remote.kind === "alias" ? "your known_hosts" : remote.knownHostsFile;
        return (
            `${dest}'s host key CHANGED - this can be a man-in-the-middle. ` +
            `Fix: verify the host, then edit ${where} by hand (backupkit never removes a pinned key for you)`
        );
    }
    const cause = describeTransientSshStderr(tail);
    const why = cause ?? SSH_NO_ANSWER_MESSAGE;
    return `${dest}: ${why}${tail === "" ? "" : ` (ssh said: ${tail})`}`;
}

/**
 * Run one command on a remote host: every argv element passed through the
 * single quoter - `quoteShellArg`, or `bareShellArg` when the remote declares
 * `restrictedShell` (an appliance shell that does not parse quotes and would
 * read `'mkdir'` as a command name; that quoter refuses anything that is not
 * already one inert word) - options from `sshArgs`, spawned through `exec/`, wrapped in the
 * control-path transient retry. Transport failures (exit 255, timeouts,
 * signals) throw `SshError` with `retriable` set by the permanent-pattern
 * classifier; any other exit - including a non-zero exit of the REMOTE
 * command itself - resolves with the ExecResult for the caller to judge.
 * Never wrap a lock-acquire `mkdir`'s EEXIST semantics in extra retries here:
 * those resolve normally (the remote exit code is not 255) and are therefore
 * never retried by this function.
 */
export async function runRemote(
    remote: ResolvedRemote,
    argv: readonly string[],
    options: RunRemoteOptions,
): Promise<ExecResult> {
    const command = argv.map(remote.restrictedShell ? bareShellArg : quoteShellArg).join(" ");
    const fullArgs = [...sshArgs(remote, options.context), sshDestination(remote), command];
    const env: Record<string, string> = { ...(options.env ?? minimalEnv()) };
    if (options.authSock !== null) {
        env.SSH_AUTH_SOCK = options.authSock;
    }
    const policy = options.retryPolicy ?? CONTROL_RETRY_POLICY;
    const dest = sshDestination(remote);
    return withTransientRetry(
        async () => {
            const result = await exec(options.sshBin, fullArgs, {
                env,
                timeoutMs: options.timeoutMs ?? 60_000,
                signal: options.signal,
            });
            if (result.timedOut) {
                const waitedMs = options.timeoutMs ?? 60_000;
                throw new SshError(
                    `ssh ${dest} gave up after ${formatDuration(waitedMs)}: ${SSH_NO_ANSWER_MESSAGE}`,
                    { retriable: true },
                );
            }
            if (result.exitCode === null) {
                throw new SshError(`ssh ${dest} was killed by signal ${result.signal ?? "unknown"}`, {
                    retriable: true,
                });
            }
            if (result.exitCode === 255) {
                const tail = sshStderrTail(result.stderr);
                throw new SshError(await sshFailureMessage(remote, tail, { sshBin: options.sshBin, env }), {
                    retriable: !isPermanentSshStderr(tail),
                });
            }
            return result;
        },
        policy,
        options.log,
        `ssh ${remote.name}`,
        options.signal,
    );
}

/** Options for one `resolveAlias` invocation. */
export interface ResolveAliasOptions {
    /** Absolute path (or PATH-resolvable name) of the local ssh binary. */
    sshBin: string;
    /** Complete child environment (default `minimalEnv()`). */
    env?: Record<string, string>;
    /** Kill the ssh child after this many milliseconds. Default 10000. */
    timeoutMs?: number;
}

/** What ssh will actually dial for an alias, per `ssh -G`. */
export interface AliasResolution {
    /** The resolved hostname. */
    hostname: string;
    /** The resolved ssh user. */
    user: string;
    /** The resolved port (validated all-digits), as printed. */
    port: string;
}

/**
 * Resolve an alias's effective hostname/user/port via `ssh -G <alias>` -
 * purely local, ssh prints its resolved configuration without connecting.
 * Informational only (`check` displays it; nothing downstream consumes it).
 * Returns null on any failure - spawn error, non-zero exit, or unparseable
 * output - so a parse failure degrades to "could not resolve alias via
 * ssh -G" without failing the probe. Every value is sanitized before return.
 */
export async function resolveAlias(remote: AliasRemote, options: ResolveAliasOptions): Promise<AliasResolution | null> {
    let result: ExecResult;
    try {
        result = await exec(options.sshBin, ["-G", remote.alias], {
            env: options.env ?? minimalEnv(),
            timeoutMs: options.timeoutMs ?? 10_000,
        });
    } catch {
        return null;
    }
    if (result.timedOut || result.exitCode !== 0) {
        return null;
    }
    const values: Partial<Record<"hostname" | "user" | "port", string>> = {};
    for (const raw of result.stdout.split("\n")) {
        const line = sanitize(raw).trim();
        const space = line.indexOf(" ");
        if (space <= 0) {
            continue;
        }
        const key = line.slice(0, space);
        if ((key === "hostname" || key === "user" || key === "port") && values[key] === undefined) {
            values[key] = line.slice(space + 1).trim();
        }
    }
    const { hostname, user, port } = values;
    if (hostname === undefined || user === undefined || port === undefined || !/^[0-9]+$/.test(port)) {
        return null;
    }
    return { hostname, user, port };
}
