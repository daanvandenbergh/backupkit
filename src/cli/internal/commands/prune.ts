/**
 * The `backupkit prune` command: apply retention now, or print the plan
 * (keeps with reasons + prune list) with --dry-run and stop. Exit 1 when any
 * deletion failed. A pure view over `Backupkit.prune()`.
 */

import type { CliDeps } from "../context.js";
import { parseFlags, selectTargets } from "../context.js";
import { COMMAND_HELP } from "../help.js";

/** The `backupkit prune` command entry. */
export async function pruneCommand(argv: string[], deps: CliDeps): Promise<number> {
    const { values, positionals } = parseFlags(
        argv,
        { "dry-run": { type: "boolean" }, force: { type: "boolean" }, config: { type: "string" } },
        true,
    );
    if (values.help === true) {
        deps.stdout(COMMAND_HELP.prune);
        return 0;
    }
    const dryRun = values["dry-run"] === true;
    const { config, engine } = deps.loadContext(values.config as string | undefined);
    const targets = selectTargets(positionals, config);
    const report = await engine.prune({ targets, dryRun, force: values.force === true });
    let failed = false;
    for (const entry of report.targets) {
        deps.stdout(`Target ${entry.target}:`);
        for (const keep of entry.plan.keep) {
            deps.stdout(`    keep   ${keep.name}  (${keep.reasons.join(", ")})`);
        }
        for (const name of entry.plan.prune) {
            deps.stdout(`    prune  ${name}${dryRun ? "" : "  (deleted)"}`);
        }
        if (entry.plan.prune.length === 0) {
            deps.stdout("    Nothing to prune - every snapshot is still within retention.");
        }
        for (const error of entry.errors) {
            deps.stderr(`Error: could not prune ${entry.target}: ${error}`);
            failed = true;
        }
    }
    if (dryRun) {
        deps.stdout("Dry run - nothing was deleted. Drop --dry-run to apply this plan.");
    }
    return failed ? 1 : 0;
}
