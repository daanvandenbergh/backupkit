/**
 * The `backupkit service` lifecycle verbs (spec sections 6 and 7):
 * install | uninstall | start | stop | restart | status, driving systemctl on
 * Linux and launchctl on macOS through exec/ (argv arrays, no shell; action
 * verbs use inherited stdio and no timeout - the documented passthrough
 * exception). Every verb is idempotent and every "cannot" message names the
 * exact next command. install/uninstall/start/stop/restart require root.
 */

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
const NOT_INSTALLED = "service not installed - run: backupkit service install";

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
        deps.stderr(`error runtime: ${bin} ${args.join(" ")} failed (exit ${result.exitCode ?? "signal"})`);
        return 1;
    }
    return 0;
}

/** Write the unit definition (+ enable on systemd, + newsyslog conf on macOS). Idempotent: rewrite + reload. */
async function install(deps: CliDeps, configArg?: string): Promise<number> {
    const { config } = deps.loadContext(configArg);
    // A configured logging.file needs its directory to exist before the daemon
    // writes its first line - on Linux it is also a ReadWritePaths member.
    const logDir = logDirOf(config);
    if (logDir !== null) {
        deps.files.mkdir(logDir, 0o750);
    }
    if (deps.platform === "darwin") {
        deps.files.mkdir(MACOS_LOG_DIR, 0o750);
        deps.files.write(
            LAUNCHD_PLIST_PATH,
            launchdPlist({ nodeBin: deps.nodeBin, cliPath: deps.cliPath, configPath: config.configPath }),
            0o644,
        );
        deps.files.write(NEWSYSLOG_CONF_PATH, NEWSYSLOG_CONF, 0o644);
    } else {
        deps.files.write(
            SYSTEMD_UNIT_PATH,
            systemdUnit({
                nodeBin: deps.nodeBin,
                cliPath: deps.cliPath,
                configPath: config.configPath,
                readWritePaths: readWritePathsOf(config),
                aliasRemote: hasAliasRemote(config),
            }),
            0o644,
        );
        for (const args of [["daemon-reload"], ["enable", "backupkit"]]) {
            const code = await action(deps, "systemctl", args);
            if (code !== 0) {
                return code;
            }
        }
    }
    deps.stdout("installed - start it: backupkit service start");
    return 0;
}

/** Stop the unit if running, then remove everything install wrote. Idempotent. */
async function uninstall(deps: CliDeps): Promise<number> {
    if (!isInstalled(deps)) {
        deps.stdout("already uninstalled");
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
    deps.stdout("uninstalled");
    return 0;
}

/** Start the installed unit; "already running" is a success. */
async function start(deps: CliDeps): Promise<number> {
    if (!isInstalled(deps)) {
        deps.stderr(NOT_INSTALLED);
        return 1;
    }
    if (deps.platform === "darwin") {
        if (await launchdLoaded(deps)) {
            deps.stdout("already running");
            return 0;
        }
        const code = await action(deps, "launchctl", ["bootstrap", "system", LAUNCHD_PLIST_PATH]);
        if (code === 0) {
            deps.stdout("started");
        }
        return code;
    }
    if (await systemdActive(deps)) {
        deps.stdout("already running");
        return 0;
    }
    const code = await action(deps, "systemctl", ["start", "backupkit"]);
    if (code === 0) {
        deps.stdout("started");
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
            deps.stdout("already stopped");
            return 0;
        }
        const code = await action(deps, "launchctl", ["bootout", `system/${LAUNCHD_LABEL}`]);
        if (code === 0) {
            deps.stdout("stopped");
        }
        return code;
    }
    if (!(await systemdActive(deps))) {
        deps.stdout("already stopped");
        return 0;
    }
    const code = await action(deps, "systemctl", ["stop", "backupkit"]);
    if (code === 0) {
        deps.stdout("stopped");
    }
    return code;
}

/** Restart the installed unit (kickstart -k on macOS; a stopped macOS job is simply started). */
async function restart(deps: CliDeps): Promise<number> {
    if (!isInstalled(deps)) {
        deps.stderr(NOT_INSTALLED);
        return 1;
    }
    if (deps.platform === "darwin") {
        if (!(await launchdLoaded(deps))) {
            return start(deps);
        }
        const code = await action(deps, "launchctl", ["kickstart", "-k", `system/${LAUNCHD_LABEL}`]);
        if (code === 0) {
            deps.stdout("restarted");
        }
        return code;
    }
    const code = await action(deps, "systemctl", ["restart", "backupkit"]);
    if (code === 0) {
        deps.stdout("restarted");
    }
    return code;
}

/** The `service: ...` header line describing the unit state. Never errors on an absent unit. */
async function statusHeader(deps: CliDeps): Promise<string> {
    if (!isInstalled(deps)) {
        return "service: not installed";
    }
    if (deps.platform === "darwin") {
        const result = await deps.execFn("launchctl", ["print", `system/${LAUNCHD_LABEL}`]);
        if (result.exitCode !== 0) {
            return "service: stopped";
        }
        const pid = /pid = ([0-9]+)/.exec(result.stdout)?.[1];
        return pid === undefined ? "service: loaded" : `service: active (pid ${pid})`;
    }
    const active = await deps.execFn("systemctl", ["is-active", "backupkit"]);
    const state = active.stdout.trim() === "" ? "unknown" : active.stdout.trim();
    if (state !== "active") {
        return `service: ${state}`;
    }
    const show = await deps.execFn("systemctl", ["show", "backupkit", "--property=MainPID", "--value"]);
    const pid = show.stdout.trim();
    return /^[0-9]+$/.test(pid) && pid !== "0" ? `service: active (pid ${pid})` : "service: active";
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
        deps.stderr(`service ${verb} requires root - run: sudo backupkit service ${verb}`);
        return 1;
    }
    switch (verb) {
        case "install":
            return install(deps, configArg);
        case "uninstall":
            return uninstall(deps);
        case "start":
            return start(deps);
        case "stop":
            return stop(deps);
        case "restart":
            return restart(deps);
        case "status":
            return status(deps, configArg);
    }
}
