/**
 * The `backupkit init` command: write the fully commented starter
 * config.jsonc (from config/internal/starter.ts - never a second copy) at the
 * path the config resolution would find, refusing to overwrite an existing
 * config without --force. stdout is three lines; all explanation lives in the
 * file it wrote.
 */

import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { STARTER_CONFIG } from "../../../config/internal/starter.js";
import type { CliDeps } from "../context.js";
import { parseFlags } from "../context.js";
import { COMMAND_HELP } from "../help.js";

/**
 * Where init writes: --config / $BACKUPKIT_CONFIG verbatim, else the first
 * probe directory for this identity (/etc/backupkit for root, else
 * ${XDG_CONFIG_HOME:-~/.config}/backupkit) + config.jsonc. The HOME fallback
 * matches config.ts's `defaultProbeDirs` exactly (os.homedir(), never a
 * literal "~") so init always writes where loadConfig will later look.
 */
export function initPath(configArg: string | undefined, deps: CliDeps): string {
    const verbatim = configArg ?? deps.env.BACKUPKIT_CONFIG;
    if (verbatim !== undefined && verbatim !== "") {
        return verbatim;
    }
    if (deps.euid === 0) {
        return "/etc/backupkit/config.jsonc";
    }
    const configHome = deps.env.XDG_CONFIG_HOME ?? join(deps.env.HOME ?? homedir(), ".config");
    return join(configHome, "backupkit", "config.jsonc");
}

/** The `backupkit init` command entry. */
export async function initCommand(argv: string[], deps: CliDeps): Promise<number> {
    const { values } = parseFlags(argv, { force: { type: "boolean" }, config: { type: "string" } }, false);
    if (values.help === true) {
        deps.stdout(COMMAND_HELP.init);
        return 0;
    }
    const path = initPath(values.config as string | undefined, deps);
    // Refuse overwriting the target path or its sibling spelling (config.json
    // next to config.jsonc would trip the "keep one" resolution error).
    const sibling = path.endsWith("config.jsonc") ? join(dirname(path), "config.json") : null;
    if (values.force !== true) {
        for (const existing of [path, sibling]) {
            if (existing !== null && deps.files.exists(existing)) {
                deps.stderr(`config exists at ${existing} - pass --force to overwrite`);
                return 1;
            }
        }
    }
    deps.files.mkdir(dirname(path));
    deps.files.write(path, STARTER_CONFIG, 0o644);
    deps.stdout(`wrote ${path}`);
    deps.stdout("edit it, then run: backupkit check");
    deps.stdout("then register the daemon: backupkit service install");
    return 0;
}
