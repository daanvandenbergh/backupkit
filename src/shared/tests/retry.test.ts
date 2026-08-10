import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Logger } from "../logger.js";
import { SshError, TransferError } from "../errors.js";
import { CONTROL_RETRY_POLICY, computeRetryDelayMs, transferRetryPolicy, withTransientRetry } from "../retry.js";

/** Build a logger capturing warn lines. */
function warnCapture(): { logger: Logger; warns: string[] } {
    const warns: string[] = [];
    const logger = new Logger({
        level: "warn",
        stdout: { write() {} },
        stderr: {
            write(chunk: string) {
                warns.push(chunk);
            },
        },
    });
    return { logger, warns };
}

/** An op failing `failures` times with retriable errors, then succeeding. */
function flaky(failures: number): { op: () => Promise<string>; calls: () => number } {
    let calls = 0;
    return {
        op: async () => {
            calls += 1;
            if (calls <= failures) {
                throw new SshError(`blip ${calls}`, { retriable: true });
            }
            return "ok";
        },
        calls: () => calls,
    };
}

describe("computeRetryDelayMs", () => {
    it("transfer policy: 15s doubling, capped at 300s (attempts 2..8, no jitter at random 0.5)", () => {
        const policy = transferRetryPolicy(10);
        const delays = [2, 3, 4, 5, 6, 7, 8].map((attempt) => computeRetryDelayMs(attempt, policy, 0.5));
        expect(delays).toEqual([15_000, 30_000, 60_000, 120_000, 240_000, 300_000, 300_000]);
    });

    it("control policy: 2s base, 8s cap", () => {
        const delays = [2, 3].map((attempt) => computeRetryDelayMs(attempt, CONTROL_RETRY_POLICY, 0.5));
        expect(delays).toEqual([2000, 4000]);
    });

    it("jitter spans exactly ±20%", () => {
        const policy = transferRetryPolicy(5);
        expect(computeRetryDelayMs(2, policy, 0)).toBe(12_000);
        expect(computeRetryDelayMs(2, policy, 0.9999999)).toBeCloseTo(18_000, -1);
        for (const random of [0, 0.25, 0.5, 0.75, 0.9999999]) {
            const delay = computeRetryDelayMs(3, policy, random);
            expect(delay).toBeGreaterThanOrEqual(0.8 * 30_000);
            expect(delay).toBeLessThanOrEqual(1.2 * 30_000);
        }
    });
});

describe("withTransientRetry", () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.spyOn(Math, "random").mockReturnValue(0.5);
    });

    afterEach(() => {
        vi.useRealTimers();
        vi.restoreAllMocks();
    });

    it("returns immediately on first-attempt success with no warns and no timers", async () => {
        const { logger, warns } = warnCapture();
        const result = await withTransientRetry(async () => "value", CONTROL_RETRY_POLICY, logger, "probe");
        expect(result).toBe("value");
        expect(warns).toHaveLength(0);
        expect(vi.getTimerCount()).toBe(0);
    });

    it("retries a retriable failure and succeeds on the second attempt", async () => {
        const { logger, warns } = warnCapture();
        const { op, calls } = flaky(1);
        const promise = withTransientRetry(op, CONTROL_RETRY_POLICY, logger, "list");
        await vi.advanceTimersByTimeAsync(2000);
        await expect(promise).resolves.toBe("ok");
        expect(calls()).toBe(2);
        expect(warns).toHaveLength(1);
        expect(warns[0]).toContain("list: transient failure, retrying");
        expect(warns[0]).toContain("attempt=2");
        expect(warns[0]).toContain("delayMs=2000");
    });

    it("control policy exhausts after 3 attempts with delays 2s then 4s", async () => {
        const { logger, warns } = warnCapture();
        const { op, calls } = flaky(Infinity);
        const promise = withTransientRetry(op, CONTROL_RETRY_POLICY, logger, "df");
        promise.catch(() => {});
        await vi.advanceTimersByTimeAsync(2000);
        expect(calls()).toBe(2);
        await vi.advanceTimersByTimeAsync(4000);
        await expect(promise).rejects.toThrow("blip 3");
        expect(calls()).toBe(3);
        expect(warns).toHaveLength(2);
        expect(warns[0]).toContain("delayMs=2000");
        expect(warns[1]).toContain("delayMs=4000");
    });

    it("transfer policy runs 5 attempts with the 15/30/60/120 delay ladder", async () => {
        const { logger, warns } = warnCapture();
        const { op, calls } = flaky(Infinity);
        const promise = withTransientRetry(op, transferRetryPolicy(5), logger, "transfer");
        promise.catch(() => {});
        for (const delay of [15_000, 30_000, 60_000, 120_000]) {
            await vi.advanceTimersByTimeAsync(delay);
        }
        await expect(promise).rejects.toThrow("blip 5");
        expect(calls()).toBe(5);
        expect(warns.map((line) => /delayMs=(\d+)/.exec(line)![1])).toEqual(["15000", "30000", "60000", "120000"]);
    });

    it("does not fire the next attempt before its delay elapses", async () => {
        const { logger } = warnCapture();
        const { op, calls } = flaky(Infinity);
        const promise = withTransientRetry(op, transferRetryPolicy(3), logger, "t");
        promise.catch(() => {});
        await vi.advanceTimersByTimeAsync(14_999);
        expect(calls()).toBe(1);
        await vi.advanceTimersByTimeAsync(1);
        expect(calls()).toBe(2);
        await vi.advanceTimersByTimeAsync(30_000);
        await expect(promise).rejects.toThrow();
    });

    it("rethrows a non-retriable error immediately on attempt 1", async () => {
        const { logger, warns } = warnCapture();
        let calls = 0;
        const op = async () => {
            calls += 1;
            throw new SshError("Permission denied (publickey)", { retriable: false });
        };
        await expect(withTransientRetry(op, transferRetryPolicy(5), logger, "t")).rejects.toThrow(
            "Permission denied",
        );
        expect(calls).toBe(1);
        expect(warns).toHaveLength(0);
    });

    it("rethrows when an error turns permanent mid-sequence", async () => {
        const { logger, warns } = warnCapture();
        let calls = 0;
        const op = async () => {
            calls += 1;
            if (calls === 1) {
                throw new TransferError("net", { exitCode: 10, retriable: true, stderrTail: "" });
            }
            throw new TransferError("bug", { exitCode: 1, retriable: false, stderrTail: "" });
        };
        const promise = withTransientRetry(op, transferRetryPolicy(5), logger, "t");
        promise.catch(() => {});
        await vi.advanceTimersByTimeAsync(15_000);
        await expect(promise).rejects.toThrow("bug");
        expect(calls).toBe(2);
        expect(warns).toHaveLength(1);
    });

    it("retries only errors whose retriable flag is exactly true", async () => {
        const { logger } = warnCapture();
        let calls = 0;
        const op = async () => {
            calls += 1;
            throw Object.assign(new Error("flagless"), { retriable: "yes" });
        };
        await expect(withTransientRetry(op, transferRetryPolicy(5), logger, "t")).rejects.toThrow("flagless");
        expect(calls).toBe(1);
    });

    it("retries a plain object carrying retriable: true (flag-based, not class-based)", async () => {
        const { logger } = warnCapture();
        let calls = 0;
        const op = async () => {
            calls += 1;
            if (calls === 1) {
                throw Object.assign(new Error("duck"), { retriable: true });
            }
            return "ok";
        };
        const promise = withTransientRetry(op, CONTROL_RETRY_POLICY, logger, "t");
        await vi.advanceTimersByTimeAsync(2000);
        await expect(promise).resolves.toBe("ok");
        expect(calls).toBe(2);
    });

    it("honors an attempts bound of 1: no retry even for retriable errors", async () => {
        const { logger, warns } = warnCapture();
        const { op, calls } = flaky(Infinity);
        await expect(withTransientRetry(op, transferRetryPolicy(1), logger, "t")).rejects.toThrow("blip 1");
        expect(calls()).toBe(1);
        expect(warns).toHaveLength(0);
    });

    it("honors a custom attempts bound (retry.attempts: 2)", async () => {
        const { logger, warns } = warnCapture();
        const { op, calls } = flaky(Infinity);
        const promise = withTransientRetry(op, transferRetryPolicy(2), logger, "t");
        promise.catch(() => {});
        await vi.advanceTimersByTimeAsync(15_000);
        await expect(promise).rejects.toThrow("blip 2");
        expect(calls()).toBe(2);
        expect(warns).toHaveLength(1);
    });

    it("applies jitter from Math.random to the actual sleep", async () => {
        vi.spyOn(Math, "random").mockReturnValue(0);
        const { logger, warns } = warnCapture();
        const { op, calls } = flaky(1);
        const promise = withTransientRetry(op, CONTROL_RETRY_POLICY, logger, "t");
        await vi.advanceTimersByTimeAsync(1599);
        expect(calls()).toBe(1);
        await vi.advanceTimersByTimeAsync(1);
        await expect(promise).resolves.toBe("ok");
        expect(warns[0]).toContain("delayMs=1600");
    });
});
