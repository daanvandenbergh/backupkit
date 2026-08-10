/**
 * The persistent ssh-agent lifecycle and key priming - explicit remotes only
 * (spec section 4). backupkit runs its own agent at `<runtimeDir>/agent.sock`,
 * never the user's session agent. Alias remotes are never primed: the user's
 * ssh_config/agent arrangement is authoritative, and a config whose remotes
 * are all aliases starts no agent at all. Every tool call is bounded by a
 * timeout except ssh-add's own TTY prompt (a human is present by definition -
 * the flow is TTY-gated before spawning), so no code path can hang.
 */

import { rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { exec, minimalEnv, type ExecResult } from "../exec/exec.js";
import { SshError } from "../shared/errors.js";
import type { Logger } from "../shared/logger.js";
import { sanitize } from "../shared/sanitize.js";
import type { ResolvedRemote } from "../shared/types.js";
import { askpassEnv } from "./internal/askpass.js";

/** An explicit-kind resolved remote. */
type ExplicitRemote = Extract<ResolvedRemote, { kind: "explicit" }>;

/** Dependencies and knobs for the agent lifecycle functions. */
export interface AgentDeps {
    /** Runtime directory holding the agent socket (created 0700 by the permission preflight). */
    runtimeDir: string;
    /** Logger for lifecycle events. */
    log: Logger;
    /**
     * COMPLETE base environment for the spawned tools (default `minimalEnv()`).
     * Must never carry the caller's own SSH_AUTH_SOCK - the backupkit socket
     * is layered on explicitly where needed.
     */
    env?: Record<string, string>;
    /** Whether an interactive TTY is available. Default: `process.stdin.isTTY === true`. */
    hasTty?: boolean;
    /** Timeout per non-interactive tool call in milliseconds. Default 10000. */
    timeoutMs?: number;
}

/** The backupkit agent socket path under a runtime directory. */
export function agentSocketPath(runtimeDir: string): string {
    return join(runtimeDir, "agent.sock");
}

/** The resolved base environment for tool spawns. */
function baseEnv(deps: AgentDeps): Record<string, string> {
    return deps.env ?? minimalEnv();
}

/** The resolved per-call timeout. */
function toolTimeout(deps: AgentDeps): number {
    return deps.timeoutMs ?? 10_000;
}

/** The resolved TTY availability. */
function hasTty(deps: AgentDeps): boolean {
    return deps.hasTty ?? process.stdin.isTTY === true;
}

/** Sanitized stderr tail for an actionable tool-failure message. */
function toolTail(stderr: string): string {
    return sanitize(stderr).slice(-512);
}

/**
 * Run one agent tool (ssh-add / ssh-agent / ssh-keygen) with a hard timeout.
 * Throws an actionable SshError when the binary cannot be spawned or the call
 * times out (hang prevention); every other outcome - including non-zero
 * exits - resolves for the caller to judge.
 */
async function runTool(
    bin: string,
    args: readonly string[],
    env: Record<string, string>,
    timeoutMs: number,
): Promise<ExecResult> {
    let result: ExecResult;
    try {
        result = await exec(bin, args, { env, timeoutMs });
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new SshError(`${bin} could not be spawned: ${message}`);
    }
    if (result.timedOut) {
        throw new SshError(`${bin} did not answer within ${timeoutMs}ms`);
    }
    return result;
}

/**
 * Ensure the persistent backupkit agent is alive at `<runtimeDir>/agent.sock`
 * and return the socket path. Probes with `ssh-add -l` (exit 0/1 = alive,
 * adopt it); otherwise removes any stale socket and spawns
 * `ssh-agent -a <sock>` (its env output is ignored - the socket path is
 * already known). Keys are added without lifetime; the agent survives process
 * restarts and `stop()` never kills it.
 */
export async function ensureAgent(deps: AgentDeps): Promise<string> {
    const sock = agentSocketPath(deps.runtimeDir);
    const env = baseEnv(deps);
    const timeout = toolTimeout(deps);
    const probe = await runTool("ssh-add", ["-l"], { ...env, SSH_AUTH_SOCK: sock }, timeout);
    if (probe.exitCode === 0 || probe.exitCode === 1) {
        deps.log.debug("adopted existing backupkit ssh-agent", { socket: sock });
        return sock;
    }
    await rm(sock, { force: true });
    const spawned = await runTool("ssh-agent", ["-a", sock], env, timeout);
    if (spawned.exitCode !== 0) {
        throw new SshError(`ssh-agent -a ${sock} failed (exit ${spawned.exitCode}): ${toolTail(spawned.stderr)}`);
    }
    deps.log.info("started persistent ssh-agent", { socket: sock });
    return sock;
}

/** Whether a path exists (any file kind). */
async function fileExists(path: string): Promise<boolean> {
    try {
        await stat(path);
        return true;
    } catch {
        return false;
    }
}

/** Unique explicit remotes by identityFile (first occurrence wins). */
function uniqueExplicitRemotes(remotes: readonly ResolvedRemote[]): ExplicitRemote[] {
    const seen = new Set<string>();
    const unique: ExplicitRemote[] = [];
    for (const remote of remotes) {
        if (remote.kind === "explicit" && !seen.has(remote.identityFile)) {
            seen.add(remote.identityFile);
            unique.push(remote);
        }
    }
    return unique;
}

/**
 * The set of key fingerprints currently loaded in the agent, from
 * `ssh-add -l` (exit 1 = agent alive but empty). Each line's second
 * whitespace field is the fingerprint; output is sanitized before parsing.
 */
async function loadedFingerprints(sock: string, deps: AgentDeps): Promise<Set<string>> {
    const result = await runTool("ssh-add", ["-l"], { ...baseEnv(deps), SSH_AUTH_SOCK: sock }, toolTimeout(deps));
    if (result.exitCode === 1) {
        return new Set();
    }
    if (result.exitCode !== 0) {
        throw new SshError(`ssh-add -l failed (exit ${result.exitCode}): ${toolTail(result.stderr)}`);
    }
    const fingerprints = new Set<string>();
    for (const raw of result.stdout.split("\n")) {
        const fields = sanitize(raw).trim().split(/\s+/);
        if (fields.length >= 2 && fields[1] !== "") {
            fingerprints.add(fields[1]);
        }
    }
    return fingerprints;
}

/**
 * Probe whether a private key is unencrypted: `ssh-keygen -y -P "" -f <key>`
 * exits 0 and prints the public half. The empty `-P ""` is not a passphrase -
 * invariant 3 holds.
 */
async function probeUnencrypted(key: string, deps: AgentDeps): Promise<ExecResult> {
    return runTool("ssh-keygen", ["-y", "-P", "", "-f", key], baseEnv(deps), toolTimeout(deps));
}

/**
 * Ensure the `.pub` sidecar exists next to a key, generating it when allowed
 * (spec section 4 step 6): unencrypted keys regenerate it any time from the
 * `-y -P ""` probe; encrypted keys regenerate it only interactively (`file:`
 * passphrase via the askpass env, `prompt` via ssh-keygen's own /dev/tty
 * prompt) and fail unattended with a pointer at `backupkit check`. Written
 * 0644. Returns the unencrypted probe result when one was run (so the caller
 * need not repeat it).
 */
async function ensurePubSidecar(remote: ExplicitRemote, deps: AgentDeps): Promise<ExecResult | null> {
    const key = remote.identityFile;
    const pubPath = `${key}.pub`;
    if (await fileExists(pubPath)) {
        return null;
    }
    if (remote.passphrase === null) {
        const probe = await probeUnencrypted(key, deps);
        if (probe.exitCode !== 0) {
            throw new SshError(
                `key ${key} could not be read without a passphrase (is it encrypted?); ` +
                    `configure "passphrase" for remote "${remote.name}" or fix the key: ${toolTail(probe.stderr)}`,
            );
        }
        await writeFile(pubPath, probe.stdout, { mode: 0o644 });
        return probe;
    }
    if (!hasTty(deps)) {
        throw new SshError(
            `key ${key} is encrypted and has no ${pubPath} sidecar; ` +
                `run "backupkit check" in a terminal to generate it, then restart the service`,
        );
    }
    const env =
        remote.passphrase.kind === "file"
            ? { ...baseEnv(deps), ...askpassEnv(remote.passphrase.value) }
            : baseEnv(deps);
    // "prompt" keys: ssh-keygen prompts on /dev/tty itself; stdout is still captured.
    const generated = await runTool("ssh-keygen", ["-y", "-f", key], env, toolTimeout(deps));
    if (generated.exitCode !== 0) {
        throw new SshError(`ssh-keygen -y -f ${key} failed (exit ${generated.exitCode}): ${toolTail(generated.stderr)}`);
    }
    await writeFile(pubPath, generated.stdout, { mode: 0o644 });
    return null;
}

/** The key's fingerprint via `ssh-keygen -lf <key>.pub` (second whitespace field, sanitized). */
async function keyFingerprint(pubPath: string, deps: AgentDeps): Promise<string | null> {
    const result = await runTool("ssh-keygen", ["-lf", pubPath], baseEnv(deps), toolTimeout(deps));
    if (result.exitCode !== 0) {
        throw new SshError(`ssh-keygen -lf ${pubPath} failed (exit ${result.exitCode}): ${toolTail(result.stderr)}`);
    }
    const fields = sanitize(result.stdout).trim().split(/\s+/);
    return fields.length >= 2 && fields[1] !== "" ? fields[1] : null;
}

/** Run `ssh-add <key>` non-interactively with the given full environment; throws on failure. */
async function sshAdd(key: string, env: Record<string, string>, deps: AgentDeps): Promise<void> {
    const result = await runTool("ssh-add", [key], env, toolTimeout(deps));
    if (result.exitCode !== 0) {
        throw new SshError(`ssh-add ${key} failed (exit ${result.exitCode}): ${toolTail(result.stderr)}`);
    }
    deps.log.info("loaded key into agent", { key });
}

/**
 * Prime one explicit remote's key into the agent (spec section 4 steps 2-6):
 * skip when its fingerprint is already loaded; otherwise add it - unencrypted
 * keys directly (after the `-y -P ""` probe confirms they need no
 * passphrase), `file:` passphrase keys via the askpass env (the passphrase is
 * never in argv or env - only the file path is), `prompt` keys via ssh-add's
 * own TTY prompt with inherited stdio (backupkit never sees the passphrase),
 * refused with an actionable error when no TTY is present.
 */
async function primeKey(
    remote: ExplicitRemote,
    sock: string,
    loaded: Set<string>,
    deps: AgentDeps,
): Promise<void> {
    const key = remote.identityFile;
    const pubPath = `${key}.pub`;
    let unencryptedProbe = await ensurePubSidecar(remote, deps);

    const fingerprint = await keyFingerprint(pubPath, deps);
    if (fingerprint !== null && loaded.has(fingerprint)) {
        deps.log.debug("key already loaded in agent", { key });
        return;
    }

    const agentEnv = { ...baseEnv(deps), SSH_AUTH_SOCK: sock };
    if (remote.passphrase === null) {
        if (unencryptedProbe === null) {
            unencryptedProbe = await probeUnencrypted(key, deps);
        }
        if (unencryptedProbe.exitCode !== 0) {
            throw new SshError(
                `key ${key} appears to be encrypted but remote "${remote.name}" configures no passphrase; ` +
                    `add "passphrase": "file:/path" or "prompt" to the remote`,
            );
        }
        await sshAdd(key, agentEnv, deps);
        return;
    }
    if (remote.passphrase.kind === "file") {
        await sshAdd(key, { ...agentEnv, ...askpassEnv(remote.passphrase.value) }, deps);
        return;
    }
    if (!hasTty(deps)) {
        throw new SshError(
            `key ${key} is encrypted and not loaded; run "backupkit check" in a terminal, then restart the service`,
        );
    }
    // ssh-add's own TTY prompt: inherited stdio, no timeout (a human is typing).
    const result = await exec("ssh-add", [key], { env: agentEnv, stdio: "inherit" });
    if (result.exitCode !== 0) {
        throw new SshError(`ssh-add ${key} failed (exit ${result.exitCode ?? "signal"})`);
    }
    deps.log.info("loaded key into agent", { key });
}

/**
 * Prime every unique explicit-remote key into the persistent agent, ensuring
 * the agent first. Alias remotes are skipped entirely, and a remote list with
 * no explicit remote starts no agent at all and spawns nothing - the return
 * is null. Otherwise returns the agent socket path for the callers that set
 * SSH_AUTH_SOCK on explicit-remote spawns.
 */
export async function loadKeys(remotes: readonly ResolvedRemote[], deps: AgentDeps): Promise<string | null> {
    const explicit = uniqueExplicitRemotes(remotes);
    if (explicit.length === 0) {
        deps.log.debug("no explicit remotes - agent not started");
        return null;
    }
    const sock = await ensureAgent(deps);
    const loaded = await loadedFingerprints(sock, deps);
    for (const remote of explicit) {
        await primeKey(remote, sock, loaded, deps);
    }
    return sock;
}
