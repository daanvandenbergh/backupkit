/**
 * The per-target run pipeline (spec section 3): everything inside
 * `store.withLock` - sweep/claim the partial, window dedup, clock-skew guard,
 * disk guard, transfer with retries into `<name>.partial`, optional verify
 * pass, promote on 0/23/24, retention - and a `TargetRunReport` on every
 * path. `LockHeldError` is the one error that escapes (engine policy: it
 * aborts the invocation); everything else lands in the report.
 */

import { join, posix } from "node:path";

import type { ResolvedTarget } from "../../config/types.js";
import type { ExecOptions, ExecResult } from "../../exec/exec.js";
import { isBackupkitError } from "../../shared/errors.js";
import type { Logger } from "../../shared/logger.js";
import { sanitize } from "../../shared/sanitize.js";
import { formatSnapshotName, parseSnapshotName } from "../../shared/snapshot-name.js";
import { windowIndex } from "../../shared/time.js";
import type { Endpoint } from "../../shared/types.js";
import { buildArgs, type TransferSpec, type dryRunStats, type runTransfer, type TransferAttempt } from "../../rsync/rsync.js";
import { planRetention } from "../../retention/retention.js";
import type { SnapshotStore } from "../../snapshots/store.js";
import { splitFutureSnapshots } from "../../snapshots/types.js";
import { evaluateDiskGuard } from "./disk-guard.js";
import { runIdFor } from "./reports.js";
import type { RunStats, TargetRunReport } from "../types.js";

/** The exec/ spawn function shape (re-declared to avoid importing the value module). */
type ExecFn = (bin: string, args: readonly string[], options?: ExecOptions) => Promise<ExecResult>;

/** Everything one target run needs beyond the target itself - every seam injectable for tests. */
export interface TargetRunnerDeps {
    /** The target's snapshot store (local or remote). */
    store: SnapshotStore;
    /** Logger (already child-scoped to the target by the caller). */
    log: Logger;
    /** Clock. */
    now: () => Date;
    /** Absolute local rsync binary (already probed against the version floor). */
    rsyncBin: string;
    /** Prebuilt ssh token array for this target's remote ([] for local-only transfers). */
    sshTokens: string[];
    /** COMPLETE child env for rsync spawns (exec semantics), or undefined for exec's minimal default. */
    env: Record<string, string> | undefined;
    /** The transfer function (production: rsync/'s runTransfer). */
    transfer: typeof runTransfer;
    /** The delta estimator (production: rsync/'s dryRunStats). */
    estimate: typeof dryRunStats;
    /** Spawn function for the verify pass and forwarded into transfer/estimate. */
    execFn: ExecFn;
    /** Total bytes of the archive filesystem, or null when unknown (percent minFree degrades; see disk-guard). */
    totalBytes: () => Promise<number | null>;
    /** Sticky disk-low state shared across runs, for one-log-per-transition semantics. */
    diskLowTargets: Set<string>;
    /**
     * Stats of this target's newest run that completed a transfer, or null when
     * there is no such run on record - the baseline for the content-collapse
     * tripwire. Called at most once per run, after the transfer.
     */
    previousStats: () => Promise<RunStats | null>;
}

/** Per-run options. */
export interface TargetRunOptions {
    /** Bypass window dedup (due-ness and backoff are the caller's checks). */
    force?: boolean;
    /** Estimate only: no claim, no transfer, no promote, retention planned but not executed. */
    dryRun?: boolean;
    /** Graceful-shutdown signal: aborts the in-flight transfer; the report status becomes "aborted". */
    signal?: AbortSignal;
}

/** The `<destination>/<targetName>/<snapName>.partial` endpoint on the target's destination side. */
function partialEndpoint(target: ResolvedTarget, snapName: string): Endpoint {
    const leaf = `${snapName}.partial`;
    if (target.dst.kind === "local") {
        return { kind: "local", path: join(target.dst.path, target.name, leaf) };
    }
    return { kind: "remote", remote: target.dst.remote, path: posix.join(target.dst.path, target.name, leaf) };
}

/** Build the TransferSpec for this run (argv is derived from it identically in every mode). */
function specFor(target: ResolvedTarget, snapName: string, linkDestBase: string | null, deps: TargetRunnerDeps): TransferSpec {
    return {
        src: target.src,
        dst: partialEndpoint(target, snapName),
        options: {
            compress: target.rsync.compress,
            bwlimit: target.rsync.bwlimit,
            ioTimeoutSec: target.rsync.ioTimeoutSec,
            xattrs: target.rsync.xattrs,
            preserveOwnership: target.rsync.preserveOwnership,
            preserveDevices: target.rsync.preserveDevices,
            remoteRsyncBin: target.rsync.remoteRsyncBin,
        },
        exclude: target.exclude,
        sshTokens: deps.sshTokens,
        linkDestBase,
        // The receiver-uid decision: --fake-super when the receiving side is
        // THIS process and it is not root. ponytail: remote receivers (push)
        // get no --fake-super - the remote uid is unknowable here; the jail
        // account's own privileges decide what it can preserve.
        fakeSuper: target.dst.kind === "local" && (process.getuid?.() ?? 0) !== 0,
    };
}

/**
 * Content-collapse tripwire threshold: a new snapshot whose file count is below
 * this fraction of the previous run's is treated as a collapse.
 *
 * Why it exists: every transfer runs `--delete --force`, so a compromised source
 * that presents an empty (or selectively emptied) tree on each scheduled run
 * promotes empty snapshots, and retention - which selects purely on names and
 * counts - then ages the real history out bucket by bucket. That is the one way
 * a source can destroy its own archive despite the jail, and it contradicts the
 * README's promise that a compromised source cannot corrupt the archive.
 *
 * ponytail: one flat halving, file count only, no per-target knob. rsync's
 * `--info=stats2` reports the transferred delta but never the tree's total size,
 * so bytes are not a usable signal here - the file count is. A halving is well
 * clear of normal churn; if a project legitimately halves its file count it
 * loses one prune cycle and `backupkit prune` clears the backlog.
 */
const COLLAPSE_FRACTION = 0.5;

/**
 * The collapse detail when `current` holds fewer than COLLAPSE_FRACTION of
 * `previous`'s files, else null. Missing stats on either side (a first run, or
 * an rsync whose stats block did not parse) never trip the wire - the tripwire
 * only ever skips a prune, so a false negative costs one retention cycle while a
 * false positive would cost disk.
 */
function collapseAgainst(
    previous: RunStats | null,
    current: RunStats | null,
): { previousFiles: number; files: number } | null {
    if (previous === null || current === null || previous.totalFiles <= 0) {
        return null;
    }
    if (current.totalFiles >= Math.ceil(previous.totalFiles * COLLAPSE_FRACTION)) {
        return null;
    }
    return { previousFiles: previous.totalFiles, files: current.totalFiles };
}

/**
 * A verify-pass itemize line that indicates a content or existence change:
 * transfers (`>`/`<`), creations/changes (`c`), hardlink changes (`h`), and
 * deletions (`*deleting`). Attribute-only lines start with `.` and pass.
 */
function isContentChangeLine(line: string): boolean {
    return /^[<>ch*]/.test(line);
}

/**
 * Run one target through the full pipeline and return its report - on every
 * path except live lock contention (`LockHeldError` is rethrown; the engine
 * aborts the invocation / the scheduler skips the tick). The caller persists
 * the report and feeds the backoff tracker.
 */
export async function runTarget(
    target: ResolvedTarget,
    deps: TargetRunnerDeps,
    options: TargetRunOptions = {},
): Promise<TargetRunReport> {
    const start = deps.now();
    const snapName = formatSnapshotName(start);
    const attempts: TransferAttempt[] = [];
    let snapshot: string | null = null;
    let stats: RunStats | null = null;
    let skippedFiles: string[] = [];
    let contentCollapse: TargetRunReport["contentCollapse"] = null;

    /** Assemble the final report from the pipeline outcome. */
    const report = (status: TargetRunReport["status"], reason: string | null, error: string | null): TargetRunReport => ({
        runId: runIdFor(start, target.name),
        target: target.name,
        direction: target.direction,
        snapshot,
        status,
        reason,
        startedAt: start.toISOString(),
        finishedAt: deps.now().toISOString(),
        attempts,
        stats,
        skippedFiles,
        error,
        contentCollapse,
    });

    try {
        return await deps.store.withLock(async () => {
            // Prepare (spec step 2): sweep .deleting artifacts and claim any surviving
            // partial under this run's name. Also guarantees the store root exists
            // before the estimate pass. Skipped on dry-run (no writes).
            let resumed = false;
            if (options.dryRun !== true) {
                resumed = (await deps.store.claimPartial(snapName)).resumed;
                if (resumed) {
                    deps.log.info("resuming partial snapshot", { snapshot: snapName });
                }
            }

            const complete = await deps.store.listComplete();
            const newest = complete.at(-1) ?? null;

            // Window dedup: a complete snapshot already in this schedule bucket = idempotent skip.
            if (options.force !== true && newest !== null) {
                const newestDate = parseSnapshotName(newest);
                if (newestDate !== null && windowIndex(target.schedule, newestDate) === windowIndex(target.schedule, start)) {
                    deps.log.info("snapshot already exists in the current schedule window - skipping", { newest });
                    return report("skipped", "window", null);
                }
            }

            // Clock-skew guard: the new name must sort strictly after the newest
            // complete name. It compares against EVERY complete name, including
            // future-dated ones: a name from the future is either a backwards
            // clock (in which case refusing is exactly right - the run would
            // otherwise write a snapshot that sorts before existing history) or
            // something a jailed writer planted, and the two are
            // indistinguishable from here. The escape hatch for the planted case
            // is `backupkit prune`, which CAN now delete a future-dated name (see
            // `newestUndeletable`); auto-ignoring it would mean auto-deleting real
            // snapshots on any machine whose clock jumps backwards.
            if (newest !== null && snapName <= newest) {
                const { future } = splitFutureSnapshots(complete, start);
                deps.log.error("clock skew: new snapshot name would not sort after the newest complete snapshot", {
                    newName: snapName,
                    newest,
                    hint:
                        future.length === 0
                            ? "check this host's clock"
                            : "check this host's clock; if it is correct these future-dated names are not ours - `backupkit prune` removes them",
                    futureDated: future.slice(0, 10).map(sanitize).join(", "),
                });
                return report("failed", "clock-skew", `new snapshot ${snapName} would sort <= newest complete ${newest}`);
            }

            const spec = specFor(target, snapName, newest, deps);

            // Every child in the pipeline - estimate, transfer, verify - gets the
            // engine's shutdown signal, so graceful stop SIGTERMs whichever rsync
            // is in flight (spec section 6: no pass may overrun TimeoutStopSec).
            const execWithSignal: ExecFn = (bin, args, execOptions) =>
                deps.execFn(bin, args, { ...execOptions, signal: options.signal });

            // Dry-run: estimate only - no claim, no transfer, no writes; retention planned, not executed.
            if (options.dryRun === true) {
                const estimated = await deps.estimate({ rsyncBin: deps.rsyncBin, spec, log: deps.log, env: deps.env, execFn: execWithSignal });
                stats = {
                    filesTransferred: 0,
                    bytesTransferred: 0,
                    totalFiles: estimated.totalFiles,
                    deltaBytes: estimated.totalTransferredSize,
                };
                if (target.retention !== null) {
                    const plan = planRetention(complete, target.retention, start);
                    deps.log.info("dry run: retention would prune", { count: plan.prune.length });
                }
                return report("success", "dry-run", null);
            }

            // Disk guard (skipped entirely when minFree is false).
            let estimatedDelta: number | null = null;
            if (target.minFree !== null) {
                const estimated = await deps.estimate({ rsyncBin: deps.rsyncBin, spec, log: deps.log, env: deps.env, execFn: execWithSignal });
                estimatedDelta = estimated.totalTransferredSize;
                const totalBytes = await deps.totalBytes();
                if (target.minFree.kind === "percent" && totalBytes === null) {
                    deps.log.warn("minFree percent floor cannot be computed for this store (unknown total size) - floor degraded to 0");
                }
                const decision = evaluateDiskGuard({
                    deltaBytes: estimatedDelta,
                    // The dry-run's transferred-file count = the files that need
                    // a NEW inode (unchanged files are hardlinked from
                    // --link-dest and need none).
                    newFiles: estimated.filesTransferred,
                    freeBytes: await deps.store.freeBytes(),
                    freeInodes: await deps.store.freeInodes(),
                    totalBytes,
                    minFree: target.minFree,
                });
                if (!decision.ok) {
                    if (!deps.diskLowTargets.has(target.name)) {
                        deps.diskLowTargets.add(target.name);
                        deps.log.error("disk low on archive filesystem - skipping run", {
                            requiredBytes: decision.requiredBytes,
                            freeBytes: decision.freeBytes,
                            floorBytes: decision.floorBytes,
                            requiredInodes: decision.requiredInodes ?? "unknown",
                            freeInodes: decision.freeInodes ?? "unknown",
                        });
                    }
                    const inodeShortfall =
                        decision.freeInodes !== null &&
                        decision.requiredInodes !== null &&
                        decision.freeInodes < decision.requiredInodes;
                    return report(
                        "skipped",
                        "disk-low",
                        inodeShortfall
                            ? `need ${decision.requiredInodes} free inodes, only ${decision.freeInodes} available`
                            : `need ${decision.requiredBytes} bytes plus a ${decision.floorBytes}-byte floor, only ${decision.freeBytes} free`,
                    );
                }
                if (deps.diskLowTargets.delete(target.name)) {
                    deps.log.info("disk space recovered - resuming runs");
                }
            }

            snapshot = snapName;

            // Transfer with the retry loop, aborting on the engine's shutdown signal.
            const result = await deps.transfer({
                rsyncBin: deps.rsyncBin,
                spec,
                retryAttempts: target.retry.attempts,
                log: deps.log,
                env: deps.env,
                signal: options.signal,
                execFn: execWithSignal,
                attemptLog: attempts,
            });
            skippedFiles = result.skippedFiles.slice(0, 100);
            stats =
                result.stats === null
                    ? null
                    : {
                          filesTransferred: result.stats.filesTransferred,
                          bytesTransferred: result.stats.totalTransferredSize,
                          totalFiles: result.stats.totalFiles,
                          deltaBytes: estimatedDelta ?? result.stats.totalTransferredSize,
                      };

            // Optional verify pass: --checksum dry-run against the partial; any content-change line fails loudly.
            if (target.rsync.verify) {
                const verifyResult = await execWithSignal(deps.rsyncBin, buildArgs(spec, "verify"), { env: deps.env });
                // Graceful shutdown during the verify pass is an abort, never a
                // verify failure: "aborted" does not enter failure backoff and the
                // partial stays for resume (spec section 6).
                if (options.signal?.aborted === true) {
                    deps.log.warn("run aborted", { snapshot: snapName });
                    return report("aborted", "aborted", "aborted during verify pass");
                }
                const changed = verifyResult.stdout
                    .split("\n")
                    .map((line) => line.trim())
                    .filter((line) => line !== "" && isContentChangeLine(line));
                const verifyOk = (verifyResult.exitCode === 0 || verifyResult.exitCode === 24) && changed.length === 0;
                if (!verifyOk) {
                    const sample = changed.slice(0, 20).map(sanitize).join(", ");
                    deps.log.error("verify pass failed - partial kept, not promoted", {
                        exitCode: verifyResult.exitCode ?? "signal",
                        changedLines: changed.length,
                    });
                    return report(
                        "failed",
                        "verify-failed",
                        `verify pass found differences (exit ${verifyResult.exitCode ?? "signal"})${sample === "" ? "" : `: ${sample}`}`,
                    );
                }
            }

            // Promote: atomic rename <name>.partial -> <name>.
            await deps.store.promote(snapName);
            deps.log.info("snapshot promoted", { snapshot: snapName, status: result.status });

            // Content-collapse tripwire (see COLLAPSE_FRACTION): a source that
            // presents an empty or selectively-emptied tree gets its snapshot
            // promoted (the data is already transferred and refusing to promote
            // would throw it away) but retention is NOT run, so the older
            // snapshots that still hold the real history cannot be aged out.
            const previous = await deps.previousStats();
            contentCollapse = collapseAgainst(previous, stats);
            if (contentCollapse !== null) {
                deps.log.error("content collapse: this snapshot holds far fewer files than the previous run - retention skipped", {
                    previousFiles: contentCollapse.previousFiles,
                    files: contentCollapse.files,
                    hint: "verify the source, then run `backupkit prune` once you are satisfied the shrink is real",
                });
            }

            // Retention after every successful promote. The floor against
            // deleting everything is NOT here: it is the store's newest-complete
            // guard (`newestUndeletable`) plus the tripwire above - planRetention
            // always claims a "newest", so a "keep is empty" check would be dead
            // code.
            let retentionError: string | null = null;
            if (target.retention !== null && contentCollapse === null) {
                try {
                    // Future-dated names get exactly the treatment
                    // `Backupkit.planFor` (the `prune` path) gives them, for the
                    // same reason: retention selects purely on names, so a name
                    // dated in the future occupies every bucket it touches and
                    // pushes the GENUINE snapshots into the prune list.
                    //
                    // The clock-skew guard above is NOT cover for this. It reads
                    // the listing BEFORE the transfer while retention re-reads it
                    // AFTER, and the party serving the transfer is exactly the
                    // party that can plant snapshot-shaped names inside that
                    // window with jail-legal `mkdir` commands - measured: ~46
                    // planted names took all 24 keep slots and put 30 of 31 real
                    // snapshots up for deletion.
                    //
                    // Policy, mirroring planFor: plan over the genuine names, and
                    // the planted ones lead the prune list - but only while
                    // genuine history exists, so a listing that is future-dated
                    // all the way down (a clock that stepped backwards mid-run
                    // makes real snapshots look future-dated) is kept untouched
                    // rather than auto-deleted (invariant 26).
                    const at = deps.now();
                    const { genuine, future } = splitFutureSnapshots(await deps.store.listComplete(), at);
                    const plan = planRetention(genuine, target.retention, at);
                    if (future.length > 0) {
                        deps.log.error("future-dated snapshot names appeared during this run - they are not ours; pruning them", {
                            count: future.length,
                            futureDated: future.slice(0, 10).map(sanitize).join(", "),
                            hint:
                                genuine.length === 0
                                    ? "every name is future-dated: keeping all of them - check this host's clock"
                                    : "check this host's clock; if it is correct the source planted these",
                        });
                    }
                    // Newest first, like every RetentionPlan: the future-dated
                    // names sort after everything genuine, so reversed they lead.
                    const prune = genuine.length === 0 ? [] : [...[...future].reverse(), ...plan.prune];
                    for (const name of [...prune].reverse()) {
                        await deps.store.remove(name);
                        deps.log.info("pruned snapshot", { snapshot: name });
                    }
                } catch (error) {
                    retentionError = `retention failed: ${sanitize(error instanceof Error ? error.message : String(error))}`;
                    deps.log.error(retentionError);
                }
            }

            return report(result.status, null, retentionError);
        });
    } catch (error) {
        if (isBackupkitError(error) && error.code === "lock-held") {
            throw error;
        }
        const message = sanitize(error instanceof Error ? error.message : String(error));
        if (options.signal?.aborted === true) {
            deps.log.warn("run aborted", { snapshot: snapName });
            return report("aborted", "aborted", message);
        }
        deps.log.error("run failed", { error: message });
        return report("failed", null, message);
    }
}
