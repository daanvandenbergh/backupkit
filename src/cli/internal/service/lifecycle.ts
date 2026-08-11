/**
 * The `backupkit service` lifecycle verbs (spec sections 6 and 7):
 * install | uninstall | start | stop | restart | status, driving systemctl on
 * Linux and launchctl on macOS through exec/ (argv arrays, no shell; action
 * verbs use inherited stdio and no timeout - the documented passthrough
 * exception). Every verb is idempotent and every "cannot" message names the
 * exact next command. install/uninstall/start/stop/restart require root.
 */

import { statSync } from "node:fs";

import type { ResolvedConfig } from "../../../config/types.js";
import { ConfigError } from "../../../shared/errors.js";
import type { CliDeps } from "../context.js";
import { parseFlags, UsageError } from "../context.js";
import { COMMAND_HELP } from "../help.js";
import { formatStatusRows } from "../commands/status.js";
import {
    hasAliasRemote,
    LAUNCHD_LABEL,
    LAUNCHD_PLIST_PATH,
    launchdPlist,
    logDirOf,
    MACOS_LOG_DIR,
    NEWSYSLOG_CONF,
    NEWSYSLOG_CONF_PATH,
    readWritePathsOf,
    SYSTEMD_UNIT_PATH,
    systemdUnit,
} from "./units.js";

/** The valid lifecycle verbs, in help order. */
const VERBS = ["install", "uninstall", "start", "stop", "restart", "status"] as const;

/** One lifecycle verb. */
type Verb = (typeof VERBS)[number];

/** The message printed when a lifecycle verb finds no installed unit. */
const NOT_INSTALLED = "The backupkit service is not installed. Register it with: sudo backupkit service install";

/** The installed unit-definition path for the current platform. */
function unitPath(deps: CliDeps): string {
    return deps.platform === "darwin" ? LAUNCHD_PLIST_PATH : SYSTEMD_UNIT_PATH;
}

/** True when the unit definition file is installed. */
function isInstalled(deps: CliDeps): boolean {
    return deps.files.exists(unitPath(deps));
}

/** True when the systemd unit is currently active (Linux). */
async function systemdActive(deps: CliDeps): Promise<boolean> {
    const result = await deps.execFn("systemctl", ["is-active", "backupkit"]);
    return result.stdout.trim() === "active";
}

/** True when the launchd job is currently loaded (macOS). */
async function launchdLoaded(deps: CliDeps): Promise<boolean> {
    const result = await deps.execFn("launchctl", ["print", `system/${LAUNCHD_LABEL}`]);
    return result.exitCode === 0;
}

/** Run one OS-tool action with inherited stdio and no timeout; non-zero exit fails the verb. */
async function action(deps: CliDeps, bin: string, args: string[]): Promise<number> {
    const result = await deps.execFn(bin, args, { stdio: "inherit" });
    if (result.exitCode !== 0) {
        deps.stderr(`Error: ${bin} ${args.join(" ")} failed (exit ${result.exitCode ?? "signal"}).`);
        return 1;
    }
    return 0;
}

/**
 * Refuse to act on a config file that is not trustworthy. This is the
 * config-file row of the permission matrix, checked here because the lifecycle
 * verbs run as root over CONFIG-CHOSEN paths (they `mkdir` the `logging.file`
 * dir and stateDir and grant them to the unit sandbox) without running the
 * daemon's full preflight. Without it, anyone who can WRITE the config picks a
 * directory root creates (`"logging.file": "/etc/cron.d/bk.log"`).
 *
 * TWO checks, and they are NOT the same:
 *  - MODE (group/other-writable): ALWAYS enforced. This is the real boundary -
 *    it stops OTHER local users from tampering with the config a root service
 *    reads. Never relax it.
 *  - OWNERSHIP: waived when we run as ROOT (euid 0), exactly like
 *    `ownershipOk` in ssh/permissions.ts and security invariant 8. Root can
 *    already read/write/chown any file, so demanding the config be chown'd to
 *    root adds nothing - it only forces operators to `chown root` a config they
 *    deliberately keep under their own home, and it would be INCONSISTENT with
 *    the runtime path, where a root `run`/`daemon` already reads that same
 *    user-owned config. The owner (the operator who pointed a root service at
 *    their own file) is trusted by that choice; the mode check still blocks
 *    everyone else. A NON-root install still requires euid-or-root ownership.
 *
 * DO NOT re-add a "root must own the config" rule here. It is friction, not
 * protection (root already has full access), it contradicts the runtime
 * permission model, and it is locked by a test ("root (euid 0) accepts a
 * user-owned config" in the lifecycle suite). If an audit flags this, the audit
 * is out of date - see invariant 8.
 *
 * A path that cannot be stat'ed is nothing to check: `loadConfig` has already
 * READ this exact file microseconds earlier (a failure there is a ConfigError),
 * so in production the file is always there.
 */
function assertConfigTrusted(deps: CliDeps, configPath: string): void {
    let uid: number;
    let mode: number;
    try {
        const info = statSync(configPath);
        uid = info.uid;
        mode = info.mode;
    } catch {
        return;
    }
    if ((mode & 0o022) !== 0) {
        throw new ConfigError(
            `config file ${configPath} is group/other-writable (mode ${(mode & 0o777).toString(8).padStart(3, "0")}); run: chmod go-w ${configPath}`,
            { file: configPath },
        );
    }
    // Ownership waived for root (euid 0); mode check above still ran. See docblock.
    if (deps.euid !== null && deps.euid !== 0 && uid !== deps.euid && uid !== 0) {
        throw new ConfigError(
            `config file ${configPath} is owned by uid ${uid}, not uid ${deps.euid} or root; run: chown root ${configPath}`,
            { file: configPath },
        );
    }
}

/**
 * Write every file the unit definition consists of, from the CURRENT config,
 * and report whether that changed anything on disk.
 *
 * The unit is a mirror of config-derived facts - `ReadWritePaths` (every local
 * destination root, the stateDir, the config dir, the logging.file dir) and the
 * alias `ReadOnlyPaths` grant. `ProtectSystem=strict` turns a stale mirror into
 * a hard failure rather than a hardening gap: a destination added after install
 * is read-only to the daemon, so its every run fails with EROFS and points at
 * the filesystem instead of at the stale unit. Every lifecycle verb that starts
 * the daemon therefore re-derives this first - see `syncUnits`.
 */
function writeUnits(deps: CliDeps, config: ResolvedConfig): boolean {
    // Every directory below is a CONFIG-CHOSEN path this process creates as
    // root, so the config file's trust is checked before any of them.
    assertConfigTrusted(deps, config.configPath);
    // A configured logging.file needs its directory to exist before the daemon
    // writes its first line - on Linux it is also a ReadWritePaths member.
    const logDir = logDirOf(config);
    if (logDir !== null) {
        deps.files.mkdir(logDir, 0o750);
    }
    // The stateDir is an UNPREFIXED ReadWritePaths member, and systemd resolves
    // that list before ExecStart: it has to exist by the time the unit starts,
    // or namespace setup fails fatally instead of the daemon creating it.
    deps.files.mkdir(config.stateDir, 0o700);
    const desired: [string, string][] =
        deps.platform === "darwin"
            ? [
                  [
                      LAUNCHD_PLIST_PATH,
                      launchdPlist({ nodeBin: deps.nodeBin, cliPath: deps.cliPath, configPath: config.configPath }),
                  ],
                  [NEWSYSLOG_CONF_PATH, NEWSYSLOG_CONF],
              ]
            : [
                  [
                      SYSTEMD_UNIT_PATH,
                      systemdUnit({
                          nodeBin: deps.nodeBin,
                          cliPath: deps.cliPath,
                          configPath: config.configPath,
                          readWritePaths: readWritePathsOf(config),
                          aliasRemote: hasAliasRemote(config),
                      }),
                  ],
              ];
    if (deps.platform === "darwin") {
        deps.files.mkdir(MACOS_LOG_DIR, 0o750);
    }
    let changed = false;
    for (const [path, content] of desired) {
        const current = deps.files.exists(path) ? deps.files.read(path) : null;
        if (current !== content) {
            changed = true;
        }
        deps.files.write(path, content, 0o644);
    }
    return changed;
}

/**
 * Re-derive the installed unit from the current config before starting the
 * daemon, so a config change since `install` cannot leave the daemon running
 * under a unit that denies it its own archive roots or log file. Returns the
 * platform reload's exit code (0 when nothing changed - the common case, which
 * costs one file read and no subprocess).
 */
async function syncUnits(deps: CliDeps, configArg: string | undefined): Promise<number> {
    const { config } = deps.loadContext(configArg);
    if (!writeUnits(deps, config)) {
        return 0;
    }
    deps.stdout("Config changed since install - refreshed the service unit.");
    return deps.platform === "darwin" ? 0 : action(deps, "systemctl", ["daemon-reload"]);
}

/** Write the unit definition (+ enable on systemd, + newsyslog conf on macOS). Idempotent: rewrite + reload. */
async function install(deps: CliDeps, configArg?: string): Promise<number> {
    const { config } = deps.loadContext(configArg);
    writeUnits(deps, config);
    if (deps.platform !== "darwin") {
        for (const args of [["daemon-reload"], ["enable", "backupkit"]]) {
            const code = await action(deps, "systemctl", args);
            if (code !== 0) {
                return code;
            }
        }
    }
    deps.stdout("Service installed. Start it with: sudo backupkit service start");
    return 0;
}

/** Stop the unit if running, then remove everything install wrote. Idempotent. */
async function uninstall(deps: CliDeps): Promise<number> {
    if (!isInstalled(deps)) {
        deps.stdout("Service was not installed - nothing to remove.");
        return 0;
    }
    if (deps.platform === "darwin") {
        if (await launchdLoaded(deps)) {
            await deps.execFn("launchctl", ["bootout", `system/${LAUNCHD_LABEL}`], { stdio: "inherit" });
        }
        deps.files.remove(LAUNCHD_PLIST_PATH);
        deps.files.remove(NEWSYSLOG_CONF_PATH);
    } else {
        if (await systemdActive(deps)) {
            await deps.execFn("systemctl", ["stop", "backupkit"], { stdio: "inherit" });
        }
        await deps.execFn("systemctl", ["disable", "backupkit"]);
        deps.files.remove(SYSTEMD_UNIT_PATH);
        await deps.execFn("systemctl", ["daemon-reload"]);
    }
    deps.stdout("Service uninstalled.");
    return 0;
}

/** Start the installed unit; "already running" is a success. The unit is re-derived from the config first. */
async function start(deps: CliDeps, configArg?: string): Promise<number> {
    if (!isInstalled(deps)) {
        deps.stderr(NOT_INSTALLED);
        return 1;
    }
    const synced = await syncUnits(deps, configArg);
    if (synced !== 0) {
        return synced;
    }
    if (deps.platform === "darwin") {
        if (await launchdLoaded(deps)) {
            deps.stdout("Service is already running.");
            return 0;
        }
        const code = await action(deps, "launchctl", ["bootstrap", "system", LAUNCHD_PLIST_PATH]);
        if (code === 0) {
            deps.stdout("Service started.");
        }
        return code;
    }
    if (await systemdActive(deps)) {
        deps.stdout("Service is already running.");
        return 0;
    }
    const code = await action(deps, "systemctl", ["start", "backupkit"]);
    if (code === 0) {
        deps.stdout("Service started.");
    }
    return code;
}

/** Stop the installed unit; "already stopped" is a success. */
async function stop(deps: CliDeps): Promise<number> {
    if (!isInstalled(deps)) {
        deps.stderr(NOT_INSTALLED);
        return 1;
    }
    if (deps.platform === "darwin") {
        if (!(await launchdLoaded(deps))) {
            deps.stdout("Service is already stopped.");
            return 0;
        }
        const code = await action(deps, "launchctl", ["bootout", `system/${LAUNCHD_LABEL}`]);
        if (code === 0) {
            deps.stdout("Service stopped.");
        }
        return code;
    }
    if (!(await systemdActive(deps))) {
        deps.stdout("Service is already stopped.");
        return 0;
    }
    const code = await action(deps, "systemctl", ["stop", "backupkit"]);
    if (code === 0) {
        deps.stdout("Service stopped.");
    }
    return code;
}

/**
 * Restart the installed unit (kickstart -k on macOS; a stopped macOS job is
 * simply started). The unit is re-derived from the config first - and on macOS
 * a CHANGED plist is reloaded with bootout+bootstrap, because launchd caches
 * the plist it bootstrapped and `kickstart -k` would re-exec the old one.
 */
async function restart(deps: CliDeps, configArg?: string): Promise<number> {
    if (!isInstalled(deps)) {
        deps.stderr(NOT_INSTALLED);
        return 1;
    }
    const { config } = deps.loadContext(configArg);
    const changed = writeUnits(deps, config);
    if (changed) {
        deps.stdout("Config changed since install - refreshed the service unit.");
    }
    if (deps.platform === "darwin") {
        if (!(await launchdLoaded(deps))) {
            return start(deps, configArg);
        }
        if (changed) {
            const out = await action(deps, "launchctl", ["bootout", `system/${LAUNCHD_LABEL}`]);
            if (out !== 0) {
                return out;
            }
            const code = await action(deps, "launchctl", ["bootstrap", "system", LAUNCHD_PLIST_PATH]);
            if (code === 0) {
                deps.stdout("Service restarted.");
            }
            return code;
        }
        const code = await action(deps, "launchctl", ["kickstart", "-k", `system/${LAUNCHD_LABEL}`]);
        if (code === 0) {
            deps.stdout("Service restarted.");
        }
        return code;
    }
    if (changed) {
        const reload = await action(deps, "systemctl", ["daemon-reload"]);
        if (reload !== 0) {
            return reload;
        }
    }
    const code = await action(deps, "systemctl", ["restart", "backupkit"]);
    if (code === 0) {
        deps.stdout("Service restarted.");
    }
    return code;
}

/**
 * The `Service: ...` header line describing the unit state. Never errors on an
 * absent unit. systemd's two everyday words are translated for somebody who did
 * not ask for a systemd lesson - `active` is "running", `inactive` is "installed,
 * not running" plus the command that fixes it - while every other state it can
 * report (`failed`, `activating`, `unknown`, ...) already reads as plain English
 * and is passed through untouched.
 */
async function statusHeader(deps: CliDeps): Promise<string> {
    if (!isInstalled(deps)) {
        return "Service: not installed (register it with: sudo backupkit service install)";
    }
    if (deps.platform === "darwin") {
        const result = await deps.execFn("launchctl", ["print", `system/${LAUNCHD_LABEL}`]);
        if (result.exitCode !== 0) {
            return "Service: installed, not running (start it with: sudo backupkit service start)";
        }
        const pid = /pid = ([0-9]+)/.exec(result.stdout)?.[1];
        // Loaded but no pid: launchd holds the job and will run it, but nothing
        // is running this second. "loaded" alone is launchd's word and tells a
        // user nothing about whether their backups are happening.
        return pid === undefined
            ? "Service: loaded, no process running right now (backupkit logs shows why)"
            : `Service: running (pid ${pid})`;
    }
    const active = await deps.execFn("systemctl", ["is-active", "backupkit"]);
    const raw = active.stdout.trim() === "" ? "unknown" : active.stdout.trim();
    if (raw !== "active") {
        return raw === "inactive"
            ? "Service: installed, not running (start it with: sudo backupkit service start)"
            : `Service: ${raw}`;
    }
    const show = await deps.execFn("systemctl", ["show", "backupkit", "--property=MainPID", "--value"]);
    const pid = show.stdout.trim();
    return /^[0-9]+$/.test(pid) && pid !== "0" ? `Service: running (pid ${pid})` : "Service: running";
}

/** Unit-state header merged with the engine's per-target status table. */
async function status(deps: CliDeps, configArg?: string): Promise<number> {
    deps.stdout(await statusHeader(deps));
    const { engine } = deps.loadContext(configArg);
    for (const line of formatStatusRows(await engine.status())) {
        deps.stdout(line);
    }
    return 0;
}

/** The `backupkit service <verb>` command entry. */
export async function serviceCommand(argv: string[], deps: CliDeps): Promise<number> {
    const { values, positionals } = parseFlags(argv, { config: { type: "string" } }, true);
    if (values.help === true) {
        deps.stdout(COMMAND_HELP.service);
        return 0;
    }
    const verb = positionals[0] as Verb | undefined;
    if (verb === undefined || !VERBS.includes(verb) || positionals.length > 1) {
        throw new UsageError(`service needs one verb: ${VERBS.join(", ")}`);
    }
    const configArg = values.config as string | undefined;
    if (verb !== "status" && deps.euid !== 0) {
        deps.stderr(`"backupkit service ${verb}" needs root. Run: sudo backupkit service ${verb}`);
        return 1;
    }
    switch (verb) {
        case "install":
            return install(deps, configArg);
        case "uninstall":
            return uninstall(deps);
        case "start":
            return start(deps, configArg);
        case "stop":
            return stop(deps);
        case "restart":
            return restart(deps, configArg);
        case "status":
            return status(deps, configArg);
    }
}
