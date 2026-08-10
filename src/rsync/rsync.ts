/**
 * The rsync engine: `runTransfer` (the retry loop around one snapshot
 * transfer), `dryRunStats` (delta estimation for the disk guard), and the
 * local/remote version probes (hard floor rsync >= 3.2.5, openrsync refused).
 * All spawning goes through exec/; ssh identity arrives as prebuilt data
 * (`sshTokens` on the TransferSpec, an injected runner for remote probes) so
 * this module never imports ssh/.
 */

import { exec, type ExecOptions, type ExecResult } from "../exec/exec.js";
import { SshError, TransferError } from "../shared/errors.js";
import type { Logger } from "../shared/logger.js";
import { CONTROL_RETRY_POLICY, transferRetryPolicy, withTransientRetry } from "../shared/retry.js";
import { sanitize } from "../shared/sanitize.js";
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

/** Take the sanitized last 2 KiB of a stderr stream (the spec's report/classification tail). */
function stderrTailOf(stderr: string): string {
    return sanitize(stderr.slice(-2048));
}

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
 * for explicit remotes, the alias string for alias remotes). Wrapped in the
 * control-path transient retry so a momentary blip never marks a healthy host
 * bad; a version below the floor (or openrsync) is a permanent refusal, never
 * retried. Successful probes are cached per identity for the process lifetime;
 * failures are not cached, so the next run re-probes a host that got fixed.
 */
export function probeRemoteRsync(params: {
    /** Cache key: the connection identity this probe travels over. */
    identity: string;
    /** The ssh runner for this remote (injected; see RemoteRunner). */
    runRemote: RemoteRunner;
    /** The target's remoteRsyncBin override, or null for the remote default "rsync". */
    remoteRsyncBin: string | null;
    /** Logger for the retry helper's per-attempt warns. */
    log: Logger;
}): Promise<string> {
    const key = probeCacheKey(params.identity, params.remoteRsyncBin);
    const cached = remoteVersionCache.get(key);
    if (cached !== undefined) {
        return cached;
    }
    const bin = params.remoteRsyncBin ?? "rsync";
    const fix = `install rsync >= ${RSYNC_VERSION_FLOOR} on the remote, or point rsync.remoteRsyncBin at one`;
    const probe = withTransientRetry(
        async () => {
            const result = await params.runRemote([bin, "--version"]);
            const tail = stderrTailOf(result.stderr);
            if (result.exitCode === 255 || result.exitCode === null || result.timedOut) {
                throw new SshError(`rsync version probe failed on ${params.identity}: ${tail || "ssh transport error"}`, {
                    retriable: classifyExit(255, tail).retriable,
                });
            }
            if (result.exitCode === 127) {
                refuse(`${bin} not found on ${params.identity} - ${fix}`);
            }
            if (result.exitCode !== 0) {
                refuse(`${bin} --version failed on ${params.identity} (exit ${result.exitCode}) - ${fix}`);
            }
            return judgeVersionBanner(`${bin} on ${params.identity}`, result.stdout, fix);
        },
        CONTROL_RETRY_POLICY,
        params.log,
        `rsync version probe ${params.identity}`,
    );
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
 * double-quoted string of each rsync error line, sanitized.
 */
function extractSkippedPaths(stderr: string): string[] {
    const paths: string[] = [];
    for (const line of stderr.split("\n")) {
        if (paths.length >= SKIPPED_FILES_CAP) {
            break;
        }
        if (!line.startsWith("rsync")) {
            continue;
        }
        const match = /"([^"]+)"/.exec(line);
        if (match !== null) {
            paths.push(sanitize(match[1]));
        }
    }
    return paths;
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
            const tail = stderrTailOf(result.stderr);
            const cls = classifyExit(result.exitCode, tail);
            attempts.push({ exitCode: result.exitCode, class: cls.class, durationMs: result.durationMs, stderrTail: tail });
            if (!cls.promote) {
                throw new TransferError(cls.message, {
                    exitCode: result.exitCode,
                    retriable: cls.retriable,
                    stderrTail: tail,
                });
            }
            const skippedFiles = result.exitCode === 23 ? extractSkippedPaths(result.stderr) : [];
            if (result.exitCode === 23) {
                params.log.warn(
                    "transfer skipped unreadable files (exit 23) - consider adding exclude patterns for them",
                    { skippedCount: skippedFiles.length },
                );
            } else if (result.exitCode === 24) {
                params.log.warn("source files vanished during transfer (exit 24)");
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
            const tail = stderrTailOf(result.stderr);
            const cls = classifyExit(result.exitCode, tail);
            if (!cls.promote) {
                throw new TransferError(`delta estimate failed: ${cls.message}`, {
                    exitCode: result.exitCode,
                    retriable: cls.retriable,
                    stderrTail: tail,
                });
            }
            const stats = parseStats2(result.stdout);
            if (stats === null) {
                throw new TransferError("delta estimate produced no parsable rsync stats output", {
                    exitCode: result.exitCode,
                    retriable: false,
                    stderrTail: tail,
                });
            }
            return stats;
        },
        CONTROL_RETRY_POLICY,
        params.log,
        "delta estimate",
    );
}
