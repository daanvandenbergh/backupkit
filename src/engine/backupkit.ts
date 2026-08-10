/**
 * The `Backupkit` class - the engine's public surface (spec section 1): run,
 * start/stop, status, listSnapshots, restore, prune, check, preflight. Owns
 * the per-target pipeline wiring, the scheduler, run-report persistence, the
 * backoff derivation, and the disk-guard decision. Everything below composes
 * the finished modules; the CLI (a later phase) is a pure view over these
 * methods.
 */

import { appendFileSync } from "node:fs";
import { lstat, readFile, realpath, statfs } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, posix, resolve, sep } from "node:path";

import { loadConfig } from "../config/config.js";
import type { ResolvedConfig, ResolvedTarget } from "../config/types.js";
import { exec, minimalEnv, type ExecOptions, type ExecResult } from "../exec/exec.js";
import { ConfigError, RestoreError } from "../shared/errors.js";
import { formatEndpoint } from "../shared/format.js";
import { Logger } from "../shared/logger.js";
import { sanitize } from "../shared/sanitize.js";
import { parseSnapshotName } from "../shared/snapshot-name.js";
import type { Endpoint, ResolvedRemote } from "../shared/types.js";
import { loadKeys } from "../ssh/agent.js";
import { checkFilePermissions, defaultPermissionDeps, type PermissionDeps } from "../ssh/permissions.js";
import { resolveAlias, runRemote, sshArgs, type SshContext } from "../ssh/ssh.js";
import { dryRunStats, probeLocalRsync, probeRemoteRsync, runTransfer } from "../rsync/rsync.js";
import { planRetention } from "../retention/retention.js";
import { openStore, type SnapshotStore } from "../snapshots/store.js";
import type { SnapshotInfo } from "../snapshots/types.js";
import { isDue } from "../shared/time.js";
import { deriveBackoff, readTargetReports, writeTargetReport } from "./internal/reports.js";
import { backoffDelayMs, BackoffTracker, nextDueAt, Scheduler } from "./internal/scheduler.js";
import { runTarget, type TargetRunnerDeps } from "./internal/target-runner.js";
import type {
    CheckReport,
    JailLine,
    PruneReport,
    RemoteCheck,
    RestoreReport,
    RunReport,
    TargetPruneReport,
    TargetRunReport,
    TargetStatus,
} from "./types.js";

/** The exec/ spawn function shape (injectable for tests). */
type ExecFn = (bin: string, args: readonly string[], options?: ExecOptions) => Promise<ExecResult>;

/** Injectable seams for tests; every field has a production default. */
export interface BackupkitDeps {
    /** Clock. Default `() => new Date()`. */
    now?: () => Date;
    /** Runtime dir override (agent socket home). Default per spec: /run/backupkit (root), $XDG_RUNTIME_DIR/backupkit, else ~/.backupkit/run. */
    runtimeDir?: string;
    /** Process environment seam (SSH_AUTH_SOCK, XDG_RUNTIME_DIR). Default process.env. */
    env?: Record<string, string | undefined>;
    /** TTY availability for the interactive key flow. Default `process.stdin.isTTY === true`. */
    hasTty?: boolean;
    /** Spawn function. Default exec/'s `exec`. */
    execFn?: ExecFn;
    /** Transfer function. Default rsync/'s `runTransfer`. */
    transfer?: typeof runTransfer;
    /** Delta estimator. Default rsync/'s `dryRunStats`. */
    estimate?: typeof dryRunStats;
    /** Local rsync probe. Default rsync/'s `probeLocalRsync`. */
    probeRsync?: typeof probeLocalRsync;
    /** Key loader. Default ssh/'s `loadKeys`. */
    loadKeysFn?: typeof loadKeys;
    /** Permission-check filesystem seam. Default the real filesystem. */
    permissionDeps?: PermissionDeps;
    /** Scheduler tick interval override in ms. Default 30000. */
    tickMs?: number;
    /** Logger override (tests). Default: a Logger built from `config.logging`. */
    logger?: Logger;
}

/** The default runtime directory for the given identity (spec section 4). */
function defaultRuntimeDir(env: Record<string, string | undefined>, euid: number | null, home: string): string {
    if (euid === 0) {
        return "/run/backupkit";
    }
    if (env.XDG_RUNTIME_DIR !== undefined && env.XDG_RUNTIME_DIR !== "") {
        return join(env.XDG_RUNTIME_DIR, "backupkit");
    }
    return join(home, ".backupkit", "run");
}

/** The remote a target talks to, or null for a purely local transfer. */
function remoteOf(target: ResolvedTarget): ResolvedRemote | null {
    if (target.src.kind === "remote") {
        return target.src.remote;
    }
    if (target.dst.kind === "remote") {
        return target.dst.remote;
    }
    return null;
}

/** The remote-probe cache identity: `user@host:port` for explicit remotes, the alias string for aliases. */
function remoteIdentity(remote: ResolvedRemote): string {
    return remote.kind === "alias" ? remote.alias : `${remote.user}@${remote.host}:${remote.port}`;
}

/** The versioned-backup engine over one resolved config. */
export class Backupkit {
    /** The fully resolved config this instance runs. */
    private readonly config: ResolvedConfig;

    /** Resolved injectable seams (optional-only fields keep their optionality). */
    private readonly deps: {
        /** Clock. */
        now: () => Date;
        /** Process environment seam. */
        env: Record<string, string | undefined>;
        /** Spawn function. */
        execFn: ExecFn;
        /** Transfer function. */
        transfer: typeof runTransfer;
        /** Delta estimator. */
        estimate: typeof dryRunStats;
        /** Local rsync probe. */
        probeRsync: typeof probeLocalRsync;
        /** Key loader. */
        loadKeysFn: typeof loadKeys;
        /** Permission-check filesystem seam. */
        permissionDeps: PermissionDeps;
        /** TTY availability override. */
        hasTty: boolean | undefined;
        /** Scheduler tick interval override. */
        tickMs: number | undefined;
    };

    /** The root logger (config level, optional file sink). */
    private readonly log: Logger;

    /** The runtime directory holding the agent socket. */
    private readonly runtimeDir: string;

    /** The backupkit agent socket after preflight, or null (all-alias / local-only config). */
    private agentSock: string | null = null;

    /** Memoized preflight, cleared on failure so a fixed environment can retry. */
    private preflightPromise: Promise<void> | null = null;

    /** Memoized local rsync probe. */
    private rsyncProbe: Promise<{ bin: string; version: string }> | null = null;

    /** Sticky disk-low state per target (one error log per transition). */
    private readonly diskLowTargets = new Set<string>();

    /** The backoff tracker (rehydrated lazily per target from run reports). */
    private readonly backoff: BackoffTracker;

    /** Targets whose backoff state has been rehydrated from disk. */
    private readonly rehydrated = new Set<string>();

    /** The running scheduler while `start()` is active. */
    private scheduler: Scheduler | null = null;

    /** The pending `start()` loop promise. */
    private startPromise: Promise<void> | null = null;

    /** Abort controller for the in-flight transfer during graceful shutdown. */
    private abortController: AbortController | null = null;

    /** Load + validate config from `path` (default: the resolution order) and construct. Synchronous: no I/O beyond the config file. */
    static fromConfig(path?: string): Backupkit {
        return new Backupkit(loadConfig(path));
    }

    /** Construct from an already-resolved config (library use). The second parameter is an internal test seam. */
    constructor(config: ResolvedConfig, deps: BackupkitDeps = {}) {
        this.config = config;
        this.deps = {
            now: deps.now ?? (() => new Date()),
            env: deps.env ?? process.env,
            execFn: deps.execFn ?? exec,
            transfer: deps.transfer ?? runTransfer,
            estimate: deps.estimate ?? dryRunStats,
            probeRsync: deps.probeRsync ?? probeLocalRsync,
            loadKeysFn: deps.loadKeysFn ?? loadKeys,
            permissionDeps: deps.permissionDeps ?? defaultPermissionDeps(),
            hasTty: deps.hasTty,
            tickMs: deps.tickMs,
        };
        this.log =
            deps.logger ??
            new Logger({
                level: config.logging.level,
                now: this.deps.now,
                fileSink:
                    config.logging.file === null
                        ? undefined
                        : (line): void => appendFileSync(config.logging.file as string, line + "\n"),
            });
        this.backoff = new BackoffTracker(this.log);
        this.runtimeDir =
            deps.runtimeDir ??
            defaultRuntimeDir(this.deps.env, this.deps.permissionDeps.euid, this.deps.env.HOME ?? homedir());
        for (const warning of config.warnings) {
            this.log.warn(warning);
        }
    }

    /**
     * Ensure agent + keys + permission checks (spec section 4; alias remotes
     * skip key priming; a config with no explicit remote starts no agent).
     * Idempotent; called by run/start. Never prompts without a TTY.
     */
    preflight(): Promise<void> {
        if (this.preflightPromise === null) {
            this.preflightPromise = this.runPreflight();
            this.preflightPromise.catch(() => {
                this.preflightPromise = null;
            });
        }
        return this.preflightPromise;
    }

    /** The actual preflight work behind the memoization. */
    private async runPreflight(): Promise<void> {
        const remotes = Object.values(this.config.remotes);
        const localRoots = [...new Set(this.config.targets.filter((t) => t.dst.kind === "local").map((t) => t.dst.path))];
        await checkFilePermissions(
            {
                configPath: this.config.configPath,
                stateDir: this.config.stateDir,
                runtimeDir: this.runtimeDir,
                localDestinationRoots: localRoots,
                remotes,
            },
            this.deps.permissionDeps,
        );
        this.agentSock = await this.deps.loadKeysFn(remotes, {
            runtimeDir: this.runtimeDir,
            log: this.log,
            hasTty: this.deps.hasTty,
        });
    }

    /** The probed local rsync binary + version (memoized; failures clear the memo). */
    private localRsync(): Promise<{ bin: string; version: string }> {
        if (this.rsyncProbe === null) {
            this.rsyncProbe = this.deps.probeRsync(this.config.rsyncBin, this.deps.execFn);
            this.rsyncProbe.catch(() => {
                this.rsyncProbe = null;
            });
        }
        return this.rsyncProbe;
    }

    /** The local ssh binary (config override or PATH "ssh"). */
    private sshBin(): string {
        return this.config.sshBin ?? "ssh";
    }

    /** SSH_AUTH_SOCK for spawns against a remote: the backupkit agent for explicit, the inherited value for aliases. */
    private authSockFor(remote: ResolvedRemote): string | null {
        if (remote.kind === "explicit") {
            return this.agentSock;
        }
        return this.deps.env.SSH_AUTH_SOCK ?? null;
    }

    /** COMPLETE rsync child env for a target: minimal env plus at most one SSH_AUTH_SOCK. */
    private childEnvFor(target: ResolvedTarget): Record<string, string> | undefined {
        const remote = remoteOf(target);
        if (remote === null) {
            return undefined;
        }
        const sock = this.authSockFor(remote);
        return sock === null ? undefined : { ...minimalEnv(), SSH_AUTH_SOCK: sock };
    }

    /** Open the snapshot store for a target in the given ssh context. */
    private storeFor(target: ResolvedTarget, context: SshContext): SnapshotStore {
        const log = this.log.with({ target: target.name });
        return openStore(
            { name: target.name, dst: target.dst },
            {
                log,
                now: this.deps.now,
                ssh:
                    target.dst.kind === "remote"
                        ? {
                              sshBin: this.sshBin(),
                              context,
                              authSock: this.authSockFor(target.dst.remote),
                          }
                        : undefined,
            },
        );
    }

    /**
     * Total bytes of a target's archive filesystem: statfs for local stores;
     * `df -Pk --` over the jailed remote surface for push stores. Null when
     * undeterminable (the percent minFree floor then degrades; disk-guard).
     */
    private async totalBytesFor(target: ResolvedTarget): Promise<number | null> {
        if (target.dst.kind === "local") {
            try {
                const stats = await statfs(target.dst.path);
                return stats.blocks * stats.bsize;
            } catch {
                return null;
            }
        }
        try {
            const root = posix.join(target.dst.path, target.name);
            const result = await runRemote(target.dst.remote, ["df", "-Pk", "--", root], {
                sshBin: this.sshBin(),
                context: "unattended",
                authSock: this.authSockFor(target.dst.remote),
                log: this.log.with({ target: target.name }),
            });
            if (result.exitCode !== 0) {
                return null;
            }
            const lines = result.stdout.split("\n").map((line) => line.trim()).filter((line) => line !== "");
            const tokens = (lines.at(-1) ?? "").split(/\s+/);
            const pctIndex = tokens.findIndex((token) => /^[0-9]+%$/.test(token));
            if (pctIndex < 4 || !/^[0-9]+$/.test(tokens[pctIndex - 3])) {
                return null;
            }
            return Number(tokens[pctIndex - 3]) * 1024;
        } catch {
            return null;
        }
    }

    /** Resolve target names to targets in CONFIG order; unknown names are a ConfigError listing the valid ones. */
    private selectTargets(names?: string[]): ResolvedTarget[] {
        if (names === undefined) {
            return this.config.targets;
        }
        const known = new Map(this.config.targets.map((t) => [t.name, t]));
        for (const name of names) {
            if (!known.has(name)) {
                throw new ConfigError(
                    `unknown target "${sanitize(name)}" (configured: ${this.config.targets.map((t) => t.name).join(", ")})`,
                );
            }
        }
        const wanted = new Set(names);
        return this.config.targets.filter((t) => wanted.has(t.name));
    }

    /** Rehydrate one target's backoff state from its persisted reports (once per instance). */
    private async ensureBackoffState(target: ResolvedTarget): Promise<void> {
        if (this.rehydrated.has(target.name)) {
            return;
        }
        this.rehydrated.add(target.name);
        const reports = await readTargetReports(this.config.stateDir, target.name, this.log);
        this.backoff.rehydrate(target.name, deriveBackoff(reports));
    }

    /** Run one target through the pipeline, persist its report, and feed the backoff tracker. */
    private async runOne(
        target: ResolvedTarget,
        options: { force?: boolean; dryRun?: boolean; signal?: AbortSignal },
    ): Promise<TargetRunReport> {
        const { bin } = await this.localRsync();
        const remote = remoteOf(target);
        const deps: TargetRunnerDeps = {
            store: this.storeFor(target, "unattended"),
            log: this.log.with({ target: target.name }),
            now: this.deps.now,
            rsyncBin: bin,
            sshTokens: remote === null ? [] : sshArgs(remote, "unattended"),
            env: this.childEnvFor(target),
            transfer: this.deps.transfer,
            estimate: this.deps.estimate,
            execFn: this.deps.execFn,
            totalBytes: () => this.totalBytesFor(target),
            diskLowTargets: this.diskLowTargets,
        };
        const report = await runTarget(target, deps, options);
        if (options.dryRun !== true) {
            await writeTargetReport(this.config.stateDir, report);
            await this.ensureBackoffState(target);
            this.backoff.record(target.name, report.status, new Date(report.finishedAt));
        }
        return report;
    }

    /** Run every due target once (or the named subset). `force` bypasses due-ness, backoff, and bucket dedup. */
    async run(options: { targets?: string[]; force?: boolean; dryRun?: boolean } = {}): Promise<RunReport> {
        const startedAt = this.deps.now().toISOString();
        await this.preflight();
        const reports: TargetRunReport[] = [];
        for (const target of this.selectTargets(options.targets)) {
            // Disabled targets never run unless explicitly named.
            if (!target.enabled && options.targets === undefined) {
                continue;
            }
            if (options.force !== true) {
                await this.ensureBackoffState(target);
                const until = this.backoff.untilFor(target.name);
                const now = this.deps.now();
                if (until !== null && now.getTime() < until.getTime()) {
                    this.log.info("target in failure backoff - skipping", {
                        target: target.name,
                        nextAttemptAt: until.toISOString(),
                    });
                    continue;
                }
                const newest = (await this.storeFor(target, "unattended").listComplete()).at(-1) ?? null;
                const newestDate = newest === null ? null : parseSnapshotName(newest);
                if (!isDue(target.schedule, newestDate, now)) {
                    continue;
                }
            }
            reports.push(await this.runOne(target, options));
        }
        return { startedAt, finishedAt: this.deps.now().toISOString(), targets: reports };
    }

    /** Foreground scheduler loop; resolves after `stop()` completes. */
    async start(): Promise<void> {
        if (this.startPromise !== null) {
            return this.startPromise;
        }
        await this.preflight();
        for (const target of this.config.targets) {
            await this.ensureBackoffState(target);
        }
        this.abortController = new AbortController();
        const signal = this.abortController.signal;
        this.scheduler = new Scheduler({
            targets: this.config.targets.filter((t) => t.enabled),
            log: this.log,
            now: this.deps.now,
            tickMs: this.deps.tickMs,
            backoff: this.backoff,
            listNewest: async (target) => (await this.storeFor(target, "unattended").listComplete()).at(-1) ?? null,
            runTarget: (target) => this.runOne(target, { signal }),
        });
        this.startPromise = this.scheduler.start().finally(() => {
            this.scheduler = null;
            this.startPromise = null;
            this.abortController = null;
        });
        return this.startPromise;
    }

    /**
     * Graceful stop: end the tick loop, abort the in-flight transfer (its
     * aborted report is written by the pipeline; lock release is structural
     * via `withLock`), and resolve once the loop has exited. Second-signal
     * semantics belong to the CLI.
     */
    async stop(): Promise<void> {
        const pending = this.startPromise;
        this.scheduler?.stop();
        this.abortController?.abort();
        if (pending !== null) {
            await pending.catch(() => undefined);
        }
    }

    /** One row per target: last snapshot, next due, last result, consecutive failures, lock state. Read-only, always instant. */
    async status(options: { targets?: string[] } = {}): Promise<TargetStatus[]> {
        const rows: TargetStatus[] = [];
        for (const target of this.selectTargets(options.targets)) {
            const reports = await readTargetReports(this.config.stateDir, target.name, this.log);
            const derived = deriveBackoff(reports);
            const now = this.deps.now();
            const backoffUntil =
                derived.lastFailedAt === null || derived.consecutiveFailures === 0
                    ? null
                    : new Date(derived.lastFailedAt.getTime() + backoffDelayMs(derived.consecutiveFailures));
            const newestDate = derived.lastSnapshot === null ? null : parseSnapshotName(derived.lastSnapshot);
            // ponytail: lockHeld is knowable instantly only for local stores; a
            // remote lock probe would be an ssh round-trip, so push targets
            // report false here (the run/prune verbs still see the real lock).
            let lockHeld = false;
            if (target.dst.kind === "local") {
                lockHeld = await lstat(join(target.dst.path, target.name, ".backupkit.lock")).then(
                    () => true,
                    () => false,
                );
            }
            rows.push({
                target: target.name,
                lastSnapshot: derived.lastSnapshot,
                nextDueAt: target.enabled ? nextDueAt(target.schedule, newestDate, backoffUntil, now).toISOString() : null,
                lastResult: derived.lastResult,
                consecutiveFailures: derived.consecutiveFailures,
                lockHeld,
            });
        }
        return rows;
    }

    /** List complete snapshots, oldest first, per target in config order. */
    async listSnapshots(options: { targets?: string[] } = {}): Promise<SnapshotInfo[]> {
        const infos: SnapshotInfo[] = [];
        for (const target of this.selectTargets(options.targets)) {
            for (const name of await this.storeFor(target, "unattended").listComplete()) {
                const createdAt = parseSnapshotName(name);
                if (createdAt !== null) {
                    infos.push({ target: target.name, name, createdAt });
                }
            }
        }
        return infos;
    }

    /** Copy one snapshot (`"latest"` accepted) to a non-existent output path; optional checksum verify pass. */
    async restore(options: { target: string; snapshot: string; output: string; verify?: boolean }): Promise<RestoreReport> {
        const target = this.config.targets.find((t) => t.name === options.target);
        if (target === undefined) {
            throw new ConfigError(
                `unknown target "${sanitize(options.target)}" (configured: ${this.config.targets.map((t) => t.name).join(", ")})`,
            );
        }
        await this.preflight();
        const store = this.storeFor(target, "unattended");
        const complete = await store.listComplete();
        const newest = complete.at(-1) ?? null;
        const snapshot = options.snapshot === "latest" ? newest : options.snapshot;
        if (snapshot === null || !complete.includes(snapshot)) {
            throw new RestoreError(
                `no complete snapshot ${options.snapshot === "latest" ? "" : `"${sanitize(options.snapshot)}" `}for target ${target.name}` +
                    (newest === null ? " (no snapshots exist yet)" : ` - newest complete is ${newest}`),
            );
        }

        // Output safety: must not exist; its realpath'd parent must not resolve inside any archive root.
        const output = resolve(options.output);
        const exists = await lstat(output).then(
            () => true,
            () => false,
        );
        if (exists) {
            throw new RestoreError(`output path ${output} already exists - restore only writes to a fresh path`);
        }
        let realParent: string;
        try {
            realParent = await realpath(dirname(output));
        } catch {
            throw new RestoreError(`output parent directory ${dirname(output)} does not exist`);
        }
        for (const root of new Set(this.config.targets.filter((t) => t.dst.kind === "local").map((t) => t.dst.path))) {
            const realRoot = await realpath(root).catch(() => null);
            if (realRoot !== null && (realParent === realRoot || realParent.startsWith(realRoot + sep))) {
                throw new RestoreError(`output ${output} resolves inside the archive root ${root} - choose a path outside every archive`);
            }
        }

        // The snapshot endpoint on the destination side.
        const snapEndpoint: Endpoint =
            target.dst.kind === "local"
                ? { kind: "local", path: join(target.dst.path, target.name, snapshot) }
                : { kind: "remote", remote: target.dst.remote, path: posix.join(target.dst.path, target.name, snapshot) };
        const sshTokens = target.dst.kind === "remote" ? sshArgs(target.dst.remote, "unattended") : [];
        const env =
            target.dst.kind === "remote" && this.authSockFor(target.dst.remote) !== null
                ? { ...minimalEnv(), SSH_AUTH_SOCK: this.authSockFor(target.dst.remote) as string }
                : undefined;
        const remoteArgs = sshTokens.length === 0 ? [] : ["-e", sshTokens.join(" ")];
        const src = formatEndpoint(snapEndpoint) + "/";

        // The copy: never --delete, symlinks copied as symlinks, awaited and exit-checked.
        const { bin } = await this.localRsync();
        const copy = await this.deps.execFn(bin, ["-a", "--sparse", "-H", ...remoteArgs, src, output], { env });
        if (copy.exitCode !== 0) {
            throw new RestoreError(
                `restore copy failed (rsync exit ${copy.exitCode ?? "signal"}): ${sanitize(copy.stderr).slice(-500)}`,
            );
        }

        // Opt-in verify: checksum dry-run; any content-change itemize line fails.
        let verified = false;
        if (options.verify === true) {
            const verify = await this.deps.execFn(
                bin,
                ["-a", "--checksum", "--dry-run", "--itemize-changes", ...remoteArgs, src, output],
                { env },
            );
            const changed = verify.stdout
                .split("\n")
                .map((line) => line.trim())
                .filter((line) => line !== "" && /^[<>ch*]/.test(line));
            if ((verify.exitCode !== 0 && verify.exitCode !== 24) || changed.length > 0) {
                throw new RestoreError(
                    `restore verify found differences (exit ${verify.exitCode ?? "signal"})` +
                        (changed.length === 0 ? "" : `: ${changed.slice(0, 20).map(sanitize).join(", ")}`),
                );
            }
            verified = true;
        }
        return { target: target.name, snapshot, output, verified };
    }

    /** Apply retention now (or plan only with `dryRun`). */
    async prune(options: { targets?: string[]; dryRun?: boolean } = {}): Promise<PruneReport> {
        const reports: TargetPruneReport[] = [];
        for (const target of this.selectTargets(options.targets)) {
            const store = this.storeFor(target, "unattended");
            const errors: string[] = [];
            if (options.dryRun === true) {
                const plan = planRetention(await store.listComplete(), target.retention, this.deps.now());
                reports.push({ target: target.name, plan, executed: false, errors });
                continue;
            }
            const plan = await store.withLock(async () => {
                const names = await store.listComplete();
                const inner = planRetention(names, target.retention, this.deps.now());
                if (inner.keep.length === 0 && inner.prune.length > 0) {
                    errors.push("retention plan would remove all snapshots, refusing");
                    return { ...inner, prune: [] };
                }
                for (const name of [...inner.prune].reverse()) {
                    try {
                        await store.remove(name);
                        this.log.info("pruned snapshot", { target: target.name, snapshot: name });
                    } catch (error) {
                        errors.push(`${name}: ${sanitize(error instanceof Error ? error.message : String(error))}`);
                    }
                }
                return inner;
            });
            reports.push({ target: target.name, plan, executed: plan.prune.length > 0, errors });
        }
        return { targets: reports };
    }

    /**
     * Readiness gate (spec section 7): verify local binaries + versions, run
     * the interactive key flow, probe each remote (TOFU pinning happens by
     * running the probe in interactive context on a TTY), resolve aliases via
     * `ssh -G`, and produce jail-line DATA for push targets - printing is the
     * CLI's job.
     */
    async check(): Promise<CheckReport> {
        const errors: string[] = [];
        let localRsync: { bin: string; version: string } | null = null;
        try {
            localRsync = await this.localRsync();
        } catch (error) {
            errors.push(sanitize(error instanceof Error ? error.message : String(error)));
        }
        let sshOk = false;
        try {
            const probe = await this.deps.execFn(this.sshBin(), ["-V"], { timeoutMs: 5000 });
            sshOk = probe.exitCode === 0;
            if (!sshOk) {
                errors.push(`${this.sshBin()} -V failed (exit ${probe.exitCode ?? "signal"})`);
            }
        } catch (error) {
            errors.push(`ssh binary not found: ${sanitize(error instanceof Error ? error.message : String(error))}`);
        }
        try {
            await this.preflight();
        } catch (error) {
            errors.push(sanitize(error instanceof Error ? error.message : String(error)));
        }

        const remoteChecks: RemoteCheck[] = [];
        for (const remote of Object.values(this.config.remotes)) {
            const row: RemoteCheck = {
                remote: remote.name,
                kind: remote.kind,
                reachable: false,
                rsyncVersion: null,
                resolved: null,
                error: null,
            };
            if (remote.kind === "alias") {
                row.resolved = await resolveAlias(remote, { sshBin: this.sshBin() });
            }
            // The first target on this remote that overrides the remote rsync binary decides the probe path.
            const remoteRsyncBin =
                this.config.targets.find((t) => remoteOf(t)?.name === remote.name && t.rsync.remoteRsyncBin !== null)
                    ?.rsync.remoteRsyncBin ?? null;
            try {
                row.rsyncVersion = await probeRemoteRsync({
                    identity: remoteIdentity(remote),
                    runRemote: (argv) =>
                        runRemote(remote, argv, {
                            sshBin: this.sshBin(),
                            context: "interactive",
                            authSock: this.authSockFor(remote),
                            log: this.log.with({ remote: remote.name }),
                        }),
                    remoteRsyncBin,
                    log: this.log.with({ remote: remote.name }),
                });
                row.reachable = true;
            } catch (error) {
                row.error = sanitize(error instanceof Error ? error.message : String(error));
                errors.push(`remote ${remote.name}: ${row.error}`);
            }
            remoteChecks.push(row);
        }

        const jailLines: JailLine[] = [];
        for (const target of this.config.targets) {
            if (target.dst.kind !== "remote") {
                continue;
            }
            const remote = target.dst.remote;
            const prefix = `restrict,command="/usr/local/bin/backupkit-remote ${target.destination}"`;
            if (remote.kind === "alias") {
                jailLines.push({
                    target: target.name,
                    remote: remote.name,
                    line: `${prefix} <append the public key your ssh_config uses for "${remote.alias}": ssh-add -L, or the .pub of its IdentityFile>`,
                });
                continue;
            }
            try {
                const pub = sanitize((await readFile(`${remote.identityFile}.pub`, "utf8")).split("\n")[0].trim());
                jailLines.push({ target: target.name, remote: remote.name, line: `${prefix} ${pub}` });
            } catch {
                const message = `cannot read ${remote.identityFile}.pub for the jail line - run "backupkit check" interactively to generate it`;
                errors.push(message);
                jailLines.push({ target: target.name, remote: remote.name, line: `${prefix} <${message}>` });
            }
        }

        return { ok: errors.length === 0, localRsync, sshOk, remotes: remoteChecks, jailLines, errors };
    }
}
