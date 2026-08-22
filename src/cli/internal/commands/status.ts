/**
 * The `backupkit status` command: one padEnd-aligned row per target (or a
 * single JSON document with --json). A pure view over `Backupkit.status()`;
 * `service status` reuses the row formatter under its unit-state header.
 */

import type { TargetStatus } from "../../../engine/types.js";
import { formatUtc } from "../../../shared/format.js";
import type { CliDeps } from "../context.js";
import { alignRows, parseFlags, selectTargets } from "../context.js";
import { COMMAND_HELP } from "../help.js";

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
 * explanation under it for every target with a failure on record.
 */
export function formatStatusRows(rows: TargetStatus[]): string[] {
    if (rows.length === 0) {
        return ["no targets configured"];
    }
    const table = alignRows(
        ["TARGET", "LAST SNAPSHOT", "NEXT DUE", "LAST RESULT", "FAILS", "LOCK"],
        rows.map((row) => [
            row.target,
            row.lastSnapshot ?? "-",
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
