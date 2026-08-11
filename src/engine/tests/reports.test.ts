/**
 * Run-report persistence tests: runId format, atomic 0600 writes, rotation to
 * the newest 50, corrupt-file quarantine, and the backoff derivation tables.
 */

import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
    deriveBackoff,
    newestStats,
    readTargetReports,
    reportDir,
    REPORTS_KEPT,
    runIdFor,
    writeTargetReport,
} from "../internal/reports.js";
import type { RunStatus, TargetRunReport } from "../types.js";
import { captureLogger } from "./fakes.js";

/** A minimal valid report fixture. */
function makeReport(overrides: Partial<TargetRunReport> = {}): TargetRunReport {
    return {
        runId: "2026-08-10T120000Z_web",
        target: "web",
        direction: "pull",
        snapshot: "2026-08-10T120000Z",
        status: "success",
        reason: null,
        startedAt: "2026-08-10T12:00:00.000Z",
        finishedAt: "2026-08-10T12:00:41.000Z",
        attempts: [{ exitCode: 0, class: "ok", durationMs: 41_000, stderrTail: "" }],
        stats: { filesTransferred: 812, bytesTransferred: 10_485_760, totalFiles: 120_433, deltaBytes: 10_485_760 },
        skippedFiles: [],
        error: null,
        ...overrides,
    };
}

/** A report list entry for the derivation tables (newest first). */
function seq(status: RunStatus, finishedAt = "2026-08-10T12:00:41.000Z", snapshot: string | null = null): TargetRunReport {
    return makeReport({ status, finishedAt, snapshot });
}

describe("runIdFor", () => {
    it("reuses the snapshot codec: <name>_<target>", () => {
        expect(runIdFor(new Date("2026-08-10T03:15:00.500Z"), "web1-var-www")).toBe("2026-08-10T031500Z_web1-var-www");
    });
});

describe("report persistence", () => {
    let stateDir = "";
    const { log } = captureLogger("error");

    beforeEach(async () => {
        stateDir = await mkdtemp(join(tmpdir(), "backupkit-reports-"));
    });

    afterEach(async () => {
        await rm(stateDir, { recursive: true, force: true });
    });

    it("writes <stateDir>/runs/<target>/<runId>.json atomically at 0600 and reads it back", async () => {
        const report = makeReport();
        await writeTargetReport(stateDir, report);
        const file = join(reportDir(stateDir, "web"), "2026-08-10T120000Z_web.json");
        const info = await stat(file);
        expect(info.mode & 0o777).toBe(0o600);
        expect(JSON.parse(await readFile(file, "utf8"))).toEqual(report);
        // No tmp file left behind.
        expect((await readdir(reportDir(stateDir, "web"))).filter((name) => name.endsWith(".tmp"))).toEqual([]);
        const read = await readTargetReports(stateDir, "web", log);
        expect(read).toEqual([report]);
    });

    it("keeps only the newest 50 reports per target", async () => {
        for (let i = 0; i < REPORTS_KEPT + 5; i += 1) {
            const start = new Date(Date.UTC(2026, 0, 1, 0, i, 0));
            await writeTargetReport(stateDir, makeReport({ runId: runIdFor(start, "web") }));
        }
        const names = (await readdir(reportDir(stateDir, "web"))).sort();
        expect(names).toHaveLength(REPORTS_KEPT);
        // The oldest five rotated out.
        expect(names[0]).toBe("2026-01-01T000500Z_web.json");
    });

    it("returns newest first", async () => {
        await writeTargetReport(stateDir, makeReport({ runId: "2026-08-09T000000Z_web", snapshot: "old" }));
        await writeTargetReport(stateDir, makeReport({ runId: "2026-08-10T000000Z_web", snapshot: "new" }));
        const read = await readTargetReports(stateDir, "web", log);
        expect(read.map((r) => r.runId)).toEqual(["2026-08-10T000000Z_web", "2026-08-09T000000Z_web"]);
    });

    it("renames a corrupt report aside and skips it with a warn", async () => {
        const { log: warnLog, lines } = captureLogger("warn");
        await writeTargetReport(stateDir, makeReport());
        const bad = join(reportDir(stateDir, "web"), "2026-08-11T000000Z_web.json");
        await writeFile(bad, "{ not json", { mode: 0o600 });
        const read = await readTargetReports(stateDir, "web", warnLog);
        expect(read).toHaveLength(1);
        expect(read[0].runId).toBe("2026-08-10T120000Z_web");
        expect(lines.some((line) => line.includes("corrupt run report"))).toBe(true);
        const names = await readdir(reportDir(stateDir, "web"));
        expect(names).toContain("2026-08-11T000000Z_web.json.corrupt");
        expect(names).not.toContain("2026-08-11T000000Z_web.json");
    });

    it("leaves an UNREADABLE report in place - a read failure is not corruption, never renamed", async () => {
        // A directory at the .json path forces readFile to fail with EISDIR - a
        // read error (like the EACCES a non-root `status` hits on a root daemon's
        // 0600 reports), reproducible on every platform and uid, unlike chmod 000
        // which root ignores. It must NOT be renamed to .corrupt or valid history
        // is destroyed (and a transient error could wipe every report at once).
        const { log: warnLog, lines } = captureLogger("warn");
        await writeTargetReport(stateDir, makeReport());
        const unreadable = join(reportDir(stateDir, "web"), "2026-08-11T000000Z_web.json");
        await mkdir(unreadable);
        const read = await readTargetReports(stateDir, "web", warnLog);
        expect(read).toHaveLength(1); // the valid report still read
        const names = await readdir(reportDir(stateDir, "web"));
        expect(names).toContain("2026-08-11T000000Z_web.json"); // NOT renamed aside
        expect(names).not.toContain("2026-08-11T000000Z_web.json.corrupt");
        expect(lines.some((line) => line.includes("could not read run report"))).toBe(true);
        expect(lines.some((line) => line.includes("corrupt run report"))).toBe(false);
    });

    it("skips a wrong-shaped report file (valid JSON, missing fields)", async () => {
        const bad = join(reportDir(stateDir, "web"), "2026-08-11T000000Z_web.json");
        await writeTargetReport(stateDir, makeReport());
        await writeFile(bad, JSON.stringify({ status: "not-a-status" }), { mode: 0o600 });
        const read = await readTargetReports(stateDir, "web", log);
        expect(read).toHaveLength(1);
    });

    it("a missing report directory is an empty history", async () => {
        expect(await readTargetReports(stateDir, "nope", log)).toEqual([]);
    });
});

describe("deriveBackoff", () => {
    it.each([
        { label: "empty history", reports: [], failures: 0, lastResult: null },
        { label: "single success", reports: [seq("success")], failures: 0, lastResult: "success" },
        { label: "single failure", reports: [seq("failed")], failures: 1, lastResult: "failed" },
        { label: "two failures", reports: [seq("failed"), seq("failed")], failures: 2, lastResult: "failed" },
        { label: "warning clears", reports: [seq("warning"), seq("failed")], failures: 0, lastResult: "warning" },
        { label: "skipped ignored", reports: [seq("skipped"), seq("failed")], failures: 1, lastResult: "skipped" },
        { label: "aborted ignored", reports: [seq("aborted"), seq("failed"), seq("failed")], failures: 2, lastResult: "aborted" },
        { label: "stops at success", reports: [seq("failed"), seq("success"), seq("failed")], failures: 1, lastResult: "failed" },
    ] as const)("$label", ({ reports, failures, lastResult }) => {
        const derived = deriveBackoff([...reports]);
        expect(derived.consecutiveFailures).toBe(failures);
        expect(derived.lastResult).toBe(lastResult);
    });

    it("anchors the timer at the NEWEST failed report's finishedAt", () => {
        const derived = deriveBackoff([
            seq("failed", "2026-08-10T12:00:00.000Z"),
            seq("failed", "2026-08-10T11:00:00.000Z"),
        ]);
        expect(derived.lastFailedAt?.toISOString()).toBe("2026-08-10T12:00:00.000Z");
    });

    it("surfaces the newest snapshot recorded by a success/warning report", () => {
        const derived = deriveBackoff([
            seq("failed", "2026-08-10T12:00:00.000Z"),
            seq("success", "2026-08-10T11:00:00.000Z", "2026-08-10T110000Z"),
            seq("success", "2026-08-09T11:00:00.000Z", "2026-08-09T110000Z"),
        ]);
        expect(derived.lastSnapshot).toBe("2026-08-10T110000Z");
    });
});

describe("newestStats - the content-collapse baseline", () => {
    /** A report that completed a transfer with `totalFiles` files. */
    function withFiles(totalFiles: number, overrides: Partial<TargetRunReport> = {}): TargetRunReport {
        return makeReport({
            stats: { filesTransferred: 1, bytesTransferred: 1, totalFiles, deltaBytes: 1 },
            ...overrides,
        });
    }

    it("never takes a run that TRIPPED the wire as the baseline (the wire must not disarm itself)", () => {
        // Reports are newest first. The newest one is the collapsed run: it
        // persists its own tiny stats, so taking "the newest report with any
        // stats" made the next run compare 0 against 0, see no collapse, and
        // prune the real history away one interval later.
        const stats = newestStats([
            withFiles(0, { contentCollapse: { previousFiles: 120_433, files: 0 } }),
            withFiles(120_433),
        ]);

        expect(stats?.totalFiles).toBe(120_433);
    });

    it("skips EVERY consecutive collapsed run, so a sustained collapse never becomes normal", () => {
        const stats = newestStats([
            withFiles(0, { contentCollapse: { previousFiles: 120_433, files: 0 } }),
            withFiles(0, { contentCollapse: { previousFiles: 120_433, files: 0 } }),
            withFiles(3, { contentCollapse: { previousFiles: 120_433, files: 3 } }),
            withFiles(120_433),
        ]);

        expect(stats?.totalFiles).toBe(120_433);
    });

    it("also skips a run whose file count could not be measured at all", () => {
        const stats = newestStats([
            withFiles(0, { contentCollapse: { previousFiles: 120_433, files: null } }),
            withFiles(120_433),
        ]);

        expect(stats?.totalFiles).toBe(120_433);
    });

    it("returns null once every pre-collapse report has rotated away, so retention can resume", () => {
        // The bound on "retention stays off": reports rotate at REPORTS_KEPT, so
        // a sustained collapse stops tripping after the last trusted run ages
        // out rather than pausing retention forever.
        const stats = newestStats([
            withFiles(0, { contentCollapse: { previousFiles: 120_433, files: 0 } }),
            withFiles(0, { contentCollapse: { previousFiles: 120_433, files: 0 } }),
        ]);

        expect(stats).toBeNull();
    });

    it("ignores reports that completed no transfer, and takes the newest trusted one", () => {
        const stats = newestStats([
            makeReport({ status: "failed", stats: null }),
            withFiles(120_433),
            withFiles(99),
        ]);

        expect(stats?.totalFiles).toBe(120_433);
    });
});
