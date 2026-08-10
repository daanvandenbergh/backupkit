/**
 * The single transient-retry primitive. Exactly two policies exist in the
 * codebase: the transfer policy (config-tunable attempts, 15 s base doubling
 * to a 300 s cap) and the fixed control policy (3 attempts, 2 s base, 8 s
 * cap) wrapping every short remote operation. Pure timers - no fs, no
 * child_process.
 */

import type { Logger } from "./logger.js";

/** Retry policy: total attempts and the capped-exponential delay parameters. */
export interface RetryPolicy {
    /** Total attempts including the first (>= 1). */
    attempts: number;
    /** Base delay in ms; the delay before attempt k is min(base * 2^(k-2), cap), jittered. */
    baseDelayMs: number;
    /** Delay ceiling in ms. */
    capMs: number;
}

/**
 * The fixed control-path policy wrapping every short remote operation
 * (version probe, store list/mkdir/mv/rm/df): 3 attempts, 2 s base, 8 s cap.
 * Not configurable.
 */
export const CONTROL_RETRY_POLICY: RetryPolicy = { attempts: 3, baseDelayMs: 2000, capMs: 8000 };

/**
 * The transfer policy for a target's configured attempt count (1-10, default
 * 5): 15 s base doubling to a 300 s cap. The delays are fixed by design -
 * `attempts` is the only knob.
 */
export function transferRetryPolicy(attempts: number): RetryPolicy {
    return { attempts, baseDelayMs: 15_000, capMs: 300_000 };
}

/**
 * The jittered delay before attempt number `attempt` (>= 2):
 * min(base * 2^(attempt-2), cap) scaled by (0.8 + 0.4 * random) - a ±20%
 * jitter. `random` is the [0, 1) roll, injectable for tests.
 */
export function computeRetryDelayMs(attempt: number, policy: RetryPolicy, random: number): number {
    const base = Math.min(policy.baseDelayMs * 2 ** (attempt - 2), policy.capMs);
    return Math.round(base * (0.8 + 0.4 * random));
}

/** Resolve after `ms` milliseconds (plain setTimeout; fake-timer friendly). */
function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Run `op` with capped-exponential retries on transient failures. Delay
 * before attempt k = min(baseDelayMs * 2^(k-2), capMs), ±20% jitter. Retries
 * only errors whose `retriable` flag is true (set by the classifiers);
 * everything else rethrows immediately. Each retried attempt logs one warn
 * naming the label, attempt number, and delay. Pure timers - no fs, no
 * child_process.
 */
export async function withTransientRetry<T>(
    op: () => Promise<T>,
    policy: RetryPolicy,
    log: Logger,
    label: string,
): Promise<T> {
    for (let attempt = 1; ; attempt += 1) {
        try {
            return await op();
        } catch (error) {
            const retriable =
                typeof error === "object" && error !== null && (error as { retriable?: unknown }).retriable === true;
            if (!retriable || attempt >= policy.attempts) {
                throw error;
            }
            const next = attempt + 1;
            const delayMs = computeRetryDelayMs(next, policy, Math.random());
            log.warn(`${label}: transient failure, retrying`, { attempt: next, of: policy.attempts, delayMs });
            await sleep(delayMs);
        }
    }
}
