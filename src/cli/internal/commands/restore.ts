/**
 * The `backupkit restore` command: copy one snapshot (`latest` accepted) to a
 * non-existent output path, with an opt-in checksum verify pass. A pure view
 * over `Backupkit.restore()`.
 */

import type { CliDeps } from "../context.js";
import { parseFlags, selectTargets, UsageError } from "../context.js";
import { COMMAND_HELP } from "../help.js";

/** The `backupkit restore` command entry. */
export async function restoreCommand(argv: string[], deps: CliDeps): Promise<number> {
    const { values, positionals } = parseFlags(
        argv,
        { output: { type: "string" }, verify: { type: "boolean" }, config: { type: "string" } },
        true,
    );
    if (values.help === true) {
        deps.stdout(COMMAND_HELP.restore);
        return 0;
    }
    if (positionals.length !== 2) {
        throw new UsageError("restore takes exactly TARGET and SNAPSHOT|latest (see: backupkit restore --help)");
    }
    const output = values.output as string | undefined;
    if (output === undefined) {
        throw new UsageError("restore requires --output PATH (a fresh, non-existent path)");
    }
    const { config, engine } = deps.loadContext(values.config as string | undefined);
    selectTargets([positionals[0]], config);
    const report = await engine.restore({
        target: positionals[0],
        snapshot: positionals[1],
        output,
        verify: values.verify === true,
    });
    deps.stdout(
        `restored ${report.target}/${report.snapshot} -> ${report.output}${report.verified ? " (verified)" : ""}`,
    );
    return 0;
}
