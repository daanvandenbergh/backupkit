/**
 * The single spawn choke point. This is the ONLY module in the codebase that
 * imports node:child_process (a guard test enforces it). Every external
 * process runs as an argv array with `shell: false`, a minimal explicit
 * environment, and an optional timeout. The `stdio: "inherit"` variant exists
 * solely for the CLI's service/logs passthrough (no timeout there by
 * convention; still argv arrays, still no shell).
 */

import { spawn } from "node:child_process";

/** Options for one process execution. */
export interface ExecOptions {
    /**
     * The COMPLETE child environment - never merged with process.env. Omit to
     * use `minimalEnv()` (PATH, HOME if set, LC_ALL=C). Callers add exactly
     * the variables the spec assigns them (e.g. one SSH_AUTH_SOCK).
     */
    env?: Record<string, string>;
    /**
     * Kill the child after this many milliseconds: SIGTERM first, SIGKILL 2 s
     * later if it lingers. Omit for no timeout (the documented service/logs
     * passthrough case).
     */
    timeoutMs?: number;
    /**
     * "pipe" (default): stdin ignored, stdout/stderr captured into the
     * result. "inherit": the child shares this process's stdio; the result's
     * stdout/stderr are empty strings.
     */
    stdio?: "pipe" | "inherit";
    /** Child working directory. Default: this process's cwd. */
    cwd?: string;
}

/** Outcome of one process execution. */
export interface ExecResult {
    /** Exit code, or null when the child was killed by a signal. */
    exitCode: number | null;
    /** Terminating signal, or null when the child exited normally. */
    signal: NodeJS.Signals | null;
    /** Captured stdout ("" in inherit mode). */
    stdout: string;
    /** Captured stderr ("" in inherit mode). */
    stderr: string;
    /** True when the timeout fired and backupkit killed the child. */
    timedOut: boolean;
    /** Wall-clock duration of the child in milliseconds. */
    durationMs: number;
}

/**
 * The minimal default child environment: PATH and HOME copied from this
 * process (HOME only when set) plus LC_ALL=C for locale-stable tool output.
 */
export function minimalEnv(): Record<string, string> {
    const env: Record<string, string> = { LC_ALL: "C" };
    if (process.env.PATH !== undefined) {
        env.PATH = process.env.PATH;
    }
    if (process.env.HOME !== undefined) {
        env.HOME = process.env.HOME;
    }
    return env;
}

/**
 * Spawn `bin` with the given argv array and resolve with its outcome.
 * `shell: false` always; the returned promise rejects only when the process
 * cannot be spawned at all (e.g. ENOENT) - every other outcome, including
 * non-zero exits, signals, and timeouts, resolves with an ExecResult for the
 * caller's classifier to judge.
 */
export function exec(bin: string, args: readonly string[], options: ExecOptions = {}): Promise<ExecResult> {
    const start = Date.now();
    const stdioMode = options.stdio ?? "pipe";
    return new Promise((resolve, reject) => {
        const child = spawn(bin, args, {
            shell: false,
            cwd: options.cwd,
            env: options.env ?? minimalEnv(),
            stdio: stdioMode === "pipe" ? ["ignore", "pipe", "pipe"] : "inherit",
        });

        let stdout = "";
        let stderr = "";
        let timedOut = false;
        let termTimer: NodeJS.Timeout | null = null;
        let killTimer: NodeJS.Timeout | null = null;

        if (options.timeoutMs !== undefined) {
            termTimer = setTimeout(() => {
                timedOut = true;
                child.kill("SIGTERM");
                killTimer = setTimeout(() => child.kill("SIGKILL"), 2000);
            }, options.timeoutMs);
        }

        child.stdout?.setEncoding("utf8");
        child.stdout?.on("data", (chunk: string) => {
            stdout += chunk;
        });
        child.stderr?.setEncoding("utf8");
        child.stderr?.on("data", (chunk: string) => {
            stderr += chunk;
        });

        child.on("error", (error) => {
            if (termTimer !== null) clearTimeout(termTimer);
            if (killTimer !== null) clearTimeout(killTimer);
            reject(error);
        });

        child.on("close", (exitCode, signal) => {
            if (termTimer !== null) clearTimeout(termTimer);
            if (killTimer !== null) clearTimeout(killTimer);
            resolve({ exitCode, signal, stdout, stderr, timedOut, durationMs: Date.now() - start });
        });
    });
}
