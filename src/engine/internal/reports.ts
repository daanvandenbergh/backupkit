/**
 * Run-report persistence and the backoff derivation (spec section 6/8): one
 * JSON per run at `<stateDir>/runs/<target>/<runId>.json`, written atomically
 * (tmp + rename, 0600), newest 50 kept per target. There is no state file -
 * backoff counters, `lastResult`, and restart recovery all derive from these
 * reports. A corrupt report file is renamed aside and ignored (treat as
 * absent, never block).
 */

import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { Logger } from "../../shared/logger.js";
import { formatSnapshotName } from "../../shared/snapshot-name.js";
import type { RunStatus, TargetRunReport } from "../types.js";

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
        let parsed: unknown;
        try {
            parsed = JSON.parse(await readFile(path, "utf8"));
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

/** Backoff bookkeeping derived from one target's reports. */
export interface DerivedBackoff {
    /** Consecutive `failed` runs from the newest report, ignoring `aborted` and `skipped`, stopping at the first success/warning. */
    consecutiveFailures: number;
    /** `finishedAt` of the newest failed report (the backoff timer anchor), or null. */
    lastFailedAt: Date | null;
    /** Status of the newest report of any kind, or null when the target never ran. */
    lastResult: RunStatus | null;
    /** Newest snapshot recorded by a success/warning report, or null. */
    lastSnapshot: string | null;
}

/**
 * Derive the backoff counters from a target's reports (newest first, as
 * `readTargetReports` returns them) - the disk-derived replacement for a
 * state file.
 */
export function deriveBackoff(reports: readonly TargetRunReport[]): DerivedBackoff {
    let consecutiveFailures = 0;
    let lastFailedAt: Date | null = null;
    let lastSnapshot: string | null = null;
    let counting = true;
    for (const report of reports) {
        if (counting) {
            if (report.status === "failed") {
                consecutiveFailures += 1;
                if (lastFailedAt === null) {
                    const finished = new Date(report.finishedAt);
                    lastFailedAt = Number.isNaN(finished.getTime()) ? null : finished;
                }
            } else if (report.status === "success" || report.status === "warning") {
                counting = false;
            }
            // aborted and skipped never increment and never stop the count.
        }
        if (
            lastSnapshot === null &&
            (report.status === "success" || report.status === "warning") &&
            typeof report.snapshot === "string"
        ) {
            lastSnapshot = report.snapshot;
        }
        if (!counting && lastSnapshot !== null) {
            break;
        }
    }
    return {
        consecutiveFailures,
        lastFailedAt,
        lastResult: reports[0]?.status ?? null,
        lastSnapshot,
    };
}
