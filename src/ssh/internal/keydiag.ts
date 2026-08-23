/**
 * Why an ALIAS remote's key could not authenticate under BatchMode.
 *
 * backupkit does not manage keys for alias remotes - the user's ssh_config and
 * their own agent are authoritative - but "authentication failed under
 * BatchMode" is a symptom, not a cause, and the overwhelmingly common cause is
 * a passphrase-protected key that no reachable agent holds. `ssh
 * <alias>` then works for a human (ssh prompts on the terminal) while every
 * unattended run fails, which reads as backupkit being broken.
 *
 * This module answers the question ssh will not: resolve the alias's
 * IdentityFile(s) with `ssh -G`, ask `ssh-keygen -y -P ""` whether the key is
 * encrypted, and ask the agent backupkit actually passed to ssh whether it
 * holds that key's fingerprint. It NEVER guesses: every probe that fails,
 * times out or comes back inconclusive yields null, and the caller keeps its
 * original message. Nothing here reads a passphrase or touches a key.
 */

import { stat } from "node:fs/promises";
import { isAbsolute, join } from "node:path";

import { exec, type ExecResult } from "../../exec/exec.js";
import { sanitize } from "../../shared/sanitize.js";

/** Inputs for one alias-auth diagnosis. */
export interface AliasAuthDiagnosisOptions {
    /** Absolute path (or PATH-resolvable name) of the local ssh binary. */
    sshBin: string;
    /**
     * The COMPLETE environment the failing ssh child was given, verbatim. Its
     * SSH_AUTH_SOCK (present or absent) is the whole point: the diagnosis must
     * describe the agent backupkit reached, not the one this process happens
     * to see.
     */
    env: Record<string, string>;
    /** Timeout per probe in milliseconds. Default 10000. */
    timeoutMs?: number;
}

/** What the agent named by SSH_AUTH_SOCK could tell us. */
type AgentState =
    | { kind: "absent" }
    | { kind: "unreachable"; sock: string }
    | { kind: "loaded"; sock: string; fingerprints: Set<string> };

/**
 * Run one probe, resolving null for every outcome that cannot be interpreted
 * (spawn failure, timeout). A diagnosis is a courtesy: it must not throw into
 * the error path it is decorating.
 */
async function probe(
    bin: string,
    args: readonly string[],
    options: AliasAuthDiagnosisOptions,
): Promise<ExecResult | null> {
    try {
        const result = await exec(bin, args, { env: options.env, timeoutMs: options.timeoutMs ?? 10_000 });
        return result.timedOut ? null : result;
    } catch {
        return null;
    }
}

/** Expand a leading `~` against the child environment's HOME; anything not absolute afterwards is dropped by the caller. */
function expandHome(path: string, home: string | undefined): string {
    if (home === undefined || home === "") {
        return path;
    }
    if (path === "~") {
        return home;
    }
    return path.startsWith("~/") ? join(home, path.slice(2)) : path;
}

/**
 * The alias's effective IdentityFile paths per `ssh -G <alias>`, in ssh's own
 * order, `~`-expanded and filtered to absolute paths. Empty when ssh cannot
 * resolve the alias.
 */
async function identityFiles(alias: string, options: AliasAuthDiagnosisOptions): Promise<string[]> {
    const result = await probe(options.sshBin, ["-G", alias], options);
    if (result === null || result.exitCode !== 0) {
        return [];
    }
    const paths: string[] = [];
    for (const raw of result.stdout.split("\n")) {
        const line = sanitize(raw).trim();
        if (!line.startsWith("identityfile ")) {
            continue;
        }
        const path = expandHome(line.slice("identityfile ".length).trim(), options.env.HOME);
        if (isAbsolute(path) && !paths.includes(path)) {
            paths.push(path);
        }
    }
    return paths;
}

/** Whether a path exists (any file kind). */
async function exists(path: string): Promise<boolean> {
    try {
        await stat(path);
        return true;
    } catch {
        return false;
    }
}

/**
 * Whether a private key needs a passphrase: `ssh-keygen -y -P "" -f <key>`
 * exits 0 for an unencrypted key. The empty `-P ""` is not a passphrase - it
 * is how ssh-keygen is told not to prompt.
 *
 * A non-zero exit is NOT enough to call the key encrypted: ssh-keygen fails
 * the same way on a truncated key, a PuTTY .ppk, a directory, or a file the
 * process cannot read ("invalid format", "No such file or directory"), and
 * telling an operator to `ssh-add` a corrupt key sends them chasing a
 * passphrase that does not exist. Only ssh-keygen naming a passphrase counts;
 * anything else is null - unknown.
 */
async function isEncrypted(key: string, options: AliasAuthDiagnosisOptions): Promise<boolean | null> {
    const result = await probe("ssh-keygen", ["-y", "-P", "", "-f", key], options);
    if (result === null) {
        return null;
    }
    if (result.exitCode === 0) {
        return false;
    }
    return /passphrase/i.test(sanitize(result.stderr)) ? true : null;
}

/** A key's fingerprint via `ssh-keygen -lf <key>` (works on an ENCRYPTED private key - only its public half is read), or null. */
async function fingerprint(key: string, options: AliasAuthDiagnosisOptions): Promise<string | null> {
    const result = await probe("ssh-keygen", ["-lf", key], options);
    if (result === null || result.exitCode !== 0) {
        return null;
    }
    const fields = sanitize(result.stdout).trim().split(/\s+/);
    return fields.length >= 2 && fields[1] !== "" ? fields[1] : null;
}

/** What the agent backupkit handed to ssh currently holds. */
async function agentState(options: AliasAuthDiagnosisOptions): Promise<AgentState> {
    const sock = options.env.SSH_AUTH_SOCK;
    if (sock === undefined || sock === "") {
        return { kind: "absent" };
    }
    const result = await probe("ssh-add", ["-l"], options);
    if (result === null || (result.exitCode !== 0 && result.exitCode !== 1)) {
        return { kind: "unreachable", sock: sanitize(sock) };
    }
    const fingerprints = new Set<string>();
    if (result.exitCode === 0) {
        for (const raw of result.stdout.split("\n")) {
            const fields = sanitize(raw).trim().split(/\s+/);
            if (fields.length >= 2 && fields[1] !== "") {
                fingerprints.add(fields[1]);
            }
        }
    }
    return { kind: "loaded", sock: sanitize(sock), fingerprints };
}

/**
 * One short sentence and the command that fixes it. Every message this module
 * produces is read off a terminal by someone who wants to know what to type
 * next, so it says what is wrong once and then says that - the explanation of
 * WHY `ssh <alias>` works by hand while backupkit cannot is true, useful, and
 * belongs in the docs, not stapled to the end of every failure line.
 */
function withFix(problem: string, keys: readonly string[]): string {
    return `${problem}. Fix: ssh-add ${keys.map((key) => sanitize(key)).join(" ")}`;
}

/**
 * The actionable reason an alias's authentication failed - one sentence and
 * the command that fixes it - or null when the probes cannot establish one (in
 * which case the caller keeps its generic message).
 *
 * A reason is returned ONLY for the one shape that is certain: every identity
 * file ssh_config gives the alias is passphrase-protected, and the agent
 * backupkit passed to ssh is missing, dead, empty, or demonstrably does not
 * hold that key. A single readable unencrypted identity file, an unresolvable
 * alias, an unreadable key, or a fingerprint already in the agent all mean the
 * failure is something else - say nothing rather than something wrong.
 */
export async function diagnoseAliasAuth(
    alias: string,
    options: AliasAuthDiagnosisOptions,
): Promise<string | null> {
    const encrypted: string[] = [];
    for (const key of await identityFiles(alias, options)) {
        if (!(await exists(key))) {
            continue;
        }
        const locked = await isEncrypted(key, options);
        if (locked !== true) {
            // Unencrypted (or unprobeable): a passphrase is not what stopped
            // this connection, so this module has nothing to add.
            return null;
        }
        encrypted.push(key);
    }
    if (encrypted.length === 0) {
        return null;
    }

    const agent = await agentState(options);
    if (agent.kind === "absent") {
        return withFix("the SSH key needs a passphrase and no ssh-agent is running", encrypted);
    }
    if (agent.kind === "unreachable") {
        return withFix("the SSH key needs a passphrase and the ssh-agent is not answering", encrypted);
    }
    if (agent.fingerprints.size === 0) {
        return withFix("the SSH key needs a passphrase and the ssh-agent is empty", encrypted);
    }
    const missing: string[] = [];
    for (const key of encrypted) {
        const print = await fingerprint(key, options);
        if (print === null) {
            // Cannot compare this key against the agent - refuse to guess.
            return null;
        }
        if (!agent.fingerprints.has(print)) {
            missing.push(key);
        }
    }
    if (missing.length === 0) {
        return null;
    }
    return withFix("the SSH key needs a passphrase and is not in the ssh-agent", missing);
}
