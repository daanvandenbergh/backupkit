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
import { quoteShellArg } from "../ssh/internal/quote.js";
import { checkFilePermissions, defaultPermissionDeps, type PermissionDeps } from "../ssh/permissions.js";
import { resolveAlias, runRemote, sshArgs, type SshContext } from "../ssh/ssh.js";
import { dryRunStats, probeLocalRsync, probeRemoteRsync, runTransfer } from "../rsync/rsync.js";
import { planRetention } from "../retention/retention.js";
import { openStore, type SnapshotStore } from "../snapshots/store.js";
import type { SnapshotInfo } from "../snapshots/types.js";
import { isDue } from "../shared/time.js";
import { deriveBackoff, readTargetReports, runIdFor, writeTargetReport } from "./internal/reports.js";
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
    /** Remote rsync probe (version floor on every transfer path). Default rsync/'s `probeRemoteRsync`. */
    probeRemote?: typeof probeRemoteRsync;
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

/**
 * Build the `restrict,command="..."` authorized_keys prefix for a push target,
 * with the destination made safe to survive TWO nested contexts (security
 * invariant 10). A raw destination containing a space, double quote, or
 * backslash could otherwise widen $ROOT to a parent directory or break out of
 * the `command="..."` quoting.
 *
 * The destination crosses two layers before reaching backupkit-remote as $1:
 *   1. sshd's `$SHELL -c <command>` re-parses the command string as a shell
 *      line, so the destination must be exactly one shell word -> single-quote
 *      it with {@link quoteShellArg}.
 *   2. That word sits inside the authorized_keys `command="..."` double-quoted
 *      field, where `\` and `"` are the only escapes -> backslash-escape both
 *      (backslash first) so a `'\''` sequence or a literal `"` cannot terminate
 *      the field early.
 */
function jailCommandPrefix(destination: string): string {
    const word = quoteShellArg(destination).replaceAll("\\", "\\\\").replaceAll('"', '\\"');
    return `restrict,command="/usr/local/bin/backupkit-remote ${word}"`;
}

/**
 * Minimum interval between full disk-low re-evaluations of one target. While
 * the archive stays low the target remains due, so without damping every 30 s
 * tick would re-run the lock, the listing, and the full rsync dry-run
 * estimate. ponytail: fixed 5 min re-check - prompt recovery once space
 * frees, a per-target knob only if someone ever needs one.
 */
const DISK_LOW_RECHECK_MS = 5 * 60_000;

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
        /** Remote rsync probe. */
        probeRemote: typeof probeRemoteRsync;
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

    /** Memoized remote rsync probes per connection identity (failures clear the memo so a fixed host re-probes next run). */
    private readonly remoteProbes = new Map<string, Promise<string>>();

    /** Per-remote key-priming failures from preflight: remote name -> actionable message. Targets on these remotes fail individually. */
    private keyFailures = new Map<string, string>();

    /** Sticky disk-low state per target (one error log per transition). */
    private readonly diskLowTargets = new Set<string>();

    /** When each disk-low target's guard last ran a full evaluation (epoch ms), for the DISK_LOW_RECHECK_MS damping. */
    private readonly diskLowCheckedAt = new Map<string, number>();

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
            probeRemote: deps.probeRemote ?? probeRemoteRsync,
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
        // Key priming is per-remote fault-isolated (spec section 4 step 5): a
        // remote whose key cannot be primed lands in keyFailures and only its
        // targets fail in the run loop - preflight still succeeds, so the daemon
        // and every other target keep running (no crash loop).
        const keys = await this.deps.loadKeysFn(remotes, {
            runtimeDir: this.runtimeDir,
            log: this.log,
            hasTty: this.deps.hasTty,
        });
        this.agentSock = keys.sock;
        this.keyFailures = keys.failures;
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

    /** Whether an interactive TTY is available (deps override, else the real stdin) - the accept-new gate of invariant 5. */
    private isInteractive(): boolean {
        return this.deps.hasTty ?? process.stdin.isTTY === true;
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

    /** A report for a run that never entered the pipeline (unavailable remote, throttled disk-low re-check). */
    private syntheticReport(
        target: ResolvedTarget,
        status: TargetRunReport["status"],
        reason: string,
        error: string,
    ): TargetRunReport {
        const start = this.deps.now();
        return {
            runId: runIdFor(start, target.name),
            target: target.name,
            direction: target.direction,
            snapshot: null,
            status,
            reason,
            startedAt: start.toISOString(),
            finishedAt: start.toISOString(),
            attempts: [],
            stats: null,
            skippedFiles: [],
            error,
        };
    }

    /**
     * The probed remote rsync version for a target's remote, memoized per
     * connection identity so the floor costs one ssh round-trip per host per
     * process (invariant 11 on the transfer path). A failed probe clears the
     * memo, so a fixed or upgraded host is re-probed on its next run.
     */
    private remoteRsyncFor(target: ResolvedTarget, remote: ResolvedRemote): Promise<string> {
        const identity = remoteIdentity(remote);
        let probe = this.remoteProbes.get(identity);
        if (probe === undefined) {
            probe = this.deps.probeRemote({
                identity,
                runRemote: (argv) =>
                    runRemote(remote, argv, {
                        sshBin: this.sshBin(),
                        context: "unattended",
                        authSock: this.authSockFor(remote),
                        log: this.log.with({ remote: remote.name }),
                    }),
                remoteRsyncBin: target.rsync.remoteRsyncBin,
                log: this.log.with({ remote: remote.name }),
            });
            this.remoteProbes.set(identity, probe);
            probe.catch(() => this.remoteProbes.delete(identity));
        }
        return probe;
    }

    /**
     * The per-remote availability gate run before a target's pipeline: null
     * when the remote is usable (or the transfer is purely local), else the
     * failed report that replaces the run. Covers the two per-remote failure
     * modes with one model: a key that could not be primed at preflight
     * (spec section 4 step 5) and a remote rsync below the version floor or
     * unreachable at probe time (invariant 11) - either fails only this
     * remote's targets, never the daemon.
     */
    private async remoteGate(target: ResolvedTarget): Promise<TargetRunReport | null> {
        const remote = remoteOf(target);
        if (remote === null) {
            return null;
        }
        const keyFailure = this.keyFailures.get(remote.name);
        if (keyFailure !== undefined) {
            this.log.error("remote unavailable - target fails without transfer", {
                target: target.name,
                remote: remote.name,
                error: keyFailure,
            });
            return this.syntheticReport(target, "failed", "remote-unavailable", keyFailure);
        }
        try {
            await this.remoteRsyncFor(target, remote);
            return null;
        } catch (error) {
            const message = sanitize(error instanceof Error ? error.message : String(error));
            this.log.error("remote rsync probe failed - target fails without transfer", {
                target: target.name,
                remote: remote.name,
                error: message,
            });
            return this.syntheticReport(target, "failed", "remote-unavailable", message);
        }
    }

    /** Run one target through the pipeline, persist its report, and feed the backoff tracker. */
    private async runOne(
        target: ResolvedTarget,
        options: { force?: boolean; dryRun?: boolean; signal?: AbortSignal },
    ): Promise<TargetRunReport> {
        // Disk-low damping: while the archive stayed low, the full evaluation
        // (lock, listing, dry-run estimate) re-runs at most every
        // DISK_LOW_RECHECK_MS instead of every scheduler tick. The synthetic
        // skip is never persisted and `force` bypasses the throttle.
        const lastLowCheck = this.diskLowCheckedAt.get(target.name);
        if (
            options.force !== true &&
            lastLowCheck !== undefined &&
            this.deps.now().getTime() - lastLowCheck < DISK_LOW_RECHECK_MS
        ) {
            return this.syntheticReport(
                target,
                "skipped",
                "disk-low",
                "archive disk low - next re-evaluation after the re-check interval",
            );
        }

        const wasDiskLow = this.diskLowTargets.has(target.name);
        let report = await this.remoteGate(target);
        if (report === null) {
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
            report = await runTarget(target, deps, options);
        }

        // Disk-low bookkeeping for the damping above.
        if (report.status === "skipped" && report.reason === "disk-low") {
            this.diskLowCheckedAt.set(target.name, this.deps.now().getTime());
        } else {
            this.diskLowCheckedAt.delete(target.name);
        }

        // Persist + feed backoff. Rehydration runs BEFORE the write so a
        // first-touch (forced) run can never read its own report back from disk
        // and double-count a failure. A repeat disk-low skip is not persisted:
        // one report per episode keeps the condition from erasing the
        // 50-report history that backoff rehydration and status() derive from.
        const repeatDiskLow = wasDiskLow && report.status === "skipped" && report.reason === "disk-low";
        if (options.dryRun !== true && !repeatDiskLow) {
            await this.ensureBackoffState(target);
            await writeTargetReport(this.config.stateDir, report);
            this.backoff.record(target.name, report.status, new Date(report.finishedAt));
        }
        return report;
    }

    /**
     * Run every due target once (or the named subset). `force` bypasses
     * due-ness, backoff, and bucket dedup. One-shot runs are abortable:
     * `stop()` aborts the in-flight target (its report lands as "aborted",
     * the rsync child gets SIGTERM) and no further target starts - the same
     * graceful-shutdown contract the daemon loop has (spec section 6).
     */
    async run(options: { targets?: string[]; force?: boolean; dryRun?: boolean } = {}): Promise<RunReport> {
        const startedAt = this.deps.now().toISOString();
        await this.preflight();
        const controller = new AbortController();
        if (this.abortController === null) {
            this.abortController = controller;
        }
        try {
            return await this.runPass(startedAt, controller.signal, options);
        } finally {
            if (this.abortController === controller) {
                this.abortController = null;
            }
        }
    }

    /** The run() pass over the selected targets, threaded with the abort signal. */
    private async runPass(
        startedAt: string,
        signal: AbortSignal,
        options: { targets?: string[]; force?: boolean; dryRun?: boolean },
    ): Promise<RunReport> {
        const reports: TargetRunReport[] = [];
        for (const target of this.selectTargets(options.targets)) {
            // A stop() during the pass aborts the in-flight target and starts no further one.
            if (signal.aborted) {
                break;
            }
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
            reports.push(await this.runOne(target, { force: options.force, dryRun: options.dryRun, signal }));
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
     * Graceful stop: end the tick loop, abort the in-flight transfer - of the
     * daemon loop OR of a one-shot `run()` pass (its aborted report is written
     * by the pipeline; lock release is structural via `withLock`), and resolve
     * once the loop has exited. Second-signal semantics belong to the CLI.
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
            // Per-remote priming failures do not fail preflight (fault isolation),
            // but check() is the diagnostic surface: report each one loudly.
            for (const [remoteName, message] of this.keyFailures) {
                errors.push(`remote ${remoteName}: ${message}`);
            }
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
            // Invariant 5: accept-new (TOFU pinning) only while a human watches a
            // real TTY; any non-TTY check() pins strictly like every unattended path.
            const context: SshContext = this.isInteractive() ? "interactive" : "unattended";
            try {
                row.rsyncVersion = await this.deps.probeRemote({
                    identity: remoteIdentity(remote),
                    runRemote: (argv) =>
                        runRemote(remote, argv, {
                            sshBin: this.sshBin(),
                            context,
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
            const prefix = jailCommandPrefix(target.destination);
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
