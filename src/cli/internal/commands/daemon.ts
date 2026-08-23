/**
 * The `backupkit daemon` command - the foreground scheduler loop the service
 * unit's ExecStart runs: preflight, then `start()` until a signal stops it.
 * The process never self-daemonizes.
 *
 * This is the SERVICE entry point, so its preflight runs in service mode: a
 * passphrase-protected key aborts startup with an actionable error instead of
 * failing silently on every tick. `backupkit start` is the same loop for a
 * human's own session, where a key CAN be unlocked.
 */

import { describeError } from "../../../shared/errors.js";
import type { CliDeps } from "../context.js";
import { count, parseFlags, schedulePreview } from "../context.js";
import { COMMAND_HELP } from "../help.js";

/** The `backupkit daemon` command entry. */
export async function daemonCommand(argv: string[], deps: CliDeps): Promise<number> {
    const { values } = parseFlags(argv, { config: { type: "string" } }, false);
    if (values.help === true) {
        deps.stdout(COMMAND_HELP.daemon);
        return 0;
    }
    const { config, engine } = deps.loadContext(values.config as string | undefined, { service: true });
    deps.wireSignals(() => engine.stop());
    await engine.preflight({ serviceMode: true });
    // The unit's ExecStart is this command, so these two lines are what the
    // journal (and `backupkit logs`) shows for a clean start and a clean stop -
    // without them a healthy daemon is indistinguishable from one that died
    // silently during preflight.
    const enabled = config.targets.filter((target) => target.enabled).length;
    deps.stdout(`Daemon started - scheduling ${enabled} of ${count(config.targets.length, "configured target")}.`);
    // And what it will actually do, for the same reason: a journal that goes
    // quiet for six hours should say up front that six hours of quiet is the
    // plan. Never fatal - the loop is the point of this command.
    try {
        for (const line of await schedulePreview(engine)) {
            deps.stdout(line);
        }
    } catch (error) {
        deps.stderr(`(could not read the current schedule: ${describeError(error)})`);
    }
    await engine.start();
    deps.stdout("Daemon stopped cleanly.");
    return 0;
}
