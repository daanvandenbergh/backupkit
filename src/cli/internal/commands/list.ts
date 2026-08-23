/**
 * The `backupkit list` command (alias `ls`): complete snapshots per target,
 * oldest first - aligned plain text, or one JSON document with --json. A pure
 * view over `Backupkit.listSnapshots()`.
 *
 * The plain-text table shows AGE rather than the creation timestamp, because
 * the snapshot name already is that timestamp. `--json` keeps `createdAt`
 * full-precision - it is the machine contract, and machines subtract.
 */

import type { CliDeps } from "../context.js";
import { alignRows, parseFlags, selectTargets, timeAgo } from "../context.js";
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
    // AGE, not a second copy of the creation time: a snapshot's NAME already IS
    // its UTC timestamp, so `2026-08-21T000000Z  2026-08-21T00:00:00Z` was two
    // columns stating one fact, and the reader had to do the subtraction that
    // matters ("how old is my newest backup?") in their head anyway. The exact
    // instant stays in `--json` as `createdAt`, which is where anything that
    // computes on it should read it from.
    const now = new Date();
    const lines = alignRows(
        ["TARGET", "SNAPSHOT", "AGE"],
        infos.map((info) => [info.target, info.name, timeAgo(info.createdAt.toISOString(), now)]),
    );
    for (const line of lines) {
        deps.stdout(line);
    }
    return 0;
}
