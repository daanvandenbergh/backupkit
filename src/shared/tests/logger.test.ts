import { describe, expect, it } from "vitest";
import { formatUtc } from "../format.js";
import { Logger, type LoggerOptions } from "../logger.js";

/** A capturing sink recording every written chunk. */
function captureStream(): { chunks: string[]; write(chunk: string): void } {
    const chunks: string[] = [];
    return {
        chunks,
        write(chunk: string) {
            chunks.push(chunk);
        },
    };
}

/**
 * Build a logger with captured streams and a frozen clock. The clock carries
 * milliseconds and every expected line below keeps them: logs are the one
 * human-facing surface at sub-second precision, so line ORDER within a busy
 * second stays recoverable. Every other displayed timestamp is `formatUtc` at
 * second precision.
 */
function testLogger(options?: Partial<LoggerOptions>) {
    const stdout = captureStream();
    const stderr = captureStream();
    const logger = new Logger({
        stdout,
        stderr,
        now: () => new Date("2026-08-10T03:15:00.123Z"),
        ...options,
    });
    return { logger, stdout, stderr };
}

describe("Logger line format", () => {
    it("emits timestamp, level, message, newline", () => {
        const { logger, stdout } = testLogger();
        logger.info("hello");
        expect(stdout.chunks).toEqual(["2026-08-10T03:15:00.123Z INFO hello\n"]);
    });

    // Logs are the ONE human-facing surface that keeps MILLISECONDS: a busy run
    // emits many lines inside a second, and without sub-second precision their
    // order is unrecoverable from the log alone. Everything else - `list`,
    // `status`, lock details - uses `formatUtc` at second precision. If this
    // ever drops to seconds, that ordering is gone silently.
    it("keeps millisecond precision, unlike every other human-facing timestamp", () => {
        const { logger, stdout } = testLogger({ now: () => new Date("2026-08-10T03:15:00.987Z") });
        logger.info("hello");
        expect(stdout.chunks[0].split(" ")[0]).toBe("2026-08-10T03:15:00.987Z");
    });

    // Still the same UTC format underneath: the log prefix is `formatUtc` plus
    // `.sss`, so the two can be read side by side without a timezone in play.
    it("is the formatUtc timestamp plus milliseconds, always UTC", () => {
        const instant = new Date(Date.UTC(2026, 7, 10, 3, 15, 0, 123));
        const { logger, stdout } = testLogger({ now: () => instant });
        logger.info("hello");
        expect(stdout.chunks[0].split(" ")[0]).toBe(`${formatUtc(instant).slice(0, -1)}.123Z`);
    });

    it("renders context as [key=value ...] before the message", () => {
        const { logger, stdout } = testLogger();
        logger.with({ target: "web1-var-www", run: "2026-08-10T031500Z_web1-var-www" }).info("message");
        expect(stdout.chunks[0]).toBe(
            "2026-08-10T03:15:00.123Z INFO [target=web1-var-www run=2026-08-10T031500Z_web1-var-www] message\n",
        );
    });

    it("appends fields as key=value tokens", () => {
        const { logger, stdout } = testLogger();
        logger.info("done", { files: 812, ok: true, host: "h1" });
        expect(stdout.chunks[0]).toBe("2026-08-10T03:15:00.123Z INFO done files=812 ok=true host=h1\n");
    });

    it("labels every level in upper case, one space either side", () => {
        const { logger, stdout, stderr } = testLogger({ level: "debug" });
        logger.error("e");
        logger.warn("w");
        logger.info("i");
        logger.debug("d");
        expect(stderr.chunks[0]).toContain(" ERROR e");
        expect(stderr.chunks[1]).toContain(" WARN w");
        expect(stdout.chunks[0]).toContain(" INFO i");
        expect(stdout.chunks[1]).toContain(" DEBUG d");
    });
});

describe("Logger levels", () => {
    it("defaults to info: debug is suppressed", () => {
        const { logger, stdout } = testLogger();
        logger.debug("hidden");
        logger.info("shown");
        expect(stdout.chunks).toHaveLength(1);
        expect(stdout.chunks[0]).toContain("shown");
    });

    it.each([
        ["error", { error: 1, warn: 0, info: 0, debug: 0 }],
        ["warn", { error: 1, warn: 1, info: 0, debug: 0 }],
        ["info", { error: 1, warn: 1, info: 1, debug: 0 }],
        ["debug", { error: 1, warn: 1, info: 1, debug: 1 }],
    ] as const)("level %s emits exactly the levels at or above it", (level, expected) => {
        const { logger, stdout, stderr } = testLogger({ level });
        logger.error("e");
        logger.warn("w");
        logger.info("i");
        logger.debug("d");
        const emitted = [...stdout.chunks, ...stderr.chunks].join("");
        expect(emitted.includes("ERROR")).toBe(expected.error === 1);
        expect(emitted.includes("WARN")).toBe(expected.warn === 1);
        expect(emitted.includes("INFO")).toBe(expected.info === 1);
        expect(emitted.includes("DEBUG")).toBe(expected.debug === 1);
    });
});

describe("Logger stream split", () => {
    it("routes debug/info to stdout and warn/error to stderr", () => {
        const { logger, stdout, stderr } = testLogger({ level: "debug" });
        logger.debug("d");
        logger.info("i");
        logger.warn("w");
        logger.error("e");
        expect(stdout.chunks).toHaveLength(2);
        expect(stderr.chunks).toHaveLength(2);
    });
});

describe("Logger children", () => {
    it("children inherit the level and sinks", () => {
        const { logger, stdout } = testLogger({ level: "error" });
        const child = logger.with({ target: "t1" });
        child.info("suppressed");
        expect(stdout.chunks).toHaveLength(0);
    });

    it("nested with() merges context, child keys overriding", () => {
        const { logger, stdout } = testLogger();
        logger.with({ target: "t1", run: "r1" }).with({ run: "r2" }).info("m");
        expect(stdout.chunks[0]).toContain("[target=t1 run=r2] m");
    });

    it("with() does not mutate the parent", () => {
        const { logger, stdout } = testLogger();
        logger.with({ target: "t1" });
        logger.info("plain");
        expect(stdout.chunks[0]).not.toContain("target=");
    });
});

describe("Logger sanitization", () => {
    it("strips control characters from message, context, and fields", () => {
        const { logger, stdout } = testLogger();
        logger.with({ host: "h\n1" }).info("msg\x1b[31m", { file: "a\r\nb\0c" });
        expect(stdout.chunks[0]).toBe("2026-08-10T03:15:00.123Z INFO [host=h1] msg[31m file=abc\n");
    });
});

describe("Logger field quoting", () => {
    /** Read a line back the way a logfmt/journald field extractor would. */
    function fields(line: string): Record<string, string> {
        const out: Record<string, string> = {};
        for (const [, key, raw] of line.matchAll(/([\w.-]+)=("(?:[^"\\]|\\.)*"|[^\s\]]*)/g)) {
            out[key] = raw.startsWith('"') ? (JSON.parse(raw) as string) : raw;
        }
        return out;
    }

    // Regression: `sanitize` strips control characters - so a forged whole LINE
    // is impossible - but leaves SPACE and `=` untouched, so a compromised
    // peer's rsync/ssh stderr tail survived it byte-identically inside the
    // `error=` field of a genuine ERROR line, and a field extractor over that
    // line yielded `status: success` plus an attacker-chosen `target=`: a
    // failure line that parses as a success, which is a cheap way to stop an
    // alert rule firing.
    it("a value containing key=value text stays ONE quoted token and forges no fields", () => {
        const { logger, stderr } = testLogger();
        const forged = "rsync: [sender] failed status=success target=payroll consecutiveFailures=0";
        logger.with({ target: "web1" }).error("transfer failed", { error: forged });
        const line = stderr.chunks[0].trimEnd();
        expect(line).toBe(
            `2026-08-10T03:15:00.123Z ERROR [target=web1] transfer failed error=${JSON.stringify(forged)}`,
        );
        expect(fields(line)).toEqual({ target: "web1", error: forged });
        // Still one physical line: quoting never introduces a newline.
        expect(line.includes("\n")).toBe(false);
    });

    it("quotes an empty value and a value containing a quote, and leaves ordinary values bare", () => {
        const { logger, stdout } = testLogger();
        logger.info("m", { empty: "", quoted: 'say "hi"', plain: "web1-var-www", n: 7, ok: false });
        const line = stdout.chunks[0].trimEnd();
        expect(line).toContain('empty=""');
        expect(line).toContain('quoted="say \\"hi\\""');
        // Greppable as before for everything that does not need quoting.
        expect(line).toContain("plain=web1-var-www n=7 ok=false");
        expect(fields(line).quoted).toBe('say "hi"');
    });

    it("quotes context fields too - a target name is remote-influenced as well", () => {
        const { logger, stdout } = testLogger();
        logger.with({ run: "r 1" }).info("m");
        expect(stdout.chunks[0]).toBe('2026-08-10T03:15:00.123Z INFO [run="r 1"] m\n');
    });
});

describe("Logger file sink", () => {
    it("receives every emitted line (without the newline) across both streams", () => {
        const lines: string[] = [];
        const { logger } = testLogger({ fileSink: (line) => lines.push(line) });
        logger.info("i");
        logger.error("e");
        logger.debug("suppressed");
        expect(lines).toHaveLength(2);
        expect(lines[0]).toContain("INFO i");
        expect(lines[1]).toContain("ERROR e");
        expect(lines.every((line) => !line.endsWith("\n"))).toBe(true);
    });

    it("children share the parent's file sink", () => {
        const lines: string[] = [];
        const { logger } = testLogger({ fileSink: (line) => lines.push(line) });
        logger.with({ t: "x" }).warn("w");
        expect(lines).toHaveLength(1);
        expect(lines[0]).toContain("[t=x] w");
    });
});

describe("Logger human console mode", () => {
    it("leads with the TARGET and drops the timestamp, the level noise, and the context bracket", () => {
        const { logger, stdout } = testLogger({ human: true });
        logger.with({ target: "web1", run: "r1" }).info("backing up /srv");
        // The target is the one thing that makes a line findable when four
        // targets are running - it leads, flush left, like the CLI's own rows.
        expect(stdout.chunks).toEqual(["web1: backing up /srv\n"]);
    });

    it("no target in scope: no prefix, no empty colon", () => {
        const { logger, stdout } = testLogger({ human: true });
        logger.info("started persistent ssh-agent");
        expect(stdout.chunks).toEqual(["started persistent ssh-agent\n"]);
    });

    it("a target FIELD wins over the sticky context - a scoped logger can log about another target", () => {
        const { logger, stdout } = testLogger({ human: true });
        logger.with({ target: "web1" }).info("pruned snapshot", { target: "db1" });
        expect(stdout.chunks).toEqual(["db1: pruned snapshot\n"]);
    });

    it("prefixes warn and error so severity is visible at a glance", () => {
        const { logger, stderr } = testLogger({ human: true });
        logger.warn("disk is nearly full");
        logger.error("cannot use this backup server");
        expect(stderr.chunks).toEqual(["Warning: disk is nearly full\n", "Error: cannot use this backup server\n"]);
    });

    it("appends the `error` field as a clause instead of a quoted key=value tail", () => {
        const { logger, stderr } = testLogger({ human: true });
        logger.error("cannot use this backup server", {
            target: "web1",
            remote: "archive",
            error: 'the SSH key needs a passphrase. Fix: ssh-add /k/id_ed25519',
        });
        // The machine line would render that value as error="the SSH key needs a
        // passphrase. Fix: ssh-add /k/id_ed25519" - every embedded quote escaped
        // and the sentence buried behind two field tokens the reader already knows.
        expect(stderr.chunks).toEqual([
            "web1: Error: cannot use this backup server - the SSH key needs a passphrase. Fix: ssh-add /k/id_ed25519\n",
        ]);
    });

    it("`detail` is a cause too, and NO field ever reaches the line", () => {
        const { logger, stdout } = testLogger({ human: true });
        logger.info("pruned snapshot 2026-08-10T03-00-00Z", {
            target: "web1",
            snapshot: "2026-08-10T03-00-00Z",
            detail: "past keepDaily",
        });
        // The snapshot name is in the SENTENCE, because a person needs it. It
        // is also still a field - for the log file, which keeps every one.
        expect(stdout.chunks).toEqual(["web1: pruned snapshot 2026-08-10T03-00-00Z - past keepDaily\n"]);
    });

    it("a fact left ONLY in a field never reaches a human line - the message has to say it", () => {
        const { logger, stdout } = testLogger({ human: true });
        logger.info("pruned snapshot", { snapshot: "2026-08-10T03-00-00Z", count: 4, freeBytes: 3328599654 });
        expect(stdout.chunks).toEqual(["pruned snapshot\n"]);
    });

    it("the FILE sink still gets the full machine line - the record is unchanged", () => {
        const lines: string[] = [];
        const { logger } = testLogger({ human: true, fileSink: (line) => lines.push(line) });
        logger.with({ target: "web1" }).error("cannot use this backup server", { error: "key refused" });
        expect(lines).toEqual([
            '2026-08-10T03:15:00.123Z ERROR [target=web1] cannot use this backup server error="key refused"',
        ]);
    });

    it("cause then Fix, in that order, on a line that carries both", () => {
        const { logger, stderr } = testLogger({ human: true });
        logger.error("cannot use this backup server", { error: "key refused", hint: "backupkit check" });
        expect(stderr.chunks).toEqual(["Error: cannot use this backup server - key refused. Fix: backupkit check\n"]);
    });

    it("children inherit human mode", () => {
        const { logger, stdout } = testLogger({ human: true });
        logger.with({ target: "web1" }).info("hello");
        expect(stdout.chunks).toEqual(["web1: hello\n"]);
    });

    it("`hint` renders as a trailing `Fix:` - advice never chains onto the cause's dash", () => {
        const { logger, stderr } = testLogger({ human: true });
        logger.error("this snapshot has 3 files where the previous run had 40000 - retention skipped", {
            previousFiles: 40_000,
            files: 3,
            hint: "verify the source, then run `backupkit prune` once you are satisfied the shrink is real",
        });
        expect(stderr.chunks).toEqual([
            "Error: this snapshot has 3 files where the previous run had 40000 - retention skipped" +
                ". Fix: verify the source, then run `backupkit prune` once you are satisfied the shrink is real\n",
        ]);
    });
});

describe("Logger consoleMute", () => {
    it("suppresses the console line while the file sink still records it", () => {
        const lines: string[] = [];
        const { logger, stdout, stderr } = testLogger({ consoleMute: ["error"], fileSink: (line) => lines.push(line) });
        logger.error("cannot use this backup server");
        logger.warn("still shown");
        logger.info("still shown");
        expect(stderr.chunks).toEqual(["2026-08-10T03:15:00.123Z WARN still shown\n"]);
        expect(stdout.chunks).toEqual(["2026-08-10T03:15:00.123Z INFO still shown\n"]);
        // The muted line is a RECORD, not a discard: `backupkit logs` must
        // still show the failure the run report summarized.
        expect(lines).toHaveLength(3);
        expect(lines[0]).toContain("ERROR cannot use this backup server");
    });

    it("children inherit the mute", () => {
        const { logger, stderr } = testLogger({ consoleMute: ["error"] });
        logger.with({ target: "web1" }).error("hidden");
        expect(stderr.chunks).toEqual([]);
    });

    it("mute() reaches a child made BEFORE it, and restores", () => {
        // `backupkit start --force` mutes for the one-shot pass and restores
        // before the scheduler loop - the loop is the only thing that reports
        // a 3am failure, so a mute that outlived the pass would silence it.
        // Every per-target line comes from a `with()` child, so a mute that
        // did not reach children would suppress nothing at all.
        const lines: string[] = [];
        const { logger, stderr } = testLogger({ fileSink: (line) => lines.push(line) });
        const target = logger.with({ target: "web1" });
        const restore = logger.mute(["error"]);
        target.error("printed by the run report instead");
        logger.error("also hidden");
        expect(stderr.chunks).toEqual([]);
        restore();
        target.error("the 3am failure nobody else reports");
        expect(stderr.chunks).toHaveLength(1);
        expect(stderr.chunks[0]).toContain("the 3am failure nobody else reports");
        // Muted or not, all three are in the log file.
        expect(lines).toHaveLength(3);
    });

    it("mute() restores the previous set, not 'nothing muted'", () => {
        const { logger, stderr } = testLogger({ consoleMute: ["error"] });
        logger.mute(["error", "warn"])();
        logger.error("still muted");
        logger.warn("shown again");
        expect(stderr.chunks).toHaveLength(1);
        expect(stderr.chunks[0]).toContain("shown again");
    });
});
