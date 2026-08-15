/**
 * The `backupkit restore` command: copy one snapshot (`latest` accepted) to a
 * non-existent output path, with an opt-in checksum verify pass, or - with
 * --dry-run - only report what that copy would write. A pure view over
 * `Backupkit.restore()`.
 */

import { formatBytes } from "../../../shared/format.js";
import type { CliDeps } from "../context.js";
import { count, parseFlags, selectTargets, UsageError } from "../context.js";
import { COMMAND_HELP } from "../help.js";

/** The `backupkit restore` command entry. */
export async function restoreCommand(argv: string[], deps: CliDeps): Promise<number> {
    const { values, positionals } = parseFlags(
        argv,
        {
            output: { type: "string" },
            verify: { type: "boolean" },
            "dry-run": { type: "boolean" },
            config: { type: "string" },
        },
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
    const dryRun = values["dry-run"] === true;
    if (dryRun && values.verify === true) {
        throw new UsageError("--dry-run writes nothing, so --verify has nothing to verify - use one or the other");
    }
    const { config, engine } = deps.loadContext(values.config as string | undefined);
    selectTargets([positionals[0]], config);
    const report = await engine.restore({
        target: positionals[0],
        snapshot: positionals[1],
        output,
        verify: values.verify === true,
        dryRun,
    });
    if (dryRun) {
        const size =
            report.plan === null
                ? "size unknown (rsync printed no stats)"
                : `${count(report.plan.files, "file")}, ${formatBytes(report.plan.bytes)}`;
        deps.stdout(`Would restore snapshot ${report.snapshot} of ${report.target} to ${report.output}: ${size}`);
        deps.stdout("Dry run - nothing was written. Drop --dry-run to restore.");
        return 0;
    }
    deps.stdout(
        `Restored snapshot ${report.snapshot} of ${report.target} to ${report.output}${report.verified ? " (contents verified)" : ""}`,
    );
    return 0;
}
