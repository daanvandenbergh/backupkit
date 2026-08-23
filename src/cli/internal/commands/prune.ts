/**
 * The `backupkit prune` command: apply retention now, or print the plan
 * (keeps with reasons + prune list) with --dry-run and stop. Exit 1 when any
 * deletion failed. A pure view over `Backupkit.prune()`.
 */

import type { CliDeps } from "../context.js";
import { count, parseFlags, selectTargets } from "../context.js";
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
    let failed = 0;
    let pruned = 0;
    for (const entry of report.targets) {
        // `<target>:` - the same row heading `run`, `status` and every log line
        // use. "Target photos:" spent a word on what the colon already says.
        deps.stdout(`${entry.target}:`);
        for (const keep of entry.plan.keep) {
            deps.stdout(`    keep   ${keep.name}  (${keep.reasons.join(", ")})`);
        }
        for (const name of entry.plan.prune) {
            deps.stdout(`    prune  ${name}${dryRun ? "" : "  (deleted)"}`);
        }
        pruned += entry.plan.prune.length;
        if (entry.plan.prune.length === 0) {
            deps.stdout("    Nothing to prune - every snapshot is still within retention.");
        }
        for (const error of entry.errors) {
            deps.stderr(`Error: could not prune ${entry.target}: ${error}`);
            failed += 1;
        }
    }
    // A closing line, like every other verb: the per-target rows scroll, and
    // "did this do anything, and did all of it work?" is the question the exit
    // code answers but a screen of snapshot names does not.
    if (failed > 0) {
        deps.stdout(`Done. ${count(failed, "snapshot")} could not be deleted - see the errors above.`);
        return 1;
    }
    if (dryRun) {
        deps.stdout(
            `Dry run - nothing was deleted. ${pruned === 0 ? "Nothing would be" : `${count(pruned, "snapshot")} would be`} removed;` +
                " drop --dry-run to apply this plan.",
        );
        return 0;
    }
    deps.stdout(pruned === 0 ? "Done. Nothing needed pruning." : `Done. Pruned ${count(pruned, "snapshot")}.`);
    return 0;
}
