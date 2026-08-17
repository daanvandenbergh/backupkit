/**
 * The `backupkit target [<name>]` and `backupkit remote [<name>]` commands:
 * dump one entry of the loaded config as backupkit actually resolved it - every
 * default filled in - so "what is this target set to?" is answered by the same
 * object the engine runs on, not by re-reading config.jsonc and guessing the
 * defaults. With no name, list every configured entry instead, so the names the
 * dump takes are discoverable from the same command.
 *
 * The field list is walked generically rather than hand-listed: a new config
 * option shows up here the moment it exists on the resolved shape, instead of
 * silently missing from the dump until someone remembers this file.
 */

import type { ResolvedConfig } from "../../../config/types.js";
import { sshDestination } from "../../../ssh/ssh.js";
import type { CliDeps } from "../context.js";
import { alignRows, parseFlags, UsageError } from "../context.js";
import { COMMAND_HELP } from "../help.js";

/**
 * Resolved-target fields NOT dumped as text: `remoteRef`, `src` and `dst` are
 * derived from `remoteName`/`direction`/`source`/`destination` and would print
 * the same remote three times. `--json` keeps them - a machine reader wants the
 * whole object.
 */
const DERIVED = new Set(["remoteRef", "src", "dst"]);

/** Flatten a resolved value to `[dotted.field, value]` rows, in declaration order. */
function fieldRows(value: unknown, prefix: string): string[][] {
    if (value === null || value === undefined) {
        return [[prefix, "(none)"]];
    }
    if (Array.isArray(value)) {
        return [[prefix, value.length === 0 ? "(none)" : value.map((item) => String(item)).join(", ")]];
    }
    if (typeof value === "object") {
        return Object.entries(value).flatMap(([key, nested]) =>
            fieldRows(nested, prefix === "" ? key : `${prefix}.${key}`),
        );
    }
    return [[prefix, String(value)]];
}

/** Print one resolved entry as JSON or as an aligned FIELD/VALUE table. */
function dump(entry: object, json: boolean, skip: Set<string>, deps: CliDeps): number {
    if (json) {
        deps.stdout(JSON.stringify(entry, null, 2));
        return 0;
    }
    const rows = Object.entries(entry)
        .filter(([key]) => !skip.has(key))
        .flatMap(([key, value]) => fieldRows(value, key));
    for (const line of alignRows(["FIELD", "VALUE"], rows)) {
        deps.stdout(line);
    }
    return 0;
}

/**
 * Parse the shared `[<name>] [--json] [--config P]` argv; null means help was
 * printed. A null `name` is the no-name form: list every entry.
 */
function parseOne(argv: string[], page: string, usage: string, deps: CliDeps): { name: string | null; json: boolean; config: string | undefined } | null {
    const { values, positionals } = parseFlags(argv, { json: { type: "boolean" }, config: { type: "string" } }, true);
    if (values.help === true) {
        deps.stdout(page);
        return null;
    }
    if (positionals.length > 1) {
        throw new UsageError(`expected at most one name - usage: ${usage}`);
    }
    return { name: positionals[0] ?? null, json: values.json === true, config: values.config as string | undefined };
}

/** Print a listing as JSON or as an aligned table with a "one entry" hint below it. */
function listing(payload: unknown, header: string[], rows: string[][], hint: string, json: boolean, deps: CliDeps): number {
    if (json) {
        deps.stdout(JSON.stringify(payload, null, 2));
        return 0;
    }
    for (const line of alignRows(header, rows)) {
        deps.stdout(line);
    }
    deps.stdout("");
    deps.stdout(hint);
    return 0;
}

/** The `backupkit target` listing: one row per configured target. */
function listTargets(config: ResolvedConfig, json: boolean, deps: CliDeps): number {
    return listing(
        config.targets,
        ["TARGET", "MODE", "DIRECTION", "REMOTE", "SOURCE", "DESTINATION"],
        config.targets.map((target) => [
            target.name,
            target.mode,
            target.direction,
            target.remoteName,
            target.source,
            target.destination,
        ]),
        "One target: backupkit target <name>",
        json,
        deps,
    );
}

/** The `backupkit remote` listing: one row per configured remote, and who uses it. */
function listRemotes(config: ResolvedConfig, json: boolean, deps: CliDeps): number {
    return listing(
        config.remotes,
        ["REMOTE", "KIND", "ADDRESS", "USED BY"],
        Object.entries(config.remotes).map(([name, remote]) => {
            const users = config.targets.filter((target) => target.remoteName === name);
            return [
                name,
                remote.kind,
                sshDestination(remote),
                users.length === 0 ? "no target" : users.map((target) => target.name).join(", "),
            ];
        }),
        "One remote: backupkit remote <name>",
        json,
        deps,
    );
}

/** The message for a name that is not configured: what was typed, and what is. */
function unknownName(kind: string, name: string, known: string[]): string {
    return `unknown ${kind} "${name}" (configured: ${known.join(", ")})`;
}

/** The `backupkit target` command entry. */
export async function targetCommand(argv: string[], deps: CliDeps): Promise<number> {
    const parsed = parseOne(argv, COMMAND_HELP.target, "backupkit target [<name>]", deps);
    if (parsed === null) {
        return 0;
    }
    const { config } = deps.loadContext(parsed.config);
    if (parsed.name === null) {
        return listTargets(config, parsed.json, deps);
    }
    const target = config.targets.find((candidate) => candidate.name === parsed.name);
    if (target === undefined) {
        throw new UsageError(unknownName("target", parsed.name, config.targets.map((candidate) => candidate.name)));
    }
    const code = dump(target, parsed.json, DERIVED, deps);
    if (!parsed.json) {
        deps.stdout("");
        deps.stdout(`Its remote: backupkit remote ${target.remoteName}`);
    }
    return code;
}

/** The `backupkit remote` command entry. */
export async function remoteCommand(argv: string[], deps: CliDeps): Promise<number> {
    const parsed = parseOne(argv, COMMAND_HELP.remote, "backupkit remote [<name>]", deps);
    if (parsed === null) {
        return 0;
    }
    const { config } = deps.loadContext(parsed.config);
    if (parsed.name === null) {
        return listRemotes(config, parsed.json, deps);
    }
    const remote = Object.hasOwn(config.remotes, parsed.name) ? config.remotes[parsed.name] : undefined;
    if (remote === undefined) {
        throw new UsageError(unknownName("remote", parsed.name, Object.keys(config.remotes)));
    }
    const code = dump(remote, parsed.json, new Set(), deps);
    if (!parsed.json) {
        const users = config.targets.filter((target) => target.remoteName === parsed.name);
        deps.stdout("");
        deps.stdout(`Used by: ${users.length === 0 ? "no target" : users.map((target) => target.name).join(", ")}`);
    }
    return code;
}
