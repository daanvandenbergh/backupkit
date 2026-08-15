/**
 * Shared CLI plumbing: the injectable dependency seam every command receives,
 * the structural engine type (so tests can substitute a fake engine), the
 * usage-error class that maps to exit code 64, the parseArgs wrapper that
 * turns unknown flags into usage errors listing the valid ones, and the
 * target-name validation shared by every command taking positional targets.
 */

import { parseArgs } from "node:util";

import type { ResolvedConfig } from "../../config/types.js";
import type { ExecOptions, ExecResult } from "../../exec/exec.js";
import type {
    CheckReport,
    PruneReport,
    RestoreReport,
    RunReport,
    TargetStatus,
    TargetUnlockReport,
} from "../../engine/types.js";
import { formatBytes } from "../../shared/format.js";
import type { SnapshotInfo } from "../../snapshots/types.js";

/** The exec/ spawn function shape used by the service/logs passthroughs. */
export type ExecFn = (bin: string, args: readonly string[], options?: ExecOptions) => Promise<ExecResult>;

/**
 * The structural subset of `Backupkit` the CLI consumes. Commands depend on
 * this shape, never the class, so tests inject a plain fake object.
 */
export interface EngineLike {
    /** Ensure agent + keys + permission checks; `serviceMode` refuses passphrase-protected keys. */
    preflight(options?: { serviceMode?: boolean }): Promise<void>;
    /** Run every due target once (or the named subset). */
    run(options?: { targets?: string[]; force?: boolean; dryRun?: boolean }): Promise<RunReport>;
    /** Foreground scheduler loop; resolves after stop() completes. */
    start(): Promise<void>;
    /** Graceful stop: abort in-flight work and end the loop. */
    stop(): Promise<void>;
    /** One row per target: last snapshot, next due, last result, failures, lock state. */
    status(options?: { targets?: string[] }): Promise<TargetStatus[]>;
    /** List complete snapshots, oldest first. */
    listSnapshots(options?: { targets?: string[] }): Promise<SnapshotInfo[]>;
    /** Copy one snapshot ("latest" accepted) to a non-existent output path; `dryRun` only reports what it would write. */
    restore(options: {
        target: string;
        snapshot: string;
        output: string;
        verify?: boolean;
        dryRun?: boolean;
    }): Promise<RestoreReport>;
    /** Apply retention now. */
    prune(options?: { targets?: string[]; dryRun?: boolean; force?: boolean }): Promise<PruneReport>;
    /** Clear a leaked destination lock; a live lock needs `force`. */
    unlock(options?: { targets?: string[]; force?: boolean }): Promise<TargetUnlockReport[]>;
    /** Validate config, probe binaries and hosts, produce jail-line data. */
    check(): Promise<CheckReport>;
}

/** The loaded config plus the engine constructed over it. */
export interface CliContext {
    /** The fully resolved config. */
    config: ResolvedConfig;
    /** The engine over that config. */
    engine: EngineLike;
}

/** Filesystem seam for the service/init commands (fake-able; tests never touch /etc). */
export interface FileOps {
    /** True when a filesystem entry exists at the path. */
    exists(path: string): boolean;
    /** Read a UTF-8 text file. */
    read(path: string): string;
    /** Write a UTF-8 text file, optionally with an explicit mode. */
    write(path: string, content: string, mode?: number): void;
    /** Remove a file if it exists (no error when absent). */
    remove(path: string): void;
    /** Create a directory recursively, optionally with an explicit mode. */
    mkdir(path: string, mode?: number): void;
    /** Set a file's mode exactly (unlike write()'s mode, not masked by umask). */
    chmod(path: string, mode: number): void;
    /** Atomically rename `from` to `to`, replacing an existing `to`. */
    rename(from: string, to: string): void;
}

/** Everything a CLI command needs from the outside world - injectable for tests. */
export interface CliDeps {
    /** Write one line to stdout (newline appended). */
    stdout(line: string): void;
    /** Write one line to stderr (newline appended). */
    stderr(line: string): void;
    /** Platform discriminator ("linux" | "darwin" | other). */
    platform: string;
    /** Effective uid, or null when unavailable (non-POSIX). */
    euid: number | null;
    /** Process environment seam. */
    env: Record<string, string | undefined>;
    /** Spawn function - always exec/'s `exec` in production (the choke point). */
    execFn: ExecFn;
    /** Filesystem operations for service/init. */
    files: FileOps;
    /** Absolute path of the node binary (ExecStart / ProgramArguments). */
    nodeBin: string;
    /** Absolute path of this CLI entry script (ExecStart / ProgramArguments). */
    cliPath: string;
    /** Package version for --version. */
    version: string;
    /** True after loadContext saw `logging.level: "debug"` - enables stack traces on stderr. */
    debugEnabled: boolean;
    /** Load config (honoring --config / $BACKUPKIT_CONFIG) and build the engine. */
    loadContext(configArg?: string): CliContext;
    /** Register SIGINT/SIGTERM to call `stop` once; a second signal exits 1 immediately. */
    wireSignals(stop: () => Promise<void>): void;
}

/** Bad CLI usage (unknown flag, subcommand, or target name) - exit code 64. */
export class UsageError extends Error {
    /** Construct a usage error with its human message. */
    constructor(message: string) {
        super(message);
        this.name = "UsageError";
    }
}

/** One flag definition for `parseFlags`. */
export interface FlagSpec {
    /** parseArgs option type. */
    type: "boolean" | "string";
    /** Optional single-character short form (e.g. "f" for -f). */
    short?: string;
}

/** The parsed outcome of one command line. */
export interface ParsedFlags {
    /** Flag values keyed by long name. */
    values: Record<string, string | boolean | undefined>;
    /** Positional arguments in order. */
    positionals: string[];
}

/**
 * Parse a command's argv with node:util parseArgs (strict): `--flag value`
 * and `--flag=value` both accepted, unknown flags become a UsageError that
 * lists the command's valid flags. Every command implicitly accepts -h/--help.
 */
export function parseFlags(argv: string[], flags: Record<string, FlagSpec>, allowPositionals: boolean): ParsedFlags {
    const options: Record<string, { type: "boolean" | "string"; short?: string }> = {
        help: { type: "boolean", short: "h" },
    };
    for (const name of Object.keys(flags)) {
        options[name] = flags[name];
    }
    try {
        const { values, positionals } = parseArgs({ args: argv, options, allowPositionals, strict: true });
        return { values: values as Record<string, string | boolean | undefined>, positionals };
    } catch (error) {
        const first = String(error instanceof Error ? error.message : error).split(". ")[0];
        const valid = Object.keys(options)
            .map((name) => `--${name}`)
            .join(", ");
        throw new UsageError(`${first} (valid flags: ${valid})`);
    }
}

/**
 * Validate positional target names against the configured targets. Returns
 * undefined for "all targets" when none were given; an unknown name is a
 * UsageError (exit 64) listing the configured names.
 */
export function selectTargets(positionals: string[], config: ResolvedConfig): string[] | undefined {
    if (positionals.length === 0) {
        return undefined;
    }
    const known = new Set(config.targets.map((target) => target.name));
    for (const name of positionals) {
        if (!known.has(name)) {
            throw new UsageError(`unknown target "${name}" (configured: ${[...known].join(", ")})`);
        }
    }
    return positionals;
}

/**
 * "1 target", "2 targets" - a count with its noun, pluralised. Every CLI line
 * that reports a count goes through this instead of writing "target(s)": a
 * person reading "1 problem(s) above need fixing" is reading a template that
 * was never finished, and that is the whole impression the message leaves.
 * `plural` is for the irregulars; the default is the English "+s".
 */
export function count(n: number, singular: string, plural: string = `${singular}s`): string {
    return `${n} ${n === 1 ? singular : plural}`;
}

/**
 * Plain English for each machine-readable skip/failure `reason`. A person
 * reading `skipped db - window` learns nothing; the reason codes stay in the
 * persisted reports and in `--json`, and this is the only place they are
 * turned into a sentence for a terminal. A code with no entry here falls back
 * to itself rather than printing "undefined".
 */
const REASON_TEXT: Record<string, string> = {
    window: "already backed up in this schedule window, run again now with --force",
    "disk-low": "not enough free disk space",
    "clock-skew": "this host's clock is behind the newest snapshot",
    "verify-failed": "the copy does not match the source",
    aborted: "stopped before it finished",
    "dry-run": "dry run, nothing was written",
    "remote-unavailable": "could not reach the backup server",
    "content-collapse": "the source holds far fewer files than last time",
    "lock-held": "another backupkit run is already working on this target",
};

/** The unreadable-paths clause, or "" when nothing was skipped. */
function skippedClause(paths: string[]): string {
    if (paths.length === 0) {
        return "";
    }
    const more = paths.length > 1 ? ` and ${paths.length - 1} more` : "";
    return ` - but ${count(paths.length, "path")} could not be read, so ${paths.length === 1 ? "it is" : "they are"} not in the backup: ${paths[0]}${more}`;
}

/**
 * One target's line: `<target>: <what happened>`, written as a sentence.
 *
 * Deliberately NOT a padded status column. `OK     web - 0 files copied, 0 B;
 * dry-run` made the reader decode a table to learn that nothing had happened,
 * and padding a word to seven characters is the kind of alignment that only
 * pays off in a table with more than one column. A sentence per target says
 * the same thing in the order a person asks it: which target, what happened
 * to it, and what is wrong if anything.
 */
function runLine(target: RunReport["targets"][number]): string {
    const name = target.target;
    const reason = target.reason === null ? null : (REASON_TEXT[target.reason] ?? target.reason);
    if (target.reason === "dry-run") {
        const delta = target.stats === null || target.stats.deltaBytes <= 0 ? "" : ` (a real run would copy about ${formatBytes(target.stats.deltaBytes)})`;
        return `${name}: dry run, nothing was written${delta}`;
    }
    if (target.status === "failed") {
        return `${name}: FAILED - ${target.error ?? reason ?? "no reason recorded"}`;
    }
    if (target.status === "aborted") {
        return `${name}: stopped before it finished, nothing was lost`;
    }
    if (target.status === "skipped") {
        return `${name}: skipped, ${reason ?? "no reason recorded"}`;
    }
    const copied =
        target.stats === null
            ? "backed up"
            : target.stats.filesTransferred === 0
              ? "already up to date, nothing to copy"
              : `backed up ${count(target.stats.filesTransferred, "file")} (${formatBytes(target.stats.bytesTransferred)})`;
    const into = target.snapshot === null ? "" : ` into snapshot ${target.snapshot}`;
    return `${name}: ${copied}${into}${skippedClause(target.skippedFiles)}`;
}

/**
 * Print one line per target of a run report and a closing summary; returns the
 * number of failed targets. Shared by `run` (whose exit code is that count) and
 * by `start --force` (whose immediate pass reports the same way before the
 * scheduler takes over).
 *
 * The closing line counts WARNINGS as well as failures. "none failed" on its
 * own is true of a run that skipped an unreadable file and of a run that
 * copied everything, and those are not the same news: the first leaves data
 * out of the backup, and the reader has to be told so on the last line they
 * read, not only in a warning further up.
 */
export function printRunReport(report: RunReport, stdout: (line: string) => void): number {
    let failed = 0;
    let warned = 0;
    let skipped = 0;
    let dryRun = 0;
    let ok = 0;
    for (const target of report.targets) {
        stdout(runLine(target));
        if (target.status === "failed") {
            failed += 1;
        } else if (target.status === "warning") {
            warned += 1;
        } else if (target.status === "skipped" || target.status === "aborted") {
            skipped += 1;
        } else if (target.reason === "dry-run") {
            dryRun += 1;
        } else {
            ok += 1;
        }
    }
    // Always a closing line: with several targets the per-target rows scroll,
    // and "did the whole pass succeed?" is the one question the exit code
    // answers but a terminal full of rows does not.
    const total = report.targets.length;
    if (failed > 0) {
        stdout(`Done. ${failed} of ${count(total, "target")} failed - see above, or run: backupkit logs`);
        return failed;
    }
    const clauses = [
        ok === 0 ? null : `${count(ok, "target")} backed up`,
        warned === 0 ? null : `${count(warned, "target")} backed up but missing files (see above)`,
        dryRun === 0 ? null : `${count(dryRun, "target")} checked, nothing written`,
        skipped === 0 ? null : `${skipped} skipped`,
    ].filter((clause) => clause !== null);
    stdout(`Done. ${clauses.join(", ")}.`);
    return failed;
}

/**
 * Render rows as padEnd-aligned plain-text columns (no ANSI, greppable).
 * Column widths fit the widest cell including the header.
 */
export function alignRows(header: string[], rows: string[][]): string[] {
    const widths = header.map((title, column) => Math.max(title.length, ...rows.map((row) => row[column].length)));
    const render = (row: string[]): string =>
        row
            .map((cell, column) => (column === row.length - 1 ? cell : cell.padEnd(widths[column] + 2)))
            .join("")
            .trimEnd();
    return [render(header), ...rows.map(render)];
}
