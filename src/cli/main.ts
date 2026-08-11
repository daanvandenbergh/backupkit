#!/usr/bin/env node
/**
 * The backupkit CLI entry (`bin` = dist/cli/main.js): static subcommand
 * dispatch over node:util parseArgs commands, the help surface (bare
 * invocation, -h/--help, `help [command]`, and `<command> -h/--help` - all
 * rendered from internal/help.ts), -v/--version, and the exit-code mapping
 * (0 success, 1 runtime failure, 2 config error, 3 lock held, 64 bad usage).
 * Errors print to stderr as `Error: message` - the machine-readable part is the
 * exit code, not a prefix a person has to read past; stack traces appear only
 * when the loaded config's logging level is "debug". Every command is a thin
 * view over one engine method except `service` and `logs`, which drive the OS
 * tools through exec/.
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

import { loadConfig } from "../config/config.js";
import { Backupkit } from "../engine/backupkit.js";
import { exec } from "../exec/exec.js";
import { isBackupkitError } from "../shared/errors.js";
import { checkCommand } from "./internal/commands/check.js";
import { daemonCommand } from "./internal/commands/daemon.js";
import { initCommand } from "./internal/commands/init.js";
import { jailCommand, jailDriftWarning } from "./internal/commands/jail.js";
import { listCommand } from "./internal/commands/list.js";
import { pruneCommand } from "./internal/commands/prune.js";
import { restoreCommand } from "./internal/commands/restore.js";
import { runCommand } from "./internal/commands/run.js";
import { startCommand } from "./internal/commands/start.js";
import { statusCommand } from "./internal/commands/status.js";
import { unlockCommand } from "./internal/commands/unlock.js";
import type { CliDeps } from "./internal/context.js";
import { UsageError } from "./internal/context.js";
import { COMMAND_HELP, ROOT_HELP } from "./internal/help.js";
import { serviceCommand } from "./internal/service/lifecycle.js";
import { logsCommand } from "./internal/service/logs.js";

/** One command implementation. */
type Command = (argv: string[], deps: CliDeps) => Promise<number>;

/** The static dispatch table (`ls` is the one alias, for `list`). */
const COMMANDS: Record<string, Command> = {
    run: runCommand,
    start: startCommand,
    daemon: daemonCommand,
    service: serviceCommand,
    logs: logsCommand,
    list: listCommand,
    ls: listCommand,
    status: statusCommand,
    restore: restoreCommand,
    prune: pruneCommand,
    unlock: unlockCommand,
    check: checkCommand,
    init: initCommand,
    jail: jailCommand,
};

/** Command aliases, resolved before a `help <topic>` lookup (`ls` -> `list`). */
const ALIASES: Record<string, string> = { ls: "list" };

/** The message for a name that is not a command: what was typed, and what is. */
function unknownCommand(name: string): string {
    return `unknown command "${name}" (valid: ${Object.keys(COMMANDS).join(", ")}). See: backupkit --help`;
}

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
            chmod: (path, mode) => {
                chmodSync(path, mode);
            },
            rename: (from, to) => {
                renameSync(from, to);
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

/** Map a thrown error to its exit code and print `Error: message` on stderr. */
function reportError(error: unknown, deps: CliDeps): number {
    if (error instanceof UsageError) {
        deps.stderr(`Error: ${error.message}`);
        return 64;
    }
    if (isBackupkitError(error)) {
        deps.stderr(`Error: ${error.message}`);
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
    deps.stderr(`Error: ${message}`);
    if (deps.debugEnabled && error instanceof Error && error.stack !== undefined) {
        deps.stderr(error.stack);
    }
    return 1;
}

/**
 * The CLI: dispatch `argv` (without the node/script prefix) and return the
 * exit code. Bare invocation, -h/--help, and `help` print the root page and
 * exit 0; `help <command>` prints that command's page.
 */
export async function main(argv: string[], deps: CliDeps = defaultDeps()): Promise<number> {
    const [first, ...rest] = argv;
    try {
        // Passive jail-drift nag on every invocation (stderr, so --json stdout
        // stays parseable). Skipped for `jail` itself, whose verbs report the
        // same state precisely.
        if (first !== "jail") {
            const drift = jailDriftWarning(deps);
            if (drift !== null) {
                deps.stderr(drift);
            }
        }
        if (first === undefined || first === "--help" || first === "-h" || first === "help") {
            // `help <command>` / `--help <command>` prints exactly what
            // `<command> --help` prints - the same page, either way round.
            const topic = rest[0] === undefined ? undefined : ALIASES[rest[0]] ?? rest[0];
            if (topic !== undefined && Object.hasOwn(COMMAND_HELP, topic)) {
                deps.stdout(COMMAND_HELP[topic]);
                return 0;
            }
            if (topic !== undefined) {
                throw new UsageError(unknownCommand(topic));
            }
            deps.stdout(ROOT_HELP);
            return 0;
        }
        if (first === "--version" || first === "-v") {
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
            throw new UsageError(unknownCommand(first));
        }
        return await command(rest, deps);
    } catch (error) {
        return reportError(error, deps);
    }
}

/**
 * True when `moduleUrl` is the script node was told to run - so the CLI runs
 * as the bin entry but stays inert when tests import it.
 *
 * `argv1` is resolved through realpath first, because the bin is ALWAYS reached
 * via a symlink in a real install (`/usr/local/bin/backupkit` ->
 * `node_modules/.../dist/cli/main.js`, and under `npm link` a second hop to the
 * checkout). Node resolves `import.meta.url` to the realpath while `argv[1]`
 * stays as-invoked, so a raw string compare is false in EVERY installed
 * scenario and true only when running the file by its real path: the CLI exits
 * 0 having printed nothing, for every command. A path that cannot be resolved
 * is compared as given - node has already executed it, so it exists.
 */
export function isEntryPoint(moduleUrl: string, argv1: string | undefined): boolean {
    if (argv1 === undefined) {
        return false;
    }
    let resolved: string;
    try {
        resolved = realpathSync(argv1);
    } catch {
        resolved = argv1;
    }
    return moduleUrl === pathToFileURL(resolved).href;
}

// Run only when executed as the bin entry, not when imported by tests.
if (isEntryPoint(import.meta.url, process.argv[1])) {
    main(process.argv.slice(2)).then(
        (code) => {
            process.exitCode = code;
        },
        (error) => {
            process.stderr.write(`Error: ${error instanceof Error ? error.message : String(error)}\n`);
            process.exitCode = 1;
        },
    );
}
