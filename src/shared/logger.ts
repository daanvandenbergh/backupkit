/**
 * The backupkit logger: leveled, single-line, greppable output with child
 * loggers carrying context. debug/info go to stdout, warn/error to stderr.
 * The optional file sink is injected as a callback (shared/ is fs-free by
 * guard test; the caller that owns `logging.file` wires the append). The
 * logger never rotates anything - rotation belongs to the platform.
 *
 * Line shape:
 * `2026-08-10T03:15:00.123Z INFO  [target=web1 run=...] message key=value`
 */

import { sanitize } from "./sanitize.js";

/** Log verbosity level, most to least severe. */
export type LogLevel = "error" | "warn" | "info" | "debug";

/** Numeric rank per level; a line is emitted when its rank <= the configured rank. */
const LEVEL_RANK: Record<LogLevel, number> = { error: 0, warn: 1, info: 2, debug: 3 };

/** Upper-case column-aligned level labels (5 chars). */
const LEVEL_LABEL: Record<LogLevel, string> = { error: "ERROR", warn: "WARN ", info: "INFO ", debug: "DEBUG" };

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
}

/** Render one `key=value` token, sanitizing the value. */
function renderField(key: string, value: string | number | boolean): string {
    return `${sanitize(key)}=${sanitize(String(value))}`;
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
        };
        this.context = context ?? {};
    }

    /**
     * Derive a child logger whose lines carry this logger's context merged
     * with (and overridden by) the given context. Level and sinks are shared.
     */
    with(context: Record<string, string | number | boolean>): Logger {
        const { level, stdout, stderr, fileSink, now } = this.options;
        return new Logger(
            { level, stdout, stderr, fileSink: fileSink ?? undefined, now },
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

    /** Format and emit one line if the level passes the configured threshold. */
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
        const stream = level === "error" || level === "warn" ? this.options.stderr : this.options.stdout;
        stream.write(line + "\n");
        this.options.fileSink?.(line);
    }
}
