/**
 * The `backupkit run` command: one pass over due targets (or the named
 * subset), with --force and --dry-run per spec sections 6 and 7. Exit 1 when
 * any target failed. SIGINT/SIGTERM stop the engine gracefully; a second
 * signal exits 1 immediately.
 */

import type { CliDeps } from "../context.js";
import { parseFlags, printRunReport, selectTargets } from "../context.js";
import { COMMAND_HELP } from "../help.js";

/** The `backupkit run` command entry. */
export async function runCommand(argv: string[], deps: CliDeps): Promise<number> {
    const { values, positionals } = parseFlags(
        argv,
        { force: { type: "boolean" }, "dry-run": { type: "boolean" }, config: { type: "string" } },
        true,
    );
    if (values.help === true) {
        deps.stdout(COMMAND_HELP.run);
        return 0;
    }
    const { config, engine } = deps.loadContext(values.config as string | undefined);
    const targets = selectTargets(positionals, config);
    deps.wireSignals(() => engine.stop());
    const report = await engine.run({
        targets,
        force: values.force === true,
        dryRun: values["dry-run"] === true,
    });
    if (report.targets.length === 0) {
        deps.stdout(
            "Nothing to do - every target is already backed up for this schedule window. " +
                "Run `backupkit status` to see when they are next due, or `backupkit run --force` to back them up again now.",
        );
        return 0;
    }
    return printRunReport(report, deps.stdout) === 0 ? 0 : 1;
}
