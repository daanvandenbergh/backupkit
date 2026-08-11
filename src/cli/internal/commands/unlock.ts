/**
 * The `backupkit unlock` command: clear a leaked destination lock, per target.
 * A LIVE lock is reported and left alone unless --force, so the default can
 * never put two pipelines into one archive root. Exit 1 when any target was
 * left locked or errored. A pure view over `Backupkit.unlock()`.
 */

import type { CliDeps } from "../context.js";
import { parseFlags, selectTargets } from "../context.js";
import { COMMAND_HELP } from "../help.js";

/** The `backupkit unlock` command entry. */
export async function unlockCommand(argv: string[], deps: CliDeps): Promise<number> {
    const { values, positionals } = parseFlags(argv, { force: { type: "boolean" }, config: { type: "string" } }, true);
    if (values.help === true) {
        deps.stdout(COMMAND_HELP.unlock);
        return 0;
    }
    const { config, engine } = deps.loadContext(values.config as string | undefined);
    const targets = selectTargets(positionals, config);
    const rows = await engine.unlock({ targets, force: values.force === true });
    let failed = false;
    for (const row of rows) {
        switch (row.status) {
            case "none":
                deps.stdout(`${row.target}: no lock held`);
                break;
            case "removed":
                deps.stdout(`${row.target}: lock cleared (${row.detail})`);
                break;
            case "held":
                // Not an error the operator mistyped - it is the answer. Name
                // the holder and the one flag that overrides it, because the
                // judgement ("is that run really dead?") is his to make.
                deps.stderr(
                    `Error: ${row.target} is locked by a live backupkit (${row.detail}). ` +
                        "Stop it, or pass --force to clear the lock anyway.",
                );
                failed = true;
                break;
            case "failed":
                deps.stderr(`Error: could not unlock ${row.target}: ${row.detail}`);
                failed = true;
                break;
        }
    }
    return failed ? 1 : 0;
}
