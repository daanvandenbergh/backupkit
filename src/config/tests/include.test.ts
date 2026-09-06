/**
 * The `include` layer: ordering (later wins, the including file last), the
 * object-merges/array-replaces rule, nesting, and every rejection - a missing
 * file, a cycle, a too-deep chain, a non-string entry, an `include` written
 * below the top level.
 *
 * These go through `loadDocument` + `validateConfig` rather than `loadConfig`
 * so a merged tree can be inspected as a whole, with one `loadConfig` case
 * proving the chain is actually wired into the command path.
 */

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConfigError } from "../../shared/errors.js";
import { loadConfig } from "../config.js";
import { loadDocument } from "../internal/include.js";
import { validateConfig } from "../internal/validate.js";

/** The base every fixture layers on: one remote, one pull snapshot target. */
const BASE = {
    remotes: { r1: { host: "10.0.0.11", user: "u", identityFile: "/k/id" } },
    targets: {
        t1: {
            mode: "snapshot",
            direction: "pull",
            remote: "r1",
            source: "/var/www",
            destination: "/srv/backups",
            exclude: ["*.log"],
        },
    },
};

let root: string;

beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "backupkit-include-"));
});

afterEach(() => {
    rmSync(root, { recursive: true, force: true });
});

/** Write `name` (a path relative to the temp root) as JSON and return its absolute path. */
function write(name: string, body: unknown): string {
    const path = join(root, name);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, typeof body === "string" ? body : JSON.stringify(body, null, 2));
    return path;
}

/** Load + validate the document at `name`, home fixed so `~` is deterministic. */
function load(name: string) {
    return validateConfig(loadDocument(join(root, name), "/home/dan"), "/home/dan");
}

describe("include", () => {
    it("merges an included file, with the including file's keys winning", () => {
        write("base.jsonc", BASE);
        write("config.jsonc", {
            include: "base.jsonc",
            targets: { t1: { source: "/var/www-new" } },
        });
        const config = load("config.jsonc");
        expect(config.targets[0].target.source).toBe("/var/www-new");
        // Untouched fields survive the merge.
        expect(config.targets[0].target.destination).toBe("/srv/backups");
        expect(config.remotes[0].name).toBe("r1");
    });

    it("a config with no include is unchanged", () => {
        write("config.jsonc", BASE);
        expect(load("config.jsonc").targets[0].target.source).toBe("/var/www");
    });

    it("merges several files in order - the last listed wins", () => {
        write("a.jsonc", BASE);
        write("b.jsonc", { targets: { t1: { source: "/from-b" } } });
        write("c.jsonc", { targets: { t1: { source: "/from-c" } } });
        write("config.jsonc", { include: ["a.jsonc", "b.jsonc", "c.jsonc"] });
        expect(load("config.jsonc").targets[0].target.source).toBe("/from-c");
    });

    it("adds new remotes and targets rather than replacing the maps", () => {
        write("base.jsonc", BASE);
        write("config.jsonc", {
            include: ["base.jsonc"],
            remotes: { r2: { host: "10.0.0.12", user: "u", identityFile: "/k/id2" } },
            targets: {
                t2: {
                    mode: "mirror",
                    direction: "pull",
                    remote: "r2",
                    source: "/etc",
                    destination: "/srv/etc",
                },
            },
        });
        const config = load("config.jsonc");
        expect(config.remotes.map((entry) => entry.name)).toEqual(["r1", "r2"]);
        // Included entries keep document order, the including file's are appended.
        expect(config.targets.map((entry) => entry.name)).toEqual(["t1", "t2"]);
    });

    it("replaces an array wholesale instead of appending to it", () => {
        write("base.jsonc", BASE);
        write("config.jsonc", { include: "base.jsonc", targets: { t1: { exclude: ["*.tmp"] } } });
        expect(load("config.jsonc").targets[0].target.exclude).toEqual(["*.tmp"]);
    });

    it("resolves a relative include against the including file's directory, not the cwd", () => {
        write("layers/base.jsonc", BASE);
        write("layers/config.jsonc", { include: "base.jsonc" });
        expect(load("layers/config.jsonc").targets[0].target.source).toBe("/var/www");
    });

    it("accepts an absolute include path", () => {
        const base = write("base.jsonc", BASE);
        write("config.jsonc", { include: base });
        expect(load("config.jsonc").targets[0].target.source).toBe("/var/www");
    });

    it("follows a nested include chain, deepest first", () => {
        write("a.jsonc", BASE);
        write("b.jsonc", { include: "a.jsonc", targets: { t1: { source: "/from-b" } } });
        write("config.jsonc", { include: "b.jsonc" });
        expect(load("config.jsonc").targets[0].target.source).toBe("/from-b");
    });

    it("reports a validation error against the file that wrote the offending value", () => {
        write("base.jsonc", { ...BASE, targets: { t1: { ...BASE.targets.t1, source: "relative/path" } } });
        write("config.jsonc", { include: "base.jsonc" });
        expect(() => load("config.jsonc")).toThrow(join(root, "base.jsonc"));
    });

    it("is consumed before validation - never an unknown key", () => {
        write("base.jsonc", BASE);
        write("config.jsonc", { include: "base.jsonc" });
        expect(() => load("config.jsonc")).not.toThrow();
    });

    it("rejects an include below the top level as an unknown key", () => {
        write("base.jsonc", BASE);
        write("config.jsonc", { ...BASE, targets: { t1: { ...BASE.targets.t1, include: "base.jsonc" } } });
        expect(() => load("config.jsonc")).toThrow('unknown key "include"');
    });

    it("fails on a missing included file", () => {
        write("config.jsonc", { include: "nope.jsonc" });
        expect(() => load("config.jsonc")).toThrow(ConfigError);
        expect(() => load("config.jsonc")).toThrow("included file not found");
    });

    it("fails on an include cycle, naming the chain", () => {
        write("a.jsonc", { include: "b.jsonc" });
        write("b.jsonc", { include: "a.jsonc" });
        expect(() => load("a.jsonc")).toThrow("include cycle");
    });

    it("fails on a self-include", () => {
        write("config.jsonc", { include: "config.jsonc" });
        expect(() => load("config.jsonc")).toThrow("include cycle");
    });

    it("fails on a chain deeper than eight levels", () => {
        for (let i = 0; i < 12; i += 1) {
            write(`l${i}.jsonc`, { include: `l${i + 1}.jsonc` });
        }
        write("l12.jsonc", BASE);
        expect(() => load("l0.jsonc")).toThrow("include nesting exceeds 8 levels");
    });

    it("fails on a non-string include entry", () => {
        write("config.jsonc", { include: 7 });
        expect(() => load("config.jsonc")).toThrow("expected a string or an array of strings");
        write("base.jsonc", BASE);
        write("config2.jsonc", { include: ["base.jsonc", 7] });
        expect(() => load("config2.jsonc")).toThrow("expected a string or an array of strings");
    });

    it("fails on an empty include array", () => {
        write("config.jsonc", { include: [] });
        expect(() => load("config.jsonc")).toThrow("expected at least one path");
    });

    it("fails on an empty include path", () => {
        write("config.jsonc", { include: "" });
        expect(() => load("config.jsonc")).toThrow("expected a non-empty path");
    });

    it("fails on a NUL in an include path", () => {
        write("config.jsonc", '{ "include": "ba\\u0000se.jsonc" }');
        expect(() => load("config.jsonc")).toThrow("may not contain NUL or newline characters");
    });

    it("refuses ~user in an include path", () => {
        write("config.jsonc", { include: "~root/base.jsonc" });
        expect(() => load("config.jsonc")).toThrow('"~user" is not supported');
    });

    it("expands a leading ~ against the home directory", () => {
        write("home/base.jsonc", BASE);
        write("config.jsonc", { include: "~/base.jsonc" });
        expect(
            validateConfig(loadDocument(join(root, "config.jsonc"), join(root, "home")), join(root, "home")).targets[0]
                .target.source,
        ).toBe("/var/www");
    });

    it("surfaces a parse error in an included file against that file", () => {
        write("base.jsonc", "{ oops }");
        write("config.jsonc", { include: "base.jsonc" });
        expect(() => load("config.jsonc")).toThrow(join(root, "base.jsonc"));
    });

    it("is wired into loadConfig, so every command sees the merged config", () => {
        write("base.jsonc", BASE);
        const path = write("config.jsonc", { include: "base.jsonc", targets: { t1: { source: "/merged" } } });
        const config = loadConfig(path, { env: { HOME: "/home/dan" }, euid: 1000, homeDir: "/home/dan" });
        expect(config.targets[0].source).toBe("/merged");
    });
});
