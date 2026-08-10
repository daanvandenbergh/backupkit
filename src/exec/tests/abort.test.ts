/**
 * AbortSignal support in exec/: on abort the child gets SIGTERM (SIGKILL 10 s
 * later if it lingers). The existing API surface stays untouched - these tests
 * only exercise the new `signal` option.
 */

import { describe, expect, it } from "vitest";
import { exec } from "../exec.js";

/** The node binary running this test - the only external "binary" the suite spawns. */
const NODE = process.execPath;

describe("exec abort", () => {
    it("SIGTERMs the child when the signal aborts mid-run", async () => {
        const controller = new AbortController();
        const pending = exec(NODE, ["-e", "setInterval(() => {}, 1000);"], { signal: controller.signal });
        setTimeout(() => controller.abort(), 200);
        const result = await pending;
        expect(result.signal).toBe("SIGTERM");
        expect(result.exitCode).toBeNull();
        expect(result.timedOut).toBe(false);
    }, 15_000);

    it("kills the child immediately when the signal is already aborted", async () => {
        const controller = new AbortController();
        controller.abort();
        const result = await exec(NODE, ["-e", "setInterval(() => {}, 1000);"], { signal: controller.signal });
        expect(result.signal).toBe("SIGTERM");
        expect(result.durationMs).toBeLessThan(5000);
    }, 15_000);

    it("escalates to SIGKILL when the child ignores SIGTERM", async () => {
        const controller = new AbortController();
        const pending = exec(
            NODE,
            ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);"],
            { signal: controller.signal },
        );
        setTimeout(() => controller.abort(), 200);
        const result = await pending;
        expect(result.signal).toBe("SIGKILL");
    }, 25_000);

    it("an abort after the child finished changes nothing", async () => {
        const controller = new AbortController();
        const result = await exec(NODE, ["-e", "process.exit(0)"], { signal: controller.signal });
        controller.abort();
        expect(result.exitCode).toBe(0);
        expect(result.signal).toBeNull();
    });

    it("a never-aborted signal leaves the run untouched", async () => {
        const controller = new AbortController();
        const result = await exec(NODE, ["-e", "process.stdout.write('ok')"], { signal: controller.signal });
        expect(result.stdout).toBe("ok");
        expect(result.exitCode).toBe(0);
    });

    it("abort and timeout compose - whichever fires first kills the child", async () => {
        const controller = new AbortController();
        const result = await exec(NODE, ["-e", "setInterval(() => {}, 1000);"], {
            signal: controller.signal,
            timeoutMs: 300,
        });
        expect(result.timedOut).toBe(true);
        expect(result.signal).toBe("SIGTERM");
    }, 15_000);
});
