/**
 * The `backupkit start` command - the same foreground scheduler loop as
 * `backupkit daemon`, but run BY the operator in their own session instead of
 * by systemd/launchd.
 *
 * That is the supported home for passphrase-protected keys: preflight starts
 * backupkit's ssh-agent and adds every explicit remote's key to it, prompting
 * on this terminal for each encrypted one, and the loop then schedules against
 * the unlocked agent for as long as the process lives. A service cannot do
 * that (no terminal to prompt on), which is why `daemon` refuses such a key.
 *
 * `--force` runs every target once before the loop starts - the same pass
 * `backupkit run --force` performs - so a session does not have to wait for
 * the first schedule tick to know the config works.
 */

import type { CliDeps } from "../context.js";
import { count, parseFlags, printRunReport } from "../context.js";
import { COMMAND_HELP } from "../help.js";

/** The `backupkit start` command entry. */
export async function startCommand(argv: string[], deps: CliDeps): Promise<number> {
    const { values } = parseFlags(argv, { force: { type: "boolean" }, config: { type: "string" } }, false);
    if (values.help === true) {
        deps.stdout(COMMAND_HELP.start);
        return 0;
    }
    const { config, engine } = deps.loadContext(values.config as string | undefined);
    deps.wireSignals(() => engine.stop());
    // No serviceMode: encrypted keys are prompted for here, not refused.
    await engine.preflight();
    const enabled = config.targets.filter((target) => target.enabled).length;
    deps.stdout(
        `Scheduler started - ${enabled} of ${count(config.targets.length, "configured target")} scheduled. ` +
            "Backups run while this process stays alive; Ctrl-C stops it.",
    );
    if (values.force === true) {
        // The immediate pass must not take the scheduler down with it: a held
        // destination lock (or any other run failure) is reported here and the
        // loop starts anyway, exactly as it would have without --force.
        try {
            deps.stdout("Running every target once now (--force), then scheduling.");
            printRunReport(await engine.run({ force: true }), deps.stdout);
        } catch (error) {
            deps.stderr(`Initial --force pass failed: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
    await engine.start();
    deps.stdout("Scheduler stopped cleanly.");
    return 0;
}
