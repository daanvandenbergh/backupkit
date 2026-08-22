/**
 * Shared test fakes for the engine suite: an in-memory `SnapshotStore`, a
 * capture logger, fixture builders for `ResolvedTarget`/`ResolvedConfig`, and
 * fake transfer/estimate functions. Test-only - never imported by src code.
 */

import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { LockHeldError } from "../../shared/errors.js";
import { Logger } from "../../shared/logger.js";
import type { ResolvedConfig, ResolvedTarget } from "../../config/types.js";
import type { ExecOptions, ExecResult } from "../../exec/exec.js";
import type { RsyncStats, TransferAttempt, TransferResult } from "../../rsync/rsync.js";
import type { UnlockOutcome } from "../../snapshots/internal/lock.js";
import type { SnapshotStore } from "../../snapshots/store.js";
import { newestUndeletable } from "../../snapshots/types.js";
import { Backupkit, type BackupkitDeps } from "../backupkit.js";

/** A logger writing into an in-memory line buffer, for asserting log output. */
export function captureLogger(level: "error" | "warn" | "info" | "debug" = "debug"): { log: Logger; lines: string[] } {
    const lines: string[] = [];
    const stream = {
        write(chunk: string): void {
            lines.push(chunk.trimEnd());
        },
    };
    return { log: new Logger({ level, stdout: stream, stderr: stream }), lines };
}

/** In-memory SnapshotStore recording every call, for pipeline state-machine tests. */
export class FakeStore implements SnapshotStore {
    /** Complete snapshot names. */
    names: string[] = [];

    /** Partial entries (full names incl. the .partial suffix). */
    partials: string[] = [];

    /** .deleting entries (full names incl. the suffix). */
    deleting: string[] = [];

    /** Free bytes reported by freeBytes(). */
    free = Number.MAX_SAFE_INTEGER;

    /** Free inodes reported by freeInodes() (null = this store cannot report them). */
    freeInodeCount: number | null = null;

    /** Ordered call log: "listComplete", "claimPartial:<n>", "promote:<n>", "remove:<n>", "freeBytes", "lock", "unlock". */
    calls: string[] = [];

    /** True while withLock's fn runs. */
    locked = false;

    /** When set, withLock throws this instead of running fn (live contention). */
    failLock: LockHeldError | null = null;

    /** What unlock() reports. */
    unlockOutcome: UnlockOutcome = { status: "none" };

    /** Clock behind the newest-complete deletion floor (the real stores take one too). */
    now: () => Date = () => new Date();

    /** Complete names, sorted ascending. */
    async listComplete(): Promise<string[]> {
        this.calls.push("listComplete");
        return [...this.names].sort();
    }

    /** Sweep .deleting, keep the newest partial renamed to <newName>.partial. */
    async claimPartial(newName: string): Promise<{ resumed: boolean }> {
        this.calls.push(`claimPartial:${newName}`);
        this.deleting = [];
        const sorted = [...this.partials].sort();
        const keep = sorted.at(-1);
        this.partials = keep === undefined ? [] : [`${newName}.partial`];
        return { resumed: keep !== undefined };
    }

    /** Move <name>.partial into the complete set. */
    async promote(name: string): Promise<void> {
        this.calls.push(`promote:${name}`);
        if (!this.partials.includes(`${name}.partial`)) {
            // The pipeline's fake transfer "creates" the partial; register it implicitly.
            this.partials = [];
        } else {
            this.partials = this.partials.filter((entry) => entry !== `${name}.partial`);
        }
        this.names.push(name);
    }

    /**
     * Delete a complete snapshot, refusing the newest - where "newest" is what
     * both real stores mean by it: the newest GENUINELY dated name
     * (`newestUndeletable`), so a future-dated name a jailed writer planted is
     * deletable while real history exists.
     */
    async remove(name: string): Promise<void> {
        this.calls.push(`remove:${name}`);
        const sorted = [...this.names].sort();
        if (newestUndeletable(sorted, this.now()) === name) {
            throw new Error(`refusing to delete the newest complete snapshot ${name}`);
        }
        this.names = this.names.filter((entry) => entry !== name);
    }

    /** The configured free-byte count. */
    async freeBytes(): Promise<number> {
        this.calls.push("freeBytes");
        return this.free;
    }

    /** The configured free-inode count (null by default, like the remote store). */
    async freeInodes(): Promise<number | null> {
        this.calls.push("freeInodes");
        return this.freeInodeCount;
    }

    /** Fake unlock: reports what `unlockOutcome` says and records the force flag. */
    async unlock(force: boolean): Promise<UnlockOutcome> {
        this.calls.push(`unlock:${force}`);
        return this.unlockOutcome;
    }

    /** Scope-shaped lock recording acquire/release; throws failLock when set. */
    async withLock<T>(fn: () => Promise<T>): Promise<T> {
        if (this.failLock !== null) {
            throw this.failLock;
        }
        this.calls.push("lock");
        this.locked = true;
        try {
            return await fn();
        } finally {
            this.locked = false;
            this.calls.push("unlock");
        }
    }
}

/** A ResolvedTarget fixture with sane local-to-local defaults, deep-overridable. */
export function makeTarget(overrides: Partial<ResolvedTarget> = {}): ResolvedTarget {
    return {
        name: "web",
        mode: "snapshot",
        direction: "pull",
        remoteName: "example",
        remoteRef: { kind: "alias", restrictedShell: false, name: "example", alias: "example" },
        source: "/data/src",
        destination: "/data/archive",
        exclude: [],
        schedule: { interval: "day", intervalCount: 1, at: "00:00", on: "mon", dayOfMonth: 1 },
        retention: null,
        retry: { attempts: 5 },
        minFree: null,
        jail: overrides.direction === "push",
        rsync: {
            compress: true,
            bwlimit: null,
            ioTimeoutSec: 600,
            xattrs: false,
            preserveOwnership: true,
            preserveDevices: false,
            remoteRsyncBin: null,
            verify: false,
        },
        enabled: true,
        src: { kind: "local", path: "/data/src" },
        dst: { kind: "local", path: "/data/archive" },
        ...overrides,
    };
}

/** A ResolvedConfig fixture over the given targets and directories. */
export function makeConfig(params: {
    /** Loaded-config-file path (must exist with sane modes for preflight tests). */
    configPath: string;
    /** Run-report root. */
    stateDir: string;
    /** Targets in document order. */
    targets: ResolvedTarget[];
}): ResolvedConfig {
    return {
        name: "backupkit",
        remotes: {},
        targets: params.targets,
        retention: null,
        stateDir: params.stateDir,
        logging: { level: "error", file: null },
        rsyncBin: null,
        sshBin: null,
        configPath: params.configPath,
        warnings: [],
    };
}

/** Fixed stats block for fake transfers/estimates. */
export function makeStats(overrides: Partial<RsyncStats> = {}): RsyncStats {
    return { filesTransferred: 3, totalFiles: 10, totalTransferredSize: 1000, ...overrides };
}

/** A successful TransferResult fixture. */
export function makeTransferResult(overrides: Partial<TransferResult> = {}): TransferResult {
    const attempts: TransferAttempt[] = [{ exitCode: 0, class: "ok", durationMs: 5, stderrTail: "" }];
    return { status: "success", attempts, stats: makeStats(), skippedFiles: [], ...overrides };
}

/** A successful, empty ExecResult fixture. */
export function makeExecResult(overrides: Partial<ExecResult> = {}): ExecResult {
    return {
        exitCode: 0,
        signal: null,
        stdout: "",
        stderr: "",
        timedOut: false,
        truncated: false,
        durationMs: 1,
        ...overrides,
    };
}

/** One recorded exec call. */
export interface RecordedExec {
    /** The spawned binary. */
    bin: string;
    /** The argv array. */
    args: string[];
    /** The exec options. */
    options: ExecOptions | undefined;
}

/** A fully wired Backupkit fixture over real temp dirs with fake spawn/transfer seams. */
export interface KitFixture {
    /** The engine instance. */
    kit: Backupkit;
    /** Temp root (removed by the test's afterEach). */
    root: string;
    /** The target's source dir. */
    source: string;
    /** The archive destination root. */
    destination: string;
    /** The run-report root. */
    stateDir: string;
    /** Every exec call the engine made. */
    execCalls: RecordedExec[];
    /** The single target. */
    target: ResolvedTarget;
    /** Mutable clock driving deps.now. */
    clock: { now: Date };
}

/**
 * Build a Backupkit over real temp directories (config file 0600, archive
 * root, state/runtime dirs) with a fake exec recorder, a fake rsync probe,
 * and a fake transfer that "creates" the partial directory so the REAL local
 * store can promote it. `deps`/`target` overrides layer on top.
 */
export async function makeKit(params: {
    /** Target field overrides. */
    target?: Partial<ResolvedTarget>;
    /** Engine seam overrides. */
    deps?: Partial<BackupkitDeps>;
    /**
     * Extra targets appended after the default one, built from the fixture's
     * archive PARENT (`<root>/archive`'s parent, i.e. `<root>`). Each one needs
     * a destination of its OWN - a destination is one target's archive root, so
     * two targets sharing one would share a lock and interleave their snapshots.
     * Every local destination is created, permission-clean, before the engine
     * sees it: preflight refuses a destination root that does not exist.
     */
    extraTargets?: (archiveParent: string) => ResolvedTarget[];
} = {}): Promise<KitFixture> {
    const root = await mkdtemp(join(tmpdir(), "backupkit-engine-"));
    const configPath = join(root, "config.jsonc");
    await writeFile(configPath, "{}\n", { mode: 0o600 });
    const source = join(root, "src");
    const destination = join(root, "archive");
    const stateDir = join(root, "state");
    await mkdir(source, { recursive: true, mode: 0o700 });
    await mkdir(destination, { recursive: true, mode: 0o700 });
    await writeFile(join(source, "a.txt"), "alpha\n");
    const target = makeTarget({
        source,
        destination,
        src: { kind: "local", path: source },
        dst: { kind: "local", path: destination },
        ...params.target,
    });
    const config = makeConfig({
        configPath,
        stateDir,
        targets: [target, ...(params.extraTargets?.(root) ?? [])],
    });
    for (const configured of config.targets) {
        if (configured.dst.kind === "local") {
            await mkdir(configured.dst.path, { recursive: true, mode: 0o700 });
        }
    }
    const clock = { now: new Date("2026-08-10T12:00:00Z") };
    const execCalls: RecordedExec[] = [];
    const kit = new Backupkit(config, {
        now: () => clock.now,
        runtimeDir: join(root, "run"),
        env: {},
        hasTty: false,
        logger: captureLogger("error").log,
        execFn: async (bin, args, options) => {
            execCalls.push({ bin, args: [...args], options });
            return makeExecResult();
        },
        probeRsync: async () => ({ bin: "/fake/rsync", version: "3.2.7" }),
        transfer: async (transferParams) => {
            // "Create" the partial directory so the real local store can promote it.
            if (transferParams.spec.dst.kind === "local") {
                await mkdir(transferParams.spec.dst.path, { recursive: true });
                await writeFile(join(transferParams.spec.dst.path, "a.txt"), "alpha\n");
            }
            const result = makeTransferResult();
            for (const attempt of result.attempts) {
                transferParams.attemptLog?.push(attempt);
            }
            return result;
        },
        estimate: async () => makeStats(),
        // The reachability probe is the ONE seam that touches a real socket.
        // Left live it makes these tests depend on the machine's DNS: the
        // fixture's alias resolves to the literal `myserver`, which an ISP
        // wildcard answers and an honest resolver does not - so the daemon
        // tests skipped their target on whichever runs happened to fail the
        // lookup. Reachable by default; the probe's own behaviour is tested
        // against real sockets in `src/ssh/tests/reach.test.ts`.
        reach: async () => ({ ok: true, failure: null, detail: "" }),
        ...params.deps,
    });
    return { kit, root, source, destination, stateDir, execCalls, target, clock };
}
