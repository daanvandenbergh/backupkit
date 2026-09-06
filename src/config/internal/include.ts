/**
 * The `include` layer: reads the config file and, when it names other files,
 * splices their documents into one JSONC node tree before validation ever runs
 * - the ssh_config `Include` idea, with JSON's structure instead of ssh's
 * flat first-value-wins keywords.
 *
 * Two rules, and everything else follows from them:
 *
 * 1. **Later wins.** Included files are merged in the order they are listed,
 *    then the INCLUDING file's own keys are merged on top. The file you are
 *    editing therefore always overrides what it pulls in - the reverse of
 *    ssh_config, and the only ordering that makes "a shared base plus my
 *    overrides" the natural spelling.
 * 2. **Objects merge, everything else replaces.** `remotes`, `targets` and a
 *    single target's `rsync`/`schedule`/`retention` merge key by key, so an
 *    override file can change one field of one target. An array (`exclude`,
 *    `extraArgs`) or a scalar replaces wholesale - a merge that appended would
 *    make an inherited exclude impossible to remove.
 *
 * Merging happens on the NODE tree, not on validated config, so every rule the
 * validator enforces - unknown keys, the cross-field matrix, path rules - is
 * enforced against the merged whole exactly once, and every node still carries
 * the file it was parsed from for error reporting.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { ConfigError, describeError } from "../../shared/errors.js";
import { expandHome } from "./home.js";
import { parseJsonc, type JsoncNode, type JsoncObjectNode } from "./jsonc.js";

/**
 * How deep an include chain may nest. An included file may itself include,
 * which is what makes a site-wide base -> per-host layer -> per-target
 * override chain expressible; the cap stops a pathological one long before it
 * exhausts the stack. A cycle is caught separately and exactly.
 */
const MAX_INCLUDE_DEPTH = 8;

/**
 * Merge `override` onto `base` and return the result. Two objects merge key by
 * key (recursing where BOTH sides are objects); anything else means `override`
 * replaces `base` outright. Base-only keys keep their original nodes - and so
 * their original file and line, which is what lets an error in an included
 * file point at that file.
 */
function mergeNodes(base: JsoncNode, override: JsoncNode): JsoncNode {
    if (base.kind !== "object" || override.kind !== "object") {
        return override;
    }
    const merged: JsoncObjectNode = {
        kind: "object",
        line: override.line,
        file: override.file,
        entries: new Map(base.entries),
    };
    for (const [key, node] of override.entries) {
        const existing = merged.entries.get(key);
        merged.entries.set(key, existing === undefined ? node : mergeNodes(existing, node));
    }
    return merged;
}

/**
 * Turn the `include` value into the absolute paths it names. Accepts one
 * string or an array of them; a relative path resolves against the directory
 * of the file that wrote it (as ssh_config resolves against `~/.ssh`), a
 * leading `~` against the running user's home. Every named file must exist -
 * an include that silently does nothing is how a machine ends up backing up
 * with half a config.
 */
function includePaths(node: JsoncNode, from: string, home: string): string[] {
    /** Throw the include-specific ConfigError, shaped like the validator's. */
    const fail = (at: JsoncNode, problem: string): never => {
        throw new ConfigError(`${at.file}:${at.line}: include: ${problem}`, {
            file: at.file,
            line: at.line,
            path: "include",
        });
    };
    const items = node.kind === "array" ? node.items : [node];
    if (items.length === 0) {
        fail(node, "expected at least one path");
    }
    const paths: string[] = [];
    for (const item of items) {
        if (item.kind !== "string") {
            fail(item, "expected a string or an array of strings");
            continue;
        }
        if (/[\0\n\r]/.test(item.value)) {
            fail(item, "path may not contain NUL or newline characters");
        }
        const expanded = expandHome(item.value, home);
        if ("error" in expanded) {
            fail(item, expanded.error);
            continue;
        }
        if (expanded.path === "") {
            fail(item, "expected a non-empty path");
        }
        const path = resolve(dirname(from), expanded.path);
        if (!existsSync(path)) {
            fail(item, `included file not found: ${path}`);
        }
        paths.push(path);
    }
    return paths;
}

/**
 * Read, parse and include-resolve one config file, returning the merged node
 * tree. `stack` is the chain of files already being read, used to name a cycle
 * precisely rather than letting it recurse to the depth cap.
 */
function readDocument(path: string, home: string, stack: string[]): JsoncNode {
    if (stack.includes(path)) {
        throw new ConfigError(`include cycle: ${[...stack, path].join(" -> ")}`, { file: path, path: "include" });
    }
    if (stack.length >= MAX_INCLUDE_DEPTH) {
        throw new ConfigError(
            `include nesting exceeds ${MAX_INCLUDE_DEPTH} levels: ${[...stack, path].join(" -> ")}`,
            { file: path, path: "include" },
        );
    }
    let text: string;
    try {
        text = readFileSync(path, "utf8");
    } catch (error) {
        throw new ConfigError(`cannot read config file ${path}: ${describeError(error)}`, { file: path });
    }
    const root = parseJsonc(text, path);
    if (root.kind !== "object") {
        return root;
    }
    const includeNode = root.entries.get("include");
    if (includeNode === undefined) {
        return root;
    }
    // Consumed here, so the validator never sees it and still rejects an
    // `include` written anywhere but the top level as an unknown key.
    root.entries.delete("include");
    let merged: JsoncNode | undefined;
    for (const included of includePaths(includeNode, path, home)) {
        const document = readDocument(included, home, [...stack, path]);
        merged = merged === undefined ? document : mergeNodes(merged, document);
    }
    return merged === undefined ? root : mergeNodes(merged, root);
}

/**
 * Load the config document at `path`, resolving any `include` chain into one
 * merged node tree. Throws ConfigError for an unreadable file, a parse error,
 * a missing or malformed include path, an include cycle, or a chain deeper
 * than eight levels.
 */
export function loadDocument(path: string, home: string): JsoncNode {
    return readDocument(path, home, []);
}
