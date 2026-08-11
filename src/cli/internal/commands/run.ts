/**
 * The `backupkit run` command: one pass over due targets (or the named
 * subset), with --force and --dry-run per spec sections 6 and 7. Exit 1 when
 * any target failed. SIGINT/SIGTERM stop the engine gracefully; a second
 * signal exits 1 immediately.
 */

import type { RunStatus } from "../../../engine/types.js";
import type { CliDeps } from "../context.js";
import { count, parseFlags, selectTargets } from "../context.js";
import { COMMAND_HELP } from "../help.js";

/**
 * The word each run outcome gets on stdout. A `Record<RunStatus, string>`, not
 * a lookup with a fallback: adding a RunStatus to the engine's union then
 * breaks `npm run typecheck` here, rather than silently printing `undefined`
 * next to a target name.
 */
const VERDICT: Record<RunStatus, string> = {
    success: "OK     ",
    warning: "WARNING",
    failed: "FAILED ",
    skipped: "skipped",
    aborted: "ABORTED",
};

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
        deps.stdout("Nothing to do - no target is due yet. Run them all anyway with: backupkit run --force");
        return 0;
    }
    let failed = 0;
    for (const target of report.targets) {
        const detail = [
            target.snapshot === null ? null : `snapshot ${target.snapshot}`,
            target.reason === null ? null : target.reason,
            target.error === null ? null : target.error,
        ]
            .filter((part) => part !== null)
            .join("; ");
        deps.stdout(`${VERDICT[target.status]} ${target.target}${detail === "" ? "" : ` - ${detail}`}`);
        if (target.status === "failed") {
            failed += 1;
        }
    }
    // Always a closing line: with several targets the per-target rows scroll,
    // and "did the whole pass succeed?" is the one question the exit code
    // answers but a terminal full of rows does not.
    const total = report.targets.length;
    deps.stdout(
        failed === 0
            ? `Done - ${count(total, "target")} processed, none failed.`
            : `Done - ${failed} of ${count(total, "target")} FAILED. See the lines above, or run: backupkit logs`,
    );
    return failed === 0 ? 0 : 1;
}
