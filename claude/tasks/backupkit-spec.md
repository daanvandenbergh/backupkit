# backupkit - Final Specification (v4)

## Revision notes (v4)

**Adopted (owner directives):**
- **SSH alias remotes.** `RemoteConfig` becomes a discriminated union: an **explicit** remote (`host` + `user` + `identityFile`, optional `port`/`passphrase`/`knownHostsFile` - unchanged) OR an **alias** remote, `{ alias: "myserver" }`, resolved entirely by ssh from the user's ssh_config. Decided minimally: `alias` admits NO sibling fields - overrides live in ssh_config; wanting per-field control means writing an explicit remote. `passphrase` therefore remains valid only alongside `identityFile` by construction. In alias mode `sshArgs` injects no `-i`, `-p`, `-o IdentitiesOnly`, `-o PreferredAuthentications`, or `-o UserKnownHostsFile`; the non-negotiable no-hang baseline (`BatchMode=yes`, `ConnectTimeout`, `ServerAlive*`, `LogLevel=ERROR`) plus contextual `StrictHostKeyChecking` is STILL always injected - command-line `-o` overrides ssh_config, so the guarantee survives a lax user config. Alias remotes use the **user's default known_hosts** (whatever ssh resolves for that alias), not the dedicated file: the user's ssh_config already owns host-key state for that alias, and a second file would orphan existing pins and make `ssh myserver` and backupkit disagree about the same host. The contextual policy is unchanged in strength: strict when unattended, TOFU (`accept-new`) only during an interactive `check`, mismatch fatal everywhere, `StrictHostKeyChecking=no` unrepresentable. Agent priming is **skipped** for alias remotes (the user's ssh_config/agent setup is authoritative; `SSH_AUTH_SOCK` is inherited verbatim for alias connections); `check` probes connectivity under BatchMode, prints the `ssh -G`-resolved hostname/user/port per alias, and turns an auth failure into an actionable message. Permission preflight in alias mode checks only what backupkit owns (config, stateDir, runtimeDir, destination roots) - ssh enforces its own files. Push-jail lines for alias remotes: `check` prints the exact `restrict,command=...` prefix plus the instruction to append the public key the alias authenticates with. New security invariant 14; endpoint formatter, validator, starter config, failure matrix, and test tables extended.
- **CLI ease + full daemon lifecycle.** `backupkit service` grows to `install | uninstall | start | stop | restart | status`: start/stop/restart drive `systemctl`/`launchctl` for the installed unit, all idempotent, every "cannot" message naming the exact next command; `service status` merges unit state with the engine's per-target status. New `backupkit logs [-f/--follow] [-n N]`: `journalctl -u backupkit` on Linux, `tail` of the launchd log files on macOS, inherited stdio, exit code passed through. Ease pass over section 7: bare `backupkit` prints a short task-oriented help (exit 0) headed by the documented 3-step setup `init` -> `check` -> `service install`; `ls` becomes an alias of `list` (the one zero-cost alias); unknown subcommand/target errors list the valid names. Surface stays `parseArgs` + the static dispatch table; exit-code set unchanged; `--json` scope unchanged (`status`, `list` only). `service`/`logs` spawn through `exec/` with inherited stdio and no timeout - the one documented exec exception, still argv arrays and `shell: false`.

## Revision notes (v3)

**Adopted (owner directives):**
- Schedule becomes a plain structured object: `schedule?: { interval: "minute" | "hour" | "day" | "week" | "month"; intervalCount?: number; at?; on?; dayOfMonth? }` with `intervalCount` defaulting to 1. The v2 string grammar is deleted. Two NEW intervals: `minute` (high-frequency targets) and `month` - done right: calendar-month windows in UTC via months-since-epoch indexing, never a 30.5-day approximation. Anchors kept minimal: `at: "HH:MM"` (day/week/month), `on` weekday (week, doubles as the week anchor), `dayOfMonth` 1-28 (month; 28 caps so the day exists in every month - no clamping). Exact validation matrix in section 2; window math in section 6 / `shared/time.ts`; starter config updated. Schedules and retention stay independent: retention keeps its hourly..yearly tiers; for minute/hour schedules `keepLast`/`keepHourly` govern sub-daily density.
- Transfer retry strengthened: default **5 attempts** total, delay before attempt k = `min(15s * 2^(k-2), 300s)` with ±20% jitter, always resuming into the same `.partial`. Exactly ONE new config knob: `retry?: { attempts?: number }` (integer 1-10, default 5) - delays are fixed, not configurable.
- One transient-retry helper `shared/retry.ts` (`withTransientRetry`) now also wraps every short remote operation - remote version probe, remote store list/mkdir/mv/rm/df, ssh connection setup via `runRemote` - at a fixed control policy (3 attempts, 2s/8s ±20% jitter, non-configurable), sharing one classification (`ssh/classify.ts`): exit 255 and exec timeouts are transient unless the sanitized stderr tail matches one of exactly three fixed permanent ssh patterns (auth failure, host-key verification failure, host-key change) - so security invariant 5 stays true at every layer. The lock-acquire `mkdir` is exempt (EEXIST is its signal, retrying it would corrupt contention semantics). A momentary network blip never fails a run at any step.
- Daemon/service restart behavior fully defined: systemd `Restart=on-failure`, `RestartSec=15`, `StartLimitIntervalSec=0` (crash always restarts, clean exit stays down, systemd never gives up); launchd `KeepAlive: { SuccessfulExit: false }`, `ThrottleInterval: 15` (same semantics). New "Restart recovery" subsection in section 6: resume `.partial` via `claimPartial`, re-derive all state from run reports (still no `state.json`), exactly one catch-up run per missed window, automatic re-priming of `file:` passphrase keys, stale-lock takeover. Per-target consecutive-failure backoff keeps its 6 h ceiling - backoff can delay scheduling but never stop it - with an error-level log line on every backoff state transition (enter, extend, clear). Failure matrix extended with control-op blips, daemon crash, host reboot, and crash-loop rows.

**Trimmed (anti-over-engineering sweep - zero cost to security, locking, atomicity, validation, or test rigor):**
- JSONC parser: nodes carry `{ line }` only; the scanner tracks column solely for parse-error messages (`<file>:<line>:<col>` there; validator errors stay `<file>:<line>: <dotted.path>` - unchanged, and dup-key errors still name both lines).
- `--json` survives only on the two commands machines actually consume (`status`, `list`); `run`/`prune`/`check` lose it - the persisted run reports and the printed prune plan are already the machine-readable record.
- `cli/internal/table.ts` and all ANSI color handling deleted; aligned plain text via `padEnd` inline in the two commands that print columns.
- launchd log self-rotation deleted; `service install` on macOS writes a native `/etc/newsyslog.d/backupkit.conf` (removed by `uninstall`); the logger never rotates anything anywhere.
- Run-report retention per target: 200 -> 50 (the backoff derivation needs at most 6).
- Evaluated and deliberately KEPT: duplicate-key rejection, depth cap, disk-guard dry-run pre-pass, opt-in verify mode, structural guard tests - each carries real robustness or security weight.

## Revision notes (v2)

**Adopted:**
- Config is JSONC. Canonical file `config.jsonc` (`config.json` still accepted; both in one directory = `ConfigError`). One hand-rolled recursive-descent parser `config/internal/jsonc.ts`: RFC 8259 plus exactly `//` comments, `/* */` comments (non-nesting), one trailing comma per object/array; duplicate keys fatal (both lines named); nesting depth cap 64; every node carries `{line, col}`; object entries insertion-ordered. `--config`/`$BACKUPKIT_CONFIG` stay verbatim, always parsed as JSONC.
- `ConfigError` messages become `<file>:<line>: <dotted.path>: <problem>` (parse errors `<file>:<line>:<col>: <problem>`).
- `backupkit init` writes a fully commented starter `config.jsonc` from `config/internal/starter.ts`; a test parses + validates the starter so example and schema cannot drift; init stdout shrinks to three lines.
- Push jail `authorized_keys` lines move from `init` to `check`, generated from the real config and real key.
- `unlock-keys` deleted; `check` subsumes it (full key-loading flow, TTY-gated exactly as before, plus `.pub` generation and remote probes).
- `targets` becomes a name-keyed record symmetric with `remotes`; `TargetConfig.name` and the uniqueness cross-rule deleted (parser dup-key rejection is stronger); run order = document order, pinned by the parser's ordered entries.
- `schedule` becomes a string grammar (`"daily at 03:00"`, `"every 6 hours"`, `"weekly on sun at 01:00"`), normalized to the unchanged internal `ScheduleConfig`; the three cross-field veto rules become unsayable.
- `disk?: DiskConfig | false` collapses to `minFree?: string | false`; `DiskConfig` deleted.
- Targets gain `retention?: RetentionConfig | false` (`false` = never prune this target) - uniform "false = mechanism off, on purpose" idiom.
- `bwlimitKbps` replaced by `bwlimit?: string` (size grammar shared with `minFree`, bare number = KiB/s).
- Verb symmetry: `runOnce()` -> `run()`, `daemon()` -> `start()` (pairs with `stop()`), `Backupkit.init()` -> `preflight()`; CLI `daemon install|uninstall|status` -> `service install|uninstall|status`.
- CLI targets become positional arguments everywhere; `--target` deleted; `list`/`status` accept `[TARGET...]` like `run`/`prune`.
- New `Backupkit.status(): Promise<TargetStatus[]>` - the CLI is now a pure view layer; `restore` returns `RestoreReport`; `run()` returns `RunReport { startedAt, finishedAt, targets: TargetRunReport[] }` (per-target file = `TargetRunReport`); `listSnapshots` takes `{ targets?: string[] }`.
- `fromConfig` is synchronous; `LogLevel`/`Weekday` exported string-literal types; `isBackupkitError` guard + closed `BackupkitErrorCode` union.
- `SnapshotStore`: `newestComplete()` deleted (derive from `listComplete()`); `lock()` replaced by `withLock<T>(fn)` - leaking a lock is unrepresentable.
- `state.json` and `engine/internal/state.ts` deleted; backoff counters derived from run reports (rehydrated at daemon start, cached in memory); `aborted` becomes a first-class report status; `stateDir` now holds only run reports.
- One lock mechanism in both stores: atomic `mkdir <root>/.backupkit.lock` + `meta` file; staleness predicates stay asymmetric (local pid+start-time, remote 24h TTL).
- One timestamp codec: `runId = <formatSnapshotName(start)>_<target>`; the compact form deleted; the regex guard test has nothing to exempt.
- One rsync argv builder `buildArgs(spec, mode)` with `mode: "transfer" | "estimate" | "verify"`.
- `Endpoint` type in `shared/types.ts` + single formatter (owns `user@host:` prefixing and IPv6 bracketing); resolution maps each target to `{src, dst}` once; no downstream code inspects `direction`.
- rsync module takes `sshTokens: string[]` as a parameter; the Phase 2 stub interface deleted.
- Shell assets co-located with their owners: `askpass.sh` -> `ssh/internal/`, `backupkit-remote.sh` -> `snapshots/internal/`; WP2.5 folds into WP2.3.
- Module table fixed: `snapshots/` exports only the `SnapshotInfo` type; the store's write surface stays internal (all mutation flows through `Backupkit` verbs).
- Security invariant 13 added (single JSONC reader; duplicate keys fatal); invariant 10 strengthened (jail lines generated only by `check` from the loaded config).

---

`@daanvandenbergh/backupkit` - versioned rsync-over-SSH backups, push and pull, hardlink snapshots, TypeScript ESM, zero runtime dependencies. This document is the single authority; where a specialist section, review, or critique conflicts with it, this document wins.

**Reviewer overrules carried from v1 (one line each):**
- Overruled simplicity #19 (fold `exec` into `shared/`): `shared/` is enforced child_process-free by test; `exec/` stays its own tiny module as the single spawn choke point.
- Overruled coherence #5 partially: the `env:VAR` passphrase form is dropped entirely (security #4 outranks systemd-EnvironmentFile convenience; `file:` under a 0600 root-owned path covers the unattended case).
- Overruled coherence #7 and rsync-engine's 3.1.0 floor: hard floor is rsync >= 3.2.5 on both ends (security #2, CVE-2022-29154 class); platforms below it are refused, not degraded.
- Overruled coherence #19 (full sysexits): 5-code exit set - nothing downstream consumes finer distinctions.
- Overruled both `knownHosts` config proposals: the policy knob is removed from config entirely; strict vs TOFU is contextual (section 4), which is stronger than either draft.

---

## 1. Architecture overview + module map

Nine modules under `src/`. Five exported from `index.ts`; four internal (never re-exported, scribekit `content-store` pattern). Every module: public files at module root, private files in `internal/`, tests in `tests/`. Docstrings on every function/class/interface/property. 4-space indent, NodeNext `.js` import extensions, no `@ts-ignore`.

| Module | Exported | Responsibility |
|---|---|---|
| `shared/` | yes | fs-free, child_process-free primitives: error hierarchy + `isBackupkitError`, `Logger`, snapshot-name codec + THE regex, `Endpoint` type + formatter (explicit and alias forms), UTC interval math (all five schedule intervals incl. months-since-epoch), transient-retry helper (`retry.ts`, timer-only), byte/duration formatting, string sanitization, common types. |
| `exec/` | no | The single `spawn` wrapper. Only module that imports `node:child_process`. argv arrays, `shell: false`, minimal explicit env, timeout, `ExecResult`. Also the `inherit` variant used only by `cli` for `service`/`logs` passthrough (inherited stdio, no timeout, still argv + `shell: false`). |
| `config/` | yes | Config types, the JSONC reader, hand-rolled validator (fail-first, `file:line` + dotted paths, unknown-key rejection at every level), the remote discriminated-shape rule (alias XOR explicit), the schedule-object validation matrix, defaults resolution, path resolution, the commented starter. Pure: reads only the config file itself. |
| `ssh/` | no | Persistent ssh-agent lifecycle, key loading (passphrase via askpass file or TTY), ssh option builder (per remote kind), `runRemote`, transient/permanent failure classification (`classify.ts`), shell-quote helper, file permission checks, known_hosts management (explicit remotes only), `ssh -G` alias resolution display for `check`. Ships `askpass.sh`. |
| `rsync/` | no | rsync argv construction (`buildArgs(spec, mode)`), version probe, exit-code classification, retry loop (via `shared/retry`), `--stats` parsing, `dryRunStats` delta estimation. Takes prebuilt `sshTokens: string[]`. |
| `snapshots/` | yes (types only) | `SnapshotStore` interface with local (fs) and remote (ssh) implementations: list, claimPartial, promote, delete (two-phase), free-space query, `withLock`. Ships `backupkit-remote.sh` (the jail is this store's exact command surface). Only `SnapshotInfo` is public; `SnapshotStore`/`openStore` stay internal so no library user can bypass the lock, retention floors, or newest-snapshot invariant. |
| `retention/` | no | Pure policy: `planRetention(names, rules, now) -> RetentionPlan`. No I/O. |
| `engine/` | yes | `Backupkit` class: run, start/stop, status, restore, list, prune, check, preflight. Owns the per-target pipeline, scheduler, run reports (and the backoff counters derived from them), disk guard decision. |
| `cli/` | no | `bin` entry: `parseArgs` dispatch (positionals + flags + the `ls` alias), output formatting, exit codes, first-run help, systemd/launchctl unit generation AND lifecycle driving (`service install|uninstall|start|stop|restart|status`) plus `logs` in `cli/internal/service/`. A pure view layer over engine methods for everything except service/logs, which are OS-tool passthroughs. |

Dependency graph (strictly acyclic):

```
cli -> engine, config, exec, shared
engine -> config, snapshots, retention, rsync, ssh, shared
snapshots -> ssh, exec, shared
rsync -> ssh, exec, shared
ssh -> exec, shared
retention -> shared        config -> shared        exec -> shared
```

(`cli -> exec` is new in v4 and exists only for the `service` lifecycle verbs and `logs` passthrough; every other CLI command remains a pure view over engine methods.)

File layout:

```
src/
  index.ts                        # re-exports engine + config types + snapshot types + shared errors/logger
  shared/
    errors.ts time.ts snapshot-name.ts logger.ts format.ts sanitize.ts types.ts retry.ts
    tests/                        # incl. purity guard test: shared imports no fs/child_process
  exec/
    exec.ts                       # exec(bin, args, opts): Promise<ExecResult>; opts.stdio "pipe" (default) | "inherit"
    tests/
  config/
    config.ts                     # loadConfig, resolveConfigPath
    types.ts                      # BackupkitConfig, ResolvedConfig, ...
    internal/jsonc.ts internal/validate.ts internal/defaults.ts internal/starter.ts
    tests/
  ssh/
    agent.ts                      # ensureAgent, loadKeys (explicit remotes only)
    ssh.ts                        # sshArgs(remote, mode), runRemote(remote, argv), resolveAlias (ssh -G, check-only)
    permissions.ts                # checkFilePermissions preflight
    classify.ts                   # isPermanentSshStderr - the ONLY stderr inspection in the codebase
    internal/askpass.ts internal/quote.ts
    internal/askpass.sh           # SSH_ASKPASS helper (shipped in dist)
    tests/
  rsync/
    rsync.ts                      # runTransfer, dryRunStats, probeVersions
    internal/args.ts internal/classify.ts internal/stats.ts
    tests/
  snapshots/
    store.ts                      # SnapshotStore + openStore(target)   (both internal to the package surface)
    types.ts                      # SnapshotInfo
    internal/local-store.ts internal/remote-store.ts internal/lock.ts
    internal/backupkit-remote.sh  # push-mode forced-command jail script (shipped in dist)
    tests/
  retention/
    retention.ts                  # planRetention
    tests/
  engine/
    backupkit.ts types.ts
    internal/target-runner.ts internal/scheduler.ts internal/reports.ts internal/disk-guard.ts
    tests/
  cli/
    main.ts                       # shebang entry
    internal/commands/*.ts internal/service/*.ts
    tests/
  testing/                        # dev-only: fake-bin.ts, fixtures.ts (added to tsconfig.build.json exclude)
```

Public API (`index.ts`):

```ts
export class Backupkit {
    /** Load + validate config from path (default: resolveConfigPath()), construct. Synchronous: no I/O beyond the config file. */
    static fromConfig(path?: string): Backupkit;
    /** Construct from an already-resolved config (library use). */
    constructor(config: ResolvedConfig);
    /** Ensure agent + keys + permission checks (section 4; alias remotes skip key priming). Idempotent; called by run/start. Never prompts without a TTY. */
    preflight(): Promise<void>;
    /** Run every due target once (or the named subset). force bypasses due-ness, backoff, and bucket dedup. */
    run(options?: { targets?: string[]; force?: boolean; dryRun?: boolean }): Promise<RunReport>;
    /** Foreground scheduler loop; resolves after stop() completes. */
    start(): Promise<void>;
    /** Graceful stop: abort in-flight transfer, write its aborted report, release locks. */
    stop(): Promise<void>;
    /** One row per target: last snapshot, next due, last result, consecutive failures, lock state. Read-only, always instant. */
    status(options?: { targets?: string[] }): Promise<TargetStatus[]>;
    /** List complete snapshots, oldest first. */
    listSnapshots(options?: { targets?: string[] }): Promise<SnapshotInfo[]>;
    /** Copy one snapshot ("latest" accepted, same resolution rule as the CLI) to a non-existent output path. */
    restore(options: { target: string; snapshot: string; output: string; verify?: boolean }): Promise<RestoreReport>;
    /** Apply retention now. */
    prune(options?: { targets?: string[]; dryRun?: boolean }): Promise<PruneReport>;
    /** Validate config, probe binaries/versions and hosts, run the interactive readiness flow (section 7). TOFU host-key pinning and passphrase prompts happen only on a TTY (stated here because it is a side effect). */
    check(): Promise<CheckReport>;
}
export type { RunReport, TargetRunReport, RestoreReport, PruneReport, CheckReport, TargetStatus } from "./engine/types.js";
export { loadConfig, resolveConfigPath } from "./config/config.js";
export type { BackupkitConfig, ResolvedConfig, TargetConfig, RemoteConfig, ExplicitRemoteConfig, AliasRemoteConfig, ScheduleInput, ScheduleConfig, RetentionConfig, RsyncOptions, LogLevel, Weekday, Interval } from "./config/types.js";
export type { SnapshotInfo } from "./snapshots/types.js";
export { BackupkitError, ConfigError, SshError, TransferError, SnapshotStoreError, LockHeldError, DiskSpaceError, RestoreError, isBackupkitError } from "./shared/errors.js";
export type { BackupkitErrorCode } from "./shared/errors.js";
export { Logger } from "./shared/logger.js";
```

Error hierarchy (`shared/errors.ts`): flat, one subclass per domain, each with a stable `code` typed as the closed union `BackupkitErrorCode = "config" | "ssh" | "transfer" | "snapshot-store" | "lock-held" | "disk-space" | "restore"`, and typed payload fields (`ConfigError` carries `path` + `file` + `line`; `LockHeldError` carries `{pid, hostname}`; `TransferError` carries `{exitCode, retriable, stderrTail}`; `SshError` carries `{retriable}`; `DiskSpaceError` carries `{requiredBytes, freeBytes}`). The `retriable` flag is set only by the classifiers (sections 3-4) and is the sole thing `withTransientRetry` reads. `isBackupkitError(e: unknown): e is BackupkitError` is the supported `catch`-side guard (ESM-safe where `instanceof` across duplicated packages betrays you). Engine policy: `ConfigError` and `LockHeldError` abort the invocation; every other error is per-target, recorded in the `RunReport`, and never escapes the loop.

`shared/types.ts` defines the local/remote seam consumed by rsync, restore, and the disk guard:

```ts
/** One side of a transfer. Config resolution maps each target to {src, dst} once; no code downstream of the resolver inspects direction. */
export type Endpoint =
    | { kind: "local"; path: string }
    | { kind: "remote"; remote: ResolvedRemote; path: string };

/** Resolved remote identity. "explicit" carries every field filled from config; "alias" carries only the ssh_config alias - ssh resolves host, user, key, and port itself. */
export type ResolvedRemote =
    | { kind: "explicit"; name: string; host: string; user: string; port: number; identityFile: string; passphrase: { kind: "file" | "prompt"; value: string } | null; knownHostsFile: string }
    | { kind: "alias"; name: string; alias: string };
```

`shared/format.ts` owns `formatEndpoint(e: Endpoint): string` - the ONLY place `user@host:` prefixing and IPv6 bracketing happen. For an alias remote the endpoint is `<alias>:<path>` - no `user@` prefix, no bracketing (the alias charset cannot contain `:` or `@`, so rsync's host split is unambiguous). `direction` survives in config and reports as the human-facing word only.

`package.json` changes (Phase 1): `bin: { "backupkit": "dist/cli/main.js" }`, `engines: { "node": ">=20" }`, `build` becomes `tsc -p tsconfig.build.json && cp src/ssh/internal/askpass.sh dist/ssh/internal/ && cp src/snapshots/internal/backupkit-remote.sh dist/snapshots/internal/`, `push-and-publish` becomes `npm run build && npm publish` (the current `git add -A` version is hook-blocked). `tsconfig.build.json` excludes gain `src/testing`. Zero runtime dependencies: `node:fs/promises` (`statfs`, `rename`, `mkdir`, `rm`, `mkdtemp`), `node:child_process` (in `exec/` only), `node:util` `parseArgs`, `node:os`, `node:path`. System prerequisites: `rsync >= 3.2.5`, `ssh`, `ssh-agent`, `ssh-add`, `ssh-keygen` (verified by `backupkit check`); `journalctl` (Linux) or `tail` (macOS) for `backupkit logs`.

---

## 2. Config format + schema + example

**JSONC** - RFC 8259 JSON plus exactly three tolerances: `//` line comments, `/* */` block comments, and one optional trailing comma before `}`/`]`. Canonical filename `config.jsonc`; plain `config.json` remains accepted (valid JSON is a strict subset, one parser serves both - the extension is a hint, not a mode). Resolution order, identical for every command (`resolveConfigPath(cliArg?)`):

1. `--config <path>` - used verbatim, any extension; missing file is a `ConfigError`, never a fallthrough.
2. `$BACKUPKIT_CONFIG` env var, same verbatim rule.
3. `/etc/backupkit/` - probe `config.jsonc`, then `config.json`.
4. `${XDG_CONFIG_HOME:-~/.config}/backupkit/` - same probe order.

Both `config.jsonc` and `config.json` present in one probed directory: `ConfigError` naming both paths ("keep one") - never a silent preference. None found: `ConfigError` listing all probed paths and ending `run "backupkit init" to create one`.

### The JSONC reader (`config/internal/jsonc.ts`)

`parseJsonc(text: string, file: string): JsoncNode` - a single hand-rolled recursive-descent parser, ~250 lines, pure, no fs. Objects are represented as insertion-ordered entries (`Map<string, JsoncNode>`); every node carries `{ line }` - the scanner tracks the column too, but only parse-error messages use it (validator errors need `file:line` alone). Grammar = RFC 8259 exactly, plus the three tolerances above. Block comments do not nest; an unterminated block comment or string is a `ConfigError` naming the opening position. Explicitly NOT tolerated, each rejected with a targeted message: single quotes, unquoted keys, multiline strings, hex / `NaN` / `Infinity` / leading-`+` numbers; comment markers inside strings are content (full JSON string-escape handling). Two strictness upgrades over `JSON.parse`:

- **Duplicate keys in any object are a `ConfigError` naming both lines** (JSON.parse silently keeps the last - a silently dropped remote or target).
- Nesting depth cap of 64.

Exhaustive table tests in `config/tests/jsonc.test.ts`: `//` and `*/` inside strings, escaped quote before a comment, `"http://x"`, CRLF, trailing comma + comment before the bracket, the trailing-comma matrix, dup-key, depth cap, unterminated everything, `/*` at EOF.

### Schema (`config/types.ts`)

```ts
export type LogLevel = "error" | "warn" | "info" | "debug";
export type Weekday = "mon" | "tue" | "wed" | "thu" | "fri" | "sat" | "sun";
export type Interval = "minute" | "hour" | "day" | "week" | "month";

/**
 * One remote host, keyed by short name in BackupkitConfig.remotes.
 * Two mutually exclusive shapes: explicit (backupkit manages host, user, key,
 * port, and known_hosts) or alias (ssh resolves everything from the user's
 * ssh_config; backupkit manages nothing but the no-hang option baseline).
 */
export type RemoteConfig = ExplicitRemoteConfig | AliasRemoteConfig;

/** Fully specified remote: backupkit owns key loading, known_hosts, and identity selection. */
export interface ExplicitRemoteConfig {
    /** Hostname or IP. IPv6 literals allowed (bracketed by the endpoint formatter). Required. */
    host: string;
    /** SSH username, /^[a-z_][a-z0-9._-]{0,31}$/i. Required. */
    user: string;
    /** SSH port, integer 1-65535. Default 22. */
    port?: number;
    /** Absolute path to the private key. No whitespace or quote chars in the path. Required. */
    identityFile: string;
    /**
     * Passphrase source for an encrypted key. "file:/abs/path" (0600, owner euid/root,
     * read via the shipped SSH_ASKPASS helper) or "prompt" (ssh-add's own TTY prompt
     * during `backupkit check`; refused when no TTY). Omit for unencrypted keys.
     * Raw passphrases and "env:" forms are rejected by the validator. Only valid
     * alongside identityFile - alias remotes cannot carry a passphrase.
     */
    passphrase?: string;
    /** Override the dedicated known_hosts file path. Default: <configDir>/known_hosts. */
    knownHostsFile?: string;
}

/**
 * ssh_config-resolved remote. The alias is passed to ssh/rsync verbatim as the
 * destination; host, user, key, port, and known_hosts all come from the user's
 * ssh_config (~/.ssh/config, /etc/ssh/ssh_config). No other field may accompany
 * "alias" - per-field overrides belong in ssh_config or an explicit remote.
 * backupkit still injects its non-negotiable -o baseline (section 4), which
 * overrides ssh_config, so the no-hang and strict-host-key guarantees survive.
 */
export interface AliasRemoteConfig {
    /** Host alias exactly as written in ssh_config. /^[a-z0-9_][a-z0-9._-]*$/i, max 64 - no whitespace, quotes, ':', '@', '/', or leading '-'. Required, and the only allowed key. */
    alias: string;
}

/** GFS retention. A snapshot survives if ANY rule claims it. */
export interface RetentionConfig {
    keepLast?: number;
    keepHourly?: number;
    keepDaily?: number;
    keepWeekly?: number;
    keepMonthly?: number;
    keepYearly?: number;
}

/**
 * Target schedule as written in config. Anchors are optional and interval-gated
 * (validation matrix below). Schedules and retention are independent: retention
 * keeps its hourly..yearly tiers regardless of the schedule interval; for
 * minute/hour schedules, keepLast and keepHourly govern sub-daily density.
 */
export interface ScheduleInput {
    /**
     * Window unit. "minute" is for high-frequency targets; "month" means calendar
     * months in UTC (months-since-epoch indexing) - never a day-count
     * approximation. Required.
     */
    interval: Interval;
    /** Run once every N intervals. Positive integer. Default 1. */
    intervalCount?: number;
    /**
     * "HH:MM" UTC: the earliest time-of-day the window's run may fire, measured
     * on the window's anchor day. Valid for day/week/month. Default "00:00".
     */
    at?: string;
    /** Weekday the week window starts on (the week anchor). Valid for week. Default "mon". */
    on?: Weekday;
    /**
     * Day of the window's first month the run anchors to, 1-28 (a day every
     * month has - no clamping, no skipped February). Valid for month. Default 1.
     */
    dayOfMonth?: number;
}

/** Per-target rsync tuning. All optional. */
export interface RsyncOptions {
    /** -z compression. Default true. */
    compress?: boolean;
    /** rsync --bwlimit: "500K", "10M", or a bare number string (KiB/s). Default: unlimited. */
    bwlimit?: string;
    /** rsync --timeout seconds. Default 600. */
    ioTimeoutSec?: number;
    /** --xattrs. Default false. */
    xattrs?: boolean;
    /** Receive owner/group (--numeric-ids). Default true; set false to add --no-owner --no-group. */
    preserveOwnership?: boolean;
    /** Allow device/special files (rsync -D). Default false: --no-devices --no-specials always added. */
    preserveDevices?: boolean;
    /** Absolute path to the rsync binary on the remote (--rsync-path). Default: remote default rsync. */
    remoteRsyncBin?: string;
    /** Pre-promote --checksum --dry-run verification pass. Default false (full re-read of both sides). */
    verify?: boolean;
}

/** One backup target. Keyed by name in BackupkitConfig.targets. */
export interface TargetConfig {
    /** "pull": this machine fetches remote source into local destination (preferred). "push": this machine sends local source to remote destination. Required. */
    direction: "pull" | "push";
    /** Key into BackupkitConfig.remotes. Required. */
    remote: string;
    /** Directory to back up (contents synced). pull: absolute path ON the remote. push: absolute local path. Required. */
    source: string;
    /** Archive root. pull: absolute local path. push: absolute path ON the remote (must equal the jail root of the forced command). Snapshots at <destination>/<name>/<snapshot>/. Required. */
    destination: string;
    /** rsync exclude patterns, one --exclude=<p> argv element each. Default []. */
    exclude?: string[];
    /** When to run (validation matrix below). Default { interval: "day" }. */
    schedule?: ScheduleInput;
    /** Overrides top-level retention wholesale (no merge). false = never prune this target. */
    retention?: RetentionConfig | false;
    /**
     * Transfer retry: total attempts per run for transient failures, integer
     * 1-10. Default 5. The only retry knob - delays are fixed (15 s doubling to
     * a 300 s cap, ±20% jitter), always resuming into the same .partial.
     */
    retry?: { attempts?: number };
    /** Free-space floor after transfer: "N%" of the filesystem or absolute "10G"/"500M" (binary units). false disables the guard and its dry-run pre-pass. Default "5%". */
    minFree?: string | false;
    /** Default {}. */
    rsync?: RsyncOptions;
    /** false = configured but never scheduled. Default true. */
    enabled?: boolean;
}

export interface BackupkitConfig {
    /** Instance label for logs/locks. Default "backupkit". */
    name?: string;
    /** At least one entry. Key charset same as target names. */
    remotes: Record<string, RemoteConfig>;
    /** At least one entry. Keys are target names, /^[a-z0-9][a-z0-9._-]*$/, max 64: snapshot subdir + CLI/log identifier. Run order = document order. */
    targets: Record<string, TargetConfig>;
    /** Default retention for targets defining none. Omit to keep everything forever. */
    retention?: RetentionConfig;
    /** Run-report root. Default /var/lib/backupkit (root) else ${XDG_STATE_HOME:-~/.local/state}/backupkit. */
    stateDir?: string;
    /** Default { level: "info" }. */
    logging?: { level?: LogLevel; file?: string };
    /** Absolute local rsync binary override. Default: /opt/homebrew/bin/rsync, /usr/local/bin/rsync, then PATH. */
    rsyncBin?: string;
    /** Absolute local ssh binary override. Default: PATH. */
    sshBin?: string;
}

/** Resolved normal form of ScheduleInput: every default filled. All boundaries UTC. */
export interface ScheduleConfig {
    interval: Interval;
    intervalCount: number;
    /** "HH:MM" UTC anchor within the window. Always "00:00" (never meaningful) for minute/hour. */
    at: string;
    /** Week anchor day. Only meaningful for interval "week". */
    on: Weekday;
    /** Anchor day-of-month, 1-28. Only meaningful for interval "month". */
    dayOfMonth: number;
}
```

`ResolvedConfig` mirrors this with every optional filled: an ordered array of resolved targets (document order, taken from the parser's ordered entries - immune to JS integer-key reordering for names like `"2024"`), each carrying its `name` (its record key), a `remoteRef: ResolvedRemote` pointer (the discriminated `explicit`/`alias` shape from `shared/types.ts`), `schedule: ScheduleConfig`, `retention: RetentionConfig | null`, `retry: { attempts: number }`, `minFree: {bytesOrPercent} | null`, and its `{ src: Endpoint; dst: Endpoint }` pair. `loadConfig(cliArg?): ResolvedConfig` is synchronous; the rest of the codebase never sees an optional config field, an unresolved schedule object, or a `direction` branch - and every remote consumer branches on `remote.kind` exactly where ssh identity matters (`sshArgs`, `preflight`, `check`, `formatEndpoint`) and nowhere else.

### Validation rules (`config/internal/validate.ts`)

Hand-rolled helpers (`expectObject/String/PositiveInt/Bool/Enum/...`) operating on `JsoncNode`s, fail on the **first** error, `ConfigError` message `<file>:<line>: <dotted.path>: <problem>` (line from the offending node - the operator's editor jumps straight there; the dotted path stays for grep/docs). Unknown keys rejected at every object level (plain `unknown key "x"`; no Levenshtein suggestions - cut). Cross-field: every `target.remote` exists; `remotes`/`targets` non-empty; no two targets share a resolved `<destination>/<name>`; unreferenced remotes are a warn. (Target-name uniqueness needs no rule: the parser rejects duplicate keys.)

**Remote shape rule (the alias XOR explicit discriminator):** a remote object containing `alias` must contain NOTHING else - any sibling key is a `ConfigError`: `remotes.myserver.host: alias remotes take no other fields - host, user, key, and port come from ssh_config; use an explicit remote for per-field control`. A remote object without `alias` is the explicit shape: `host`, `user`, `identityFile` all required (each missing one named individually), plus the optional `port`/`passphrase`/`knownHostsFile`. `alias` matches `/^[a-z0-9_][a-z0-9._-]*$/i`, max 64 - the charset excludes whitespace, quotes, `:`, `@`, `/`, and a leading `-` by construction, so an alias can never confuse rsync's `host:path` split, ssh's option parsing, or shell quoting. `passphrase` is structurally impossible on an alias remote (it is not a key of `AliasRemoteConfig`); the "only valid alongside identityFile" rule needs no cross-check.

Field rules: `remotes`/`targets` keys match `/^[a-z0-9][a-z0-9._-]*$/`, max 64; all path fields absolute (`~` rejected with "use an absolute path"); no NUL/newline in any path or exclude; paths must not start with `-`; `identityFile`/`knownHostsFile`/`sshBin`/`rsyncBin`/`remoteRsyncBin` contain no whitespace/quotes (they enter rsync's `-e` string or a remote command); `passphrase` matches `/^file:\/.+/` or is exactly `"prompt"` - anything else: `passphrase must be "file:/path" or "prompt" - never the passphrase itself`; retention counts non-negative integers, `retention: {}` rejected (target-level `false` is the explicit keep-everything spelling); `retry.attempts` an integer 1-10 (unknown keys inside `retry` rejected like everywhere else); `minFree` matches `/^\d+(\.\d+)?%$/` (0-50) or `/^\d+(\.\d+)?[KMGT]$/`; `bwlimit` matches `/^\d+(\.\d+)?[KMG]?$/` and is passed to rsync verbatim as one `--bwlimit=<v>` token (rsync >= 3.0 parses suffixes; our floor is 3.2.5).

The **schedule object** replaces v2's string grammar. The combinations a grammar made unsayable are now vetoed by an explicit matrix - every rejection names the field and the rule:

| field | type / range | valid for interval | default |
|---|---|---|---|
| `interval` | `"minute" \| "hour" \| "day" \| "week" \| "month"` | always (required) | - |
| `intervalCount` | integer >= 1 | every interval | 1 |
| `at` | `"HH:MM"`, 00:00-23:59, UTC | day, week, month | "00:00" |
| `on` | `"mon".."sun"` | week | "mon" |
| `dayOfMonth` | integer 1-28 | month | 1 |

An anchor present outside its "valid for" row is a `ConfigError` naming both: `targets.web.schedule.on: "on" is only valid for interval "week"` (same shape for `at` on minute/hour and `dayOfMonth` off-month). `at` with `intervalCount > 1` is legal and unambiguous: the run fires no earlier than the window's anchor day at HH:MM (window semantics in section 6). `dayOfMonth` caps at 28 so the day exists in every month - no clamping rule, no skipped February. `intervalCount: 1` written explicitly is fine (it is the default, not a rejection).

The validator touches no filesystem beyond the config file itself; permission checks are the ssh module's (section 4). The validator never reads ssh_config - an alias that resolves to nothing is `check`'s finding, not the validator's (config validity cannot depend on a file backupkit does not own).

### The starter config (`config/internal/starter.ts` - what `backupkit init` writes, and the canonical example)

The config module owns its schema AND its canonical example; a unit test feeds this text through `parseJsonc` + the validator, so the shipped example can never drift from the schema. Every field comment is that field's docstring from `config/types.ts`.

````jsonc
// backupkit - /etc/backupkit/config.jsonc
// Comments (// and /* */) and trailing commas are allowed; otherwise strict JSON.
// Reference: https://daanvandenbergh.github.io/backupkit/configuration
{
    // Instance label used in logs and lock files.
    "name": "backupkit",

    // Machines this host talks to, keyed by a short name targets refer to.
    "remotes": {
        "example": {
            // Hostname or IP. IPv6 literals are fine.
            "host": "10.0.0.11",
            // SSH user on the remote. For pull targets a read-only user is enough.
            "user": "backup-reader",
            // "port": 22,
            // Absolute path to the SSH private key (mode 0600).
            "identityFile": "/etc/backupkit/keys/example_ed25519",
            // Only for encrypted keys. "file:/abs/path" = a 0600 file holding the
            // passphrase (unattended daemons); "prompt" = you type it once via
            // `backupkit check` after each reboot. NEVER the passphrase itself.
            // "passphrase": "file:/etc/backupkit/keys/example.pass",
        },
        // Alternatively: a Host alias from your ~/.ssh/config or /etc/ssh/ssh_config.
        // ssh resolves the hostname, user, key, and port itself; backupkit manages
        // nothing but its safety options. "alias" must be the ONLY field.
        // "myserver": { "alias": "myserver" },
    },

    // What to back up. The key is the target name: it becomes the snapshot
    // subdirectory (<destination>/<name>/<timestamp>/) and the log identifier.
    "targets": {
        "example-var-www": {
            // "pull": this machine fetches from the remote (recommended).
            // "push": this machine sends to the remote (the key is jailed; see
            // `backupkit check`, which prints the authorized_keys line to install).
            "direction": "pull",
            // A key of "remotes" above.
            "remote": "example",
            // Directory to back up. pull: path ON the remote. push: local path.
            "source": "/var/www",
            // Archive root. pull: local path. push: path ON the remote.
            "destination": "/srv/backups",
            // rsync exclude patterns.
            "exclude": ["cache/", "*.tmp"],
            // How often: "interval" is "minute" | "hour" | "day" | "week" | "month";
            // "intervalCount" = every N intervals (default 1). Optional anchors:
            // "at" "HH:MM" UTC (day/week/month), "on" "mon".."sun" (week),
            // "dayOfMonth" 1-28 (month). Default { "interval": "day" }.
            "schedule": { "interval": "day", "at": "03:00" },
            // Per-target override of the default retention below.
            // false = never prune this target.
            // "retention": { "keepLast": 24, "keepDaily": 30 },
            // Transfer retry attempts per run (transient failures only, 1-10).
            // "retry": { "attempts": 5 },
            // Keep this much free on the archive filesystem: "5%" or "10G".
            // false disables the free-space guard. Default "5%".
            // "minFree": "5%",
            // Tuning knobs, all optional: compress, bwlimit ("10M"), ioTimeoutSec,
            // xattrs, preserveOwnership, preserveDevices, remoteRsyncBin, verify.
            // "rsync": { "bwlimit": "10M" },
            // false = configured but never scheduled.
            // "enabled": true,
        },
    },

    // Default retention for targets that define none. A snapshot survives if ANY
    // rule claims it. Omit the whole object to keep everything forever.
    "retention": {
        "keepLast": 7,      // the 7 newest, unconditionally
        "keepDaily": 14,    // newest snapshot of each day, 14 days
        "keepWeekly": 8,    // newest per ISO week, 8 weeks
        "keepMonthly": 12,  // newest per month, 12 months
    },

    // Run reports live here. Default: /var/lib/backupkit (root),
    // else ~/.local/state/backupkit.
    // "stateDir": "/var/lib/backupkit",

    // "error" | "warn" | "info" | "debug"; optional "file" for a log path.
    "logging": { "level": "info" },
}
````

A push target is the same shape with `direction: "push"`, local `source`, and remote `destination` equal to the jail root; `backupkit check` prints the matching `authorized_keys` line (section 4).

---

## 3. rsync engine + snapshot lifecycle

### Snapshot naming - single source of truth

`shared/snapshot-name.ts` exports the ONLY codec and regex in the codebase:

```ts
/** Snapshot dir name: UTC ISO-basic without colons, e.g. "2026-08-10T031502Z". Lexical sort = chronological. */
export const SNAPSHOT_NAME_REGEX: RegExp;   // ^\d{4}-\d{2}-\d{2}T\d{6}Z$
export function formatSnapshotName(date: Date): string;      // truncate to seconds, UTC
export function parseSnapshotName(name: string): Date | null; // strict regex + real-date validation
export function isPartialName(entry: string): boolean;        // <name>.partial
export function isDeletingName(entry: string): boolean;       // <name>.deleting
```

A guard test in `shared/tests/` greps `src/` for competing patterns (`\d{4}-\d{2}-\d{2}T` literals, `^\d+$` snapshot matching, compact `\d{8}T\d{6}Z` forms) outside this file and fails the build if found - same enforcement style as the fs-import guard. There is nothing to exempt: `runId` (section 8) reuses this codec. The name records the actual run start time; scheduling buckets are computed from parsed names, never encoded in them. Legacy epoch-named vbackup dirs never match the regex: backupkit lists them nowhere and deletes them never. Migration is explicitly out of v1; the first backupkit snapshot starts a fresh chain (documented).

### Directory states

- In progress: `<name>.partial`
- Complete: `<name>` (regex match, no suffix). Completeness is purely name-based - no marker files.
- Being deleted: `<name>.deleting` (two-phase prune, section 5).

Only complete names are ever eligible as `--link-dest` base, restore source, list output, or retention input.

### Per-target run pipeline (`engine/internal/target-runner.ts`)

The whole pipeline runs inside `store.withLock(...)` (section 6) - steps 2-8 execute in `fn`; the report write happens in all paths and the lock release is structural (`withLock`'s `finally`), not a caller obligation.

1. **Lock**: `withLock` acquires the store-root lock; `LockHeldError` on live contention.
2. **Prepare** (via `SnapshotStore`): sweep every `.deleting` entry (`rm -rf`); if a `.partial` entry exists, `claimPartial(newName)` renames it to `<newName>.partial` and this run resumes into it (at most one partial can exist under the lock invariant); extra partials are deleted. If a complete snapshot already exists in the current schedule bucket and `force` is not set, the run is a skip (idempotent).
3. **Disk guard** (skipped when `minFree: false`): `dryRunStats()` - `buildArgs(spec, "estimate")`, same `--link-dest` - parses "Total transferred file size" as `deltaBytes`. Required = `deltaBytes * 1.2 + 268435456` (20% margin + 256 MiB inode floor). Free space via `store.freeBytes()`: local store `fs.statfs(destination)` (`bavail * bsize`); remote store `df -Pk -- <dir>` via `runRemote`, output validated `/^\d+$/`. If `free - required < minFreeBytes`: run status `skipped`, reason `disk-low`, one `error` log per state transition, next scheduled run re-evaluates. Never crashes the daemon, never deletes anything (emergency prune is cut).
4. **Link-dest base**: last element of `listComplete()`, or none (first snapshot).
5. **Transfer** into `<name>.partial/` with retries (below), `buildArgs(spec, "transfer")`.
6. **Optional verify** (`rsync.verify: true`): `buildArgs(spec, "verify")` against the partial; passes iff exit 0/24 and no content-change itemize lines; failure = keep partial, no retry, loud error.
7. **Promote** on exit 0/23/24: atomic rename `<name>.partial -> <name>` (local `fs.rename`; remote `mv -- '<partial>' '<final>'` - pure `rename(2)`, destination never pre-exists).
8. **Retention** (section 5) runs after every successful promote.
9. **Report** written (section 8) after `withLock` returns or throws.

### rsync argv (built by `rsync/internal/args.ts`, pure, fixed order)

One builder: `buildArgs(spec: TransferSpec, mode: "transfer" | "estimate" | "verify"): string[]`. `estimate` = transfer + `--dry-run`; `verify` = transfer + `--dry-run --checksum --itemize-changes`. `TransferSpec` carries the `{src, dst}` `Endpoint` pair, the resolved options, and the prebuilt `sshTokens: string[]` (produced only by `sshArgs`, section 4 - explicit or alias form, the builder cannot tell and does not care).

| args | when |
|---|---|
| `-a -H --numeric-ids --sparse` | always |
| `--no-devices --no-specials` | unless `preserveDevices: true` |
| `--chmod=ug-s` | always on receive (strips setuid/setgid from hostile archives) |
| `-z` | `compress` (default true) |
| `--delete --force --partial` | always (resume-into-partial correctness; not configurable) |
| `--timeout=<ioTimeoutSec>` | always, default 600 |
| `--info=stats2` | always |
| `--no-owner --no-group` | `preserveOwnership: false` |
| `--fake-super` | receiving side when `process.getuid() !== 0` |
| `--xattrs` | `xattrs: true` |
| `--bwlimit=<v>` | `bwlimit` set (validated token, verbatim) |
| `--exclude=<p>` repeated | per pattern, single `=`-joined argv token |
| `--rsync-path=<p>` | `remoteRsyncBin` set (absolute, validated) |
| `-e "<ssh tokens space-joined>"` | whenever either endpoint is remote; every token pre-validated whitespace/quote-free |
| `--link-dest=../<base>` | when a complete previous snapshot exists (exactly one) |
| `--dry-run` | modes `estimate` and `verify` |
| `--checksum --itemize-changes` | mode `verify` |
| `<src> <dst>` | `formatEndpoint(src) + "/"` -> `formatEndpoint(dst under <destination>/<name>/<snap>.partial)`; the formatter owns `user@host:` prefixing, IPv6 bracketing, and the bare `<alias>:` form |

No `extraRsyncArgs`, no `--inplace`, no `--checksum` on the transfer pass, no `-s` (unneeded at the 3.2.5 floor), never `--trust-sender`. Spawned via `exec/` - argv array, `shell: false`, `stdio: ["ignore","pipe","pipe"]`, env `{ PATH, HOME, LC_ALL: "C" }` plus exactly one agent variable: `SSH_AUTH_SOCK = <backupkit agent sock>` for explicit remotes, or the inherited `process.env.SSH_AUTH_SOCK` verbatim for alias remotes when the invoking environment has one (the user's own agent setup is authoritative in alias mode; unset stays unset). Nothing else.

### Version policy

Local binary resolved once at startup (`rsyncBin` override, else `/opt/homebrew/bin/rsync`, `/usr/local/bin/rsync`, PATH). Probe `--version` (5 s timeout); openrsync and anything `< 3.2.5` refused with an error naming the binary, found version, floor, and fix (`brew install rsync` / distro package). Remote probe once per connection identity per process - `user@host:port` for explicit remotes, the alias string for alias remotes - via `runRemote` (`<remoteRsyncBin ?? rsync> --version`), wrapped in the control-path transient retry (section 4) so a momentary blip never marks a healthy host bad; same floor; a host that still fails after retries fails all its targets with one host-level error. A version below the floor is a permanent refusal, never retried.

### Exit-code table + retry

| exit | outcome |
|---|---|
| 0 | success, promote |
| 24 (vanished) | success-with-warning, promote |
| 23 (partial/permissions) | **promote with `warning` status**; first 100 offending paths (from stderr) in the report with an exclude hint; no retry |
| 10, 12, 30, 35 | transient: retry |
| 255 (ssh transport) | transient: retry - unless the sanitized stderr tail matches a permanent ssh pattern (section 4): then fail, no retry |
| 11 (file I/O / ENOSPC) | fail, no retry, surfaced as disk error |
| 1, 2, 4, 5, 6 | fail hard: backupkit bug or version escape, message says so |
| 20 (signal) | fail, no retry (shutdown path) |
| other | fail, no retry |

Retry: up to `retry.attempts` total attempts (default 5, valid 1-10 - the single retry knob in config), delay before attempt k = `min(15s * 2^(k-2), 300s)` with ±20% jitter (15/30/60/120/240... capped at 300), always resuming into the same `.partial`. Classification is by exit code plus the three fixed permanent ssh stderr patterns (section 4) and nothing else - implemented as `classifyExit(code, stderrTail)` in `rsync/internal/classify.ts`, which sets `retriable` on the thrown `TransferError`. The loop itself is `shared/retry.ts`'s `withTransientRetry` with the transfer policy - the same helper, same backoff shape, and same classification flag as every control-path remote operation, so transfer and control retries can never drift apart. On engine SIGTERM the child gets SIGTERM, SIGKILL after 10 s; the partial stays for resume; an aborted run is never retried in-process.

---

## 4. SSH / agent / security model

### Process invocation

Every external process goes through `exec/` - the only `node:child_process` importer (guard test enforces). `shell: true` does not exist in the codebase. Minimal explicit env (section 3). Binaries resolved to absolute paths at startup and logged. One documented stdio exception: the CLI's `service` lifecycle verbs and `logs` spawn `systemctl`/`launchctl`/`journalctl`/`tail` through `exec/` with `stdio: "inherit"` and no timeout (they are interactive passthroughs an operator watches and Ctrl-C's) - still argv arrays, still `shell: false`, still absolute-path resolved.

### ssh option baseline

Every ssh use (rsync `-e` and `runRemote`) is built by one function, `sshArgs(remote, mode)` - the single source of truth; no other module adds `-o` options. It branches once, on `remote.kind`:

**Explicit remotes** carry exactly:

```
-o BatchMode=yes -o ConnectTimeout=15 -o ServerAliveInterval=15 -o ServerAliveCountMax=4
-o StrictHostKeyChecking=<contextual, below> -o UserKnownHostsFile=<dedicated file>
-o IdentitiesOnly=yes -o PreferredAuthentications=publickey -o LogLevel=ERROR
-p <port> -i <identityFile>
```

**Alias remotes** carry exactly the non-negotiable baseline and nothing more:

```
-o BatchMode=yes -o ConnectTimeout=15 -o ServerAliveInterval=15 -o ServerAliveCountMax=4
-o StrictHostKeyChecking=<contextual, below> -o LogLevel=ERROR
```

No `-i`, no `-p`, no `-o IdentitiesOnly`, no `-o PreferredAuthentications`, no `-o UserKnownHostsFile`: hostname, user, port, keys, certificates, jumps, and known_hosts location are the ssh_config entry's business - injecting any of them would silently fight the setup the operator chose alias mode to keep. The baseline that IS injected is the no-hang and host-key-safety contract, and it wins by construction: OpenSSH gives command-line `-o` options precedence over every ssh_config file, so a config entry saying `BatchMode no` or `StrictHostKeyChecking no` is overridden, not obeyed. The destination token ssh/rsync receive is the bare alias.

The rsync module never calls `sshArgs`: the engine passes the resulting token array in as plain data (`sshTokens: string[]`), so `sshArgs` stays the single `-o` authority with no cross-module type scaffolding. Alias tokens pass the same whitespace/quote-free precondition as every other token (the alias charset guarantees it).

### Transient-failure retry (one helper, one classification)

`shared/retry.ts` exports the single retry primitive:

```ts
/** Run op with capped-exponential retries on transient failures. Delay before attempt k = min(baseDelayMs * 2^(k-2), capMs), ±20% jitter. Retries only errors whose retriable flag is true (set by the classifiers); everything else rethrows immediately. Each retried attempt logs one warn naming the label, attempt number, and delay. Pure timers - no fs, no child_process. */
export function withTransientRetry<T>(op: () => Promise<T>, policy: { attempts: number; baseDelayMs: number; capMs: number }, log: Logger, label: string): Promise<T>;
```

Exactly two policies exist in the codebase:

- **transfer**: `attempts` = the target's `retry.attempts` (default 5), base 15 s, cap 300 s (section 3);
- **control**: attempts 3, base 2 s, cap 8 s, not configurable - wraps every short remote operation: the remote rsync version probe, every remote-store command (`find` listing, `mkdir`, `mv`, `rm -rf`, `df`), and every other `runRemote` call. Control ops are cheap and fast; only the transfer gets a knob.

**Classification** is the ONLY stderr inspection in the codebase, centralized in `ssh/classify.ts`: `isPermanentSshStderr(stderrTail)` matches exactly three fixed substrings - `Permission denied (`, `Host key verification failed`, `REMOTE HOST IDENTIFICATION HAS CHANGED`. ssh/rsync exit 255 and exec timeouts are transient unless one matches; rsync exits 10/12/30/35 are transient (section 3); everything else is permanent. Unknown stderr defaults to transient - retrying a permanent failure wastes minutes, misclassifying a transient one loses a run, so the bias goes toward retry. The classifiers set `retriable` on the thrown `SshError`/`TransferError`; `withTransientRetry` reads only that flag. This keeps invariant 5 airtight: an auth failure or host-key mismatch is permanent at every layer, never retried anywhere - identically for explicit and alias remotes (classification reads stderr, not config shape).

Two exemptions, both deliberate: the lock-acquire `mkdir` is never wrapped (EEXIST is its contention signal - retrying would turn "held" into "stale-looking"); and a retried `mv`/`mkdir` whose first attempt actually took effect before the connection dropped fails its retry loudly - the next run's disk-derived state (window dedup, `.partial` claim, `.deleting` sweep) self-heals, which is exactly what deriving all state from directory names buys.

Net effect: a momentary network blip never fails a run - not at the probe, not at the listing, not mid-transfer, not at promote, not during prune.

### Host keys - contextual policy, no config knob

**Explicit remotes**: dedicated known_hosts at `<configDir>/known_hosts` (i.e. `/etc/backupkit/known_hosts` by default; `knownHostsFile` overrides the path but there is no fallback to `~/.ssh/known_hosts`, ever). Created 0600.

**Alias remotes**: the user's default known_hosts - whatever ssh resolves for that alias (its ssh_config `UserKnownHostsFile` if set, else `~/.ssh/known_hosts` + the system file). Rationale, stated once: the ssh_config entry already owns host-key state for that alias - it may pin a nonstandard file, use certificates, or hash hostnames - and forcing backupkit's dedicated file would orphan every existing pin and make `ssh myserver` and backupkit hold contradictory opinions about the same host. What backupkit refuses to delegate is the *policy*, which the injected `-o` wins:

- **Unattended contexts** (`run`, `daemon`, any non-TTY invocation): `StrictHostKeyChecking=yes` for BOTH remote kinds. An unpinned host fails loudly with "run `backupkit check` interactively to pin the host key".
- **Interactive contexts** (`check` with a TTY): `StrictHostKeyChecking=accept-new` for both kinds - TOFU happens only while a human watches. For alias remotes the pin lands in the user's own known_hosts, exactly where their `ssh myserver` would put it.
- A host key **mismatch** is fatal for that host in every context and both kinds, never retried, never auto-healed, logged at error level: a human edits the relevant known_hosts.
- `StrictHostKeyChecking=no` is unrepresentable in config and code - alias mode included, because the option is always injected on the command line and command-line `-o` overrides ssh_config.

### ssh-agent

backupkit runs its own persistent agent at `<runtimeDir>/agent.sock` (`/run/backupkit` for uid 0, else `$XDG_RUNTIME_DIR/backupkit`, else `~/.backupkit/run`; dir 0700). Never the user's session agent. **The agent and everything below applies to explicit remotes only**: for alias remotes `preflight()` primes nothing - there is no `identityFile` to fingerprint, and the user's own ssh_config/agent arrangement is authoritative (their `IdentityFile` directives, certificates, or an inherited `SSH_AUTH_SOCK`, which backupkit passes through verbatim for alias connections, section 3). An alias remote whose auth is broken fails fast under `BatchMode=yes` with the actionable message below - never a hang. A config whose remotes are all aliases starts no agent at all.

`preflight()` for explicit remotes:

1. Probe socket with `ssh-add -l` (exit 0/1 = alive). Dead/absent: remove stale socket, `ssh-agent -a <sock>`, ignore its env output.
2. Per unique key: fingerprint via `ssh-keygen -lf <key>.pub` compared against `ssh-add -l`; already loaded = done.
3. Not loaded, unencrypted (`ssh-keygen -y -P "" -f <key>` exits 0): `ssh-add <key>`.
4. Not loaded, encrypted, `passphrase: "file:..."`: `ssh-add <key>` with `SSH_ASKPASS=<dist>/ssh/internal/askpass.sh`, `SSH_ASKPASS_REQUIRE=force`, `BACKUPKIT_PASSPHRASE_FILE=<path>` - after the permission check below. The helper is `#!/bin/sh` + `cat "$BACKUPKIT_PASSPHRASE_FILE"`.
5. Not loaded, encrypted, `passphrase: "prompt"`: TTY present -> `ssh-add` with inherited stdio (ssh-add's own prompt; backupkit never sees the passphrase); no TTY -> immediate `SshError`: `key <path> is encrypted and not loaded; run "backupkit check" in a terminal, then restart the service`. Never a hang - and it fails only that remote's targets, never the daemon.
6. Missing `.pub` sidecar next to an encrypted key: generated during an interactive `check` (`ssh-keygen -y`, written 0644); a startup error pointing at `backupkit check` when unattended.

Keys are added without lifetime; agent survives process restarts; `stop()` does not kill it. After a reboot or crash-restart, `file:` keys reload automatically at daemon start with no operator action; `prompt` keys require one interactive `backupkit check`. Alias remotes have no reboot step at all: whatever made `ssh myserver` work before the reboot makes it work after.

Runtime auth failure on an alias remote (exit 255 + `Permission denied (`): permanent, no retry, error message `ssh alias "myserver": authentication failed under BatchMode - verify that "ssh myserver" works non-interactively for this user (uid <euid>); backupkit does not manage keys for alias remotes`. `check` surfaces the same message with the `ssh -G` resolution shown alongside (below).

### File permission preflight (`ssh/permissions.ts`, before any network I/O, fail hard)

Backupkit checks only what backupkit owns. Rows marked *explicit* are skipped entirely for alias remotes: ssh_config files, the keys they name, and the user's known_hosts are ssh's own business (ssh already refuses world-readable keys itself; duplicating its policing against files we did not choose would be guessing).

| File | Requirement | Applies to |
|---|---|---|
| private key | regular file; `mode & 0o077 === 0`; owner euid or root | explicit |
| passphrase file (`file:`) | regular file; `mode & 0o077 === 0`; owner euid or root | explicit |
| key `.pub` | if present: not group/other-writable | explicit |
| config file | not group/other-writable; owner euid or root | always |
| known_hosts (dedicated) | not group/other-writable (created 0600 if absent) | explicit |
| runtime dir / stateDir | 0700, owner euid (created so) | always |
| destination root (local stores) | exists; not group/other-writable | always |

### Push-mode jail (resolves red-team #1)

Push mode never gets an unrestricted shell on the archive server. `backupkit check` prints, per configured push target, the exact ready-to-paste `authorized_keys` line. For **explicit** remotes it is generated from the loaded config and the real key's public half (`ssh-keygen -y` / the `.pub` sidecar) - never a template the operator hand-edits:

```
restrict,command="/usr/local/bin/backupkit-remote <jailRoot>" ssh-ed25519 AAAA...
```

For **alias** push remotes the public key is unknown to backupkit (the identity lives in ssh_config), so `check` prints the exact generated prefix followed by an explicit instruction instead of a fake key:

```
restrict,command="/usr/local/bin/backupkit-remote <jailRoot>" <append the public key your ssh_config uses for "myserver": ssh-add -L, or the .pub of its IdentityFile>
```

The jail requirement itself is identical for both kinds; only the key-half provenance differs, and no printed line is ever installable without the restriction prefix. `check` also prints the `backupkit-remote` install instruction and flags a push remote whose probe shows the jail is not answering. `backupkit-remote` is a POSIX sh script shipped in `dist/snapshots/internal/` (co-located with the remote store whose exact command surface it jails; installed on the archive server by the operator). It reads `$SSH_ORIGINAL_COMMAND` and permits exactly:

- `rsync --server` invocations whose destination argument resolves under `<jailRoot>/` (no `..`, absolute-prefixed check),
- the lifecycle argv forms `mkdir -p -- <p>`, `mkdir -- <p>`, `find <p> -maxdepth 1 -mindepth 1 -print0`, `mv -- <a> <b>`, `rm -rf -- <p>`, `df -Pk -- <p>`, `rsync --version`, where every path operand is under `<jailRoot>/` and every leaf component matches the snapshot regex or its `.partial`/`.deleting`/`.backupkit.lock` forms or a configured target-name component,

and rejects everything else with exit 1. A compromised push key can poison new snapshots and prune its own target's history (equivalent exposure to `rrsync -wo`), but cannot read or touch anything outside its jail and cannot obtain a shell. Pull remains the documented, recommended default; `sudo`-on-source is cut from v1 (docs cover pull + a read-only source user).

### Remote command surface

One function `runRemote(remote, argv: string[])` in `ssh/`: every element shell-quoted by the single quoter in `ssh/internal/quote.ts` (reject NUL/newline, then `'` + `s.replaceAll("'", "'\\''")` + `'`); `--` precedes every path operand on every command (universal rule); every call classified transient/permanent per `ssh/classify.ts` and wrapped by callers in the control-path `withTransientRetry` (lock-acquire `mkdir` excepted). The destination token is `user@host` (explicit) or the bare alias. Remote directory listings use `find <dir> -maxdepth 1 -mindepth 1 -print0`, parsed NUL-delimited; entries failing the snapshot-name regex family are ignored and never deleted. All remote output is untrusted: numeric probes validated `/^\d+$/`, and every remote-derived string (filenames, stderr) passes `shared/sanitize.ts` (strips `\n`, `\r`, `\x1b`, NUL, other C0 controls) before logging, report inclusion, or classification. `ssh -G <alias>` output (check-only, below) is local ssh output but passes the same sanitizer before display.

### Alias resolution display (`check` only)

`ssh/ssh.ts` exports `resolveAlias(remote): Promise<{hostname, user, port}>` - runs `ssh -G <alias>` (purely local: ssh prints its resolved configuration without connecting), parses exactly the `hostname`, `user`, and `port` lines, sanitized. `check` prints them per alias remote so the operator sees what ssh will actually dial. Informational only: nothing downstream consumes the values (backupkit never builds a `user@host` form for an alias), and a parse failure degrades to "could not resolve alias via ssh -G" without failing the probe.

### systemd hardening (unit template, section 6)

`NoNewPrivileges=true`, `PrivateTmp=true`, `ProtectSystem=strict` + explicit `ReadWritePaths=<destination roots> <stateDir> <runtimeDir> <configDir>`, `RestrictSUIDSGID=true`, `PrivateDevices=true`, `ProtectHome=read-only` (note: alias remotes need read access to `~/.ssh` for the daemon user; for root that is `/root/.ssh`, readable under `ProtectHome=read-only` by uid 0's own home rules - the generated unit adds `ReadOnlyPaths=/root/.ssh` explicitly when any alias remote is configured, so resolution never silently breaks), `ProtectKernelModules=true`, `ProtectControlGroups=true`, `RestrictNamespaces=true`, `LockPersonality=true`, `SystemCallFilter=@system-service`. Docs recommend mounting the archive filesystem `nosuid,nodev,noexec`.

### Security invariants (seed for `claude/audit-security/rules.md`)

1. No process is ever spawned with `shell: true`; no command line is ever built by string concatenation of config- or remote-derived values; `exec/` is the only `child_process` importer.
2. Every remote command argv element is quoted by the single quoter in `ssh/internal/quote.ts`; `--` precedes every path operand; no other code constructs remote commands.
3. Passphrases are never in config values, env, argv, or logs; only ssh-add's TTY prompt or the 0600 askpass file ever carries one. Alias remotes carry no passphrase at all (structurally impossible).
4. Every ssh invocation carries `BatchMode=yes`; no code path can block on an interactive prompt - alias mode included, because the injected command-line `-o` overrides any ssh_config setting.
5. `StrictHostKeyChecking` is `yes` unattended and `accept-new` only on an interactive TTY, for explicit and alias remotes alike; `no` is unrepresentable; a key mismatch is fatal, never retried at any layer (the retry classifier marks it permanent), never auto-removed.
6. There is exactly one snapshot-name regex (`shared/snapshot-name.ts`); every destructive operation acts only on names matching it or its `.partial`/`.deleting` forms.
7. Complete snapshot directories are never a write destination; prune never deletes the newest complete snapshot; restore output can never resolve inside an archive root; restore never passes `--delete`.
8. Private keys, passphrase files, config, known_hosts, stateDir, and destination roots fail closed on permissive modes before any network I/O - for the files backupkit owns; ssh_config-managed files (alias mode) are ssh's own enforcement domain and are never a reason to skip checking backupkit's own files.
9. All remote-derived data is untrusted: shape-validated before use, control-char-sanitized before logging, never interpolated into a subsequent command.
10. Push-mode keys are always jailed by the `backupkit-remote` forced command; the `authorized_keys` line (explicit remotes) or restriction prefix + key instruction (alias remotes) is generated only by `backupkit check` from the loaded config; no example or generated line ever shows an unrestricted key.
11. rsync < 3.2.5 (or openrsync) on either end is refused, never worked around.
12. Received trees are stripped of setuid/setgid and refuse device/special files unless a target opts in.
13. Config is read only through the single JSONC reader in `config/internal/jsonc.ts`, whose tolerance is exactly comments and trailing commas; duplicate keys are fatal, so a shadowed remote or target is unrepresentable.
14. Alias mode never weakens the baseline: `sshArgs` injects `BatchMode=yes`, `ConnectTimeout`, `ServerAlive*`, `LogLevel=ERROR`, and the contextual `StrictHostKeyChecking` on the command line for every remote kind, and injects NO identity/port/known_hosts options for aliases; an alias remote admits no sibling config fields, and the alias charset excludes every character that could confuse host:path splitting, option parsing, or quoting.

---

## 5. Versioning + retention + pruning

### `SnapshotStore` (`snapshots/store.ts`)

```ts
/** Archive access for one target. openStore(target) returns the local or remote implementation based on which endpoint the destination is. Package-internal: all mutation flows through Backupkit verbs. */
export interface SnapshotStore {
    /** Complete snapshot names, lexically ascending. Ignores anything failing the regex. */
    listComplete(): Promise<string[]>;
    /** Rename the single existing .partial (if any) to <newName>.partial; delete stray partials/.deleting. */
    claimPartial(newName: string): Promise<{ resumed: boolean }>;
    /** Atomic rename <name>.partial -> <name>. */
    promote(name: string): Promise<void>;
    /** Two-phase delete: rename to <name>.deleting, then rm -rf. */
    remove(name: string): Promise<void>;
    /** Free bytes on the archive filesystem (statfs / df -Pk). */
    freeBytes(): Promise<number>;
    /** Acquire the per-destination-root lock, run fn, release in finally - leaking a lock is unrepresentable. Throws LockHeldError on live contention without running fn. */
    withLock<T>(fn: () => Promise<T>): Promise<T>;
}
```

The newest complete snapshot is `(await listComplete()).at(-1) ?? null` - no redundant method on the load-bearing seam. Local implementation: `node:fs/promises`. Remote implementation: `runRemote` with the section-4 quoting/`--`/NUL-listing rules, every command wrapped in the control-path transient retry except the lock-acquire `mkdir` (section 4). This interface is what makes retention, prune, disk guard, list, and restore work identically in both directions (closes coherence gap #30).

### Retention (`retention/retention.ts` - pure, no I/O)

`planRetention(snapshots: string[], rules: RetentionConfig, now: Date): RetentionPlan` where `RetentionPlan = { keep: { name: string; reasons: string[] }[]; prune: string[] }`.

Algorithm (restic-style, deterministic): input complete names sorted newest-first; the newest is always kept (reason `"newest"`, unconditional hard invariant); `keepLast: N` keeps the N newest (`"last"`); then for hourly/daily/weekly/monthly/yearly in that order, walk newest-first with a seen-bucket set and remaining counter, keeping the newest snapshot per unseen bucket (reason e.g. `"daily=2026-08-10"`). Buckets computed in UTC from parsed names: `YYYY-MM-DDTHH`, `YYYY-MM-DD`, ISO-8601 week `GGGG-Www` (Monday start), `YYYY-MM`, `YYYY`. Everything unclaimed goes on `prune`. Resolved rules `null` (top-level absent and target silent, or target `retention: false`) = plan is keep-everything. Retention tiers are independent of the schedule interval by design: a minute- or hour-scheduled target thins naturally through `keepLast`/`keepHourly` into the daily/weekly/monthly tiers.

### Execution (in `snapshots/`, not `retention/`)

Runs automatically after every successful promote, and on demand via `backupkit prune`. Oldest-first, two-phase per snapshot (`rename` to `.deleting`, then recursive rm - crash mid-delete leaves an invisible `.deleting` swept next run). Hard floors independent of policy: refuses a plan whose keep set is empty ("would remove all snapshots, refusing"); refuses to touch the newest complete snapshot; only regex-family names are ever deleted. `PruneReport` carries the per-target `RetentionPlan` (keep with reasons + prune list); `prune --dry-run` prints it and stops.

Cut from v1: emergency prune-on-disk-low (the disk guard only skips + alerts), `du`-based marginal-usage reporting, `migrate` for legacy epoch dirs.

---

## 6. Scheduling + daemon + locking + state

### Due-ness (disk-derived, restart-safe)

`engine/internal/scheduler.ts`, pure functions + a loop class. All window math lives in `shared/time.ts`, all UTC.

Window model, per interval:

- **minute / hour / day**: window index = `floor(unitsSinceEpoch(now) / intervalCount)` (whole minutes, hours, or days since the Unix epoch, UTC).
- **week**: weeks anchored on the schedule's `on` day (default Monday); index = `floor(weeksSince(anchorEpoch) / intervalCount)`.
- **month**: calendar months, never day-count arithmetic - `monthsSinceEpoch(d) = (utcYear(d) - 1970) * 12 + utcMonth(d)`; index = `floor(monthsSinceEpoch / intervalCount)`. A window always starts at 00:00 UTC on the 1st of its first month, so month length and leap years are irrelevant by construction.

A target is **due** when: (a) it has no complete snapshot whose parsed time falls in the current window (checked against the newest name from `listComplete()`); (b) `now` has reached the window's **anchor moment** - the window start for minute/hour; the window's first day at `at` for day; the window's first `on` day at `at` for week; the window's first month's `dayOfMonth` (1-28) at `at` for month (`at` defaults to "00:00", so an anchorless schedule fires at the window start); and (c) the failure backoff has elapsed. `--force` bypasses (a), (b), and (c) - a new run-start-named snapshot is always created.

Clock-skew guard: if the new snapshot name would sort `<=` the newest complete name, the run fails with reason `clock-skew` (never creates a name that breaks lexical ordering). Snapshot names have second resolution, so this holds even at `interval: "minute"`.

### Loop

30 s `setTimeout` tick; each tick recomputes due-ness for every enabled target from the wall clock (self-heals across sleep/NTP; bounds schedule lateness at 30 s, fine even for `interval: "minute"`). Due targets run **sequentially in config document order**. Immediate tick at startup (catch-up = exactly one run per missed window, by construction of the window comparison - never a queue of stale runs).

**Failure backoff** (the per-target crash-loop damper): a target with `consecutiveFailures = n` is not retried until `min(15min * 2^(n-1), 6h)` after its last failed attempt's `finishedAt`. Resets on `success` or `warning`; `aborted` and `skipped` never increment. The 6 h ceiling is absolute and load-bearing: backoff can delay a target but can NEVER stop it - every target is retried within at most 6 h, forever, so a transient condition that heals is always picked up without operator action. Every backoff state transition logs at **error** level naming the target, the failure count, and the next attempt time: entering backoff after a first failure, extending it after each further failure, hitting the ceiling, and clearing it on the first success. Silence is never a state.

### Persisted state = run reports, nothing else

There is no `state.json`. Run reports (`<stateDir>/runs/<target>/<runId>.json`, section 8) are the single persistent record of every attempt - already atomic (tmp+`rename`), 0600, written per completion, newest 50 kept per target. Backoff bookkeeping is **derived** from them (`engine/internal/reports.ts`), the same principle that makes snapshot directory names the source of truth:

- Scan a target's reports newest-first (lexical on `runId` = chronological). An unparseable report file is skipped with one warn - it degrades to "treat as absent", never blocks.
- `consecutiveFailures` = count of consecutive `failed` from the newest, ignoring `aborted` and `skipped`, stopping at the first `success` or `warning`.
- The backoff timer is anchored at the newest `failed` report's `finishedAt`.
- `lastResult` (for `status`) = the newest report's `status`.

The daemon rehydrates these counters once at startup and keeps them as an in-memory cache updated as each report is written; `run` and `status` derive on demand. 50 retained reports is an order of magnitude more history than the derivation can consume (the 6 h ceiling is reached at 6 consecutive failures). `stateDir` holds run reports and nothing else; the agent socket lives in `runtimeDir` (section 4).

### Locking

One lock per destination root, taken before any write, held across the whole pipeline via `withLock`, shared by `run`, `daemon`, and `prune` (they can never collide). One mechanism in both stores: atomic `mkdir <root>/.backupkit.lock` (atomic on POSIX exactly like `O_EXCL`; fails `EEXIST` on a pre-planted symlink), then write a `meta` file inside: `{ pid, pidStartTime, hostname, createdAt }`. Staleness predicates stay asymmetric where reality is asymmetric:

- **Local store**: holder dead if `process.kill(pid, 0)` throws `ESRCH` OR recorded pid start time mismatches the live process (Linux: field 22 of `/proc/<pid>/stat`; macOS: `ps -p <pid> -o lstart=` verbatim); unparseable meta = stale. Stale: remove the lock dir + one re-attempt; second `EEXIST` = live contention. Preflight has already verified the parent is not group/other-writable.
- **Remote store (push)**: `mkdir -- <jail>/<target>/.backupkit.lock` via the jail script; stale after 24 h TTL.
- **Contention**: daemon logs a warning and skips until next tick; `run`/`prune` exit code 3 immediately, touching nothing. Release is structural (`withLock` finally, including the SIGTERM/abort path where `fn` throws); a crashed holder is handled by staleness. The lock-acquire `mkdir` is never retry-wrapped (section 4): `EEXIST` is the signal, not a failure.

### Daemon + service units

The process never self-daemonizes. `backupkit daemon` = foreground loop (`start()`: preflight, then scheduler forever). `backupkit run` = one pass, cron-friendly. `backupkit service install|uninstall|start|stop|restart|status` generates/removes/drives/reports the OS unit ("daemon" = the process, "service" = the OS registration; the lifecycle verbs are defined in section 7); install/uninstall/start/stop/restart require root, refuse otherwise with a clear message; every verb is idempotent (`install` = rewrite + reload; `start` on a running unit and `stop` on a stopped one both succeed with an "already" message).

systemd (`/etc/systemd/system/backupkit.service`): `Type=simple`, `ExecStart=<node> <cli> daemon --config <config>`, **`Restart=on-failure`** (a crash, OOM kill, or non-zero exit always restarts; a clean exit - `systemctl stop`, SIGTERM, exit 0 - stays down, so an operator stop is respected), **`RestartSec=15`**, **`StartLimitIntervalSec=0`** (systemd never gives up restarting - the per-target failure backoff above is the crash-loop damper, and it never silently stops either), `After=network-online.target`/`Wants=network-online.target`, `KillSignal=SIGTERM`, `TimeoutStopSec=30`, `User=root` by default (pull must recreate arbitrary uid/gid; non-root is fully supported - `--fake-super` makes it correct - by editing the unit or using `run` under user cron), plus the full hardening block from section 4 (including the `ReadOnlyPaths=/root/.ssh` line emitted only when an alias remote is configured). Logging: journald (no `StandardOutput` override, `logging.file` unset on Linux). `install` also runs `systemctl daemon-reload && systemctl enable backupkit`; starting is `service start`'s job, and `install`'s last output line says so.

launchd (`/Library/LaunchDaemons/com.daanvandenbergh.backupkit.plist`): `ProgramArguments` = node + cli + `daemon --config`, `RunAtLoad` (reboot recovery), **`KeepAlive: { SuccessfulExit: false }`** (same semantics as `Restart=on-failure`: crash restarts, clean exit stays down), **`ThrottleInterval: 15`** (the restart pacing twin of `RestartSec`), `StandardOutPath`/`StandardErrorPath` = `/var/log/backupkit/backupkit.{log,err.log}` (dir created 0750). Log rotation is the platform's job, not the logger's: `service install` writes `/etc/newsyslog.d/backupkit.conf` (`/var/log/backupkit/*.log  root:wheel  640  5  10240  *  J` - rotate at 10 MiB, keep 5, compressed) and `service uninstall` removes it; the logger itself never rotates anything on any platform. On macOS `install` writes the plist and newsyslog conf only; `service start` performs the `launchctl bootstrap`.

### Restart recovery (crash or reboot - always clean)

Everything the daemon knows is re-derivable from disk, so startup is byte-for-byte the same procedure after a graceful stop, a `kill -9`, an OOM kill, or a host reboot - there is no "dirty" start:

1. The service manager restarts the process per the settings above (15 s pacing, never gives up); only a clean operator stop stays down.
2. `preflight()` re-creates the runtime dir, re-probes or re-spawns the agent, and re-loads every explicit-remote key: `file:` passphrase keys **re-prime automatically** with zero operator action; a `prompt` key that is not in a surviving agent fails fast with the run-`backupkit check` message, failing only that remote's targets - the daemon and every other target keep running. Alias remotes need no priming at all.
3. Backoff counters, `consecutiveFailures`, and `lastResult` rehydrate from the run reports on disk (nothing else exists, so nothing can be lost or double-counted).
4. The first tick runs immediately: any `.partial` left by the dead process is resumed via `claimPartial` (never restarted from scratch), exactly one catch-up run fires per missed window (a window comparison, not a replay queue), and the dead process's locks are taken over via the pid/start-time staleness check (local) or TTL (remote).

### Graceful shutdown

SIGTERM/SIGINT: stop the tick loop; `AbortController` -> engine SIGTERMs the rsync child (SIGKILL after 10 s); wait up to 20 s; write the in-flight target's report with status `aborted`, release locks (structurally, via `withLock`), exit 0 - which the service manager correctly treats as "stay down". The `.partial` stays for resume; no completed-looking snapshot can result. Second signal during shutdown = `process.exit(1)` (stale-lock detection cleans up, and the service manager restarts).

---

## 7. CLI reference

`bin` = `backupkit` (`dist/cli/main.js`, shebang). Subcommand dispatch via a static table; flags and positionals via `node:util` `parseArgs` (`allowNegative` off, unknown flag = hard error listing valid flags). `--flag value` and `--flag=value` accepted. Target names are positional; an unknown positional name = exit 64 listing the configured names. Every command is a thin call into one engine method - the CLI is a pure view layer - except `service` and `logs`, which drive the OS tools through `exec/` (inherited stdio, no timeout, argv arrays, `shell: false`).

**First run**: bare `backupkit` (no arguments) is a help request, not misuse - it prints a short task-oriented help and exits 0:

```
backupkit - versioned rsync-over-SSH backups

Setup (3 steps):
    1. backupkit init             write a commented starter config
    2. backupkit check            verify keys, hosts, and versions
    3. backupkit service install  register the daemon (then: backupkit service start)

Commands:
    run [TARGET...]        back up due targets now
    status  [TARGET...]    one row per target: last run, next due
    list    [TARGET...]    complete snapshots (alias: ls)
    restore TARGET SNAP    copy a snapshot to a fresh path
    prune   [TARGET...]    apply retention now
    logs                   tail the daemon logs
    service <verb>         install|uninstall|start|stop|restart|status
    daemon                 foreground scheduler (what the service runs)
    check | init           readiness / starter config

backupkit <command> --help for details.
```

`--help` prints the same text; `<command> --help` prints that command's flags. This text is the entire first-run surface - no wizard, no interactive prompts.

```
backupkit run       [TARGET...] [--force] [--dry-run] [--config P]
backupkit daemon    [--config P]
backupkit service   install|uninstall|start|stop|restart|status [--config P]
backupkit logs      [-f|--follow] [-n N|--lines N] [--config P]
backupkit list      [TARGET...] [--json] [--config P]        (alias: ls)
backupkit status    [TARGET...] [--json] [--config P]
backupkit restore   TARGET SNAPSHOT|latest --output PATH [--verify] [--config P]
backupkit prune     [TARGET...] [--dry-run] [--config P]
backupkit check     [--config P]
backupkit init      [--force] [--config P]
backupkit --version | --help | <command> --help
```

- **run** -> `run()`: one pass over due targets (or the named ones; `--force` per section 6). `--dry-run`: no writes, no snapshot dir, transfer replaced by `--dry-run --itemize-changes` output, retention planned but not executed.
- **daemon** -> `start()`: foreground loop (what the service unit runs).
- **service install|uninstall|start|stop|restart|status**: full OS-unit lifecycle (section 6). `install` writes the unit (+ enables on systemd, + newsyslog conf on macOS) and ends with `installed - start it: backupkit service start`; `uninstall` stops the unit first if running, then removes everything it wrote. `start`/`stop`/`restart` run `systemctl start|stop|restart backupkit` (Linux) or `launchctl bootstrap system <plist>` / `launchctl bootout system/com.daanvandenbergh.backupkit` / `launchctl kickstart -k system/com.daanvandenbergh.backupkit` (macOS). All verbs idempotent with plain messages: `start` on a running unit prints `already running` (exit 0); `stop` on a stopped unit prints `already stopped` (exit 0); any lifecycle verb without an installed unit prints `service not installed - run: backupkit service install` (exit 1). `status` merges the unit state (`systemctl is-active` + main pid / `launchctl print`) with the engine's `status()` rows in one view: a header line `service: active (pid 1234, since ...)` or `service: not installed` followed by the per-target table; never errors just because the unit is absent. install/uninstall/start/stop/restart require root; `service status` does not.
- **logs**: tails the daemon logs - Linux: `journalctl -u backupkit -n <N> [-f]`; macOS: `tail -n <N> [-f] /var/log/backupkit/backupkit.log /var/log/backupkit/backupkit.err.log`. `-n/--lines` default 100; `-f/--follow` streams until Ctrl-C. Inherited stdio, child's exit code passed through. Missing source (no journal entry / no log files): `no daemon logs found - is the service installed? (backupkit service install)`, exit 1. No `--json` (journald already has `-o json` for machines).
- **list** (alias **ls**) -> `listSnapshots()`: complete snapshots per target - name, human UTC timestamp, partial-resume indicator. No sizes (usage reporting cut). Missing archive dir = "no backups yet - run: backupkit run", exit 0.
- **status** -> `status()`: one row per target - last snapshot, next due, last result, consecutive failures, lock state. Derived from run reports + due computation - always instant. (Unit state is `service status`'s addition; plain `status` needs no root and no OS tools.)
- **restore** -> `restore()`: section 8. `SNAPSHOT` may be `latest` (resolved via `listComplete()` - same rule in library and CLI). `--output` stays a named flag (the one argument where positional ambiguity could hurt).
- **prune** -> `prune()`: plan via `planRetention`, `--dry-run` prints the plan (keeps with reasons + prune list) and stops; execution per section 5 under the store lock.
- **check** -> `check()`: the interactive readiness gate. Validates config (fail-first, one error); verifies local rsync/ssh binaries + versions; runs the full `preflight()` key flow for explicit remotes - load unencrypted keys, `file:` keys via askpass, `prompt` keys via ssh-add's TTY prompt (TTY-gated exactly as section 4), generate missing `.pub` sidecars; for alias remotes skips priming, prints the `ssh -G`-resolved hostname/user/port, and probes connectivity under BatchMode with the actionable auth-failure message from section 4; probes each remote (`ssh ... rsync --version`, transient-retry wrapped), reports remote versions; TOFU-pins unpinned host keys (TTY only - dedicated file for explicit remotes, the user's own known_hosts for aliases); prints per-push-target `authorized_keys` jail lines (real key for explicit remotes, restriction prefix + append-your-key instruction for aliases) plus the `backupkit-remote` install instruction, and flags a push jail that is not answering. The one command a `prompt`-passphrase deployment runs after each reboot. Exit 2 on config error, 1 on any probe failure.
- **init**: writes the fully commented starter `config.jsonc` (section 2, from `config/internal/starter.ts`) at the resolved path, refuses overwrite without `--force` (message: `config exists at <path> - pass --force to overwrite`). stdout is three lines: the written path, "edit it, then run: backupkit check", done - all explanation lives in the file it wrote.

Every "cannot proceed" message names the exact next command: missing config -> `backupkit init`; unpinned host key -> `backupkit check`; encrypted `prompt` key unattended -> `backupkit check`; unit not installed -> `backupkit service install`; unknown target/subcommand -> the valid names.

Output: plain text, columns aligned with `String.prototype.padEnd` inline in the two commands that print tables - no table module, no ANSI color (greppable everywhere; `NO_COLOR` is moot). `--json` exists on exactly the two read-only view commands machines consume, `status` and `list`: one JSON document on stdout, logs to stderr only. `run`/`prune`/`check`/`service`/`logs` have no `--json` - the persisted run reports (section 8), the printed prune plan, and journald's own `-o json` are already the machine-readable record. Errors to stderr as `error <CODE>: message`; stack traces only at `logging.level: "debug"`.

**Exit codes (complete set, unchanged)**: `0` success (including bare `backupkit`, `--help`, and idempotent service no-ops) · `1` runtime failure (a target failed, a prune deletion failed, a probe failed, a lifecycle verb without an installed unit, no logs found) · `2` config error · `3` lock held (try again later) · `64` bad CLI usage (unknown flag/subcommand/target). `logs` passes through the child's exit code when it ran.

---

## 8. Reliability

### Failure matrix

| Failure | Detection | Handling | Operator sees |
|---|---|---|---|
| Network drop mid-transfer | exit 10/12/30/35, or 255 without a permanent pattern | in-run retry: up to `retry.attempts` (default 5), 15s doubling to 300s cap ±20% jitter, resuming into the same `.partial`; exhausted -> run `failed`, partial kept for next scheduled run | warn per attempt; error + report on final failure |
| Momentary blip on a control op (probe, list, mkdir, mv, rm, df) | ssh exit 255 / exec timeout inside `withTransientRetry` | 3 attempts per op (2s, 8s ±20% jitter); still failing -> the op's error propagates to its normal per-target path | one warn per retried attempt; nothing if the retry heals it |
| Host unreachable | ssh fails in <= 15 s, exit 255 | same transfer retry path; no partial created if never connected | `host unreachable: user@10.0.0.11:22` (or the alias) |
| Host key mismatch | permanent stderr pattern (section 4) | permanent: no retry at any layer, fatal for host, never auto-healed | error naming the relevant known_hosts remediation |
| Auth failure / key not loaded (explicit) | preflight fingerprint check; runtime exit 255 + `Permission denied (` | preflight: fail fast pointing at `backupkit check`; runtime: permanent, run `failed`, no retry | actionable one-liner |
| Auth failure (alias) | runtime exit 255 + `Permission denied (` under BatchMode | permanent, no retry; backupkit manages no keys for aliases | `ssh alias "myserver": authentication failed - verify "ssh myserver" works non-interactively for this user`; `check` shows the `ssh -G` resolution |
| Disk low on archive | guard: delta*1.2+256MiB vs free minus minFree | skip target (`skipped`, reason `disk-low`), nothing deleted, daemon lives | error once per state transition; flagged row in `status` |
| ENOSPC mid-transfer | exit 11 | fail, no retry, partial kept | disk error in report |
| Permission-denied source files | exit 23 | **promote** with `warning`; <=100 paths + exclude hint in report | warn with count + sample |
| Vanished files | exit 24 | promote with warning | warn |
| Clock skew | new name would sort <= newest | run `failed`, reason `clock-skew` | error naming both timestamps |
| Crash mid-snapshot | `.partial` present next run | `claimPartial` resumes into it; never promoted, never link-dest | info: `resuming partial snapshot` |
| Daemon crash / OOM kill | service manager sees signal or non-zero exit | restart after 15 s (`Restart=on-failure` / `KeepAlive {SuccessfulExit:false}`, no start limit); recovery steps 2-4 of section 6 run: partial resumed, state rehydrated from reports, `file:` keys re-primed, stale lock taken over | aborted/failed run visible in `status`; restart in `backupkit logs` |
| Host reboot | `RunAtLoad` / `WantedBy=multi-user.target` | identical recovery path; exactly one catch-up run per missed window; `file:` keys re-prime with zero operator action (`prompt` keys fail only their remote's targets, pointing at `check`; alias remotes need nothing) | info: catch-up run per target |
| Repeated target failure (crash-loop guard) | `consecutiveFailures` derived from run reports | per-target backoff `15min * 2^(n-1)` capped at 6 h - delays scheduling, never stops it; service-level restarts stay paced at 15 s | error log on every backoff transition (enter/extend/ceiling/clear) |
| Two instances | destination-root lock | exit 3 / daemon skip-tick; stale detection via pid+start-time | `another backupkit (pid N) holds <path>` |
| Corrupt run report | parse/shape failure during derivation | skip that file, treat as absent (dir names + remaining reports are truth) | warn |
| Missing/old rsync or ssh | startup probe / remote exit 127 | local: exit 1 before any I/O; remote: host-level fail, permanent (version floors are never retried) | version + fix instructions |
| Remote rsync < 3.2.5 | remote probe (transient-retry wrapped, so a blip never misgrades a host) | refuse host's targets | error naming floor |

### Logging

`shared/logger.ts`. Levels `error < warn < info < debug` (config `logging.level`, default info). One line, greppable: `2026-08-10T03:15:00.123Z INFO  [target=web1-var-www run=2026-08-10T031500Z_web1-var-www] message key=value`. Child loggers via `logger.with({target, run})`. debug/info -> stdout, warn/error -> stderr; optional `logging.file` append sink - rotation belongs to the platform (journald on Linux, newsyslog on macOS, section 6), the logger never rotates. All remote-derived values pass `sanitize()` before logging. debug level logs full rsync argv (nothing secret ever appears in argv by construction). Never `console.*` outside the logger and CLI output. `backupkit logs` (section 7) is the operator's tail over the platform sink.

### Run reports

Two typed layers, both exported from `engine/types.ts`: `run()` returns the invocation summary `RunReport = { startedAt: string; finishedAt: string; targets: TargetRunReport[] }`; each per-target result is a `TargetRunReport`, persisted one JSON per run at `<stateDir>/runs/<target>/<runId>.json`, atomic write, 0600, newest 50 kept. `runId = <formatSnapshotName(start)>_<target>` - the snapshot codec, reused (filesystem-safe, lexically sortable; uniqueness per target per second is guaranteed by the pipeline lock):

```json
{
    "runId": "2026-08-10T031500Z_web1-var-www", "target": "web1-var-www", "direction": "pull",
    "snapshot": "2026-08-10T031500Z", "status": "success", "reason": null,
    "startedAt": "...", "finishedAt": "...",
    "attempts": [ { "exitCode": 0, "class": "ok", "durationMs": 41000, "stderrTail": "" } ],
    "stats": { "filesTransferred": 812, "bytesTransferred": 10485760, "totalFiles": 120433, "deltaBytes": 10485760 },
    "skippedFiles": [], "error": null
}
```

`status` in `success | warning | failed | skipped | aborted`; `stderrTail` = sanitized last 2 KiB; `attempts` records every retry, so the report shows exactly how a run fought through a flaky link. These files are the single persistent record: `status()`, the backoff derivation, and restart recovery (section 6) read nothing else. Notifications (webhook/command hooks) are cut from v1 - journald/logs are the alerting surface.

### Status

`Backupkit.status()` returns `TargetStatus[]`:

```ts
export interface TargetStatus {
    target: string;
    lastSnapshot: string | null;
    nextDueAt: string | null;
    lastResult: "success" | "warning" | "failed" | "skipped" | "aborted" | null;
    consecutiveFailures: number;
    lockHeld: boolean;
}
```

Read-only over reports + the due computation; the CLI `status` command only formats it (and `service status` prepends the unit-state header, section 7). `nextDueAt` includes any active backoff delay, so an operator can see exactly when a failing target retries.

### Restore (legacy bugs 2 and 7 dead)

`backupkit restore TARGET SNAPSHOT --output PATH` / `restore(options): Promise<RestoreReport>` with `RestoreReport = { target: string; snapshot: string; output: string; verified: boolean }`:

1. Snapshot resolved against `listComplete()` only (`latest` = newest, identical rule in library and CLI); unknown/partial = error naming the newest complete one.
2. `output` must not exist (no into-existing mode, no `--delete`, ever). Its realpath'd parent must not resolve inside any configured destination root.
3. Copy: the snapshot's store endpoint -> local output, one rsync either way - local archives `rsync -a --sparse -H <snap>/ <output>/`; remote (push-mode) archives the same rsync over ssh (`formatEndpoint` of the remote snapshot -> `<output>/`). Symlinks are copied as symlinks, never followed; the destination is fresh, so no symlink-directed write exists.
4. Success reported only after rsync exits 0 (awaited, exit-checked).
5. `--verify`: post-copy `buildArgs` verify-mode pass (`-a --checksum --dry-run --itemize-changes`); any content-change line = exit 1 listing differing paths. Opt-in (full re-read). `verified: true` in the report only on a clean verify pass.

---

## 9. Test strategy

Vitest, tests in `src/<module>/tests/`, existing glob `src/**/tests/**/*.test.ts` unchanged. Naming: `*.test.ts` pure unit, `*.integration.test.ts` real local rsync + tmpfs, `*.fake.test.ts` PATH-shimmed fake binaries. Dev-only helpers in `src/testing/` (`fake-bin.ts`, `fixtures.ts`), excluded from build. Target 100% coverage per house rule; `retention/`, `shared/`, `config/` are pure and must hit it trivially.

**Structural guard tests** (the enforcement pattern this repo already uses):
- `shared/tests/purity.test.ts`: `shared/` and `retention/` import no `node:fs`/`node:child_process`.
- `exec/tests/choke-point.test.ts`: source scan - `child_process` imported nowhere but `exec/`; no `exec(`/`shell: true` anywhere.
- `shared/tests/regex-single-source.test.ts`: no competing snapshot-name or timestamp pattern outside `snapshot-name.ts` (no exemptions - `runId` reuses the codec).

**Unit layer** (table-driven `it.each`, all pure, explicit `now` params, no `Date.now()` inside functions under test; retry tests on fake timers):
- `config/tests/jsonc.test.ts`: exhaustive parser tables - `//` and `*/` inside strings, `"http://x"`, escaped quote before a comment, CRLF, trailing-comma matrix, comment before closing bracket, dup-key (both lines reported), depth-cap 64, unterminated string/block-comment/`/*`-at-EOF, single-quote/unquoted-key/`NaN` rejections, insertion-order preservation incl. integer-like keys (`"2024"` stays in document order).
- `config/`: minimal-valid defaults; unknown key at every level (incl. inside `schedule` and `retry`); each missing required field; both-filenames-in-one-dir error; bad remote ref; path rules (relative, `~`, whitespace-in-keyPath, leading `-`); `passphrase` form rejection incl. raw and `env:`; **remote-shape table** - `{alias}` alone accepted and resolved to `{kind: "alias"}`, `alias` + each sibling key (`host`, `user`, `identityFile`, `port`, `passphrase`, `knownHostsFile`, unknown) rejected with the "alias remotes take no other fields" message, explicit shape missing each required field individually named, alias charset rejections (whitespace, `:`, `@`, `/`, quote, leading `-`, empty, 65 chars), mixed alias + explicit remotes in one config accepted; **schedule-object matrix table** - every legal field combination -> exact `ScheduleConfig` with defaults filled (`intervalCount` 1, `at` "00:00", `on` "mon", `dayOfMonth` 1), every anchor outside its interval -> the targeted message (`"on" is only valid for interval "week"`, `at` on minute/hour, `dayOfMonth` off-month), `intervalCount` 0/negative/fractional rejected, `dayOfMonth` 0 and 29 rejected, `at` "24:00"/"3:00" rejected, `at` with `intervalCount > 1` accepted; `retry.attempts` 0 and 11 rejected, 1 and 10 accepted, default 5; retention `{}` rejection + target `retention: false` -> resolved `null`; `minFree` grammar + `false`; `bwlimit` grammar (bare, K/M/G, rejects `Kbps`-style junk); shared-snapshot-root collision; error messages carry `file:line`; **starter fixture test** - `starter.ts` text parses via `parseJsonc` and passes the validator (incl. the commented alias example when uncommented by the test).
- `shared/snapshot-name.ts`: codec round-trip, fixed-width sort property, invalid-date rejection, `.partial`/`.deleting` classification, legacy epoch names rejected.
- `shared/format.ts`: `formatEndpoint` table - local passthrough, `user@host:` prefixing, IPv6 bracketing, port irrelevance (ports travel in ssh tokens), **alias form `myserver:/path` with no `user@` and no brackets**.
- `shared/time.ts` + scheduler: window indices for **all five intervals** across DST dates under `TZ=America/New_York` and `TZ=Asia/Kolkata` asserting identical UTC output; minute windows with `intervalCount` 1 and 5; **month tables** - months-since-epoch indexing across a year boundary, leap-February, Jan-31 23:59 vs Feb-01 00:00 landing in adjacent windows, `intervalCount: 2` window starts on odd/even months, `dayOfMonth` + `at` anchor gating (not due on the 1st when `dayOfMonth: 15`); `intervalCount: 3` restart simulation from a directory listing (no early re-fire); catch-up = one run per missed week and per missed month; `at` gating incl. `intervalCount > 1`; backoff cap; clock-skew guard.
- `shared/retry.ts`: fake-clock tables - exact delay sequences for both policies (15/30/60/120 capped 300; 2/8), jitter stays within ±20%, retries only `retriable: true` errors, non-retriable rethrows on attempt 1, attempts bound honored, success short-circuits, one warn per retried attempt.
- `retention/`: full GFS tables (keep/prune exact sets), newest-always-kept with all-zero rules, ISO-Monday week buckets, leap day, empty input, multi-reason snapshots.
- `rsync/internal/args.ts`: exact full-argv equality for pull and push minimal + maximal option sets **as one three-column table per spec (mode transfer/estimate/verify)** - a mode can never silently inherit a flag it must not have; link-dest present/absent/`../` single-level only; hostile exclude strings appear as single unmodified argv elements; `--bwlimit` token verbatim; trailing-slash normalization; `--chmod=ug-s`/`--no-devices` presence; `--fake-super` on non-root; `sshTokens` joined into `-e` only when an endpoint is remote (identical handling for explicit and alias token sets - the builder is kind-blind by assertion).
- `rsync/internal/classify.ts` + `stats.ts`: full exit-code matrix **including the 255 x stderr cross-table** - each of the three permanent patterns -> `retriable: false`, arbitrary/empty/garbage stderr -> `retriable: true`, patterns checked against the sanitized tail; stats2 parsing incl. locale-independent output (LC_ALL=C).
- `ssh/`: `sshArgs` exact argv for unattended vs interactive contexts **for both remote kinds** - explicit carries the full option set; alias carries exactly the six baseline tokens plus contextual StrictHostKeyChecking and NEVER `-i`/`-p`/`IdentitiesOnly`/`PreferredAuthentications`/`UserKnownHostsFile` (asserted as absence, not just presence); `classify.ts` pattern table (shared fixtures with the rsync cross-table so the two callers can never diverge); quoter torture cases (`'`, `$`, backtick, space, newline-rejected); `--` before every path operand; permission-check matrix via injected stat results (both root/non-root branches; alias config skips every explicit-only row, still checks config/stateDir/destination); `resolveAlias` parsing of `ssh -G` output incl. garbage/partial output degrading to the "could not resolve" path.
- `engine/`: target-runner state machine against a fake `SnapshotStore` + fake exec (skip/dedup/force/disk-low/promote/retention-trigger paths, `withLock` releases on every throw path); report shape incl. `aborted` and multi-entry `attempts`; **backoff-derivation table** (report sequences -> `consecutiveFailures`/anchor, `aborted`/`skipped` ignored, corrupt file skipped, ceiling at 6 h); **backoff transition logging** - fixture sequences assert one error-level line per enter/extend/ceiling/clear transition and none otherwise; `status()` rows against fixture report dirs incl. `nextDueAt` reflecting active backoff; preflight with an all-alias config spawns no agent and probes no fingerprints (fake exec records zero `ssh-agent`/`ssh-add` calls).
- Env seam: exec-call fixtures assert `SSH_AUTH_SOCK` = the backupkit agent sock on explicit-remote spawns, = the inherited value (or absent) on alias-remote spawns.

**Integration layer** (real local rsync, no ssh; `skipIfNoRsync` loudly degrades local dev, CI image has rsync): first snapshot content equality; second snapshot inode-equality for unchanged files and inode-divergence for changed (real `--link-dest` proof); delete propagation; excludes; filenames with spaces/`$`/quotes byte-identical; **atomicity + restart kill-test** - SIGTERM and SIGKILL mid-transfer each leave only `<name>.partial`, a fresh process (cold start, state rehydrated from reports alone) resumes via `claimPartial` and promotes; two-phase prune crash artifact sweep; lock contention with two concurrent runs against the mkdir lock (exactly one final snapshot), stale-dir takeover after a kill -9 (pid/start-time), symlink-planted lock name refused; restore to fresh path byte-identical, refuses existing output, resolves only after real completion.

**Fake-bin layer** (`src/testing/fake-bin.ts`: node-shebang recorder scripts writing `JSON.stringify(process.argv.slice(2))` per line to `$FAKE_BIN_LOG`, exit code/stdout/stderr from env; PATH passed per-call via the exec options env, never mutating `process.env`): agent bootstrap (spawn vs adopt, fingerprint skip, per-key `ssh-add` argv order, passphrase never in argv, askpass env vars set correctly); hang prevention (fake `ssh-add` sleeping -> timeout rejection, never a hang); **retry wiring end-to-end** (fake rsync exiting 10,0 -> 2 invocations; 10 five times -> 5 invocations and fatal; `retry.attempts: 2` -> 2 and fatal; 255 with `Permission denied (publickey,password)` stderr -> exactly 1 invocation, no retry; 23 -> promote-with-warning, 1 invocation); **control-op retry wiring** (fake ssh failing once with exit 255 then succeeding -> probe/list/df succeed with one warn; three failures -> the op's error propagates; lock `mkdir` returning EEXIST -> exactly 1 invocation, never retried); ssh `-o` flags actually reaching the spawn **for both remote kinds** (alias spawn shows the alias as destination token and no `-i`/`-p` anywhere in the recorded argv); remote store lifecycle argv (`find -print0`, `mv --`, `rm -rf --`, `mkdir --` lock) with NUL-embedded and regex-failing names ignored; fake `ssh -G` output driving `check`'s alias resolution display; the `backupkit-remote` jail driven with allowed and escaping `SSH_ORIGINAL_COMMAND` values (lives in `snapshots/tests/`, next to the argv builder it must mirror).

**CLI/service layer**: parse/dispatch unit tests (positionals, unknown-name exit 64, `ls` dispatching to `list`, bare invocation printing the 3-step help with exit 0, `--json` rejected on run/prune/check/service/logs as an unknown flag); **unit-file string-generation tables** asserting the exact restart stanzas - `Restart=on-failure`, `RestartSec=15`, `StartLimitIntervalSec=0` (systemd), `KeepAlive` with `SuccessfulExit: false`, `ThrottleInterval: 15` (launchd), the newsyslog conf line, the conditional `ReadOnlyPaths=/root/.ssh` (present with an alias remote, absent without) - plus the full hardening block; **lifecycle-verb tables against fake `systemctl`/`launchctl`** - exact argv per verb (`start`/`stop`/`restart` -> `systemctl <verb> backupkit`; macOS bootstrap/bootout/kickstart forms), idempotent messages (already-running/already-stopped exit 0, not-installed exit 1 naming `service install`), `service status` header merged with fake-engine rows; **logs command tables** - `journalctl -u backupkit -n 100`, `-f` and `-n 20` propagation, macOS `tail` form with both file paths, missing-source message and exit 1, child exit code passthrough; command tests against a fake engine.

**Manual smoke script** `scripts/smoke-test.sh` (release gate, never CI): two hosts/containers, passphrase key end-to-end via `backupkit check`, an alias remote defined only in `~/.ssh/config` pulling successfully with `{alias}` config (incl. `check`'s `ssh -G` display and a deliberate wrong-alias auth failure showing the actionable message), push through the `backupkit-remote` jail (including a rejected escape attempt), pull with zero credentials on source, mid-transfer kill + recovery, `service install`/`start`/`stop`/`restart`/`status` and `logs -f` exercised on both OSes, crash-restart and reboot-recovery behavior (kill -9 the daemon, watch it return in ~15 s and resume the partial), loopback-fs disk-low skip, restore + diff.

CI safety rules binding on every test: no `/etc` access, no network, no real ssh, no root, tmpdirs via `mkdtemp` cleaned in `afterEach`, sorted directory comparisons, every file runnable in isolation.

---

## 10. Docs plan

`site/` = private Next.js App Router app mirroring scribekit's own, sharing root `node_modules`; root scripts `docs`/`docs:build` added. `site/app/docs/_docs.ts`: `new Docs({ contentDir: "./docs", siteUrl: "https://daanvandenbergh.github.io/backupkit/", brandName: "Backupkit", tabs, groups })` (verify origin against `git remote get-url origin` at build time). Chrome files copied verbatim from scribekit's site. GitHub Pages via scribekit-docs-github-pages CREATE mode: `output: "export"`, `images.unoptimized`, basePath `/backupkit` from `NEXT_PUBLIC_BASE_PATH`, `site/public/.nojekyll`, `.github/workflows/deploy.yml` at repo root with `working-directory: site` and artifact path `site/out`, Node 22.

Corpus (`site/docs/<slug>/en.mdx`, front-matter + hero via `/scribekit-hero` generated in the same change):

| slug | title | tab/group | order |
|---|---|---|---|
| `getting-started` | Getting Started | guide/start | 1 |
| `push-vs-pull` | Push vs Pull Architecture | guide/concepts | 1 |
| `security-model` | Security Model | guide/concepts | 2 |
| `retention` | Versioning & Retention | guide/concepts | 3 |
| `daemon-setup` | Daemon Setup | guide/operate | 1 |
| `restore` | Restoring a Backup | guide/operate | 2 |
| `configuration` | Configuration Reference | reference/config | 1 |
| `cli-reference` | CLI Reference | reference/cli | 1 |

Every documented flag/default traces to a real `file:line` (scribekit-docs hard rule). CLI reference is written from section 7's tree - including the full `service` lifecycle, `logs`, the `ls` alias, and the bare-invocation help; configuration reference from section 2's schema, JSONC rules (the three tolerances, duplicate-key rejection), the remote discriminated shape (a worked alias example: the ssh_config entry side by side with the one-line backupkit remote), the schedule-object validation matrix (with a worked example per interval, month and minute included), the retry knob, and the starter as its worked example. `security-model` documents: pull-preferred rationale, the push jail and `check`'s generated `authorized_keys` line (both remote kinds), host-key pinning workflow (dedicated file for explicit remotes, the user's own known_hosts for aliases, and why the `-o` baseline still wins over a lax ssh_config), key permission requirements and the alias-mode division of responsibility, `nosuid,nodev` mount advice. `daemon-setup` documents the 3-step setup, the full `service` verb set with idempotence semantics, `logs`/`logs -f` as the tail surface, the restart-recovery guarantees and the exact service-unit settings from section 6 (crash vs clean-exit semantics, backoff ceiling, `file:` vs `prompt` vs alias key behavior across reboots, macOS newsyslog rotation). `getting-started` teaches the linear workflow: `init` -> edit -> `check` -> `service install` -> `service start` (with `run` for a first manual pass).

README restructure (after code lands): pitch + hero, badges, quick start (install, `backupkit init`, edit the commented config - alias remote shown as the one-liner it is, `backupkit check`, `backupkit service install`), push-vs-pull with pull marked default, trimmed config table + CLI table linking to the docs site (README is a funnel, never a second schema copy), security notes, development, license.

---

## 11. Build phases

Each phase ends at a green checkpoint (`npm run typecheck && npm test` pass) and a commit with explicit paths only, message naming the area, Co-Authored-By trailer, never pushed. Work packages within a phase marked `[P]` are parallelizable across agents; unmarked ones are sequential within the phase. `claude/active_sessions.md` protocol applies from Phase 1 onward.

### Phase 0 - Repo hygiene (single agent)
- Rewrite `push-and-publish` to `npm run build && npm publish`; add `engines: {node: ">=20"}` (full `bin` wiring deferred to Phase 4).
- Create `claude/tasks/plans.md`, `claude/memory/lessons.md`, `claude/active_sessions.md`.
- Add `rules/active_sessions.md` + `rules/audit_security_rules.md` imports to `CLAUDE.md`; seed `claude/audit-security/rules.md` with the section-4 invariants list (all 14).
- Symlink `.claude/skills/{scribekit-docs,scribekit-blog,scribekit-docs-github-pages}`.
- Add `src/testing` to `tsconfig.build.json` exclude.
- Checkpoint: trivially green. Commit: "repo hygiene: skills, workflow files, publish script, build excludes".

### Phase 1 - Foundations (single agent; everything depends on it)
- **WP1.1 `shared/`**: `errors.ts` (hierarchy + `isBackupkitError` + code union + `retriable` payloads), `snapshot-name.ts` (codec + regex + guard-test), `time.ts` (UTC window math for all five intervals incl. months-since-epoch), `retry.ts` (`withTransientRetry` + fake-clock tests), `types.ts` (incl. `Endpoint` + the discriminated `ResolvedRemote`), `format.ts` (incl. `formatEndpoint` with the alias form), `logger.ts` (+ sanitize) + full unit tests incl. purity guard and TZ-invariance tables.
- **WP1.2 `exec/`**: `exec()` wrapper (argv, no shell, minimal env, timeout, ExecResult, the `stdio: "inherit"` variant) + choke-point guard test + unit tests.
- **WP1.3 `config/`**: `internal/jsonc.ts` (the JSONC reader + its torture tables), `internal/starter.ts` (+ the starter-validates fixture test, alias remote in comments), types (RemoteConfig union), validator (incl. the alias-XOR-explicit shape rule, the schedule-object validation matrix, and the `retry` knob), defaults, `resolveConfigPath` (jsonc/json probe + both-present error), `loadConfig` (endpoint mapping incl. alias endpoints, document-order targets) + the full validation test table (section 9).
- Checkpoint: all three green, 100% on pure modules. Commit: "shared+exec+config: primitives, snapshot codec, retry helper, jsonc, alias remotes, validator, starter".

### Phase 2 - Engine building blocks (parallel agents, each depends only on Phase 1)
- **WP2.1 [P] `ssh/`**: agent lifecycle (explicit remotes only; all-alias configs spawn nothing), askpass helper + `internal/askpass.sh` asset, `sshArgs` contextual builder for both remote kinds, `resolveAlias` (`ssh -G`), `classify.ts` (permanent-pattern classification), `runRemote` + quoter, permission preflight (alias-aware row skipping), known_hosts management (explicit remotes). Tests: unit + fake-bin agent/hang/argv suites (both kinds) + the classification pattern table.
- **WP2.2 [P] `rsync/`**: `buildArgs(spec, mode)`, version probes (3.2.5 floor, transient-retry wrapped, per-alias keying), `classifyExit` (exit codes x permanent stderr), stats parser, retry loop on `shared/retry`'s transfer policy, `dryRunStats`. Consumes `Endpoint` pairs and a plain `sshTokens: string[]` parameter - kind-blind, no cross-module stub, no build-order dependency on WP2.1 beyond `ssh/classify.ts`. Tests: three-column argv-equality tables + the 255 x stderr cross-table + fake-bin retry wiring.
- **WP2.3 [P] `snapshots/`**: `SnapshotStore` interface (`withLock`), local store, remote store (NUL listing, `--`, jail-compatible argv, control-path retry on every command except lock mkdir), unified mkdir+meta lock (local pid/start-time staleness, remote TTL), two-phase delete, `claimPartial`/`promote`, `internal/backupkit-remote.sh` jail script + its fake-bin suite driving allowed and escaping `SSH_ORIGINAL_COMMAND` values (the jail and the argv it must permit evolve in one directory, reviewed together). Tests: tmpdir local-store integration (atomicity kill-test, lock contention, symlink refusal) + fake-`runRemote` remote-store unit tests incl. control-op retry wiring.
- **WP2.4 [P] `retention/`**: `planRetention` + exhaustive GFS tables.
- Phase gate: all four green before Phase 3. Commits per WP: "ssh: agent, options, alias mode, quoting, classify, preflight", etc.

### Phase 3 - Engine (single agent; depends on all of Phase 2)
- **WP3.1** `engine/`: `Backupkit` class (`preflight`/`run`/`start`/`stop`/`status`/`listSnapshots`/`restore`/`prune`/`check`), target-runner pipeline (withLock -> prepare -> guard -> transfer -> verify -> promote -> retention -> report), scheduler + five-interval due-ness, run reports + backoff derivation and transition logging (`internal/reports.ts` - no state file), restart-recovery startup sequence, disk-guard decision, signal handling/abort (aborted report), `check`'s alias connectivity probe + `ssh -G` display + per-kind jail-line output.
- Tests: fake-store/fake-exec state-machine suite, backoff-derivation + transition-logging tables, all-alias preflight no-agent assertion, end-to-end local-rsync integration (full pipeline pull-mode against tmpdirs incl. the cold-restart resume test).
- Checkpoint green. Commit: "engine: pipeline, scheduler, reports, restart recovery, status, alias check flow".

### Phase 4 - CLI (single agent; depends on Phase 3)
- **WP4.1** `cli/`: main dispatch (positional targets, `ls` alias, bare-invocation help), all commands from section 7 as thin views over engine methods, padEnd-aligned/JSON output, exit-code mapping, help text, service unit generation (systemd hardened template with the restart stanzas + conditional `ReadOnlyPaths` + launchd plist + newsyslog conf) AND lifecycle verbs (`start`/`stop`/`restart`/`status` driving `systemctl`/`launchctl` idempotently) plus `logs` (journalctl/tail passthrough) under `cli/internal/service/`; `init` writes the starter from `config/internal/starter.ts` (never embeds its own copy); `check` output incl. generated jail lines for both remote kinds.
- **WP4.2** `package.json`: `bin`, build-script asset copy (`src/ssh/internal/askpass.sh`, `src/snapshots/internal/backupkit-remote.sh` to their dist mirrors).
- Tests: parse/dispatch unit tests (positionals, unknown-name exit 64, `ls` alias, bare help exit 0, `--json` scope), unit-file string-generation tables (restart stanzas exact, conditional alias `ReadOnlyPaths`), lifecycle-verb and logs tables against fake `systemctl`/`launchctl`/`journalctl`/`tail`, command tests against a fake engine.
- Checkpoint green. Commit: "cli: commands, service lifecycle, logs, unit generation, bin wiring".

### Phase 5 - Verification pass (single agent)
- `scripts/smoke-test.sh` written + executed by the owner per section 9's checklist incl. the alias-remote, service-lifecycle, crash-restart, and reboot-recovery steps (release gate).
- `/audit-security` run against the finished `src/`; findings fixed; `claude/audit-security/rules.md` finalized.
- Checkpoint green. Commit: "reliability: smoke script, security audit fixes".

### Phase 6 - Docs (two parallel agents; depends on Phases 1-4 for file:line accuracy)
- **WP6.1 [P]** scribekit-docs write mode: the 8 corpus pages + heroes.
- **WP6.2 [P]** `site/` scaffold + GitHub Pages CREATE (workflow, next.config, `.nojekyll`); final `_docs.ts` tabs/groups merge waits on WP6.1's front-matter.
- Checkpoint: `npm run docs:build` static-exports successfully; root typecheck/test still green. Commit: "docs: corpus + Pages deployment".

### Phase 7 - README (single agent; depends on Phase 6 for live links)
- Restructure per section 10; verify every link resolves to a real slug.
- Checkpoint green. Commit: "readme: restructure per docs site".
