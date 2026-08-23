/**
 * The backupkit logger: leveled, single-line, greppable output with child
 * loggers carrying context. debug/info go to stdout, warn/error to stderr.
 * The optional file sink is injected as a callback (shared/ is fs-free by
 * guard test; the caller that owns `logging.file` wires the append). The
 * logger never rotates anything - rotation belongs to the platform.
 *
 * Line shape:
 * `2026-08-10T03:15:00.123Z INFO [target=web1 run=...] message key=value`
 *
 * The timestamp is the project's one UTC format plus MILLISECONDS - which is
 * exactly `toISOString()`. Logs are the deliberate exception to the second
 * precision every other human-facing surface uses (`shared/format.ts`
 * `formatUtc`): a busy run emits many lines inside one second, and without
 * sub-second precision their order is unrecoverable from the log alone.
 * Everything else about it is the same - always UTC, always `Z`-suffixed.
 *
 * A field value that would break that grammar - empty, or carrying whitespace,
 * `=` or `"` - is JSON-quoted so it stays ONE token (see `renderField`).
 *
 * ## Two audiences, one line
 *
 * That shape is for the LOG FILE and the journal - a grep target, read later,
 * by a machine or by someone hunting. It is not what a person staring at a
 * terminal needs, and printing it there buried the one sentence that mattered
 * under a timestamp, a level, a repeat of the target name they just typed, and
 * a `error="..."` field whose quoting turned every embedded quote into `\"`.
 *
 * So `human: true` renders the CONSOLE line for a reader instead:
 * `Error: cannot use this backup server - <cause>`. The file sink always gets
 * the machine line regardless, so nothing is lost from the record - the two
 * renderings are of the same event, chosen by who is reading.
 */

import { sanitize } from "./sanitize.js";

/** Log verbosity level, most to least severe. */
export type LogLevel = "error" | "warn" | "info" | "debug";

/** Numeric rank per level; a line is emitted when its rank <= the configured rank. */
const LEVEL_RANK: Record<LogLevel, number> = { error: 0, warn: 1, info: 2, debug: 3 };

/** Upper-case level labels. */
const LEVEL_LABEL: Record<LogLevel, string> = { error: "ERROR", warn: "WARN", info: "INFO", debug: "DEBUG" };

/** Minimal writable-stream seam satisfied by process.stdout/process.stderr. */
export interface LogStream {
    /** Write one chunk of text (a full line including its trailing newline). */
    write(chunk: string): unknown;
}

/** Extra structured key=value fields appended to a log line. */
export type LogFields = Record<string, string | number | boolean>;

/** Logger construction options; every field has a working default. */
export interface LoggerOptions {
    /** Minimum level to emit. Default "info". */
    level?: LogLevel;
    /** Sink for debug/info lines. Default process.stdout. */
    stdout?: LogStream;
    /** Sink for warn/error lines. Default process.stderr. */
    stderr?: LogStream;
    /** Optional extra sink receiving every emitted line (the `logging.file` append, injected by the owner of the fs handle). */
    fileSink?: (line: string) => void;
    /** Clock used for timestamps; injectable for tests. Default `() => new Date()`. */
    now?: () => Date;
    /**
     * Render CONSOLE lines for a person (no timestamp, no context bracket, no
     * `key=value` tail) instead of the machine format. The file sink is
     * unaffected - it always receives the machine line. Default false.
     */
    human?: boolean;
    /**
     * Levels whose CONSOLE line is suppressed; the file sink still receives
     * them. `backupkit run` mutes "error", because it prints its own
     * per-target `FAILED - <error>` line and a second copy of the same
     * sentence directly above it is exactly the noise this logger's human mode
     * exists to remove. Nothing is lost: a muted line is still in the log file,
     * and an error that ESCAPES the engine is printed by the CLI's own
     * top-level handler, not by this logger. Default: mute nothing.
     */
    consoleMute?: readonly LogLevel[];
}

/** Fully resolved logger options shared by a logger and all its children. */
interface ResolvedLoggerOptions {
    /** Minimum level to emit. */
    level: LogLevel;
    /** Sink for debug/info lines. */
    stdout: LogStream;
    /** Sink for warn/error lines. */
    stderr: LogStream;
    /** Optional extra sink for every emitted line. */
    fileSink: ((line: string) => void) | null;
    /** Timestamp clock. */
    now: () => Date;
    /** Render console lines for a person rather than for grep. */
    human: boolean;
    /** Levels whose console line is suppressed (the file sink still gets them). */
    consoleMute: readonly LogLevel[];
}

/** Values that would stop being ONE token: empty, or carrying whitespace, `=`, or `"`. */
const NEEDS_QUOTES = /^$|[\s="]/;

/**
 * Render one `key=value` token, sanitizing the value and quoting it when it
 * would otherwise forge FIELDS inside the line. `sanitize` strips control
 * characters - so a forged whole LINE is impossible - but leaves SPACE and `=`
 * untouched, and a compromised peer's rsync/ssh stderr tail of
 * `rsync: [sender] failed status=success target=payroll consecutiveFailures=0`
 * survived it byte-identically inside the `error=` field of a genuine ERROR
 * line: a logfmt/journald-style field extractor then read `status: success` and
 * an attacker-chosen `target=` off it - a failure line that parses as a success,
 * which is a cheap way to stop an alert rule firing. `JSON.stringify` is the
 * quoting tool (already this project's report serializer, and it cannot emit a
 * newline), and ordinary values stay bare so the format stays greppable.
 */
function renderField(key: string, value: string | number | boolean): string {
    const rendered = sanitize(String(value));
    return `${sanitize(key)}=${NEEDS_QUOTES.test(rendered) ? JSON.stringify(rendered) : rendered}`;
}

/**
 * Fields carrying the CAUSE a message points at. On a human line the cause is
 * the payload, so it is appended to the sentence (` - <cause>`) rather than
 * hung off the end as a quoted `error="..."` token that the reader has to
 * unescape by eye.
 */
const CAUSE_FIELDS = ["error", "detail", "cause"];

/**
 * Fields that only repeat what a human line already shows. `target`/`remote`
 * are the name the reader typed and the name in the target's own line; `run`
 * is an id that means nothing until you go looking in the log file; `delayMs`
 * is the exact jittered wait whose readable form ("in 2s") is already in the
 * sentence. The machine line still carries all four.
 */
const HUMAN_MUTED_FIELDS = new Set(["target", "remote", "run", "delayMs"]);

/**
 * The console line for a person: an optional `Error:`/`Warning:` prefix, the
 * message, its cause appended as a clause, and whatever fields are left -
 * bare, in the machine `key=value` shape, because a field that survives this
 * filter is one the sentence does NOT already contain (`snapshot=`, `file=`)
 * and dropping it would lose the fact. No timestamp (the terminal is now), no
 * context bracket (the CLI's own lines name the target).
 */
function humanLine(level: LogLevel, message: string, fields: LogFields | undefined): string {
    const parts: string[] = [];
    if (level === "error") {
        parts.push("Error:");
    } else if (level === "warn") {
        parts.push("Warning:");
    }
    parts.push(sanitize(message));
    for (const key of CAUSE_FIELDS) {
        const value = fields?.[key];
        if (value !== undefined) {
            parts.push(`- ${sanitize(String(value))}`);
        }
    }
    for (const key of Object.keys(fields ?? {})) {
        if (!CAUSE_FIELDS.includes(key) && !HUMAN_MUTED_FIELDS.has(key)) {
            parts.push(renderField(key, (fields as LogFields)[key]));
        }
    }
    return parts.join(" ");
}

/**
 * Leveled line logger with child-context support. Construct one root logger
 * from config, derive children via `with()` per target/run.
 */
export class Logger {
    /** Resolved options shared with children. */
    private readonly options: ResolvedLoggerOptions;

    /** Sticky context rendered as `[k=v ...]` on every line from this logger. */
    private readonly context: Readonly<Record<string, string | number | boolean>>;

    /** Construct a root logger. The second parameter is internal (used by `with()`). */
    constructor(options?: LoggerOptions, context?: Record<string, string | number | boolean>) {
        this.options = {
            level: options?.level ?? "info",
            stdout: options?.stdout ?? process.stdout,
            stderr: options?.stderr ?? process.stderr,
            fileSink: options?.fileSink ?? null,
            now: options?.now ?? (() => new Date()),
            human: options?.human ?? false,
            consoleMute: options?.consoleMute ?? [],
        };
        this.context = context ?? {};
    }

    /**
     * Derive a child logger whose lines carry this logger's context merged
     * with (and overridden by) the given context. Level and sinks are shared.
     */
    with(context: Record<string, string | number | boolean>): Logger {
        const { level, stdout, stderr, fileSink, now, human, consoleMute } = this.options;
        return new Logger(
            { level, stdout, stderr, fileSink: fileSink ?? undefined, now, human, consoleMute },
            { ...this.context, ...context },
        );
    }

    /** Log at error level (stderr). */
    error(message: string, fields?: LogFields): void {
        this.log("error", message, fields);
    }

    /** Log at warn level (stderr). */
    warn(message: string, fields?: LogFields): void {
        this.log("warn", message, fields);
    }

    /** Log at info level (stdout). */
    info(message: string, fields?: LogFields): void {
        this.log("info", message, fields);
    }

    /** Log at debug level (stdout). */
    debug(message: string, fields?: LogFields): void {
        this.log("debug", message, fields);
    }

    /**
     * Format and emit one line if the level passes the configured threshold.
     * The machine line is always what the file sink receives; the console gets
     * the human rendering when `human` is set, and nothing at all when the
     * level is muted.
     */
    private log(level: LogLevel, message: string, fields?: LogFields): void {
        if (LEVEL_RANK[level] > LEVEL_RANK[this.options.level]) {
            return;
        }
        const parts: string[] = [this.options.now().toISOString(), LEVEL_LABEL[level]];
        const contextKeys = Object.keys(this.context);
        if (contextKeys.length > 0) {
            parts.push(`[${contextKeys.map((key) => renderField(key, this.context[key])).join(" ")}]`);
        }
        parts.push(sanitize(message));
        if (fields !== undefined) {
            for (const key of Object.keys(fields)) {
                parts.push(renderField(key, fields[key]));
            }
        }
        const line = parts.join(" ");
        this.options.fileSink?.(line);
        if (this.options.consoleMute.includes(level)) {
            return;
        }
        const stream = level === "error" || level === "warn" ? this.options.stderr : this.options.stdout;
        stream.write((this.options.human ? humanLine(level, message, fields) : line) + "\n");
    }
}
