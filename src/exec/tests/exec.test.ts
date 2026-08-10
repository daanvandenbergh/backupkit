import { describe, expect, it } from "vitest";
import { exec, minimalEnv } from "../exec.js";

/** The node binary running this test - the only external "binary" the suite spawns. */
const NODE = process.execPath;

describe("minimalEnv", () => {
    it("contains LC_ALL=C plus PATH and HOME from this process", () => {
        const env = minimalEnv();
        expect(env.LC_ALL).toBe("C");
        expect(Object.keys(env).every((key) => ["PATH", "HOME", "LC_ALL"].includes(key))).toBe(true);
        if (process.env.PATH !== undefined) {
            expect(env.PATH).toBe(process.env.PATH);
        }
    });
});

describe("exec", () => {
    it("captures stdout, stderr, and the exit code", async () => {
        const result = await exec(NODE, [
            "-e",
            "process.stdout.write('out'); process.stderr.write('err'); process.exit(3);",
        ]);
        expect(result.stdout).toBe("out");
        expect(result.stderr).toBe("err");
        expect(result.exitCode).toBe(3);
        expect(result.signal).toBeNull();
        expect(result.timedOut).toBe(false);
        expect(result.durationMs).toBeGreaterThanOrEqual(0);
    });

    it("resolves (never rejects) on a non-zero exit", async () => {
        const result = await exec(NODE, ["-e", "process.exit(1)"]);
        expect(result.exitCode).toBe(1);
    });

    it("passes argv elements verbatim - shell metacharacters are data", async () => {
        const hostile = ["$HOME; echo pwned", "a b", "'single'", '"double"', "`backtick`", "*", "&&|"];
        const result = await exec(NODE, [
            "-e",
            "console.log(JSON.stringify(process.argv.slice(1)))",
            ...hostile,
        ]);
        expect(JSON.parse(result.stdout)).toEqual(hostile);
    });

    it("gives the child exactly the minimal env by default", async () => {
        const result = await exec(NODE, ["-e", "console.log(JSON.stringify(process.env))"]);
        const childEnv = JSON.parse(result.stdout) as Record<string, string>;
        expect(childEnv.LC_ALL).toBe("C");
        // macOS's spawn layer injects __CF_USER_TEXT_ENCODING; nothing else may leak.
        const unexpected = Object.keys(childEnv).filter(
            (key) => !["PATH", "HOME", "LC_ALL", "__CF_USER_TEXT_ENCODING"].includes(key),
        );
        expect(unexpected).toEqual([]);
    });

    it("uses an explicit env verbatim - no merge with process.env", async () => {
        const result = await exec(NODE, ["-e", "console.log(JSON.stringify(process.env))"], {
            env: { FOO: "bar", PATH: process.env.PATH ?? "" },
        });
        const childEnv = JSON.parse(result.stdout) as Record<string, string>;
        expect(childEnv.FOO).toBe("bar");
        expect(childEnv.LC_ALL).toBeUndefined();
        expect(childEnv.HOME).toBeUndefined();
    });

    it("ignores stdin in pipe mode (a stdin reader sees EOF, no hang)", async () => {
        const result = await exec(NODE, [
            "-e",
            "process.stdin.on('data', () => {}); process.stdin.on('end', () => { console.log('eof'); });",
        ]);
        expect(result.stdout).toBe("eof\n");
        expect(result.exitCode).toBe(0);
    });

    it("kills a hanging child on timeout and reports timedOut", async () => {
        const result = await exec(NODE, ["-e", "setInterval(() => {}, 1000);"], { timeoutMs: 300 });
        expect(result.timedOut).toBe(true);
        expect(result.signal).toBe("SIGTERM");
        expect(result.exitCode).toBeNull();
        expect(result.durationMs).toBeLessThan(10_000);
    }, 15_000);

    it("escalates to SIGKILL when the child ignores SIGTERM", async () => {
        const result = await exec(
            NODE,
            ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);"],
            { timeoutMs: 300 },
        );
        expect(result.timedOut).toBe(true);
        expect(result.signal).toBe("SIGKILL");
    }, 15_000);

    it("does not set timedOut when the child finishes in time", async () => {
        const result = await exec(NODE, ["-e", "process.exit(0)"], { timeoutMs: 30_000 });
        expect(result.timedOut).toBe(false);
        expect(result.exitCode).toBe(0);
    });

    it("rejects when the binary does not exist", async () => {
        await expect(exec("/nonexistent/backupkit-test-binary", [])).rejects.toThrow();
    });

    it("respects cwd", async () => {
        const result = await exec(NODE, ["-e", "console.log(process.cwd())"], { cwd: "/" });
        expect(result.stdout.trim()).toBe("/");
    });

    it("inherit mode runs the child and returns empty stdout/stderr", async () => {
        const result = await exec(NODE, ["-e", "process.exit(7)"], { stdio: "inherit" });
        expect(result.exitCode).toBe(7);
        expect(result.stdout).toBe("");
        expect(result.stderr).toBe("");
    });
});
