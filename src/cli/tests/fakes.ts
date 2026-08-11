/**
 * Shared CLI test fakes: a fully in-memory `CliDeps` (captured stdout/stderr,
 * recorded exec calls with scripted results, in-memory files, a structural
 * fake engine) plus a `ResolvedConfig` fixture reusing the engine suite's
 * builders. No test through these fakes spawns a real process or touches
 * /etc. Test-only - never imported by src code.
 */

import type { ResolvedConfig } from "../../config/types.js";
import type { ExecOptions, ExecResult } from "../../exec/exec.js";
import type {
    CheckReport,
    PruneReport,
    RestoreReport,
    RunReport,
    TargetRunReport,
    TargetStatus,
    TargetUnlockReport,
} from "../../engine/types.js";
import type { SnapshotInfo } from "../../snapshots/types.js";
import { makeConfig, makeExecResult, makeTarget } from "../../engine/tests/fakes.js";
import type { CliDeps, EngineLike } from "../internal/context.js";

export { makeConfig, makeExecResult, makeTarget };

/** One recorded exec call made through the fake deps. */
export interface RecordedCall {
    /** The spawned binary. */
    bin: string;
    /** The argv array. */
    args: string[];
    /** The exec options. */
    options: ExecOptions | undefined;
}

/** A structural fake engine whose every method returns a configurable result or throws a scripted error. */
export class FakeEngine implements EngineLike {
    /** Ordered method-call log (method names, with option snapshots for assertions). */
    calls: { method: string; options: unknown }[] = [];

    /** When set, every method throws this instead of returning. */
    failure: Error | null = null;

    /** Result of run(). */
    runReport: RunReport = { startedAt: "2026-08-10T00:00:00.000Z", finishedAt: "2026-08-10T00:01:00.000Z", targets: [] };

    /** Result of status(). */
    statusRows: TargetStatus[] = [];

    /** Result of listSnapshots(). */
    snapshots: SnapshotInfo[] = [];

    /** Result of restore(). */
    restoreReport: RestoreReport = { target: "web", snapshot: "2026-08-10T031500Z", output: "/tmp/out", verified: false };

    /** Result of prune(). */
    pruneReport: PruneReport = { targets: [] };

    /** Result of unlock(). */
    unlockRows: TargetUnlockReport[] = [];

    /** Result of check(). */
    checkReport: CheckReport = { ok: true, localRsync: { bin: "/usr/bin/rsync", version: "3.2.7" }, sshOk: true, remotes: [], jailLines: [], encryptedKeys: [], errors: [] };

    /** Record a call and either throw the scripted failure or return the given value. */
    private answer<T>(method: string, options: unknown, value: T): Promise<T> {
        this.calls.push({ method, options });
        if (this.failure !== null) {
            return Promise.reject(this.failure);
        }
        return Promise.resolve(value);
    }

    /** Fake preflight (records the serviceMode options the command passed). */
    preflight(options?: { serviceMode?: boolean }): Promise<void> {
        return this.answer("preflight", options, undefined);
    }

    /** When set, ONLY run() rejects with this - a failing pass on an otherwise healthy engine. */
    runFailure: Error | null = null;

    /** Fake run. */
    run(options?: { targets?: string[]; force?: boolean; dryRun?: boolean }): Promise<RunReport> {
        if (this.runFailure !== null) {
            this.calls.push({ method: "run", options });
            return Promise.reject(this.runFailure);
        }
        return this.answer("run", options, this.runReport);
    }

    /** Fake start. */
    start(): Promise<void> {
        return this.answer("start", undefined, undefined);
    }

    /** Fake stop. */
    stop(): Promise<void> {
        return this.answer("stop", undefined, undefined);
    }

    /** Fake status. */
    status(options?: { targets?: string[] }): Promise<TargetStatus[]> {
        return this.answer("status", options, this.statusRows);
    }

    /** Fake listSnapshots. */
    listSnapshots(options?: { targets?: string[] }): Promise<SnapshotInfo[]> {
        return this.answer("listSnapshots", options, this.snapshots);
    }

    /** Fake restore. */
    restore(options: { target: string; snapshot: string; output: string; verify?: boolean }): Promise<RestoreReport> {
        return this.answer("restore", options, this.restoreReport);
    }

    /** Fake prune. */
    prune(options?: { targets?: string[]; dryRun?: boolean }): Promise<PruneReport> {
        return this.answer("prune", options, this.pruneReport);
    }

    /** Fake unlock. */
    unlock(options?: { targets?: string[]; force?: boolean }): Promise<TargetUnlockReport[]> {
        return this.answer("unlock", options, this.unlockRows);
    }

    /** Fake check. */
    check(): Promise<CheckReport> {
        return this.answer("check", undefined, this.checkReport);
    }
}

/** The in-memory test harness around one `CliDeps` instance. */
export interface FakeDeps {
    /** The deps object to pass into commands / main. */
    deps: CliDeps;
    /** Captured stdout lines. */
    out: string[];
    /** Captured stderr lines. */
    err: string[];
    /** Every exec call made. */
    execCalls: RecordedCall[];
    /** In-memory filesystem (path -> content). */
    fileMap: Map<string, string>;
    /** The fake engine handed out by loadContext. */
    engine: FakeEngine;
    /** The config handed out by loadContext. */
    config: ResolvedConfig;
    /** Every stop callback registered through wireSignals. */
    stops: (() => Promise<void>)[];
    /** config args passed to loadContext, in order (undefined entries preserved). */
    loadedWith: (string | undefined)[];
    /** Every directory creation requested through `files.mkdir`, in order. */
    mkdirs: { path: string; mode: number | undefined }[];
    /** Every mode change requested through `files.chmod`, in order. */
    chmods: { path: string; mode: number }[];
    /** Every rename requested through `files.rename`, in order. */
    renames: { from: string; to: string }[];
}

/** Options for `fakeDeps`. */
export interface FakeDepsOptions {
    /** Platform discriminator. Default "linux". */
    platform?: string;
    /** Effective uid. Default 0 (root - most service tests need it). */
    euid?: number | null;
    /** Config fixture override. */
    config?: ResolvedConfig;
    /** Environment. Default {}. */
    env?: Record<string, string | undefined>;
    /** Scripted exec results by `bin arg0 arg1...` prefix match; first match wins. Default: exit 0, empty output. */
    execResults?: { match: (bin: string, args: string[]) => boolean; result: ExecResult }[];
    /** When set, loadContext throws this (config-error simulation). */
    loadFailure?: Error;
    /** Pre-existing in-memory files (path -> content). */
    files?: Record<string, string>;
}

/** Build a fully in-memory CliDeps harness. */
export function fakeDeps(options: FakeDepsOptions = {}): FakeDeps {
    const out: string[] = [];
    const err: string[] = [];
    const execCalls: RecordedCall[] = [];
    const fileMap = new Map<string, string>(Object.entries(options.files ?? {}));
    const engine = new FakeEngine();
    const config =
        options.config ?? makeConfig({ configPath: "/etc/backupkit/config.jsonc", stateDir: "/var/lib/backupkit", targets: [makeTarget()] });
    const stops: (() => Promise<void>)[] = [];
    const loadedWith: (string | undefined)[] = [];
    const mkdirs: { path: string; mode: number | undefined }[] = [];
    const chmods: { path: string; mode: number }[] = [];
    const renames: { from: string; to: string }[] = [];
    const deps: CliDeps = {
        stdout: (line) => out.push(line),
        stderr: (line) => err.push(line),
        platform: options.platform ?? "linux",
        euid: options.euid !== undefined ? options.euid : 0,
        env: options.env ?? {},
        execFn: async (bin, args, execOptions) => {
            execCalls.push({ bin, args: [...args], options: execOptions });
            const scripted = options.execResults?.find((entry) => entry.match(bin, [...args]));
            return scripted?.result ?? makeExecResult();
        },
        files: {
            exists: (path) => fileMap.has(path),
            read: (path) => {
                const content = fileMap.get(path);
                if (content === undefined) {
                    throw new Error(`ENOENT: ${path}`);
                }
                return content;
            },
            write: (path, content) => {
                fileMap.set(path, content);
            },
            remove: (path) => {
                fileMap.delete(path);
            },
            mkdir: (path, mode) => {
                mkdirs.push({ path, mode });
            },
            chmod: (path, mode) => {
                chmods.push({ path, mode });
            },
            rename: (from, to) => {
                const content = fileMap.get(from);
                if (content === undefined) {
                    throw new Error(`ENOENT: ${from}`);
                }
                fileMap.delete(from);
                fileMap.set(to, content);
                renames.push({ from, to });
            },
        },
        nodeBin: "/usr/bin/node",
        cliPath: "/opt/backupkit/dist/cli/main.js",
        version: "0.1.0-test",
        debugEnabled: false,
        loadContext: (configArg) => {
            loadedWith.push(configArg);
            if (options.loadFailure !== undefined) {
                throw options.loadFailure;
            }
            return { config, engine };
        },
        wireSignals: (stop) => {
            stops.push(stop);
        },
    };
    return { deps, out, err, execCalls, fileMap, engine, config, stops, loadedWith, mkdirs, chmods, renames };
}

/** A minimal TargetRunReport fixture. */
export function makeRunReport(overrides: Partial<TargetRunReport> = {}): TargetRunReport {
    return {
        runId: "2026-08-10T031500Z_web",
        target: "web",
        direction: "pull",
        snapshot: "2026-08-10T031500Z",
        status: "success",
        reason: null,
        startedAt: "2026-08-10T03:15:00.000Z",
        finishedAt: "2026-08-10T03:16:00.000Z",
        attempts: [],
        stats: null,
        skippedFiles: [],
        error: null,
        ...overrides,
    };
}
