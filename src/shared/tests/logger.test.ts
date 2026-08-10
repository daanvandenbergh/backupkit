import { describe, expect, it } from "vitest";
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

/** Build a logger with captured streams and a frozen clock. */
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
    it("emits timestamp, padded level, message, newline", () => {
        const { logger, stdout } = testLogger();
        logger.info("hello");
        expect(stdout.chunks).toEqual(["2026-08-10T03:15:00.123Z INFO  hello\n"]);
    });

    it("renders context as [key=value ...] before the message", () => {
        const { logger, stdout } = testLogger();
        logger.with({ target: "web1-var-www", run: "2026-08-10T031500Z_web1-var-www" }).info("message");
        expect(stdout.chunks[0]).toBe(
            "2026-08-10T03:15:00.123Z INFO  [target=web1-var-www run=2026-08-10T031500Z_web1-var-www] message\n",
        );
    });

    it("appends fields as key=value tokens", () => {
        const { logger, stdout } = testLogger();
        logger.info("done", { files: 812, ok: true, host: "h1" });
        expect(stdout.chunks[0]).toBe("2026-08-10T03:15:00.123Z INFO  done files=812 ok=true host=h1\n");
    });

    it("pads every level label to five characters", () => {
        const { logger, stdout, stderr } = testLogger({ level: "debug" });
        logger.error("e");
        logger.warn("w");
        logger.info("i");
        logger.debug("d");
        expect(stderr.chunks[0]).toContain(" ERROR e");
        expect(stderr.chunks[1]).toContain(" WARN  w");
        expect(stdout.chunks[0]).toContain(" INFO  i");
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
        expect(stdout.chunks[0]).toBe("2026-08-10T03:15:00.123Z INFO  [host=h1] msg[31m file=abc\n");
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
        expect(lines[0]).toContain("INFO  i");
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
