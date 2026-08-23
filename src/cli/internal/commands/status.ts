/**
 * The `backupkit status` command: one padEnd-aligned row per target (or a
 * single JSON document with --json). A pure view over `Backupkit.status()`;
 * `service status` reuses the row formatter under its unit-state header.
 */

import type { TargetStatus } from "../../../engine/types.js";
import { formatDuration, formatUtc } from "../../../shared/format.js";
import type { CliDeps } from "../context.js";
import { alignRows, parseFlags, selectTargets } from "../context.js";
import { COMMAND_HELP } from "../help.js";

/**
 * How long ago the newest successful run started, as a person reads it -
 * "20h ago", "3d 4h ago", or "never".
 *
 * RELATIVE, where every other time column is absolute, and deliberately so:
 * this column exists to answer "are my backups current", and an absolute
 * timestamp makes the reader do the arithmetic that IS the question. The exact
 * instant is still in `--json` as `lastSuccessAt` for anything that needs to
 * compute on it.
 *
 * A future timestamp (a clock that moved backwards, a report written by a host
 * whose clock is ahead) reads "just now" rather than a negative age - the
 * clock-skew guard is what reports that condition, and it says so properly.
 */
function successAge(lastSuccessAt: string | null, now: Date): string {
    if (lastSuccessAt === null) {
        return "never";
    }
    const at = new Date(lastSuccessAt);
    if (Number.isNaN(at.getTime())) {
        return "-";
    }
    const elapsed = now.getTime() - at.getTime();
    return elapsed <= 0 ? "just now" : `${formatDuration(elapsed)} ago`;
}

/** How much of a failure explanation one status line carries before it is trimmed. */
const ERROR_MAX_CHARS = 300;

/**
 * The "why is this target failing" block printed under the table.
 *
 * The table answers everything except the one question a person opens
 * `backupkit status` to ask. `failed 9` and a next-due six hours out told them
 * something was wrong, how badly, and nothing whatever about what - so the
 * only way to find out was to go and read the log. A column cannot hold a
 * sentence, so this goes underneath, once per failing target.
 */
function failureNotes(rows: TargetStatus[]): string[] {
    const lines: string[] = [];
    for (const row of rows.filter((r) => r.lastError !== null)) {
        const error = row.lastError as string;
        const when = row.lastErrorAt === null ? "" : ` at ${formatUtc(new Date(row.lastErrorAt))}`;
        const times = row.consecutiveFailures > 1 ? ` (${row.consecutiveFailures} times in a row)` : "";
        lines.push("");
        lines.push(`${row.target} last failed${when}${times}:`);
        lines.push(`  ${error.length > ERROR_MAX_CHARS ? `${error.slice(0, ERROR_MAX_CHARS)}...` : error}`);
        if (row.consecutiveFailures > 0 && row.nextDueAt !== null) {
            lines.push(
                `  Waiting until ${formatUtc(new Date(row.nextDueAt))} before trying again; ` +
                    `\`backupkit run --force ${row.target}\` retries it now.`,
            );
        }
    }
    return lines;
}

/**
 * Render status rows as aligned plain-text lines: the table, then a short
 * explanation under it for every target with a failure on record. `now` is
 * injectable so the relative LAST SUCCESS column is testable.
 */
export function formatStatusRows(rows: TargetStatus[], now: Date = new Date()): string[] {
    if (rows.length === 0) {
        return ["no targets configured"];
    }
    const table = alignRows(
        ["TARGET", "LAST SNAPSHOT", "LAST SUCCESS", "NEXT DUE", "LAST RESULT", "FAILS", "LOCK"],
        rows.map((row) => [
            row.target,
            row.lastSnapshot ?? "-",
            successAge(row.lastSuccessAt, now),
            // The struct carries strict ISO-8601 for --json; humans get formatUtc.
            row.nextDueAt === null ? "-" : formatUtc(new Date(row.nextDueAt)),
            row.lastResult ?? "-",
            String(row.consecutiveFailures),
            row.lockHeld ? "held" : "-",
        ]),
    );
    return [...table, ...failureNotes(rows)];
}

/** The `backupkit status` command entry. */
export async function statusCommand(argv: string[], deps: CliDeps): Promise<number> {
    const { values, positionals } = parseFlags(
        argv,
        { json: { type: "boolean" }, config: { type: "string" } },
        true,
    );
    if (values.help === true) {
        deps.stdout(COMMAND_HELP.status);
        return 0;
    }
    const { config, engine } = deps.loadContext(values.config as string | undefined);
    const targets = selectTargets(positionals, config);
    const rows = await engine.status(targets === undefined ? undefined : { targets });
    if (values.json === true) {
        deps.stdout(JSON.stringify(rows, null, 2));
        return 0;
    }
    for (const line of formatStatusRows(rows)) {
        deps.stdout(line);
    }
    return 0;
}
