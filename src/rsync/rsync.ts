/**
 * The rsync engine: `runTransfer` (the retry loop around one snapshot
 * transfer), `dryRunStats` (delta estimation for the disk guard), and the
 * local/remote version probes (hard floor rsync >= 3.2.5, openrsync refused).
 * All spawning goes through exec/; ssh identity and connections arrive as
 * prebuilt DATA (`sshTokens` on the TransferSpec, an injected runner for remote
 * probes), so this module never reaches ssh/ to make a connection. The imports
 * it does take on ssh/ are the pure stderr helpers - the classifier
 * (`internal/classify.ts` -> `ssh/classify.ts`) and `sshStderrTail` - because
 * how a stderr tail is cut, and which text in it means "permanently failed",
 * must have exactly one owner.
 */

import { exec, type ExecOptions, type ExecResult } from "../exec/exec.js";
import { SshError, TransferError } from "../shared/errors.js";
import type { Logger } from "../shared/logger.js";
import { CONTROL_RETRY_POLICY, transferRetryPolicy, withTransientRetry } from "../shared/retry.js";
import { sanitize } from "../shared/sanitize.js";
import { describeTransientSshStderr, sshStderrTail } from "../ssh/classify.js";
import { buildArgs, type TransferSpec } from "./internal/args.js";
import { classifyExit, type ExitClass } from "./internal/classify.js";
import { parseStats2, type RsyncStats } from "./internal/stats.js";

export { buildArgs, type BuildMode, type TransferOptions, type TransferSpec } from "./internal/args.js";
export { classifyExit, type ExitClass, type ExitClassification } from "./internal/classify.js";
export { parseStats2, type RsyncStats } from "./internal/stats.js";

/** The exec/ spawn function shape, injectable for tests (fake exec, no real child). */
export type ExecFn = (bin: string, args: readonly string[], options?: ExecOptions) => Promise<ExecResult>;

/**
 * A remote command runner: ssh/'s `runRemote` partially applied to one remote.
 * Injected as a plain function (ssh/ is built in parallel; this module takes
 * no import on it). Resolves with the ExecResult of the ssh invocation - exit
 * 255 means the transport failed - and rejects only when ssh itself cannot be
 * spawned.
 */
export type RemoteRunner = (argv: readonly string[]) => Promise<ExecResult>;

/** The minimum supported rsync version on both ends (spec: CVE-2022-29154 class). */
export const RSYNC_VERSION_FLOOR = "3.2.5";

/** Default local rsync discovery order when config sets no rsyncBin override. */
const LOCAL_RSYNC_CANDIDATES = ["/opt/homebrew/bin/rsync", "/usr/local/bin/rsync", "rsync"];

/** Fix instruction appended to every local version refusal. */
const LOCAL_FIX = 'install rsync >= 3.2.5 (macOS: "brew install rsync"; Debian/Ubuntu: "apt install rsync")';

/** Matches the version triple in an rsync --version banner ("rsync  version 3.2.7  protocol version 31"). */
const VERSION_BANNER = /rsync\s+version\s+v?([0-9]+)\.([0-9]+)\.([0-9]+)/;

/** Throw the standard non-retriable TransferError for a probe/build failure (no child exit involved). */
function refuse(message: string): never {
    throw new TransferError(message, { exitCode: null, retriable: false, stderrTail: "" });
}

/**
 * Judge one `rsync --version` output against the floor: refuses openrsync and
 * anything below 3.2.5 with an error naming the binary, the found version,
 * the floor, and the fix. Returns the accepted version string.
 */
function judgeVersionBanner(binLabel: string, output: string, fix: string): string {
    if (output.includes("openrsync")) {
        refuse(`${binLabel} is openrsync, which is not supported (floor: rsync ${RSYNC_VERSION_FLOOR}) - ${fix}`);
    }
    const match = VERSION_BANNER.exec(output);
    if (match === null) {
        refuse(`${binLabel} did not print a recognizable rsync version banner - ${fix}`);
    }
    const [major, minor, patch] = [Number(match[1]), Number(match[2]), Number(match[3])];
    const [floorMajor, floorMinor, floorPatch] = RSYNC_VERSION_FLOOR.split(".").map(Number);
    const meetsFloor =
        major !== floorMajor
            ? major > floorMajor
            : minor !== floorMinor
              ? minor > floorMinor
              : patch >= floorPatch;
    const version = `${major}.${minor}.${patch}`;
    if (!meetsFloor) {
        refuse(`${binLabel} is rsync ${version}, below the required floor ${RSYNC_VERSION_FLOOR} - ${fix}`);
    }
    return version;
}

/**
 * Resolve and probe the local rsync binary once at startup: the config
 * override if set, else /opt/homebrew/bin/rsync, /usr/local/bin/rsync, then
 * PATH. The first spawnable candidate is THE binary; a candidate that exists
 * but is openrsync or below the floor is refused, never worked around.
 */
export async function probeLocalRsync(
    rsyncBin: string | null,
    execFn: ExecFn = exec,
): Promise<{ bin: string; version: string }> {
    const candidates = rsyncBin !== null ? [rsyncBin] : LOCAL_RSYNC_CANDIDATES;
    for (const bin of candidates) {
        let result: ExecResult;
        try {
            result = await execFn(bin, ["--version"], { timeoutMs: 5000 });
        } catch {
            continue;
        }
        if (result.exitCode !== 0) {
            refuse(`${bin} --version failed (exit ${result.exitCode ?? "signal"}) - ${LOCAL_FIX}`);
        }
        return { bin, version: judgeVersionBanner(bin, result.stdout, LOCAL_FIX) };
    }
    refuse(`no rsync binary found (tried: ${candidates.join(", ")}) - ${LOCAL_FIX}`);
}

/**
 * Successful remote probes, so each host+binary pair is probed once per
 * process. The key is `<identity>\0<remoteRsyncBin>`, NOT the identity alone:
 * `remoteRsyncBin` is a per-TARGET setting, so two targets may legitimately
 * share one host while pointing `--rsync-path` at different binaries. Keying
 * on the host alone would let the first target's result stand in for the
 * second's, leaving a binary that the transfer really uses never checked
 * against the version floor.
 */
const remoteVersionCache = new Map<string, Promise<string>>();

/** The cache key for one probe: the connection identity plus the binary being probed. */
function probeCacheKey(identity: string, remoteRsyncBin: string | null): string {
    return `${identity}\0${remoteRsyncBin ?? ""}`;
}

/** Drop every cached remote probe result (tests, and nothing else, need this). */
export function clearRemoteVersionCache(): void {
    remoteVersionCache.clear();
}

/**
 * Probe the remote rsync version over one connection identity (`user@host:port`
 * for explicit remotes, the alias string for alias remotes). A version below
 * the floor (or openrsync) is a permanent refusal. Successful probes are cached
 * per identity for the process lifetime; failures are not cached, so the next
 * run re-probes a host that got fixed.
 *
 * TRANSIENT RETRIES BELONG TO THE RUNNER, not to this function. `runRemote` is
 * already wrapped in the control-path retry, so a second ladder here MULTIPLIED
 * with it: 3 outer attempts x 3 inner ones was 9 ssh connects for one probe.
 * Against a host that is simply down, at ConnectTimeout=15 that is over two
 * minutes of `backupkit check` sitting silent, and eight near-identical
 * "retrying" lines for one dead host. The runner's own ladder is the control
 * policy - the exact thing the outer wrapper was there to provide.
 */
export function probeRemoteRsync(params: {
    /** Cache key: the connection identity this probe travels over. */
    identity: string;
    /** The ssh runner for this remote (injected; see RemoteRunner). */
    runRemote: RemoteRunner;
    /** The target's remoteRsyncBin override, or null for the remote default "rsync". */
    remoteRsyncBin: string | null;
}): Promise<string> {
    const key = probeCacheKey(params.identity, params.remoteRsyncBin);
    const cached = remoteVersionCache.get(key);
    if (cached !== undefined) {
        return cached;
    }
    const bin = params.remoteRsyncBin ?? "rsync";
    const fix = `install rsync >= ${RSYNC_VERSION_FLOOR} on the remote, or point rsync.remoteRsyncBin at one`;
    const probe = (async (): Promise<string> => {
        const result = await params.runRemote([bin, "--version"]);
        const tail = sshStderrTail(result.stderr);
        if (result.exitCode === 255 || result.exitCode === null || result.timedOut) {
            const why = describeTransientSshStderr(tail) ?? "the ssh transport failed before rsync could answer";
            throw new SshError(
                `could not ask ${params.identity} for its rsync version: ${why}` +
                    (tail === "" ? "" : ` [ssh said: ${tail}]`),
                { retriable: classifyExit(255, tail).retriable },
            );
        }
        if (result.exitCode === 127) {
            refuse(`${bin} not found on ${params.identity} - ${fix}`);
        }
        if (result.exitCode !== 0) {
            refuse(`${bin} --version failed on ${params.identity} (exit ${result.exitCode}) - ${fix}`);
        }
        return judgeVersionBanner(`${bin} on ${params.identity}`, result.stdout, fix);
    })();
    remoteVersionCache.set(key, probe);
    probe.catch(() => remoteVersionCache.delete(key));
    return probe;
}

/** One transfer attempt as recorded in the run report's `attempts` array. */
export interface TransferAttempt {
    /** rsync exit code, or null when the child died on a signal. */
    exitCode: number | null;
    /** Exit-code table row the attempt landed on. */
    class: ExitClass;
    /** Wall-clock duration of the attempt in milliseconds. */
    durationMs: number;
    /** Sanitized last 2 KiB of the attempt's stderr. */
    stderrTail: string;
}

/** Outcome of a successful (promotable) transfer. */
export interface TransferResult {
    /** "success" on exit 0; "warning" on exit 23/24 (still promoted). */
    status: "success" | "warning";
    /** Every attempt this run made, first to last. */
    attempts: TransferAttempt[];
    /** Parsed stats2 block of the final attempt, or null when unparsable. */
    stats: RsyncStats | null;
    /** On exit 23: up to 100 offending paths extracted from stderr (sanitized). Empty otherwise. */
    skippedFiles: string[];
}

/** Cap on the offending paths extracted from an exit-23 stderr. */
const SKIPPED_FILES_CAP = 100;

/**
 * Extract up to 100 offending paths from an exit-23 stderr: the first
 * double-quoted string of each rsync error line, sanitized, each with rsync's
 * own reason for it when the line carries one ("Permission denied", "No such
 * file or directory"). The reason is what keeps the warning honest: the same
 * exit 23 covers an unreadable file and a source directory that is not there
 * at all, and telling someone whose volume is unmounted to "fix the
 * permissions" sends them after the wrong thing.
 */
function extractSkippedPaths(stderr: string): { path: string; reason: string | null }[] {
    const found: { path: string; reason: string | null }[] = [];
    for (const line of stderr.split("\n")) {
        if (found.length >= SKIPPED_FILES_CAP) {
            break;
        }
        if (!line.startsWith("rsync")) {
            continue;
        }
        const match = /"([^"]+)"/.exec(line);
        if (match === null) {
            continue;
        }
        // rsync's tail is `...: <reason> (<errno>)`; keep the words, drop the number.
        const reason = /:\s*([A-Za-z][^:()]*?)\s*\(\d+\)\s*$/.exec(line);
        found.push({ path: sanitize(match[1]), reason: reason === null ? null : reason[1] });
    }
    return found;
}

/**
 * Run the transfer for one snapshot with the spec's retry loop: up to
 * `retryAttempts` total attempts (the target's `retry.attempts`, default 5)
 * via shared/retry's transfer policy - 15 s doubling to a 300 s cap, ±20%
 * jitter - always resuming into the same `.partial` (the argv, and therefore
 * the destination, is built once). Classification is `classifyExit` and
 * nothing else; a non-retriable failure throws its TransferError immediately.
 * Resolves only for promotable exits (0/23/24).
 *
 * Abort: when `signal` is aborted, no further attempt starts (a TransferError
 * with the aborted message is thrown before the next spawn). Killing the
 * in-flight child on engine SIGTERM is the spawner's concern; a child that
 * dies on a signal classifies non-retriable, so an aborted run is never
 * retried in-process.
 */
export async function runTransfer(params: {
    /** Absolute local rsync binary (from probeLocalRsync). */
    rsyncBin: string;
    /** The transfer spec; argv is built once, so every attempt resumes the same .partial. */
    spec: TransferSpec;
    /** Total attempts including the first (the target's retry.attempts, 1-10). */
    retryAttempts: number;
    /** Logger for retry warns and the exit-23/24 warnings. */
    log: Logger;
    /** COMPLETE child env (exec semantics: PATH/HOME/LC_ALL plus at most one SSH_AUTH_SOCK). Omit for exec's minimal default. */
    env?: Record<string, string>;
    /** Abort signal: set = start no further attempts. */
    signal?: AbortSignal;
    /** Spawn function, injectable for tests. */
    execFn?: ExecFn;
    /** Caller-provided sink receiving every attempt record even when the transfer ultimately throws (for the run report). */
    attemptLog?: TransferAttempt[];
}): Promise<TransferResult> {
    const execFn = params.execFn ?? exec;
    const attempts = params.attemptLog ?? [];
    const argv = buildArgs(params.spec, "transfer");
    return withTransientRetry(
        async () => {
            if (params.signal?.aborted === true) {
                throw new TransferError("transfer aborted", { exitCode: null, retriable: false, stderrTail: "" });
            }
            const result = await execFn(params.rsyncBin, argv, { env: params.env });
            const tail = sshStderrTail(result.stderr);
            const cls = classifyExit(result.exitCode, tail);
            attempts.push({ exitCode: result.exitCode, class: cls.class, durationMs: result.durationMs, stderrTail: tail });
            if (!cls.promote) {
                throw new TransferError(cls.message, {
                    exitCode: result.exitCode,
                    retriable: cls.retriable,
                    stderrTail: tail,
                });
            }
            const skipped = result.exitCode === 23 ? extractSkippedPaths(result.stderr) : [];
            const skippedFiles = skipped.map((entry) => entry.path);
            if (result.exitCode === 23) {
                // ponytail: names the first 5 paths inline - the full list (capped at 100) is on the result.
                const shown = skipped
                    .slice(0, 5)
                    .map((entry) => (entry.reason === null ? entry.path : `${entry.path} (${entry.reason})`))
                    .join(", ");
                const more = skipped.length > 5 ? ` and ${skipped.length - 5} more` : "";
                const one = skipped.length === 1;
                params.log.warn(
                    (one
                        ? `could not read ${shown === "" ? "1 path" : shown}, so it is not in this backup. `
                        : `could not read ${skipped.length} paths, so they are not in this backup${shown === "" ? "" : `: ${shown}${more}`}. `) +
                        `Check that ${one ? "it exists and is readable" : "they exist and are readable"}, or add ${one ? "it" : "them"} to this target's exclude list.`,
                );
            } else if (result.exitCode === 24) {
                params.log.warn(
                    "some files were deleted while the backup was running, so they are not in this backup - normal on a live system.",
                );
            }
            return {
                status: result.exitCode === 0 ? ("success" as const) : ("warning" as const),
                attempts,
                stats: parseStats2(result.stdout),
                skippedFiles,
            };
        },
        transferRetryPolicy(params.retryAttempts),
        params.log,
        "transfer",
        // Without this a stop lands in a backoff sleep of up to the 300 s cap,
        // long past any service unit's stop timeout, before the next attempt's
        // aborted-check would even run.
        params.signal,
    );
}

/**
 * Delta estimation for the disk guard: one estimate-mode pass (same argv as
 * the transfer plus --dry-run, same --link-dest) whose stats2 block yields
 * "Total transferred file size" as the projected delta. Wrapped in the
 * control-path transient retry (3 attempts, 2 s/8 s) - a momentary blip never
 * skips a run - and tolerant of exit 23/24 (an unreadable file surfaces in
 * the real transfer, not here).
 */
export async function dryRunStats(params: {
    /** Absolute local rsync binary (from probeLocalRsync). */
    rsyncBin: string;
    /** The transfer spec (dst = the .partial endpoint, identical to the transfer pass). */
    spec: TransferSpec;
    /** Logger for the retry helper's per-attempt warns. */
    log: Logger;
    /** COMPLETE child env (exec semantics). Omit for exec's minimal default. */
    env?: Record<string, string>;
    /** Spawn function, injectable for tests. */
    execFn?: ExecFn;
}): Promise<RsyncStats> {
    const execFn = params.execFn ?? exec;
    const argv = buildArgs(params.spec, "estimate");
    return withTransientRetry(
        async () => {
            const result = await execFn(params.rsyncBin, argv, { env: params.env });
            const tail = sshStderrTail(result.stderr);
            const cls = classifyExit(result.exitCode, tail);
            if (!cls.promote) {
                throw new TransferError(`sizing up the changes failed: ${cls.message}`, {
                    exitCode: result.exitCode,
                    retriable: cls.retriable,
                    stderrTail: tail,
                });
            }
            const stats = parseStats2(result.stdout);
            if (stats === null) {
                throw new TransferError("sizing up the changes produced no parsable rsync stats output", {
                    exitCode: result.exitCode,
                    retriable: false,
                    stderrTail: tail,
                });
            }
            return stats;
        },
        CONTROL_RETRY_POLICY,
        params.log,
        "sizing up the changes",
    );
}
