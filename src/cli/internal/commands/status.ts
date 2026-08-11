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

/** Render status rows as aligned plain-text lines (header + one line per target). */
export function formatStatusRows(rows: TargetStatus[]): string[] {
    if (rows.length === 0) {
        return ["no targets configured"];
    }
    return alignRows(
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
