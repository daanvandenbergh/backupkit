/**
 * The `backupkit run` command: one pass over due targets (or the named
 * subset), with --force and --dry-run per spec sections 6 and 7. Exit 1 when
 * any target failed. SIGINT/SIGTERM stop the engine gracefully; a second
 * signal exits 1 immediately.
 */

import type { CliDeps } from "../context.js";
import { parseFlags, selectTargets } from "../context.js";
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
        deps.stdout("no targets were due - pass --force to run anyway");
        return 0;
    }
    let failed = false;
    for (const target of report.targets) {
        const detail = [
            target.snapshot === null ? null : `snapshot=${target.snapshot}`,
            target.reason === null ? null : `reason=${target.reason}`,
            target.error === null ? null : `error=${target.error}`,
        ]
            .filter((part) => part !== null)
            .join(" ");
        deps.stdout(`${target.target}: ${target.status}${detail === "" ? "" : " " + detail}`);
        if (target.status === "failed") {
            failed = true;
        }
    }
    return failed ? 1 : 0;
}
