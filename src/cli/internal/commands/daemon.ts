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
    const { engine } = deps.loadContext(values.config as string | undefined);
    deps.wireSignals(() => engine.stop());
    await engine.preflight();
    await engine.start();
    return 0;
}
