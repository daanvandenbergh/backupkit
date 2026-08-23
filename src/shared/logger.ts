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
    /** Levels whose console line is suppressed (the file sink still gets them); mutable via `mute()`. */
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
 * the payload, so it is appended as a clause (` - <cause>`) rather than hung
 * off the end as a quoted `error="..."` token the reader has to unescape by
 * eye.
 */
const CAUSE_FIELDS = ["error", "detail", "cause"];

/**
 * The field carrying WHAT TO DO about it. Rendered `. Fix: <hint>` - last, and
 * deliberately not as another ` - ` clause: message, cause and hint chained on
 * dashes produced lines like "the source has 3 files where the last run saw
 * 40000 - refusing to mirror - a mirror deletes whatever the source no longer
 * has - check the source is fully mounted", where the reader cannot tell which
 * dash separates the problem from the advice. `Fix:` is already this project's
 * word for the command that ends the problem (see ssh/'s failure messages), so
 * the eye can jump straight to it.
 */
const HINT_FIELD = "hint";

/**
 * The console line for a person: `<target>: [Error: |Warning: ]<message>[ -
 * <cause>][. Fix: <hint>]`. A SENTENCE, and nothing else.
 *
 * The TARGET LEADS, because it is the one thing that makes a line findable when
 * several targets are running: the eye follows a flush-left column, and
 * "backup finished in 3s" with no name in front of it is unreadable in a pass
 * over four targets. It matches the CLI's own `<target>: FAILED - ...` rows for
 * the same reason.
 *
 * NO `key=value` TAIL, ever. Not a filtered one - none. Every line that kept
 * "just the useful fields" ended the same way: the reader got to the end of the
 * sentence and then hit `previousFiles=40000 files=3 destination=/srv/mirror`,
 * or five raw byte counts they had to divide by 1024 three times. The rule is
 * total because a filtered version is a judgement call at 30 call sites, and it
 * loses every time somebody adds the 31st.
 *
 * What that BUYS is the discipline: a fact a person needs is a fact the message
 * has to say, in words - "pruned snapshot 2026-08-01T000000Z", not "pruned
 * snapshot" plus `snapshot=`. Fields are then unambiguously the machine's copy,
 * and the log file still carries every one of them.
 */
function humanLine(
    level: LogLevel,
    message: string,
    fields: LogFields | undefined,
    context: Readonly<Record<string, string | number | boolean>>,
): string {
    const parts: string[] = [];
    // A field beats the sticky context: a logger scoped to one target can still
    // log ABOUT another, and the field is the specific one.
    const target = fields?.target ?? context.target;
    if (target !== undefined) {
        parts.push(`${sanitize(String(target))}:`);
    }
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
    const line = parts.join(" ");
    const hint = fields?.[HINT_FIELD];
    return hint === undefined ? line : `${line}. Fix: ${sanitize(String(hint))}`;
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

    /** Construct a root logger. The second and third parameters are internal (used by `with()`). */
    constructor(
        options?: LoggerOptions,
        context?: Record<string, string | number | boolean>,
        inherited?: ResolvedLoggerOptions,
    ) {
        this.options = inherited ?? {
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
     * with (and overridden by) the given context. Level and sinks are shared -
     * the resolved options OBJECT is shared, not copied, so `mute()` on any
     * logger in the family reaches the children too. Every per-target line the
     * engine writes comes from a child, so a copy would have muted nothing.
     */
    with(context: Record<string, string | number | boolean>): Logger {
        return new Logger(undefined, { ...this.context, ...context }, this.options);
    }

    /**
     * Suppress these levels on the console until the returned function puts
     * the previous set back. The file sink is untouched, and so is every other
     * level.
     *
     * For a command that prints its own report of the same failures: the
     * engine's ERROR line and `<target>: FAILED - <the same sentence>` one
     * line below it are the same fact twice. `backupkit run` sets this for its
     * whole invocation via `logStyleFor`; `backupkit start --force` cannot -
     * its scheduler loop lives on afterwards and is the ONLY thing that
     * reports a 3am failure - so it mutes just the one-shot pass and restores.
     */
    mute(levels: readonly LogLevel[]): () => void {
        const previous = this.options.consoleMute;
        this.options.consoleMute = levels;
        return () => {
            this.options.consoleMute = previous;
        };
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
        stream.write((this.options.human ? humanLine(level, message, fields, this.context) : line) + "\n");
    }
}
