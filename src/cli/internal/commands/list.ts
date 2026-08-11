/**
 * The `backupkit list` command (alias `ls`): complete snapshots per target,
 * oldest first - aligned plain text, or one JSON document with --json. A pure
 * view over `Backupkit.listSnapshots()`.
 */

import { formatUtc } from "../../../shared/format.js";
import type { CliDeps } from "../context.js";
import { alignRows, parseFlags, selectTargets } from "../context.js";
import { COMMAND_HELP } from "../help.js";

/** The `backupkit list` command entry. */
export async function listCommand(argv: string[], deps: CliDeps): Promise<number> {
    const { values, positionals } = parseFlags(
        argv,
        { json: { type: "boolean" }, config: { type: "string" } },
        true,
    );
    if (values.help === true) {
        deps.stdout(COMMAND_HELP.list);
        return 0;
    }
    const { config, engine } = deps.loadContext(values.config as string | undefined);
    const targets = selectTargets(positionals, config);
    const infos = await engine.listSnapshots(targets === undefined ? undefined : { targets });
    if (values.json === true) {
        deps.stdout(JSON.stringify(infos, null, 2));
        return 0;
    }
    if (infos.length === 0) {
        deps.stdout("No snapshots yet. Create the first one with: backupkit run");
        return 0;
    }
    const lines = alignRows(
        ["TARGET", "SNAPSHOT", "CREATED (UTC)"],
        infos.map((info) => [info.target, info.name, formatUtc(info.createdAt)]),
    );
    for (const line of lines) {
        deps.stdout(line);
    }
    return 0;
}
