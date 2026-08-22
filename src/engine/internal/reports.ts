/**
 * Run-report persistence and the backoff derivation (spec section 6/8): one
 * JSON per run at `<stateDir>/runs/<target>/<runId>.json`, written atomically
 * (tmp + rename, 0600), newest 50 kept per target. There is no state file -
 * backoff counters, `lastResult`, and restart recovery all derive from these
 * reports. A report that reads fine but is unparseable/wrong-shaped is renamed
 * aside to `.corrupt` and ignored (treat as absent, never block). A report that
 * cannot be READ (permission, transient I/O) is left untouched - a read failure
 * is not corruption, and renaming it would destroy valid history.
 */

import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { Logger } from "../../shared/logger.js";
import { formatSnapshotName } from "../../shared/snapshot-name.js";
import type { RunStats, RunStatus, TargetRunReport } from "../types.js";

/** Reports kept per target - an order of magnitude more than the backoff derivation consumes. */
export const REPORTS_KEPT = 50;

/** The valid report statuses, for shape-checking files read back from disk. */
const STATUSES: readonly RunStatus[] = ["success", "warning", "failed", "skipped", "aborted"];

/** The run id for a run started at `start`: `<formatSnapshotName(start)>_<target>` (the snapshot codec, reused). */
export function runIdFor(start: Date, target: string): string {
    return `${formatSnapshotName(start)}_${target}`;
}

/** The report directory for one target: `<stateDir>/runs/<target>`. */
export function reportDir(stateDir: string, target: string): string {
    return join(stateDir, "runs", target);
}

/**
 * Persist one target run report atomically: write `<runId>.json.tmp` (0600),
 * rename over the final name, then rotate the directory down to the newest
 * 50 reports (lexical order on the runId filename = chronological).
 */
export async function writeTargetReport(stateDir: string, report: TargetRunReport): Promise<void> {
    const dir = reportDir(stateDir, report.target);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const final = join(dir, `${report.runId}.json`);
    const tmp = `${final}.tmp`;
    await writeFile(tmp, JSON.stringify(report, null, 4) + "\n", { mode: 0o600 });
    await rename(tmp, final);
    // Both families rotate to the same depth. `.corrupt` files are kept for
    // forensics, but they are set aside by `readTargetReports` and nothing ever
    // removes them, so without their own pass a directory that keeps producing
    // unparseable reports grows without bound.
    const names = await readdir(dir);
    for (const suffix of [".json", ".json.corrupt"]) {
        const kept = names.filter((name) => name.endsWith(suffix)).sort();
        for (const stale of kept.slice(0, Math.max(0, kept.length - REPORTS_KEPT))) {
            await rm(join(dir, stale), { force: true });
        }
    }
}

/** Whether a parsed value has the TargetRunReport shape this module relies on. */
function isReportShaped(value: unknown): value is TargetRunReport {
    if (typeof value !== "object" || value === null) {
        return false;
    }
    const report = value as Partial<TargetRunReport>;
    return (
        typeof report.runId === "string" &&
        typeof report.target === "string" &&
        typeof report.startedAt === "string" &&
        typeof report.finishedAt === "string" &&
        STATUSES.includes(report.status as RunStatus)
    );
}

/**
 * Read a target's persisted reports, NEWEST FIRST (lexical on the runId
 * filename = chronological). An unparseable or wrong-shaped file is renamed
 * aside to `<file>.corrupt` with one warn and skipped - it degrades to
 * "treat as absent", never blocks. A missing directory is an empty history.
 */
export async function readTargetReports(stateDir: string, target: string, log: Logger): Promise<TargetRunReport[]> {
    const dir = reportDir(stateDir, target);
    let names: string[];
    try {
        names = await readdir(dir);
    } catch {
        return [];
    }
    const reports: TargetRunReport[] = [];
    for (const name of names.filter((entry) => entry.endsWith(".json")).sort().reverse()) {
        const path = join(dir, name);
        // Split READ failure from CORRUPTION. A failed read is NOT corruption:
        // a permission error (reports written by a root daemon, read by a
        // non-root `status`), a transient EMFILE/EIO, or a concurrent unlink.
        // The old code caught reads and parses in one catch and renamed the file
        // to `.corrupt` - so an unreadable-but-valid report was destroyed, and a
        // transient error could wipe EVERY report (history + backoff state).
        // Only rename aside when the file READ fine but is not a valid report.
        let text: string;
        try {
            text = await readFile(path, "utf8");
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
                log.warn("could not read run report - left in place, not treated as corrupt", { file: path });
            }
            continue;
        }
        let parsed: unknown;
        try {
            parsed = JSON.parse(text);
        } catch {
            parsed = null;
        }
        if (!isReportShaped(parsed)) {
            log.warn("skipping corrupt run report", { file: path });
            await rename(path, `${path}.corrupt`).catch(() => undefined);
            continue;
        }
        reports.push(parsed);
    }
    return reports;
}

/**
 * Stats of the newest TRUSTED run - the newest report that completed a transfer
 * AND did not itself trip the content-collapse tripwire (reports newest first,
 * as `readTargetReports` returns them), or null when no such run is on record.
 * The baseline the tripwire compares this run against.
 *
 * Skipping the collapsed reports is what makes the tripwire mean anything.
 * Taking the newest report with ANY stats made the wire disarm itself after
 * exactly one run: the collapsed run persists its own (tiny) stats, so the next
 * run compared empty against empty, saw no collapse, and pruned normally. A
 * source presenting an empty tree therefore lost one prune cycle and then aged
 * the real history out on schedule - the archive-destruction path invariant 27
 * exists to close, reopened by the baseline rather than by the comparison.
 * Measured before the fix: run 2 tripped and pruned nothing, run 3 deleted the
 * last two genuine snapshots, and by run 7 the archive was two empty snapshots.
 *
 * A sustained collapse therefore keeps retention off run after run, which is the
 * intended direction (a false trip costs disk, a missed trip is permanent) and
 * is bounded rather than permanent: reports rotate at REPORTS_KEPT, so
 * once every pre-collapse report has aged out this returns null, the wire stops
 * tripping, and scheduled retention resumes. `backupkit prune` remains the
 * operator's immediate override - it never consults the tripwire at all.
 */
export function newestStats(reports: readonly TargetRunReport[]): RunStats | null {
    for (const report of reports) {
        if (report.contentCollapse !== null && report.contentCollapse !== undefined) {
            continue;
        }
        if (report.stats !== null && report.stats !== undefined) {
            return report.stats;
        }
    }
    return null;
}

/** A known point in a target's history: how much of it existed, and up to which name. */
export interface HistoryMark {
    /** Newest complete snapshot name at that point. */
    newest: string;
    /** How many complete snapshots existed at that point. */
    count: number;
}

/**
 * The newest recorded history mark - the most recent report that recorded both
 * the snapshot it created and how many complete snapshots existed when it
 * finished - or null when no such run is on record (a first run, a fresh state
 * dir, or reports written before the field existed).
 *
 * Unlike `newestStats` this does NOT skip tripped runs: the count is a factual
 * observation of the archive, not a judgement about it, and a run that tripped a
 * tripwire still counted the snapshots correctly. Skipping them would let a
 * second plant hide behind the first.
 */
export function newestHistoryMark(reports: readonly TargetRunReport[]): HistoryMark | null {
    for (const report of reports) {
        if (typeof report.snapshot === "string" && typeof report.completeCount === "number") {
            return { newest: report.snapshot, count: report.completeCount };
        }
    }
    return null;
}

/**
 * The insertion detail when complete snapshots have APPEARED at or below the
 * previous run's newest name, else null. Null `mark` (no run on record) is
 * always null - there is nothing to compare against.
 *
 * This client only ever creates snapshots named for the current time, so the
 * number of names at or below a fixed past point can shrink as retention removes
 * them, or hold, but never grow. Growth means something else wrote into the
 * archive. It is the past-dated counterpart to `splitFutureSnapshots`, which
 * cannot see a plant whose timestamp the planter chose to put in the past.
 *
 * ONE owner, called by both the run pipeline and `prune`. The run path and the
 * prune path drifting apart is the single most repeated bug shape in this
 * codebase - a guard added where the bug was noticed and its sibling left open -
 * so the comparison lives here rather than inline at either call site.
 */
export function detectHistoryInsertion(
    complete: readonly string[],
    mark: HistoryMark | null,
): { previousNewest: string; previousCount: number; count: number } | null {
    if (mark === null) {
        return null;
    }
    const count = complete.filter((name) => name <= mark.newest).length;
    if (count <= mark.count) {
        return null;
    }
    return { previousNewest: mark.newest, previousCount: mark.count, count };
}

/**
 * Complete snapshot names at or below `mark.newest` that no run report claims -
 * the likely plants, for an operator to eyeball.
 *
 * BEST EFFORT, and it must be presented that way: reports rotate at
 * REPORTS_KEPT, so a genuine snapshot older than the report window is unattested
 * too. This narrows the operator's search; it is never grounds to delete
 * anything, which is why nothing acts on it.
 */
export function unattestedBelow(
    complete: readonly string[],
    reports: readonly TargetRunReport[],
    mark: HistoryMark,
): string[] {
    const attested = new Set(
        reports.map((report) => report.snapshot).filter((name): name is string => typeof name === "string"),
    );
    return complete.filter((name) => name <= mark.newest && !attested.has(name));
}

/** Backoff bookkeeping derived from one target's reports. */
export interface DerivedBackoff {
    /** Consecutive `failed` runs from the newest report, ignoring `aborted` and `skipped`, stopping at the first success/warning. */
    consecutiveFailures: number;
    /** `finishedAt` of the newest failed report (the backoff timer anchor), or null. */
    lastFailedAt: Date | null;
    /** Status of the newest report of any kind, or null when the target never ran. */
    lastResult: RunStatus | null;
    /** Newest snapshot recorded by a success/warning report, or null (always null for a mirror target). */
    lastSnapshot: string | null;
    /**
     * `startedAt` of the newest success/warning report, or null when the target
     * never completed a run. This is a MIRROR target's only record that its
     * schedule window was fulfilled - it writes no snapshot, so there is no
     * archive listing to ask. A snapshot target uses its listing instead (which
     * also sees snapshots this host did not create), so this is unused there.
     */
    lastSuccessAt: Date | null;
    /**
     * The `error` of the newest FAILED report, or null when there is none.
     *
     * The newest FAILED one specifically, not the newest of any kind: a
     * `skipped` run recorded after a failure must not hide the failure that is
     * still driving the backoff and still the reason nothing is being backed
     * up. `status` shows this, which is the difference between "failed 9" and
     * knowing what to go and fix.
     */
    lastError: string | null;
    /** `finishedAt` of that failed report, or null. */
    lastErrorAt: Date | null;
}

/**
 * Derive the backoff counters from a target's reports (newest first, as
 * `readTargetReports` returns them) - the disk-derived replacement for a
 * state file.
 */
export function deriveBackoff(reports: readonly TargetRunReport[]): DerivedBackoff {
    let consecutiveFailures = 0;
    let lastFailedAt: Date | null = null;
    let lastError: string | null = null;
    let lastSnapshot: string | null = null;
    let lastSuccessAt: Date | null = null;
    for (const report of reports) {
        if (report.status === "failed") {
            consecutiveFailures += 1;
            if (lastError === null) {
                const finished = new Date(report.finishedAt);
                lastFailedAt = Number.isNaN(finished.getTime()) ? null : finished;
                // A failed report with no message still marks the newest
                // failure, so the reason code stands in - never leave the
                // scan looking for an older, less relevant failure.
                lastError = report.error ?? report.reason ?? "no reason recorded";
            }
            continue;
        }
        // aborted and skipped never increment the count and never stop the scan.
        if (report.status !== "success" && report.status !== "warning") {
            continue;
        }
        // The newest COMPLETED run ends the scan: it stops the failure count and
        // answers both "last" fields, and nothing older can change either. A
        // mirror's reports carry no snapshot at all, so scanning on until one
        // turns up would walk the whole history on every call - and would answer
        // with a snapshot older than the newest completed run, which is exactly
        // the wrong record of where the archive stands.
        lastSnapshot = typeof report.snapshot === "string" ? report.snapshot : null;
        const started = new Date(report.startedAt);
        lastSuccessAt = Number.isNaN(started.getTime()) ? null : started;
        break;
    }
    return {
        consecutiveFailures,
        lastFailedAt,
        lastResult: reports[0]?.status ?? null,
        lastSnapshot,
        lastSuccessAt,
        lastError,
        lastErrorAt: lastError === null ? null : lastFailedAt,
    };
}
