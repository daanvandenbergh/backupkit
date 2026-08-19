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
 * The single-attempt policy for remote operations that are NOT idempotent -
 * the lock-acquire `mkdir` and every `mv` rename. Retrying those is unsafe in a
 * way retrying a read is not: the transport can fail AFTER the remote command
 * already succeeded, so a second attempt re-executes a mutation that has
 * already happened. For the lock `mkdir` that is fatal (the re-sent mkdir hits
 * EEXIST against the lock this process just won, and a lock with no creation
 * marker is held forever); for a `mv` it turns a completed rename into a
 * spurious run failure. The scheduler's next tick is the retry for these.
 */
export const NO_RETRY_POLICY: RetryPolicy = { attempts: 1, baseDelayMs: 0, capMs: 0 };

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

/** How much of a failure message the per-attempt warn carries before it is trimmed. */
const CAUSE_MAX_CHARS = 200;

/** Whether the shutdown signal (if any) has fired. A function so each call re-reads it after an await. */
function isAborted(signal: AbortSignal | undefined): boolean {
    return signal !== undefined && signal.aborted;
}

/**
 * Resolve after `ms` milliseconds, or as soon as `signal` aborts (plain
 * setTimeout; fake-timer friendly). The early wake matters on the shutdown
 * path: the transfer policy's backoff reaches 300 s, far past the service
 * unit's `TimeoutStopSec`, and a graceful stop must not sit in a sleep it
 * already knows is pointless.
 */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted === true) {
        return Promise.resolve();
    }
    return new Promise((resolve) => {
        const timer = setTimeout(() => {
            signal?.removeEventListener("abort", onAbort);
            resolve();
        }, ms);
        /** Wake immediately on abort. */
        function onAbort(): void {
            clearTimeout(timer);
            resolve();
        }
        signal?.addEventListener("abort", onAbort, { once: true });
    });
}

/**
 * The failing error's message, trimmed to one readable log field.
 *
 * Without this the warn said only "hit a temporary problem", so a night of
 * dropped Wi-Fi and a night of a dead backup server produced byte-identical
 * logs - the reader could see THAT it retried and never WHY. The classifiers
 * put the plain-language cause at the FRONT of every message they build, so
 * the head of the string is the part worth keeping; the tail is the raw
 * stderr, up to 2 KiB of it, which belongs in the final error and not in
 * sixteen warn lines.
 */
function retryCause(error: unknown): string {
    const message = error instanceof Error ? error.message : String(error);
    return message.length > CAUSE_MAX_CHARS ? `${message.slice(0, CAUSE_MAX_CHARS)}...` : message;
}

/**
 * Run `op` with capped-exponential retries on transient failures. Delay
 * before attempt k = min(baseDelayMs * 2^(k-2), capMs), ±20% jitter. Retries
 * only errors whose `retriable` flag is true (set by the classifiers);
 * everything else rethrows immediately. Each retried attempt logs one warn
 * naming the label, attempt number, delay, and the trimmed failure cause -
 * without that last field a retry storm says nothing about what is failing. Pure timers - no fs, no
 * child_process.
 *
 * `signal` is the graceful-shutdown signal: once aborted, no further attempt
 * starts and any pending backoff wakes immediately. Without it a stop could be
 * held up by a sleep of up to the policy cap (300 s on the transfer policy),
 * which no service unit's stop timeout tolerates.
 */
export async function withTransientRetry<T>(
    op: () => Promise<T>,
    policy: RetryPolicy,
    log: Logger,
    label: string,
    signal?: AbortSignal,
): Promise<T> {
    for (let attempt = 1; ; attempt += 1) {
        try {
            return await op();
        } catch (error) {
            const retriable =
                typeof error === "object" && error !== null && (error as { retriable?: unknown }).retriable === true;
            if (!retriable || attempt >= policy.attempts || isAborted(signal)) {
                throw error;
            }
            const next = attempt + 1;
            const delayMs = computeRetryDelayMs(next, policy, Math.random());
            log.warn(`${label} hit a temporary problem - trying again`, {
                attempt: next,
                of: policy.attempts,
                delayMs,
                cause: retryCause(error),
            });
            await sleep(delayMs, signal);
            // Aborted while waiting: the backoff woke early precisely so this
            // check happens now rather than after the full delay. Rethrow the
            // failure that caused the wait - no further attempt starts.
            if (isAborted(signal)) {
                throw error;
            }
        }
    }
}
