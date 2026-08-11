/**
 * The `backupkit daemon` command - the foreground scheduler loop the service
 * unit's ExecStart runs: preflight, then `start()` until a signal stops it.
 * The process never self-daemonizes.
 */

import type { CliDeps } from "../context.js";
import { parseFlags } from "../context.js";
import { COMMAND_HELP } from "../help.js";

/** The `backupkit daemon` command entry. */
export async function daemonCommand(argv: string[], deps: CliDeps): Promise<number> {
    const { values } = parseFlags(argv, { config: { type: "string" } }, false);
    if (values.help === true) {
        deps.stdout(COMMAND_HELP.daemon);
        return 0;
    }
    const { config, engine } = deps.loadContext(values.config as string | undefined);
    deps.wireSignals(() => engine.stop());
    await engine.preflight();
    // The unit's ExecStart is this command, so these two lines are what the
    // journal (and `backupkit logs`) shows for a clean start and a clean stop -
    // without them a healthy daemon is indistinguishable from one that died
    // silently during preflight.
    const enabled = config.targets.filter((target) => target.enabled).length;
    deps.stdout(`daemon started - scheduling ${enabled} of ${config.targets.length} target(s)`);
    await engine.start();
    deps.stdout("daemon stopped");
    return 0;
}
