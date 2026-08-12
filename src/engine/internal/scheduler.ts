/**
 * Scheduling (spec section 6): the pure due-ness/backoff math and the 30 s
 * foreground tick loop. Due targets run sequentially in config (document)
 * order; catch-up is exactly one run per missed window by construction of the
 * window comparison; per-target consecutive-failure backoff is derived from
 * run reports (no state file) with `min(15min * 2^(n-1), 6h)` - backoff can
 * delay a target but can NEVER stop it, and every backoff state transition
 * logs at error level.
 */

import type { ResolvedTarget } from "../../config/types.js";
import type { Logger } from "../../shared/logger.js";
import { isBackupkitError } from "../../shared/errors.js";
import { formatUtc } from "../../shared/format.js";
import { isDue, windowAnchor, windowIndex, type ScheduleSpec } from "../../shared/time.js";
import type { DerivedBackoff } from "./reports.js";
import type { RunStatus, TargetRunReport } from "../types.js";

/** Milliseconds between scheduler ticks. */
export const TICK_MS = 30_000;

/** Backoff base delay: 15 minutes. */
const BACKOFF_BASE_MS = 15 * 60_000;

/** Backoff ceiling: 6 hours - absolute and load-bearing (backoff never stops a target). */
export const BACKOFF_CAP_MS = 6 * 3_600_000;

/** The backoff delay after `n` consecutive failures: `min(15min * 2^(n-1), 6h)`; 0 when n <= 0. */
export function backoffDelayMs(consecutiveFailures: number): number {
    if (consecutiveFailures <= 0) {
        return 0;
    }
    return Math.min(BACKOFF_BASE_MS * 2 ** (consecutiveFailures - 1), BACKOFF_CAP_MS);
}

/**
 * When a target is next due: the current window's anchor if unfulfilled, else
 * the next window's anchor - pushed out to `backoffUntil` when a failure
 * backoff is active. Pure; `newest` is when the target last fulfilled a window
 * (the newest complete snapshot's time, or - for a mirror, which writes none -
 * the start of its newest completed run), or null when it never has.
 */
export function nextDueAt(schedule: ScheduleSpec, newest: Date | null, backoffUntil: Date | null, now: Date): Date {
    const index = windowIndex(schedule, now);
    let due: Date;
    if (newest !== null && windowIndex(schedule, newest) === index) {
        due = windowAnchor(schedule, index + 1);
    } else {
        const anchor = windowAnchor(schedule, index);
        due = now.getTime() >= anchor.getTime() ? now : anchor;
    }
    if (backoffUntil !== null && backoffUntil.getTime() > due.getTime()) {
        return backoffUntil;
    }
    return due;
}

/** One target's in-memory backoff state. */
interface BackoffState {
    /** Consecutive failed runs. */
    failures: number;
    /** `finishedAt` of the newest failed run, or null. */
    anchor: Date | null;
}

/**
 * In-memory backoff bookkeeping, rehydrated from run reports at startup and
 * updated as each report is recorded. Owns the mandatory error-level log on
 * every state transition: enter (first failure), extend (further failures),
 * ceiling, and clear (first success/warning after failures).
 */
export class BackoffTracker {
    /** Per-target state. */
    private readonly state = new Map<string, BackoffState>();

    /** Logger for the transition lines. */
    private readonly log: Logger;

    /** Construct a tracker logging transitions through `log`. */
    constructor(log: Logger) {
        this.log = log;
    }

    /** Seed one target's state from its derived report history (no transition logs - nothing changed). */
    rehydrate(target: string, derived: DerivedBackoff): void {
        this.state.set(target, { failures: derived.consecutiveFailures, anchor: derived.lastFailedAt });
    }

    /**
     * Record one finished run and log any backoff transition at error level.
     * `aborted` and `skipped` never change the state.
     */
    record(target: string, status: RunStatus, finishedAt: Date): void {
        const current = this.state.get(target) ?? { failures: 0, anchor: null };
        if (status === "failed") {
            const failures = current.failures + 1;
            this.state.set(target, { failures, anchor: finishedAt });
            const delayMs = backoffDelayMs(failures);
            const nextAttemptAt = formatUtc(new Date(finishedAt.getTime() + delayMs));
            const phase = failures === 1 ? "entering" : delayMs >= BACKOFF_CAP_MS ? "at ceiling for" : "extending";
            this.log.error(`${phase} failure backoff`, { target, failures, nextAttemptAt });
            return;
        }
        if ((status === "success" || status === "warning") && current.failures > 0) {
            this.state.set(target, { failures: 0, anchor: null });
            this.log.error("clearing failure backoff after successful run", { target });
            return;
        }
        if (status === "success" || status === "warning") {
            this.state.set(target, { failures: 0, anchor: null });
        }
    }

    /** Consecutive failures currently recorded for a target. */
    failuresFor(target: string): number {
        return this.state.get(target)?.failures ?? 0;
    }

    /** The instant before which the target must not be retried, or null when no backoff is active. */
    untilFor(target: string): Date | null {
        const current = this.state.get(target);
        if (current === undefined || current.failures === 0 || current.anchor === null) {
            return null;
        }
        return new Date(current.anchor.getTime() + backoffDelayMs(current.failures));
    }
}

/** Everything the tick loop needs - every seam injectable for tests. */
export interface SchedulerDeps {
    /** Enabled targets in config document order. */
    targets: readonly ResolvedTarget[];
    /** Logger. */
    log: Logger;
    /** Clock. */
    now: () => Date;
    /** Milliseconds between ticks. Default 30000. */
    tickMs?: number;
    /** Run one target now and return its (already persisted) report. */
    runTarget: (target: ResolvedTarget) => Promise<TargetRunReport>;
    /**
     * When a target last fulfilled a schedule window - the time of its newest
     * complete snapshot, or for a mirror target (which writes none) the start
     * of its newest completed run. Called once per target, then cached from the
     * reports the loop itself produces.
     */
    lastFulfilledAt: (target: ResolvedTarget) => Promise<Date | null>;
    /**
     * Persist a report for a target whose run left no report of its own, and
     * feed the backoff tracker with it. Used by BOTH failure paths in the tick -
     * the due-check failure (`due-check-failed`) and an unexpected throw out of
     * `runTarget` (`run-threw`): without it a target whose archive host is
     * unreachable, or whose rsync is unusable, would leave no record at all, so
     * `status` would keep reporting the last success forever.
     */
    recordOutcome: (target: ResolvedTarget, status: RunStatus, reason: string, error: string) => Promise<void>;
    /** The shared backoff tracker (rehydrated by the engine before the loop starts). */
    backoff: BackoffTracker;
}

/**
 * The foreground scheduler loop: an immediate tick at startup (catch-up),
 * then one tick every 30 s recomputing due-ness for every enabled target from
 * the wall clock (self-heals across sleep/NTP). Due targets run sequentially
 * in config order. `stop()` ends the loop after the current tick; aborting an
 * in-flight transfer is the engine's AbortController, not ours.
 */
export class Scheduler {
    /** Injected dependencies. */
    private readonly deps: SchedulerDeps;

    /** Cached last-fulfilled time per target (avoids per-tick store I/O). */
    private readonly newestCache = new Map<string, Date | null>();

    /** True once stop() was called; the loop exits at the next check. */
    private stopping = false;

    /** Wakes the sleeping loop early on stop(). */
    private wake: (() => void) | null = null;

    /** Construct the loop over its dependencies. */
    constructor(deps: SchedulerDeps) {
        this.deps = deps;
    }

    /** Run the loop until `stop()`; resolves after the in-flight tick completes. */
    async start(): Promise<void> {
        const tickMs = this.deps.tickMs ?? TICK_MS;
        while (!this.stopping) {
            await this.tick();
            if (this.stopping) {
                break;
            }
            await new Promise<void>((resolve) => {
                const timer = setTimeout(resolve, tickMs);
                this.wake = () => {
                    clearTimeout(timer);
                    resolve();
                };
            });
            this.wake = null;
        }
    }

    /** End the loop: the sleeping wait wakes immediately; an in-flight tick finishes first. */
    stop(): void {
        this.stopping = true;
        this.wake?.();
    }

    /** One tick: run every due target sequentially in config order. */
    private async tick(): Promise<void> {
        for (const target of this.deps.targets) {
            if (this.stopping) {
                return;
            }
            if (!target.enabled) {
                continue;
            }
            const now = this.deps.now();
            // Respect the failure backoff BEFORE any remote work. A backed-off
            // target must not be LISTED or run: the due-check listing is an ssh
            // round-trip for push targets, so gating backoff only before
            // runTarget (as this used to) let an unreachable remote fail that
            // listing on every 30 s tick - spamming a failure and driving the
            // count to the 6 h ceiling instead of actually spacing retries out.
            const until = this.deps.backoff.untilFor(target.name);
            if (until !== null && now.getTime() < until.getTime()) {
                continue;
            }
            let newest = this.newestCache.get(target.name);
            if (newest === undefined) {
                try {
                    newest = await this.deps.lastFulfilledAt(target);
                } catch (error) {
                    // A failed due check is a FAILED RUN, not a quiet skip. For a
                    // push target this listing is an ssh round-trip, so every
                    // persistent condition (archive host down, key revoked, jail
                    // script renamed) lands here - and a warn-and-continue left no
                    // report, so consecutiveFailures stayed 0, backoff never
                    // engaged, and `status` reported the last success forever
                    // while nothing ran for weeks.
                    const message = String(error);
                    this.deps.log.error("could not list snapshots for the due check - target run recorded as failed", {
                        target: target.name,
                        error: message,
                    });
                    // A failing state dir must never end the daemon loop.
                    await this.deps.recordOutcome(target, "failed", "due-check-failed", message).catch((writeError) => {
                        this.deps.log.error("could not persist the due-check failure report", {
                            target: target.name,
                            error: String(writeError),
                        });
                    });
                    continue;
                }
                this.newestCache.set(target.name, newest);
            }
            if (!isDue(target.schedule, newest, now)) {
                continue;
            }
            try {
                const report = await this.deps.runTarget(target);
                if (report.status === "success" || report.status === "warning") {
                    // The run's own start time, not its snapshot name: a snapshot
                    // is named for exactly that instant, and a mirror run has no
                    // name at all. An unparseable time is dropped rather than
                    // cached - an Invalid Date compares false against every
                    // window, so caching one would make this target due on every
                    // 30 s tick for the rest of the process's life.
                    const fulfilled = new Date(report.startedAt);
                    if (Number.isNaN(fulfilled.getTime())) {
                        this.newestCache.delete(target.name);
                    } else {
                        this.newestCache.set(target.name, fulfilled);
                    }
                } else if (report.status === "skipped" && report.reason === "window") {
                    // Something this loop did not create already fulfils the
                    // window (a manual run, --force, or another writer): drop the
                    // stale cache so the next tick re-reads instead of re-entering
                    // the pipeline every 30 s for the rest of the window.
                    this.newestCache.delete(target.name);
                }
            } catch (error) {
                if (isBackupkitError(error) && error.code === "lock-held") {
                    this.deps.log.warn("destination lock held - skipping until next tick", {
                        target: target.name,
                        error: error.message,
                    });
                    continue;
                }
                // Same silent failure as the due-check catch above, on its
                // sibling path: this logged and wrote NO report, so
                // consecutiveFailures stayed 0, backoff never engaged, and
                // `status` reported the last success forever while nothing ran.
                // Reachable whenever the local rsync becomes unusable
                // (uninstalled, downgraded below the 3.2.5 floor, sandboxed away
                // by ProtectSystem=strict), when the report write inside the
                // pipeline fails, or on any unexpected throw.
                const message = String(error);
                this.deps.log.error("target run threw unexpectedly - recorded as failed", {
                    target: target.name,
                    error: message,
                });
                // A failing state dir must never end the daemon loop.
                await this.deps.recordOutcome(target, "failed", "run-threw", message).catch((writeError) => {
                    this.deps.log.error("could not persist the unexpected-throw failure report", {
                        target: target.name,
                        error: String(writeError),
                    });
                });
            }
        }
    }
}
