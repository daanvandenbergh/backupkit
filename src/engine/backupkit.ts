/**
 * The `Backupkit` class - the engine's public surface (spec section 1): run,
 * start/stop, status, listSnapshots, restore, prune, check, preflight. Owns
 * the per-target pipeline wiring, the scheduler, run-report persistence, the
 * backoff derivation, and the disk-guard decision. Everything below composes
 * the finished modules; the CLI (a later phase) is a pure view over these
 * methods.
 */

import { closeSync, constants as fsConstants, openSync, writeSync } from "node:fs";
import { lstat, readFile, realpath, statfs } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, posix, resolve, sep } from "node:path";

import { loadConfig } from "../config/config.js";
import type { ResolvedConfig, ResolvedTarget } from "../config/types.js";
import { exec, minimalEnv, type ExecOptions, type ExecResult } from "../exec/exec.js";
import { ConfigError, isBackupkitError, RestoreError } from "../shared/errors.js";
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
import { planRetention, type RetentionPlan } from "../retention/retention.js";
import { openStore, type SnapshotStore } from "../snapshots/store.js";
import { splitFutureSnapshots, type SnapshotInfo } from "../snapshots/types.js";
import { isDue } from "../shared/time.js";
import {
    deriveBackoff,
    detectHistoryInsertion,
    newestHistoryMark,
    newestStats,
    readTargetReports,
    runIdFor,
    unattestedBelow,
    writeTargetReport,
} from "./internal/reports.js";
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
    TargetUnlockReport,
} from "./types.js";

/** The exec/ spawn function shape (injectable for tests). */
type ExecFn = (bin: string, args: readonly string[], options?: ExecOptions) => Promise<ExecResult>;

/** Injectable seams for tests; every field has a production default. */
export interface BackupkitDeps {
    /** Clock. Default `() => new Date()`. */
    now?: () => Date;
    /** Runtime dir override (agent socket home). Default (root) /run/backupkit on Linux, /var/db/backupkit/agent on macOS (/var/run is group-writable); else $XDG_RUNTIME_DIR/backupkit, else ~/.backupkit/run. */
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

/**
 * Build the `logging.file` append sink, made fail-safe: a log line must never
 * be able to kill the process that emits it. The daemon can lose write access
 * to its log file for reasons that have nothing to do with backups (a stale
 * systemd `ReadWritePaths` after the log path moved, a full or remounted
 * filesystem), and an unguarded `appendFileSync` would throw out of whatever
 * call site happened to log - including out of the scheduler's own error
 * handler, ending the daemon. On the first failure the sink reports once on
 * stderr (which journald/launchd still capture) and disables itself.
 *
 * The open is `O_NOFOLLOW` and creates at 0600. Without it the append follows a
 * symlink at `path`, so a local user who can plant one in the log directory
 * turns every log line into a root-privileged append to a file of their
 * choosing (`/etc/sudoers.d/...`, an `authorized_keys`), and the default
 * `0666 & ~umask` would leave config- and remote-derived text world-readable.
 * `checkFilePermissions` refuses a group/other-writable log directory, which
 * closes the intermediate-component half; this closes the final component,
 * where ELOOP lands in the catch below and disables file logging loudly rather
 * than writing through the link.
 */
function fileSinkFor(path: string): (line: string) => void {
    const appendNoFollow =
        fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_APPEND | fsConstants.O_NOFOLLOW;
    let live = true;
    return (line): void => {
        if (!live) {
            return;
        }
        let fd: number | null = null;
        try {
            fd = openSync(path, appendNoFollow, 0o600);
            writeSync(fd, line + "\n");
        } catch (error) {
            live = false;
            // Written straight to stderr, not through the logger: routing this
            // through Logger would re-enter the sink that just failed.
            process.stderr.write(
                `backupkit: logging.file ${path} is not writable (${sanitize(
                    error instanceof Error ? error.message : String(error),
                )}) - file logging disabled for this process; stdout/stderr logging continues\n`,
            );
        } finally {
            // Every line opens and closes its own descriptor; without this a
            // long-running daemon leaks one per log line until EMFILE.
            if (fd !== null) {
                try {
                    closeSync(fd);
                } catch {
                    // A descriptor we cannot close is not worth failing a log write over.
                }
            }
        }
    };
}

/**
 * How many log lines are held while `logging.file` is still unjudged. Only the
 * constructor's config warnings and whatever a verb logs before its preflight
 * land here, so the cap is a memory backstop for a process that never
 * preflights (`status`), not a working buffer.
 * ponytail: fixed 512 - a knob only if some verb ever logs more than that
 * before its gate.
 */
const PENDING_LOG_LINES_MAX = 512;

/** The default runtime directory for the given identity (spec section 4). */
export function defaultRuntimeDir(
    env: Record<string, string | undefined>,
    euid: number | null,
    home: string,
    platform: NodeJS.Platform,
): string {
    if (euid === 0) {
        // Linux keeps /run (a tmpfs the systemd unit's RuntimeDirectory= owns;
        // /run is 0755 root-owned, so its child passes the parent-writability
        // check). macOS has NO private runtime dir: /run is absent and /var/run
        // is 0775 (group 'daemon' writable), which the parent-writability check
        // in ssh/permissions.ts correctly refuses - a group-writable parent lets
        // another account swap the socket dir. So on macOS the agent socket
        // lives inside backupkit's OWN 0700 tree under /var/db (which is 0755
        // root:wheel), never under /var/run. Do not move this back to /var/run.
        return platform === "darwin" ? "/var/db/backupkit/agent" : "/run/backupkit";
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

    /** The real `logging.file` append sink, or null when file logging is off. */
    private fileSink: ((line: string) => void) | null = null;

    /** Set once the preflight has judged `logging.file`; until then the sink only buffers. */
    private logFileTrusted = false;

    /** Lines logged before that judgement, flushed by it (capped at PENDING_LOG_LINES_MAX). */
    private readonly pendingLogLines: string[] = [];

    /** The runtime directory holding the agent socket. */
    private readonly runtimeDir: string;

    /** The backupkit agent socket after preflight, or null (all-alias / local-only config). */
    private agentSock: string | null = null;

    /** Memoized preflight, cleared on failure so a fixed environment can retry. */
    private preflightPromise: Promise<void> | null = null;

    /** Memoized local rsync probe. */
    private rsyncProbe: Promise<{ bin: string; version: string }> | null = null;

    /** Memoized remote rsync probes per connection identity + probed binary (failures clear the memo so a fixed host re-probes next run). */
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

    /** Set by `stop()`; makes a stop that lands before the scheduler exists still prevent the loop. */
    private stopRequested = false;

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
                fileSink: config.logging.file === null ? undefined : this.deferredFileSink(config.logging.file),
            });
        this.backoff = new BackoffTracker(this.log);
        this.runtimeDir =
            deps.runtimeDir ??
            defaultRuntimeDir(this.deps.env, this.deps.permissionDeps.euid, this.deps.env.HOME ?? homedir(), process.platform);
        for (const warning of config.warnings) {
            this.log.warn(warning);
        }
    }

    /**
     * The `logging.file` sink, held CLOSED until `checkFilePermissions` has
     * judged the path (invariant 8: nothing privileged before the gate). The
     * constructor wires the sink and then immediately emits `config.warnings`, so
     * the first thing every verb used to do as root was
     * `openSync(path, O_CREAT|O_APPEND, 0600)` plus a write - upstream of the
     * config-file permission row and of `checkLoggingFile`. With a
     * group/other-writable config that turned `"logging": {"file": "<anything>"}`
     * into a root-owned 0600 file at an attacker-chosen path, or an append to an
     * existing root-owned one (`/etc/sudoers.d/*` -> parse error -> sudo refuses
     * everything). `O_NOFOLLOW` only closed the symlink variant of that; nothing
     * closed the direct path.
     *
     * Buffering rather than dropping the sink, because the alternative loses the
     * config warnings entirely - they are emitted before any verb runs, and they
     * are exactly what an operator needs. It also keeps the fail-safe property
     * intact: the buffer and the flush cannot throw, so a log line still cannot
     * kill the call site that logged it. Lines held by a process that never
     * preflights (`status`) are dropped at exit; stdout/stderr logging carries
     * them regardless.
     */
    private deferredFileSink(path: string): (line: string) => void {
        this.fileSink = fileSinkFor(path);
        return (line): void => {
            if (this.logFileTrusted) {
                this.fileSink?.(line);
                return;
            }
            if (this.pendingLogLines.length < PENDING_LOG_LINES_MAX) {
                this.pendingLogLines.push(line);
            }
        };
    }

    /** Open the log sink and drain everything buffered before the gate passed. Never throws (the sink swallows its own failures). */
    private trustLogFile(): void {
        this.logFileTrusted = true;
        const sink = this.fileSink;
        const pending = this.pendingLogLines.splice(0);
        if (sink === null) {
            return;
        }
        for (const line of pending) {
            sink(line);
        }
    }

    /**
     * Ensure agent + keys + permission checks (spec section 4; alias remotes
     * skip key priming; a config with no explicit remote starts no agent).
     * Idempotent; called by run/start. Never prompts without a TTY.
     *
     * `serviceMode` marks this process as the installed service (what
     * `backupkit daemon` passes): a passphrase-protected key is then a fatal
     * startup error instead of a per-remote failure, because no unattended
     * process can ever unlock one. Memoized with the first call's options.
     */
    preflight(options?: { serviceMode?: boolean }): Promise<void> {
        if (this.preflightPromise === null) {
            this.preflightPromise = this.runPreflight(options?.serviceMode === true);
            this.preflightPromise.catch(() => {
                this.preflightPromise = null;
            });
        }
        return this.preflightPromise;
    }

    /** The actual preflight work behind the memoization. */
    private async runPreflight(serviceMode: boolean): Promise<void> {
        const remotes = Object.values(this.config.remotes);
        const localRoots = [...new Set(this.config.targets.filter((t) => t.dst.kind === "local").map((t) => t.dst.path))];
        await checkFilePermissions(
            {
                configPath: this.config.configPath,
                stateDir: this.config.stateDir,
                runtimeDir: this.runtimeDir,
                loggingFile: this.config.logging.file,
                localDestinationRoots: localRoots,
                remotes,
            },
            this.deps.permissionDeps,
        );
        // The log path has now been judged (`checkLoggingFile`): open the sink
        // and drain what was logged before this point.
        this.trustLogFile();
        // Key priming is per-remote fault-isolated (spec section 4 step 5): a
        // remote whose key cannot be primed lands in keyFailures and only its
        // targets fail in the run loop - preflight still succeeds, so the daemon
        // and every other target keep running (no crash loop).
        const keys = await this.deps.loadKeysFn(remotes, {
            runtimeDir: this.runtimeDir,
            log: this.log,
            hasTty: this.deps.hasTty,
            serviceMode,
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

    /**
     * The complete `-e` command for rsync: the ssh BINARY followed by
     * `sshArgs`' options, or [] when no remote is involved.
     *
     * `sshArgs` returns options only - it is shared with `runRemote`, which
     * spawns ssh directly and supplies the binary itself. rsync's `-e` value is
     * a whole command line, so handing it the bare option list made rsync try to
     * exec `-o` ("Failed to exec -o: No such file or directory", exit 14) and
     * every remote transfer, estimate and restore failed. THE one producer of
     * that command - the transfer path and restore both come through here, so
     * they cannot drift apart again.
     *
     * Being a command string is also why every token has to be free of
     * whitespace and quotes: rsync word-splits the value, so one space turns the
     * remainder of a token into EXTRA ssh arguments. `validate.ts` enforces that
     * on every explicitly-written path, but the default `knownHostsFile` is
     * synthesized from `configPath` downstream of that gate - which made
     * `--config "/tmp/a -o ProxyCommand=/tmp/evil/x/config.jsonc"` emit the token
     * `-o ProxyCommand=/tmp/evil/x/known_hosts` and ssh execute it as root
     * (config.ts now refuses such a path). This is the boundary assertion for the
     * NEXT path that reintroduces whitespace: throw here, never sanitize - a
     * silently rewritten known_hosts or identity path is a host-key check
     * pointed at the wrong file.
     */
    private sshCommandFor(remote: ResolvedRemote | null): string[] {
        if (remote === null) {
            return [];
        }
        const tokens = [this.sshBin(), ...sshArgs(remote, "unattended")];
        for (const token of tokens) {
            if (/[\s'"]/.test(token)) {
                throw new ConfigError(
                    `refusing to build the rsync -e command for remote ${remote.name}: token "${sanitize(token)}" ` +
                        "contains whitespace or quote characters, which rsync would split into further ssh arguments",
                );
            }
        }
        return tokens;
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

    /**
     * Open the snapshot store for a target in the given ssh context. `signal`
     * is the graceful-shutdown signal: passing it makes the store's remote
     * commands abortable, which is what keeps a stop inside the unit's
     * `TimeoutStopSec` even when the archive host has gone unresponsive.
     */
    private storeFor(target: ResolvedTarget, context: SshContext, signal?: AbortSignal): SnapshotStore {
        const log = this.log.with({ target: target.name });
        return openStore(
            { name: target.name, dst: target.dst, jail: target.jail },
            {
                log,
                now: this.deps.now,
                ssh:
                    target.dst.kind === "remote"
                        ? {
                              sshBin: this.sshBin(),
                              context,
                              authSock: this.authSockFor(target.dst.remote),
                              signal,
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
            // The digit test has no length bound: a hostile `df` answering 400
            // digits parses to Infinity, which would make a percent minFree
            // floor infinite (or, on the free-bytes side, pass unconditionally).
            const bytes = Number(tokens[pctIndex - 3]) * 1024;
            return Number.isSafeInteger(bytes) ? bytes : null;
        } catch {
            return null;
        }
    }

    /** The newest complete snapshot name of a target, or null when the archive is empty. */
    private async newestComplete(target: ResolvedTarget): Promise<string | null> {
        return (await this.storeFor(target, "unattended").listComplete()).at(-1) ?? null;
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

    /**
     * A report for a run that never entered the pipeline: an unavailable
     * remote, a throttled disk-low re-check, a held destination lock, or a due
     * check that could not reach the archive. Every one of those paths MUST
     * produce a report - a target that silently never runs is the failure mode
     * `status()` exists to make impossible.
     */
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
     * The probed remote rsync version for a target's remote, memoized so the
     * floor costs one ssh round-trip per host+binary per process (invariant 11
     * on the transfer path). A failed probe clears the memo, so a fixed or
     * upgraded host is re-probed on its next run.
     *
     * The memo key includes `rsync.remoteRsyncBin`, because that is a
     * per-TARGET setting: two targets may share one remote while pointing
     * `--rsync-path` at different binaries, and a host-only key would let one
     * target's probe stand in for the other's - leaving a binary the transfer
     * really uses never checked against the floor.
     */
    private remoteRsyncFor(target: ResolvedTarget, remote: ResolvedRemote): Promise<string> {
        const identity = remoteIdentity(remote);
        const key = `${identity}\0${target.rsync.remoteRsyncBin ?? ""}`;
        let probe = this.remoteProbes.get(key);
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
            this.remoteProbes.set(key, probe);
            probe.catch(() => this.remoteProbes.delete(key));
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
            const deps: TargetRunnerDeps = {
                store: this.storeFor(target, "unattended", options.signal),
                log: this.log.with({ target: target.name }),
                now: this.deps.now,
                rsyncBin: bin,
                sshTokens: this.sshCommandFor(remoteOf(target)),
                env: this.childEnvFor(target),
                transfer: this.deps.transfer,
                estimate: this.deps.estimate,
                execFn: this.deps.execFn,
                totalBytes: () => this.totalBytesFor(target),
                diskLowTargets: this.diskLowTargets,
                previousStats: async () =>
                    newestStats(await readTargetReports(this.config.stateDir, target.name, this.log)),
                previousHistory: async () =>
                    newestHistoryMark(await readTargetReports(this.config.stateDir, target.name, this.log)),
            };
            try {
                report = await runTarget(target, deps, options);
            } catch (error) {
                // LockHeldError is the one error the pipeline lets escape. It used
                // to escape here too, unrecorded: the scheduler logged a warn and
                // continued, so a target stuck behind a lock nobody releases (a
                // future-dated remote marker, an operator's forgotten manual run)
                // kept reporting `lastResult: success` with 0 failures forever.
                // The report is written first, then the error is rethrown - the
                // invocation-aborting semantics are unchanged.
                if (!isBackupkitError(error) || error.code !== "lock-held") {
                    throw error;
                }
                const held = this.syntheticReport(target, "skipped", "lock-held", sanitize(error.message));
                if (options.dryRun !== true) {
                    await this.ensureBackoffState(target);
                    await writeTargetReport(this.config.stateDir, held);
                }
                throw error;
            }
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

    /**
     * The run() pass over the selected targets, threaded with the abort signal.
     *
     * A lock held on ONE target is contained to that target, exactly as the
     * scheduler's tick has always contained it: the pipeline lets `LockHeldError`
     * escape, `runOne` records the skipped report for the locked target, and the
     * pass moves on to the next one. Letting it unwind the invocation meant every
     * LATER target of a one-shot `backupkit run` silently never ran - no report,
     * no log line naming it - so `status` showed them with their last successful
     * snapshot, `success`, 0 failures, while a remote lock nobody releases kept
     * them from backing up for weeks.
     *
     * The invocation's own outcome is unchanged: the first lock-held error is
     * rethrown once the pass has finished, so `backupkit run` still exits 3 and a
     * cron wrapper still alarms.
     */
    private async runPass(
        startedAt: string,
        signal: AbortSignal,
        options: { targets?: string[]; force?: boolean; dryRun?: boolean },
    ): Promise<RunReport> {
        const reports: TargetRunReport[] = [];
        let lockHeld: unknown = null;
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
                const newest = await this.newestComplete(target);
                const newestDate = newest === null ? null : parseSnapshotName(newest);
                if (!isDue(target.schedule, newestDate, now)) {
                    continue;
                }
            }
            try {
                reports.push(await this.runOne(target, { force: options.force, dryRun: options.dryRun, signal }));
            } catch (error) {
                if (!isBackupkitError(error) || error.code !== "lock-held") {
                    throw error;
                }
                // runOne has already persisted this target's skipped report, so
                // `status` and the backoff history see it; nothing is pushed into
                // `reports` because the rethrow below discards them anyway.
                this.log.warn("destination lock held - target skipped, continuing with the remaining targets", {
                    target: target.name,
                    error: sanitize(error.message),
                });
                lockHeld ??= error;
            }
        }
        if (lockHeld !== null) {
            throw lockHeld;
        }
        return { startedAt, finishedAt: this.deps.now().toISOString(), targets: reports };
    }

    /**
     * Foreground scheduler loop; resolves after `stop()` completes. A `stop()`
     * that arrives BEFORE the loop exists (during preflight or backoff
     * rehydration - both do real I/O, and the daemon wires its signal handlers
     * before either) still counts: it would otherwise be a no-op that leaves the
     * process ignoring SIGTERM and then starting backups anyway.
     */
    async start(): Promise<void> {
        if (this.startPromise !== null) {
            return this.startPromise;
        }
        await this.preflight();
        for (const target of this.config.targets) {
            await this.ensureBackoffState(target);
        }
        if (this.stopRequested) {
            // Consumed here so a later start() is unaffected - the request
            // applies to the one startup it interrupted, nothing more.
            this.stopRequested = false;
            this.log.info("stop requested during startup - not starting the scheduler");
            return;
        }
        this.abortController = new AbortController();
        const signal = this.abortController.signal;
        this.scheduler = new Scheduler({
            targets: this.config.targets.filter((t) => t.enabled),
            log: this.log,
            now: this.deps.now,
            tickMs: this.deps.tickMs,
            backoff: this.backoff,
            listNewest: (target) => this.newestComplete(target),
            runTarget: (target) => this.runOne(target, { signal }),
            recordOutcome: async (target, status, reason, error) => {
                const report = this.syntheticReport(target, status, reason, sanitize(error));
                await this.ensureBackoffState(target);
                await writeTargetReport(this.config.stateDir, report);
                this.backoff.record(target.name, report.status, new Date(report.finishedAt));
            },
        });
        this.startPromise = this.scheduler.start().finally(() => {
            this.scheduler = null;
            this.startPromise = null;
            this.abortController = null;
            this.stopRequested = false;
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
        this.stopRequested = true;
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

    /**
     * List complete snapshots, oldest first, per target in config order.
     *
     * Preflights first: for a push target `listComplete()` is an ssh round-trip,
     * and invariant 8 puts the permission gate before ANY network I/O. Without
     * it this verb and `prune` were the two siblings that would happily open ssh
     * with a world-readable private key and report success, so the operator's
     * evidence that the archive is healthy came from precisely the paths that
     * skipped the check.
     */
    async listSnapshots(options: { targets?: string[] } = {}): Promise<SnapshotInfo[]> {
        await this.preflight();
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

    /**
     * Clear a leaked destination lock, per target in config order.
     *
     * The escape hatch for the one lock state nothing else can resolve: a
     * remote lock has no pid to probe, so a holder killed before its release
     * blocks the target until the 24 h TTL - and one killed inside the
     * acquire window blocks it forever. Before this verb the only cure was an
     * ssh session and an `rm -rf` typed by hand against a live archive root.
     *
     * A LIVE lock is reported and left alone unless `force`: "held" means a
     * pipeline may be writing into that root right now, and two pipelines over
     * one root is the exact thing the lock prevents. One target's failure never
     * stops the rest - it is reported as `failed` and the loop continues, the
     * same shape `prune` uses.
     *
     * Preflights first: clearing a push target's lock is an ssh round-trip, and
     * invariant 8 puts the permission gate before ANY network I/O.
     */
    async unlock(options: { targets?: string[]; force?: boolean } = {}): Promise<TargetUnlockReport[]> {
        await this.preflight();
        const rows: TargetUnlockReport[] = [];
        for (const target of this.selectTargets(options.targets)) {
            try {
                const outcome = await this.storeFor(target, "unattended").unlock(options.force === true);
                rows.push({
                    target: target.name,
                    status: outcome.status,
                    detail: outcome.status === "none" ? "" : outcome.detail,
                });
                if (outcome.status === "removed") {
                    this.log.warn("lock cleared by hand", { target: target.name, detail: outcome.detail });
                }
            } catch (error) {
                const message = sanitize(error instanceof Error ? error.message : String(error));
                this.log.error("unlock failed", { target: target.name, error: message });
                rows.push({ target: target.name, status: "failed", detail: message });
            }
        }
        return rows;
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
        // Invariant 11: restore's rsync talks to the remote as SENDER - the
        // server-to-client-write direction the >= 3.2.5 floor exists for. Every
        // scheduled transfer gates on this probe; restore used to be the one
        // sibling entrypoint that skipped it.
        if (target.dst.kind === "remote") {
            try {
                await this.remoteRsyncFor(target, target.dst.remote);
            } catch (error) {
                throw new RestoreError(
                    `remote rsync check failed for ${target.dst.remote.name} - refusing to restore: ${sanitize(
                        error instanceof Error ? error.message : String(error),
                    )}`,
                );
            }
        }
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
            // A root that does not exist yet (a configured target that has never
            // run) still has to be honored: skipping it on a failed realpath let
            // `restore web --output /srv/B/out` write straight into target B's
            // archive root. Every ResolvedConfig path is already normalized, so
            // the literal prefix comparison is the correct fallback.
            const realRoot = await realpath(root).catch(() => resolve(root));
            if (realParent === realRoot || realParent.startsWith(realRoot + sep)) {
                throw new RestoreError(`output ${output} resolves inside the archive root ${root} - choose a path outside every archive`);
            }
        }

        // The snapshot endpoint on the destination side.
        const snapEndpoint: Endpoint =
            target.dst.kind === "local"
                ? { kind: "local", path: join(target.dst.path, target.name, snapshot) }
                : { kind: "remote", remote: target.dst.remote, path: posix.join(target.dst.path, target.name, snapshot) };
        const sshTokens = this.sshCommandFor(target.dst.kind === "remote" ? target.dst.remote : null);
        const env =
            target.dst.kind === "remote" && this.authSockFor(target.dst.remote) !== null
                ? { ...minimalEnv(), SSH_AUTH_SOCK: this.authSockFor(target.dst.remote) as string }
                : undefined;
        const remoteArgs = sshTokens.length === 0 ? [] : ["-e", sshTokens.join(" ")];
        const src = formatEndpoint(snapEndpoint) + "/";

        // Restore writes with the SAME hardening ingest applies (invariant 12).
        // `-a` implies -p and -D, so without these a snapshot holding a
        // setuid-root binary or a /dev/mem node - which a compromised push
        // source CAN place in its own archive, since the client's --chmod never
        // reaches the server argv - would be faithfully recreated by a root
        // `backupkit restore`. The output is deliberately forced outside every
        // archive root, so the nosuid/nodev mount that covers the archive cannot
        // cover it either. `preserveDevices` is honored exactly as on ingest.
        const hardening = ["--numeric-ids", "--chmod=ug-s"];
        if (!target.rsync.preserveDevices) {
            hardening.push("--no-devices", "--no-specials");
        }

        // The copy: never --delete, symlinks copied as symlinks, awaited and exit-checked.
        const { bin } = await this.localRsync();
        const copy = await this.deps.execFn(bin, ["-a", "--sparse", "-H", ...hardening, ...remoteArgs, src, output], {
            env,
        });
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
                ["-a", "--checksum", "--dry-run", "--itemize-changes", ...hardening, ...remoteArgs, src, output],
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

    /**
     * Apply retention now (or plan only with `dryRun`). This is also the
     * operator's override for the pipeline's content-collapse tripwire: a run
     * that tripped it promotes but prunes nothing, and `prune` is what clears
     * the backlog once a human has confirmed the shrink is real.
     */
    async prune(options: { targets?: string[]; dryRun?: boolean; force?: boolean } = {}): Promise<PruneReport> {
        // Before any ssh: this verb DELETES, so invariant 8's "fail closed on
        // permissive modes before any network I/O" matters here more than
        // anywhere. See listSnapshots for the sibling-path history.
        await this.preflight();
        const reports: TargetPruneReport[] = [];
        for (const target of this.selectTargets(options.targets)) {
            const store = this.storeFor(target, "unattended");
            const errors: string[] = [];

            // The past-dated-insertion guard, on the operator's path too.
            //
            // The run pipeline skips retention when names appear below the
            // previous run's newest, but `prune` is the documented way to clear
            // that state - so it cannot simply refuse, or an operator would be
            // left with a tripwire and no way out. It also cannot quietly
            // proceed: retention selects on names, so a poisoned listing makes
            // prune delete the REAL history (measured: 10 of 11) while the
            // planted names take every keep slot.
            //
            // So: detect, refuse by default, and require `--force`. The operator
            // reviews `--dry-run` (which prints the full keep/prune plan and
            // therefore SHOWS real snapshots queued for deletion), then decides.
            // That turns a silent deletion into an authorised one.
            //
            // Deliberately NOT "delete the unattested names and keep the rest":
            // run reports rotate, so a genuine snapshot older than the report
            // window is unattested exactly like a plant. The count knows HOW MANY
            // names appeared, never WHICH - so naming suspects is best-effort
            // context for a human, never grounds for the machine to delete.
            const complete = await store.listComplete();
            const targetReports = await readTargetReports(this.config.stateDir, target.name, this.log);
            const mark = newestHistoryMark(targetReports);
            const insertion = detectHistoryInsertion(complete, mark);
            if (insertion !== null && options.force !== true) {
                const suspects = mark === null ? [] : unattestedBelow(complete, targetReports, mark);
                this.log.error("refusing to prune: snapshots appeared below the previous run's newest", {
                    target: target.name,
                    previousNewest: sanitize(insertion.previousNewest),
                    previousCount: insertion.previousCount,
                    count: insertion.count,
                });
                errors.push(
                    `${insertion.count - insertion.previousCount} snapshot(s) appeared at or below ` +
                        `${sanitize(insertion.previousNewest)} since the last run recorded ${insertion.previousCount} ` +
                        `there - this client only ever creates snapshots dated now, so something else wrote into the ` +
                        `archive. Retention selects on names, so pruning now may delete real history instead of the ` +
                        `additions.` +
                        (suspects.length === 0
                            ? ""
                            : ` Not created by any recorded run (best effort - reports rotate): ` +
                              `${suspects.slice(0, 10).map(sanitize).join(", ")}.`) +
                        ` Review with \`backupkit prune --dry-run\`, remove anything that is not yours, then re-run ` +
                        `with --force to prune anyway.`,
                );
                // --dry-run must still SHOW the plan: it is the review step this
                // very message sends the operator to, and a refusal that also
                // refuses to explain itself is a dead end.
                const plan = options.dryRun === true ? this.planFor(complete, target) : { keep: [], prune: [] };
                reports.push({ target: target.name, plan, executed: false, errors });
                continue;
            }

            if (options.dryRun === true) {
                const plan = this.planFor(complete, target);
                reports.push({ target: target.name, plan, executed: false, errors });
                continue;
            }
            const plan = await store.withLock(async () => {
                const inner = this.planFor(await store.listComplete(), target);
                // There is no "would remove all snapshots" check here: the floor
                // is planRetention always claiming a "newest" plus the store's own
                // newest-complete guard (`newestUndeletable`), which no plan can
                // talk past. A `keep.length === 0` test was unreachable code.
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
     * The retention plan for one target over a store listing: the policy runs on
     * the genuinely-dated names, and future-dated names are appended to the
     * prune list - but only while genuine history exists, so a target whose only
     * snapshot is future-dated keeps it rather than losing its last copy.
     */
    private planFor(names: string[], target: ResolvedTarget): RetentionPlan {
        const { genuine, future } = splitFutureSnapshots(names, this.deps.now());
        const plan = planRetention(genuine, target.retention, this.deps.now());
        if (future.length === 0) {
            return plan;
        }
        if (genuine.length === 0) {
            // Nothing genuine to fall back on: the future-dated names may hold the
            // only copy of the data (a snapshot this host wrote while its clock was
            // wrong), so they are kept and shown as such, never pruned.
            this.log.error("every snapshot of this target is dated in the future - keeping them; check this host's clock", {
                target: target.name,
                snapshots: future.slice(0, 10).join(", "),
            });
            return { keep: [...future].reverse().map((name) => ({ name, reasons: ["future-dated"] })), prune: [] };
        }
        // Newest first, like every RetentionPlan: the future-dated names sort
        // after everything genuine, so they lead the list reversed.
        return { keep: plan.keep, prune: [...[...future].reverse(), ...plan.prune] };
    }

    /**
     * Readiness gate (spec section 7): verify local binaries + versions, run
     * the interactive key flow, probe each remote (TOFU pinning happens by
     * running the probe in interactive context on a TTY), resolve aliases via
     * `ssh -G`, and produce jail-line DATA for push targets with the jail
     * enabled (`jail: false` targets are omitted; the jail is never probed) -
     * printing is the CLI's job.
     *
     * The trust gate runs FIRST, and a failed gate ENDS the verb (invariant 8).
     * Two bugs lived in the old order. The local probes came before
     * `preflight()`, so `rsyncBin`/`sshBin` - values read from a config the gate
     * had not yet judged - were SPAWNED as root: with a group/other-writable
     * config a local user set `"rsyncBin": "/tmp/evil"` and the next
     * `backupkit check` (the very command `init` tells the operator to run) ran
     * their binary. And a failed gate was merely collected into `errors[]`,
     * after which check went on to open ssh to every remote with the key and
     * `known_hosts` it had just condemned - on a TTY pinning fresh host keys into
     * an untrusted pin store.
     *
     * `check` is still the diagnostic verb, so it reports as much as it can
     * rather than throwing on the first problem: the gate failure and every
     * per-remote key-priming failure land in `errors[]` and the caller gets a
     * complete `ok: false` report. What it must not do is act on an untrusted
     * config, so once the gate has failed there is no spawn, no ssh, and no
     * reading of config-named files (the `.pub` sidecar included) - the report
     * comes back with the local rows unknown and no remote rows at all.
     */
    async check(): Promise<CheckReport> {
        const errors: string[] = [];
        try {
            await this.preflight();
            // Per-remote priming failures do not fail preflight (fault isolation),
            // but check() is the diagnostic surface: report each one loudly.
            for (const [remoteName, message] of this.keyFailures) {
                errors.push(`remote ${remoteName}: ${message}`);
            }
        } catch (error) {
            errors.push(sanitize(error instanceof Error ? error.message : String(error)));
            return { ok: false, localRsync: null, sshOk: false, remotes: [], jailLines: [], errors };
        }

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
            // EVERY distinct remote rsync binary in play on this remote is
            // probed, not just the first override: `remoteRsyncBin` is a
            // per-target setting, so two targets on one host can use different
            // binaries, and checking one of them would leave the other's floor
            // (invariant 11) unverified until a transfer used it. The row
            // reports the first accepted version; any failure is an error.
            const binsInUse = [
                ...new Set(
                    this.config.targets
                        .filter((t) => remoteOf(t)?.name === remote.name)
                        .map((t) => t.rsync.remoteRsyncBin),
                ),
            ];
            const remoteRsyncBins = binsInUse.length === 0 ? [null] : binsInUse;
            // Invariant 5: accept-new (TOFU pinning) only while a human watches a
            // real TTY; any non-TTY check() pins strictly like every unattended path.
            const context: SshContext = this.isInteractive() ? "interactive" : "unattended";
            for (const remoteRsyncBin of remoteRsyncBins) {
                try {
                    const version = await this.deps.probeRemote({
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
                    row.rsyncVersion = row.rsyncVersion ?? version;
                    row.reachable = true;
                } catch (error) {
                    const message = sanitize(error instanceof Error ? error.message : String(error));
                    row.error = row.error ?? message;
                    row.reachable = false;
                    errors.push(`remote ${remote.name}: ${message}`);
                }
            }
            remoteChecks.push(row);
        }

        const jailLines: JailLine[] = [];
        for (const target of this.config.targets) {
            if (target.dst.kind !== "remote" || !target.jail) {
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
