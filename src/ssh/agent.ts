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
import { describeError, SshError } from "../shared/errors.js";
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
    /**
     * True when this process is the SERVICE (`backupkit daemon` under systemd
     * or launchd). Passphrase-protected keys are then refused up front - see
     * {@link findEncryptedKeys} for why a service cannot own one. Default false
     * (a local, user-run process: `backupkit start`, `run`, `check`).
     */
    serviceMode?: boolean;
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
        const message = describeError(error);
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

/**
 * Write a `.pub` sidecar at mode 0644 with O_EXCL (`flag: "wx"`). O_EXCL is
 * load-bearing: `fileExists` probes with `stat`, which FOLLOWS symlinks, so a
 * DANGLING symlink planted at `<key>.pub` reads as absent - and a plain write
 * would then follow it and create/truncate whatever it names, as whatever uid
 * backupkit runs under (root, for the daemon). With O_EXCL the kernel refuses
 * both the dangling symlink and a racing writer. Either outcome means we did
 * NOT generate this sidecar, so it fails loudly rather than treating a file of
 * unknown provenance as ours.
 */
async function writePubSidecar(pubPath: string, content: string): Promise<void> {
    try {
        await writeFile(pubPath, content, { mode: 0o644, flag: "wx" });
    } catch (error) {
        const code = typeof error === "object" && error !== null ? (error as { code?: unknown }).code : undefined;
        if (code === "EEXIST") {
            throw new SshError(
                `${pubPath} appeared while backupkit was generating it (a pre-planted symlink or a racing ` +
                    `process won); inspect and remove it, then retry`,
            );
        }
        throw new SshError(`${pubPath} could not be written: ${describeError(error)}`);
    }
}

/** Explicit remotes grouped by identityFile in first-seen order (one priming attempt per key; a failure marks every remote in the group). */
function explicitRemotesByKey(remotes: readonly ResolvedRemote[]): Map<string, ExplicitRemote[]> {
    const groups = new Map<string, ExplicitRemote[]>();
    for (const remote of remotes) {
        if (remote.kind === "explicit") {
            const group = groups.get(remote.identityFile);
            if (group === undefined) {
                groups.set(remote.identityFile, [remote]);
            } else {
                group.push(remote);
            }
        }
    }
    return groups;
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
 * passphrase via the askpass env, otherwise via ssh-keygen's own /dev/tty
 * prompt - declared `prompt` and undeclared alike) and fail unattended with a
 * pointer at `backupkit check`. Written
 * 0644 through `writePubSidecar` (O_EXCL - never following a planted symlink).
 * Returns the unencrypted probe result when one was run (so the caller need
 * not repeat it).
 */
async function ensurePubSidecar(remote: ExplicitRemote, deps: AgentDeps): Promise<ExecResult | null> {
    const key = remote.identityFile;
    const pubPath = `${key}.pub`;
    if (await fileExists(pubPath)) {
        return null;
    }
    if (remote.passphrase === null) {
        const probe = await probeUnencrypted(key, deps);
        if (probe.exitCode === 0) {
            await writePubSidecar(pubPath, probe.stdout);
            return probe;
        }
        if (!hasTty(deps)) {
            throw new SshError(
                `key ${key} could not be read without a passphrase (is it encrypted?); ` +
                    `configure "passphrase" for remote "${remote.name}" or fix the key: ${toolTail(probe.stderr)}`,
            );
        }
        // Encrypted, undeclared, and a human is here (`backupkit start`,
        // `check`): ssh-keygen's own /dev/tty prompt settles it, exactly as it
        // would for a declared "prompt" key. Demanding the declaration first
        // would be a hoop with no purpose - the terminal is right there.
    } else if (!hasTty(deps)) {
        throw new SshError(
            `key ${key} is encrypted and has no ${pubPath} sidecar; ` +
                `run "backupkit check" in a terminal to generate it, then restart the service`,
        );
    }
    const env =
        remote.passphrase?.kind === "file"
            ? { ...baseEnv(deps), ...askpassEnv(remote.passphrase.value) }
            : baseEnv(deps);
    // "prompt" keys: ssh-keygen prompts on /dev/tty itself; stdout is still captured.
    const generated = await runTool("ssh-keygen", ["-y", "-f", key], env, toolTimeout(deps));
    if (generated.exitCode !== 0) {
        throw new SshError(`ssh-keygen -y -f ${key} failed (exit ${generated.exitCode}): ${toolTail(generated.stderr)}`);
    }
    await writePubSidecar(pubPath, generated.stdout);
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
 *
 * An encrypted key whose remote declares NO passphrase takes that same TTY
 * prompt when a human is present - `backupkit start` is meant to load every key
 * it was given, and refusing over a missing declaration when the terminal is
 * right there would be a hoop, not a safeguard. Without a TTY it stays the
 * actionable failure it was.
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
        if (unencryptedProbe.exitCode === 0) {
            await sshAdd(key, agentEnv, deps);
            return;
        }
        if (!hasTty(deps)) {
            throw new SshError(
                `key ${key} appears to be encrypted but remote "${remote.name}" configures no passphrase; ` +
                    `add "passphrase": "file:/path" or "prompt" to the remote, or run "backupkit start" in a terminal`,
            );
        }
        // Encrypted but undeclared, with a human present: fall through to
        // ssh-add's own prompt rather than refusing over a missing declaration.
        // This is what makes `backupkit start` load EVERY key it was given.
    } else if (remote.passphrase.kind === "file") {
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

/** One explicit remote whose private key is passphrase-protected. */
export interface EncryptedKey {
    /** The remote's short name (its key in config `remotes`). */
    remote: string;
    /** Absolute path of the encrypted private key. */
    key: string;
}

/**
 * Every unique explicit-remote key that is passphrase-protected, in config
 * order. A key counts as encrypted when the remote DECLARES a passphrase
 * source (`file:` or `prompt`) or when `ssh-keygen -y -P ""` cannot read it -
 * the second half is what catches an encrypted key whose remote declares
 * nothing, which is the shape that used to fail later, per-remote, as a
 * priming error.
 *
 * Why the service refuses these outright (see {@link loadKeys}): unlocking a
 * key needs either a human at a TTY - which a launchd/systemd unit never has -
 * or the passphrase in a file next to the key, which buys no secrecy over an
 * unencrypted key while adding a second secret to lose. A service therefore
 * takes ONLY unencrypted keys; an operator who wants a passphrase runs
 * `backupkit start` in their own session, where an agent can be unlocked once
 * and interactively.
 */
export async function findEncryptedKeys(
    remotes: readonly ResolvedRemote[],
    deps: AgentDeps,
): Promise<EncryptedKey[]> {
    const encrypted: EncryptedKey[] = [];
    for (const group of explicitRemotesByKey(remotes).values()) {
        const remote = group[0];
        if (remote.passphrase !== null || (await probeUnencrypted(remote.identityFile, deps)).exitCode !== 0) {
            encrypted.push({ remote: remote.name, key: remote.identityFile });
        }
    }
    return encrypted;
}

/** The operator-facing message for keys a service cannot unlock (one wording, two call sites). */
export function encryptedKeysMessage(keys: readonly EncryptedKey[]): string {
    const list = keys.map((entry) => `${entry.key} (remote "${entry.remote}")`).join(", ");
    return (
        `passphrase-protected keys are not supported when backupkit runs as a service: ${list}. ` +
        "A service has no terminal to unlock a key on. Either give the service its own key with no " +
        'passphrase (ssh-keygen -t ed25519 -N ""), or stop the service and run "backupkit start" in ' +
        "your own session instead - it starts an ssh-agent, prompts once for each key, and then " +
        "schedules exactly like the service does."
    );
}

/** The outcome of `loadKeys`: the agent socket plus every per-remote priming failure. */
export interface LoadKeysResult {
    /** The agent socket path for explicit-remote spawns, or null when no explicit remote exists (no agent started). */
    sock: string | null;
    /** Remote name -> actionable priming-failure message; every remote sharing an un-primeable identityFile is listed. Empty when all keys primed. */
    failures: Map<string, string>;
}

/**
 * Prime every unique explicit-remote key into the persistent agent, ensuring
 * the agent first. Alias remotes are skipped entirely, and a remote list with
 * no explicit remote starts no agent at all and spawns nothing (`sock` is
 * null). Key priming is per-remote fault-isolated (spec section 4 step 5): a
 * key that cannot be primed - e.g. an encrypted `prompt` key with no TTY -
 * lands in `failures` for every remote using it, so the caller fails only
 * that remote's targets while the daemon and every other remote keep running.
 * Only agent-level failures (agent cannot start or answer) still throw.
 *
 * `serviceMode` is the one exception to that fault isolation: a
 * passphrase-protected key THROWS instead, before any agent is started, so the
 * service refuses to come up rather than running half-blind forever (its
 * targets would fail every tick with an error no unattended process can ever
 * resolve). See {@link findEncryptedKeys}.
 */
export async function loadKeys(remotes: readonly ResolvedRemote[], deps: AgentDeps): Promise<LoadKeysResult> {
    const groups = explicitRemotesByKey(remotes);
    if (groups.size === 0) {
        deps.log.debug("no explicit remotes - agent not started");
        return { sock: null, failures: new Map() };
    }
    if (deps.serviceMode === true) {
        const encrypted = await findEncryptedKeys(remotes, deps);
        if (encrypted.length > 0) {
            throw new SshError(encryptedKeysMessage(encrypted));
        }
    }
    const sock = await ensureAgent(deps);
    const loaded = await loadedFingerprints(sock, deps);
    const failures = new Map<string, string>();
    for (const group of groups.values()) {
        try {
            await primeKey(group[0], sock, loaded, deps);
        } catch (error) {
            const message = describeError(error);
            for (const remote of group) {
                failures.set(remote.name, message);
            }
            deps.log.error(
                "this SSH key could not be loaded into the agent - every target using it will fail until that is fixed",
                { key: group[0].identityFile, error: message },
            );
        }
    }
    return { sock, failures };
}
