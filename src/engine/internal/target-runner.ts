/**
 * The per-target run pipelines and a `TargetRunReport` on every path.
 *
 * `runTarget` is the SNAPSHOT pipeline (spec section 3): everything inside
 * `store.withLock` - sweep/claim the partial, window dedup, clock-skew guard,
 * disk guard, transfer with retries into `<name>.partial`, optional verify
 * pass, promote on 0/23/24, retention. `LockHeldError` is the one error that
 * escapes (engine policy: it aborts the invocation); everything else lands in
 * the report.
 *
 * `runMirror` is the MIRROR pipeline: window dedup, collapse guard, transfer
 * straight into `<destination>`, optional verify pass. It shares the argv
 * builder and the retry loop and nothing else - there is no snapshot store, so
 * no lock, no partial, no promote, and no retention. The two are separate
 * functions with separate dependency sets rather than one function with a mode
 * flag, so neither can be handed a seam the other needs and it does not.
 */

import { join, posix } from "node:path";

import type { ResolvedTarget } from "../../config/types.js";
import type { ExecOptions, ExecResult } from "../../exec/exec.js";
import { describeError, isBackupkitError, isTransientFailure } from "../../shared/errors.js";
import type { Logger } from "../../shared/logger.js";
import { sanitize } from "../../shared/sanitize.js";
import { formatBytes, formatDuration, formatEndpoint } from "../../shared/format.js";
import { formatSnapshotName, parseSnapshotName } from "../../shared/snapshot-name.js";
import { windowIndex } from "../../shared/time.js";
import type { Endpoint } from "../../shared/types.js";
import { buildArgs, type TransferSpec, type dryRunStats, type runTransfer, type TransferAttempt } from "../../rsync/rsync.js";
import { planRetention } from "../../retention/retention.js";
import type { SnapshotStore } from "../../snapshots/store.js";
import { splitFutureSnapshots } from "../../snapshots/types.js";
import { evaluateDiskGuard } from "./disk-guard.js";
import { detectHistoryInsertion, type HistoryMark, runIdFor } from "./reports.js";
import type { RunReason, RunStats, TargetRunReport } from "../types.js";

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
    /** Sticky disk-low state shared across runs, for one-log-per-transition semantics. */
    diskLowTargets: Set<string>;
    /**
     * Stats of this target's newest run that completed a transfer, or null when
     * there is no such run on record - the baseline for the content-collapse
     * tripwire. Called at most once per run, after the transfer.
     */
    previousStats: () => Promise<RunStats | null>;
    /**
     * How much history existed at this target's newest recorded run, or null
     * when there is no such run - the baseline for the past-dated-insertion
     * check. Called at most once per run, after the transfer.
     */
    previousHistory: () => Promise<HistoryMark | null>;
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

/** The `<destination>/<snapName>.partial` endpoint on the target's destination side. */
function partialEndpoint(target: ResolvedTarget, snapName: string): Endpoint {
    const leaf = `${snapName}.partial`;
    if (target.dst.kind === "local") {
        return { kind: "local", path: join(target.dst.path, leaf) };
    }
    return { kind: "remote", remote: target.dst.remote, path: posix.join(target.dst.path, leaf) };
}

/**
 * Build the TransferSpec for one run (argv is derived from it identically in
 * every mode). `dst` is the `<snap>.partial` endpoint for a snapshot run and
 * the destination root itself for a mirror run; `linkDestBase` is always null
 * for a mirror, which has no previous snapshot to hardlink against.
 */
function specFor(
    target: ResolvedTarget,
    dst: Endpoint,
    linkDestBase: string | null,
    sshTokens: string[],
): TransferSpec {
    return {
        src: target.src,
        dst,
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
        sshTokens,
        linkDestBase,
        // The receiver-uid decision: --fake-super when the receiving side is
        // THIS process and it is not root. ponytail: remote receivers (push)
        // get no --fake-super - the remote uid is unknowable here; the jail
        // account's own privileges decide what it can preserve.
        fakeSuper: target.dst.kind === "local" && (process.getuid?.() ?? 0) !== 0,
    };
}

/**
 * Content-collapse tripwire threshold: a run whose file count is below this
 * fraction of the previous run's is treated as a collapse.
 *
 * Why it exists: every transfer runs `--delete --force`, so a compromised source
 * that presents an empty (or selectively emptied) tree on each scheduled run
 * promotes empty snapshots, and retention - which selects purely on names and
 * counts - then ages the real history out bucket by bucket. That is the one way
 * a source can destroy its own archive despite the jail, and it contradicts the
 * README's promise that a compromised source cannot corrupt the archive.
 *
 * A MIRROR has no snapshot to fall back on, so the same threshold is applied
 * one step earlier there - to the pre-transfer estimate, refusing the run
 * outright - because "promote and skip retention" has no mirror equivalent: by
 * the time a mirror's transfer has run, the previous contents are already gone.
 * That is the same failure this wire exists for (a source that presents an empty
 * or emptied tree), reached by the shorter path: an unmounted volume, a
 * half-restored home directory, a compromised sender.
 *
 * ponytail: one flat halving, file count only, no per-target knob. rsync's
 * `--info=stats2` reports the transferred delta but never the tree's total size,
 * so bytes are not a usable signal here - the file count is. A halving is well
 * clear of normal churn; if a project legitimately halves its file count a
 * snapshot target loses one prune cycle (`backupkit prune` clears the backlog)
 * and a mirror target skips one run (`backupkit run --force <target>` performs
 * it, which is the operator confirming the shrink is real).
 */
const COLLAPSE_FRACTION = 0.5;

/**
 * The collapse detail when `current` holds fewer than COLLAPSE_FRACTION of
 * `previous`'s files - or when `current` could not be measured at all - else
 * null.
 *
 * The two missing-stats cases are NOT symmetric, and treating them as one was a
 * fail-open. No baseline (`previous === null`, a first run) genuinely means
 * "nothing to compare against", so retention proceeds. But no CURRENT stats,
 * with a baseline on record, means the wire cannot do its job - and the sibling
 * read-only path (`dryRunStats`) already throws on exactly that unparsable
 * output while this, the path that goes on to DELETE, silently scored it as
 * "no collapse" and pruned. A hostile source picks whether its rsync emits a
 * parsable stats block, so it also picked which branch ran.
 *
 * The direction is deliberate and one-way: an unnecessary trip costs disk (a
 * skipped prune), a missed trip costs the archive.
 */
function collapseAgainst(
    previous: RunStats | null,
    current: RunStats | null,
): { previousFiles: number; files: number | null } | null {
    if (previous === null || previous.totalFiles <= 0) {
        return null;
    }
    if (current === null) {
        return { previousFiles: previous.totalFiles, files: null };
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
 * The line each pipeline logs when it actually starts moving data - after the
 * window dedup and the guards, so a target that had nothing to do never
 * announces a backup it is not making. It names both ends because that is the
 * question a log reader has at 3am ("which machine was this pulling from?"),
 * and neither the target name nor the destination alone answers it.
 */
function startLine(target: ResolvedTarget, destination: string, options: TargetRunOptions): string {
    const verb = options.dryRun === true ? "dry run: checking" : "backing up";
    return `${verb} ${sanitize(formatEndpoint(target.src))} -> ${destination}`;
}

/** Everything one MIRROR run needs beyond the target itself - every seam injectable for tests. */
export interface MirrorRunnerDeps {
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
    /** The pre-transfer estimator (production: rsync/'s dryRunStats) - the collapse guard's only input. */
    estimate: typeof dryRunStats;
    /** Spawn function for the verify pass and forwarded into transfer/estimate. */
    execFn: ExecFn;
    /**
     * Stats of this target's newest run that completed a transfer, or null when
     * there is no such run on record - the baseline for the collapse guard.
     * Called at most once per run, BEFORE the transfer.
     */
    previousStats: () => Promise<RunStats | null>;
    /**
     * When this target last completed a run, or null when it never has - the
     * window-dedup input. A mirror writes no snapshot, so its run reports are
     * the only record that a schedule window was fulfilled.
     */
    lastRunAt: () => Promise<Date | null>;
}

/**
 * Run one MIRROR target: window dedup, pre-transfer estimate, collapse guard,
 * transfer straight into `<destination>`, optional verify pass. Returns a
 * report on every path; nothing escapes (there is no lock to contend for).
 *
 * What this pipeline deliberately does NOT have, and why: no lock (the store's
 * lock directory would live inside the mirrored tree, where `--delete` would
 * remove it), no `.partial` and no promote (the destination IS the tree - there
 * is nothing to promote it from), no retention (no history), and no disk guard
 * (a mirror frees roughly what it writes instead of adding a snapshot).
 *
 * What it keeps is the guard that matters here: every transfer runs `--delete
 * --force`, and a mirror cannot undo one, so the collapse check runs BEFORE the
 * transfer and refuses it. `--force` is the operator's override.
 */
export async function runMirror(
    target: ResolvedTarget,
    deps: MirrorRunnerDeps,
    options: TargetRunOptions = {},
): Promise<TargetRunReport> {
    const start = deps.now();
    const attempts: TransferAttempt[] = [];
    let stats: RunStats | null = null;
    let skippedFiles: string[] = [];
    let contentCollapse: TargetRunReport["contentCollapse"] = null;

    /** Assemble the final report. A mirror has no snapshot and no archive listing, so those fields stay null. */
    const report = (status: TargetRunReport["status"], reason: RunReason | null, error: string | null): TargetRunReport => ({
        runId: runIdFor(start, target.name),
        target: target.name,
        direction: target.direction,
        snapshot: null,
        status,
        reason,
        startedAt: start.toISOString(),
        finishedAt: deps.now().toISOString(),
        attempts,
        stats,
        skippedFiles,
        error,
        contentCollapse,
        historyInsertion: null,
        completeCount: null,
    });

    try {
        // Window dedup: this target already completed a run in the current
        // schedule bucket = idempotent skip. The snapshot pipeline asks the
        // archive listing; a mirror has none, so it asks its own run reports.
        if (options.force !== true) {
            const last = await deps.lastRunAt();
            if (last !== null && windowIndex(target.schedule, last) === windowIndex(target.schedule, start)) {
                deps.log.info("already backed up in this window - nothing to do", {
                    lastRunAt: last.toISOString(),
                });
                return report("skipped", "window", null);
            }
        }

        deps.log.info(startLine(target, sanitize(formatEndpoint(target.dst)), options));

        const spec = specFor(target, target.dst, null, deps.sshTokens);
        const execWithSignal: ExecFn = (bin, args, execOptions) =>
            deps.execFn(bin, args, { ...execOptions, signal: options.signal });

        // The estimate is NOT optional here the way the disk guard's is: it is
        // the collapse guard's only view of the source, and it is the last point
        // at which this run can still be refused.
        const estimated = await deps.estimate({
            rsyncBin: deps.rsyncBin,
            spec,
            log: deps.log,
            env: deps.env,
            execFn: execWithSignal,
        });
        stats = {
            filesTransferred: 0,
            bytesTransferred: 0,
            totalFiles: estimated.totalFiles,
            deltaBytes: estimated.totalTransferredSize,
        };

        if (options.force !== true) {
            contentCollapse = collapseAgainst(await deps.previousStats(), stats);
        }
        if (contentCollapse !== null) {
            deps.log.error(
                `the source has ${contentCollapse.files ?? "an unmeasurable number of"} files where the last run saw ` +
                    `${contentCollapse.previousFiles} - refusing to mirror`,
                {
                previousFiles: contentCollapse.previousFiles,
                files: contentCollapse.files ?? "unmeasured",
                destination: sanitize(target.destination),
                hint:
                    "check that the source is fully mounted and intact (a mirror deletes whatever the source no " +
                    "longer has, and cannot undo it), then run `backupkit run --force " +
                    `${target.name}\` to mirror it anyway`,
            });
            // A dry run reports the refusal rather than becoming one: it wrote
            // nothing either way, and "this is what a real run would do" is the
            // whole point of asking.
            return options.dryRun === true
                ? report("success", "dry-run", null)
                : report(
                      "failed",
                      "content-collapse",
                      `source holds ${contentCollapse.files ?? "an unmeasurable number of"} files against ` +
                          `${contentCollapse.previousFiles} at the last run - transfer refused`,
                  );
        }
        if (options.dryRun === true) {
            return report("success", "dry-run", null);
        }

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
                      deltaBytes: result.stats.totalTransferredSize,
                  };

        // Optional verify pass. Unlike the snapshot pipeline's, a failure here
        // cannot withhold anything - the destination is already updated - so it
        // is a loud failed report and nothing more.
        if (target.rsync.verify) {
            const verifyResult = await execWithSignal(deps.rsyncBin, buildArgs(spec, "verify"), { env: deps.env });
            if (options.signal?.aborted === true) {
                deps.log.warn("stopped before finishing - shutdown requested");
                return report("aborted", "aborted", "aborted during verify pass");
            }
            const changed = verifyResult.stdout
                .split("\n")
                .map((line) => line.trim())
                .filter((line) => line !== "" && isContentChangeLine(line));
            if ((verifyResult.exitCode !== 0 && verifyResult.exitCode !== 24) || changed.length > 0) {
                const sample = changed.slice(0, 20).map(sanitize).join(", ");
                deps.log.error(
                    `verification failed - ${changed.length} file${changed.length === 1 ? "" : "s"} in the copy do not match the source`,
                    { exitCode: verifyResult.exitCode ?? "signal", changedLines: changed.length },
                );
                return report(
                    "failed",
                    "verify-failed",
                    `verify pass found differences (exit ${verifyResult.exitCode ?? "signal"})${sample === "" ? "" : `: ${sample}`}`,
                );
            }
        }

        deps.log.info(
            `backup finished${result.status === "warning" ? " with warnings" : ""} in ${formatDuration(deps.now().getTime() - start.getTime())}` +
                ` - ${sanitize(target.destination)}${result.status === "warning" ? " updated" : " now mirrors the source"}`,
        );
        return report(result.status, null, null);
    } catch (error) {
        const message = describeError(error);
        if (options.signal?.aborted === true) {
            deps.log.warn("stopped before finishing - shutdown requested");
            return report("aborted", "aborted", message);
        }
        logRunFailure(deps, error, message, start);
        return report("failed", null, message);
    }
}

/**
 * The line a person reads when a backup did not finish - the most-read error
 * in the whole log, and until now the least informative: `backup failed` and
 * an error field.
 *
 * It carries two things that line did not. HOW LONG it ran, because five
 * seconds means it never got started and two hours means it nearly made it.
 * And WHAT HAPPENS NEXT, which is the question the reader actually has - the
 * level answers it on the same rule the scheduler uses: a transient failure
 * retries itself and is a warning, a permanent one needs a human and is an
 * error. The cause itself is already spelled out in `error` by the
 * classifiers, so this never restates it.
 */
function logRunFailure(
    deps: { log: Logger; now: () => Date },
    error: unknown,
    message: string,
    startedAt: Date,
): void {
    const transient = isTransientFailure(error);
    deps.log[transient ? "warn" : "error"](
        transient
            ? "backup did not finish (a temporary problem), will retry"
            : "backup FAILED and will not fix itself",
        { ranFor: formatDuration(deps.now().getTime() - startedAt.getTime()), error: message },
    );
}

/**
 * Run one SNAPSHOT target through the full pipeline and return its report - on
 * every path except live lock contention (`LockHeldError` is rethrown; the
 * engine aborts the invocation / the scheduler skips the tick). The caller
 * persists the report and feeds the backoff tracker.
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
    let historyInsertion: TargetRunReport["historyInsertion"] = null;
    let completeCount: number | null = null;

    /** Assemble the final report from the pipeline outcome. */
    const report = (status: TargetRunReport["status"], reason: RunReason | null, error: string | null): TargetRunReport => ({
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
        historyInsertion,
        completeCount,
    });

    try {
        const pipeline = async (): Promise<TargetRunReport> => {
            // Prepare (spec step 2): sweep .deleting artifacts and claim any surviving
            // partial under this run's name. Also guarantees the store root exists
            // before the estimate pass. Skipped on dry-run (no writes).
            let resumed = false;
            if (options.dryRun !== true) {
                resumed = (await deps.store.claimPartial(snapName)).resumed;
                if (resumed) {
                    deps.log.info(`resuming the last unfinished run (${snapName})`, { snapshot: snapName });
                }
            }

            const complete = await deps.store.listComplete();
            const newest = complete.at(-1) ?? null;

            // Window dedup: a complete snapshot already in this schedule bucket = idempotent skip.
            if (options.force !== true && newest !== null) {
                const newestDate = parseSnapshotName(newest);
                if (newestDate !== null && windowIndex(target.schedule, newestDate) === windowIndex(target.schedule, start)) {
                    deps.log.info("already backed up in this window - nothing to do", { newest });
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
                deps.log.error(
                    "this host's clock is behind the archive - refusing to file this backup before snapshots that already exist",
                    {
                        newName: snapName,
                        newest,
                        hint:
                            future.length === 0
                                ? "check this host's clock"
                                : "check this host's clock; if it is correct these future-dated names are not ours - `backupkit prune` removes them",
                        futureDated: future.slice(0, 10).map(sanitize).join(", "),
                    },
                );
                return report("failed", "clock-skew", `new snapshot ${snapName} would sort <= newest complete ${newest}`);
            }

            deps.log.info(startLine(target, `snapshot ${snapName}`, options));

            const spec = specFor(target, partialEndpoint(target, snapName), newest, deps.sshTokens);

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
                    deps.log.info(`dry run: retention would prune ${plan.prune.length} snapshot${plan.prune.length === 1 ? "" : "s"}`, {
                        count: plan.prune.length,
                    });
                }
                return report("success", "dry-run", null);
            }

            // Disk guard (skipped entirely when minFree is false).
            let estimatedDelta: number | null = null;
            if (target.minFree !== null) {
                const estimated = await deps.estimate({ rsyncBin: deps.rsyncBin, spec, log: deps.log, env: deps.env, execFn: execWithSignal });
                estimatedDelta = estimated.totalTransferredSize;
                // Through the STORE, like every other archive-filesystem fact
                // this pipeline reads: that is what puts it behind the shutdown
                // signal and the truncated-output refusal. The engine used to
                // ask the remote itself, so this one query - inside the lock -
                // was the one child a `systemctl stop` could not kill.
                const totalBytes = await deps.store.totalBytes();
                if (target.minFree.kind === "percent" && totalBytes === null) {
                    deps.log.warn("cannot read the filesystem size - ignoring the minFree percentage this run");
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
                        // The SENTENCE carries the numbers, in the units a
                        // person thinks in: `requiredBytes=12884901888` is a
                        // figure the reader has to divide by 1024 three times
                        // before it means "12 GiB". The raw counts stay as
                        // fields for the log file, where a machine reads them.
                        deps.log.error(
                            `not enough free disk space - needs ${formatBytes(decision.requiredBytes)} plus a ` +
                                `${formatBytes(decision.floorBytes)} floor, only ${formatBytes(decision.freeBytes)} free; skipping this run`,
                            {
                                requiredBytes: decision.requiredBytes,
                                freeBytes: decision.freeBytes,
                                floorBytes: decision.floorBytes,
                                requiredInodes: decision.requiredInodes ?? "unknown",
                                freeInodes: decision.freeInodes ?? "unknown",
                            },
                        );
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
                    deps.log.warn("stopped before finishing - shutdown requested", { snapshot: snapName });
                    return report("aborted", "aborted", "aborted during verify pass");
                }
                const changed = verifyResult.stdout
                    .split("\n")
                    .map((line) => line.trim())
                    .filter((line) => line !== "" && isContentChangeLine(line));
                const verifyOk = (verifyResult.exitCode === 0 || verifyResult.exitCode === 24) && changed.length === 0;
                if (!verifyOk) {
                    const sample = changed.slice(0, 20).map(sanitize).join(", ");
                    deps.log.error("verification failed - the unfinished snapshot was kept, not saved as a backup", {
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
            deps.log.info(
                `backup finished${result.status === "warning" ? " with warnings" : ""} in ${formatDuration(deps.now().getTime() - start.getTime())}` +
                    ` - saved as snapshot ${snapName}`,
            );

            // Content-collapse tripwire (see COLLAPSE_FRACTION): a source that
            // presents an empty or selectively-emptied tree gets its snapshot
            // promoted (the data is already transferred and refusing to promote
            // would throw it away) but retention is NOT run, so the older
            // snapshots that still hold the real history cannot be aged out.
            const previous = await deps.previousStats();
            contentCollapse = collapseAgainst(previous, stats);
            if (contentCollapse !== null) {
                deps.log.error(
                    contentCollapse.files === null
                        ? "could not measure this run's file count - retention skipped"
                        : `this snapshot has ${contentCollapse.files} files where the previous run had ` +
                          `${contentCollapse.previousFiles} - retention skipped`,
                    {
                        previousFiles: contentCollapse.previousFiles,
                        files: contentCollapse.files ?? "unmeasured",
                        hint: "verify the source, then run `backupkit prune` once you are satisfied the shrink is real",
                    },
                );
            }

            // The past-dated twin of the future-dated guard below. That guard
            // only separates names dated AHEAD of now - and the party planting
            // names picks the timestamp, so dating each plant one second after a
            // real snapshot put a planted name in every retention bucket while
            // `splitFutureSnapshots` reported nothing unusual at all. Measured:
            // 10 of 11 real snapshots went into the delete list, and
            // `newestUndeletable` ended up protecting a PLANTED name.
            //
            // Counting is what catches it, because this client only ever creates
            // snapshots named for the current time: the number of complete
            // snapshots at or below a fixed past point can shrink (retention) or
            // hold, never grow. Growth means names appeared underneath us.
            //
            // Treated exactly like a content collapse - promote, skip retention,
            // log loudly - because the safe direction is identical: an
            // unnecessary skip costs disk, a missed one costs the archive. An
            // operator restoring an old snapshot into the archive by hand trips
            // this too, and `backupkit prune` is their override.
            const completeNow = await deps.store.listComplete();
            completeCount = completeNow.length;
            historyInsertion = detectHistoryInsertion(completeNow, await deps.previousHistory());
            if (historyInsertion !== null) {
                deps.log.error("snapshots appeared below the previous run's newest - not ours; retention skipped", {
                    previousNewest: sanitize(historyInsertion.previousNewest),
                    previousCount: historyInsertion.previousCount,
                    count: historyInsertion.count,
                    hint: "review with `backupkit prune --dry-run` - the source may have planted snapshot-shaped directories",
                });
            }

            // Retention after every successful promote. The floor against
            // deleting everything is NOT here: it is the store's newest-complete
            // guard (`newestUndeletable`) plus the tripwires above - planRetention
            // always claims a "newest", so a "keep is empty" check would be dead
            // code.
            let retentionError: string | null = null;
            if (target.retention !== null && contentCollapse === null && historyInsertion === null) {
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
                    // The SAME listing the insertion check counted - re-listing
                    // here would reopen a window between the count and the plan
                    // for the very party the check exists to catch.
                    const at = deps.now();
                    const { genuine, future } = splitFutureSnapshots(completeNow, at);
                    const plan = planRetention(genuine, target.retention, at);
                    if (future.length > 0) {
                        deps.log.error(`${future.length} future-dated snapshot name${future.length === 1 ? "" : "s"} appeared - not ours; pruning them`, {
                            count: future.length,
                            futureDated: future.slice(0, 10).map(sanitize).join(", "),
                            hint:
                                genuine.length === 0
                                    ? "check this host's clock - every name is future-dated, so all of them are being kept"
                                    : "check this host's clock; if it is correct, the source planted these",
                        });
                    }
                    // Newest first, like every RetentionPlan: the future-dated
                    // names sort after everything genuine, so reversed they lead.
                    const prune = genuine.length === 0 ? [] : [...[...future].reverse(), ...plan.prune];
                    for (const name of [...prune].reverse()) {
                        await deps.store.remove(name);
                        deps.log.info(`pruned snapshot ${sanitize(name)}`, { snapshot: name });
                    }
                } catch (error) {
                    retentionError = `retention failed: ${describeError(error)}`;
                    deps.log.error(retentionError);
                }
            }

            return report(result.status, null, retentionError);
        };
        // A dry run writes NOTHING to the destination - no claimPartial, no
        // transfer, retention only planned - so it does NOT take the
        // destination lock. Locking it made an advisory, read-only estimate
        // fail outright against a real run in flight, and (worse) made the
        // estimate itself leave a lock behind: a remote lock has no pid to
        // check, so a dry run that was SIGKILLed before its `finally` blocked
        // the target for the full 24 h TTL, clearable only by hand ON THE
        // ARCHIVE HOST. The price is that a concurrent run may promote or
        // prune under the estimate, which can only make the estimate stale -
        // never the archive wrong.
        return options.dryRun === true ? await pipeline() : await deps.store.withLock(pipeline);
    } catch (error) {
        if (isBackupkitError(error) && error.code === "lock-held") {
            throw error;
        }
        const message = describeError(error);
        if (options.signal?.aborted === true) {
            deps.log.warn("stopped before finishing - shutdown requested", { snapshot: snapName });
            return report("aborted", "aborted", message);
        }
        logRunFailure(deps, error, message, start);
        return report("failed", null, message);
    }
}
