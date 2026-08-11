/**
 * The `backupkit jail` command: manage the `backupkit-remote` forced-command
 * script ON the archive server itself - `install` copies the script this
 * package ships to its well-known path (atomically: temp write + chmod +
 * rename, so a crash can never leave a half-written jail), and `status`
 * reports whether the installed copy matches the shipped one. Both verbs are
 * config-free: an archive server that only RECEIVES pushes has no backupkit
 * config, and neither verb needs one. Installation is deliberately a local
 * root action - the push client must never hold a credential that can rewrite
 * the server's jail (that would let a compromised client replace it), so the
 * update path is `npm update` plus this command, run by the server's admin.
 */

import { dirname, isAbsolute, join } from "node:path";

import type { CliDeps } from "../context.js";
import { parseFlags, UsageError } from "../context.js";
import { COMMAND_HELP } from "../help.js";

/** The valid jail verbs, in help order. */
const VERBS = ["install", "status"] as const;

/** One jail verb. */
type Verb = (typeof VERBS)[number];

/** Where the jail script lives on an archive server - the path every generated forced command names. */
export const JAIL_INSTALL_PATH = "/usr/local/bin/backupkit-remote";

/**
 * The absolute path of the script this package ships, resolved relative to
 * the CLI entry: `<dist|src>/cli/main.js -> <dist|src>/snapshots/internal/
 * backupkit-remote.sh`. The same relative shape holds in the built package
 * and in the source tree, so tests and production resolve identically.
 */
function shippedScriptPath(deps: CliDeps): string {
    return join(dirname(deps.cliPath), "..", "snapshots", "internal", "backupkit-remote.sh");
}

/**
 * Read the shipped script, or null (with the error printed) when this
 * install of the package is missing it - a broken or partial install.
 */
function readShipped(deps: CliDeps): string | null {
    const path = shippedScriptPath(deps);
    if (!deps.files.exists(path)) {
        deps.stderr(`Error: this backupkit installation is missing its jail script (expected at ${path}) - reinstall the package.`);
        return null;
    }
    return deps.files.read(path);
}

/**
 * Install (or update) the jail script at `dest`. Idempotent: an up-to-date
 * copy is left alone apart from re-asserting mode 0755. The write is
 * temp-file + rename so an interrupted install can never leave a truncated
 * script answering push connections.
 */
function install(deps: CliDeps, dest: string): number {
    const shipped = readShipped(deps);
    if (shipped === null) {
        return 1;
    }
    const existing = deps.files.exists(dest) ? deps.files.read(dest) : null;
    if (existing === shipped) {
        // Mode is re-asserted even on a byte-identical copy: a 0644 jail
        // rejects every push with a bare "Permission denied".
        deps.files.chmod(dest, 0o755);
        deps.stdout(`Jail script at ${dest} is already up to date.`);
        return 0;
    }
    deps.files.mkdir(dirname(dest));
    const temp = `${dest}.backupkit-install`;
    deps.files.write(temp, shipped, 0o755);
    // write()'s mode is masked by the process umask; chmod is not.
    deps.files.chmod(temp, 0o755);
    deps.files.rename(temp, dest);
    deps.stdout(existing === null ? `Jail script installed at ${dest}.` : `Jail script at ${dest} updated.`);
    deps.stdout("The authorized_keys lines that use it are printed by `backupkit check` on each push client.");
    return 0;
}

/** Report whether the installed copy at `dest` matches the shipped script. Exit 0 only when it does. */
function status(deps: CliDeps, dest: string): number {
    const shipped = readShipped(deps);
    if (shipped === null) {
        return 1;
    }
    if (!deps.files.exists(dest)) {
        deps.stdout(`Jail script: not installed at ${dest}. Install it with: sudo backupkit jail install`);
        return 1;
    }
    if (deps.files.read(dest) !== shipped) {
        deps.stdout(
            `Jail script: ${dest} differs from the version this package ships (${deps.version}) - an old copy rejects every push. Update it with: sudo backupkit jail install`,
        );
        return 1;
    }
    deps.stdout(`Jail script: ${dest} is up to date (package ${deps.version}).`);
    return 0;
}

/** The `backupkit jail <verb>` command entry. */
export async function jailCommand(argv: string[], deps: CliDeps): Promise<number> {
    const { values, positionals } = parseFlags(argv, { path: { type: "string" } }, true);
    if (values.help === true) {
        deps.stdout(COMMAND_HELP.jail);
        return 0;
    }
    const verb = positionals[0] as Verb | undefined;
    if (verb === undefined || !VERBS.includes(verb) || positionals.length > 1) {
        throw new UsageError(`jail needs one verb: ${VERBS.join(", ")}`);
    }
    const dest = (values.path as string | undefined) ?? JAIL_INSTALL_PATH;
    if (!isAbsolute(dest)) {
        throw new UsageError(`--path must be absolute (got "${dest}")`);
    }
    if (verb === "install" && deps.euid !== 0) {
        deps.stderr(`"backupkit jail install" needs root. Run: sudo backupkit jail install`);
        return 1;
    }
    return verb === "install" ? install(deps, dest) : status(deps, dest);
}
