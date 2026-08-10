#!/usr/bin/env node
/**
 * The backupkit CLI entry (`bin` = dist/cli/main.js): static subcommand
 * dispatch over node:util parseArgs commands, the bare-invocation 3-step
 * help, --version, per-command --help, and the exit-code mapping
 * (0 success, 1 runtime failure, 2 config error, 3 lock held, 64 bad usage).
 * Errors print to stderr as `error <CODE>: message`; stack traces appear only
 * when the loaded config's logging level is "debug". Every command is a thin
 * view over one engine method except `service` and `logs`, which drive the OS
 * tools through exec/.
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

import { loadConfig } from "../config/config.js";
import { Backupkit } from "../engine/backupkit.js";
import { exec } from "../exec/exec.js";
import { isBackupkitError } from "../shared/errors.js";
import { checkCommand } from "./internal/commands/check.js";
import { daemonCommand } from "./internal/commands/daemon.js";
import { initCommand } from "./internal/commands/init.js";
import { listCommand } from "./internal/commands/list.js";
import { pruneCommand } from "./internal/commands/prune.js";
import { restoreCommand } from "./internal/commands/restore.js";
import { runCommand } from "./internal/commands/run.js";
import { statusCommand } from "./internal/commands/status.js";
import type { CliDeps } from "./internal/context.js";
import { UsageError } from "./internal/context.js";
import { ROOT_HELP } from "./internal/help.js";
import { serviceCommand } from "./internal/service/lifecycle.js";
import { logsCommand } from "./internal/service/logs.js";

/** One command implementation. */
type Command = (argv: string[], deps: CliDeps) => Promise<number>;

/** The static dispatch table (`ls` is the one alias, for `list`). */
const COMMANDS: Record<string, Command> = {
    run: runCommand,
    daemon: daemonCommand,
    service: serviceCommand,
    logs: logsCommand,
    list: listCommand,
    ls: listCommand,
    status: statusCommand,
    restore: restoreCommand,
    prune: pruneCommand,
    check: checkCommand,
    init: initCommand,
};

/** The package version, read from the adjacent package.json. */
function packageVersion(): string {
    const raw = readFileSync(new URL("../../package.json", import.meta.url), "utf8");
    return (JSON.parse(raw) as { version: string }).version;
}

/** Build the production dependency set (real fs, real exec, real engine). */
export function defaultDeps(): CliDeps {
    const deps: CliDeps = {
        stdout: (line) => process.stdout.write(line + "\n"),
        stderr: (line) => process.stderr.write(line + "\n"),
        platform: process.platform,
        euid: process.getuid?.() ?? null,
        env: process.env,
        execFn: exec,
        files: {
            exists: (path) => existsSync(path),
            read: (path) => readFileSync(path, "utf8"),
            write: (path, content, mode) => writeFileSync(path, content, mode === undefined ? {} : { mode }),
            remove: (path) => rmSync(path, { force: true }),
            mkdir: (path, mode) => {
                mkdirSync(path, { recursive: true, mode });
            },
        },
        nodeBin: process.execPath,
        cliPath: fileURLToPath(import.meta.url),
        version: packageVersion(),
        debugEnabled: false,
        loadContext: (configArg) => {
            const config = loadConfig(configArg);
            deps.debugEnabled = config.logging.level === "debug";
            return { config, engine: new Backupkit(config) };
        },
        wireSignals: (stop) => {
            let stopping = false;
            const handler = (): void => {
                if (stopping) {
                    process.exit(1);
                }
                stopping = true;
                void stop();
            };
            process.on("SIGINT", handler);
            process.on("SIGTERM", handler);
        },
    };
    return deps;
}

/** Map a thrown error to its exit code and print `error <CODE>: message` on stderr. */
function reportError(error: unknown, deps: CliDeps): number {
    if (error instanceof UsageError) {
        deps.stderr(`error usage: ${error.message}`);
        return 64;
    }
    if (isBackupkitError(error)) {
        deps.stderr(`error ${error.code}: ${error.message}`);
        if (deps.debugEnabled && error.stack !== undefined) {
            deps.stderr(error.stack);
        }
        if (error.code === "config") {
            return 2;
        }
        if (error.code === "lock-held") {
            return 3;
        }
        return 1;
    }
    const message = error instanceof Error ? error.message : String(error);
    deps.stderr(`error runtime: ${message}`);
    if (deps.debugEnabled && error instanceof Error && error.stack !== undefined) {
        deps.stderr(error.stack);
    }
    return 1;
}

/**
 * The CLI: dispatch `argv` (without the node/script prefix) and return the
 * exit code. Bare invocation and --help print the 3-step help and exit 0.
 */
export async function main(argv: string[], deps: CliDeps = defaultDeps()): Promise<number> {
    const [first, ...rest] = argv;
    try {
        if (first === undefined || first === "--help" || first === "-h" || first === "help") {
            deps.stdout(ROOT_HELP);
            return 0;
        }
        if (first === "--version") {
            deps.stdout(deps.version);
            return 0;
        }
        // Object.hasOwn, never a truthiness/undefined test: COMMANDS is a plain
        // object literal, so `COMMANDS["toString"]` is an INHERITED function and
        // an `=== undefined` guard would wave it straight through to be called
        // with (rest, deps) - dispatch failing open on every Object.prototype
        // member instead of the usage error.
        const command = Object.hasOwn(COMMANDS, first) ? COMMANDS[first] : undefined;
        if (command === undefined) {
            throw new UsageError(
                `unknown command "${first}" (valid: ${Object.keys(COMMANDS).join(", ")})`,
            );
        }
        return await command(rest, deps);
    } catch (error) {
        return reportError(error, deps);
    }
}

// Run only when executed as the bin entry, not when imported by tests.
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
    main(process.argv.slice(2)).then(
        (code) => {
            process.exitCode = code;
        },
        (error) => {
            process.stderr.write(`error runtime: ${error instanceof Error ? error.message : String(error)}\n`);
            process.exitCode = 1;
        },
    );
}
