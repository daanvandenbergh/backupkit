/**
 * `backupkit target <name>` / `backupkit remote <name>`: the resolved-config
 * dump. Covers the aligned FIELD/VALUE table (nested objects flattened to
 * dotted paths, empty arrays and nulls rendered as "(none)"), the derived
 * fields left out of the table but kept in --json, the cross-reference footers,
 * and the usage errors for a missing, extra, or unknown name.
 */

import { describe, expect, it } from "vitest";

import type { ResolvedConfig } from "../../config/types.js";
import type { ResolvedRemote } from "../../shared/types.js";
import { main } from "../main.js";
import { fakeDeps, makeConfig, makeTarget } from "./fakes.js";

/** An explicit remote fixture (every field backupkit resolves itself). */
const EXPLICIT: ResolvedRemote = {
    kind: "explicit",
    name: "box",
    host: "10.0.0.9",
    user: "backup",
    port: 2222,
    identityFile: "/root/.ssh/backupkit",
    passphrase: null,
    knownHostsFile: "/etc/backupkit/known_hosts",
    restrictedShell: false,
};

/** A config with one snapshot target on the explicit remote, plus an unused alias remote. */
function config(): ResolvedConfig {
    const base = makeConfig({
        configPath: "/etc/backupkit/config.jsonc",
        stateDir: "/var/lib/backupkit",
        targets: [
            makeTarget({
                remoteName: "box",
                remoteRef: EXPLICIT,
                exclude: ["node_modules", ".cache"],
                minFree: { kind: "percent", percent: 5 },
                src: { kind: "remote", remote: EXPLICIT, path: "/data/src" },
            }),
        ],
    });
    return {
        ...base,
        remotes: { box: EXPLICIT, spare: { kind: "alias", name: "spare", alias: "spare", restrictedShell: true } },
    };
}

describe("backupkit target <name>", () => {
    it("prints every resolved field, flattening nested objects onto dotted paths", async () => {
        const h = fakeDeps({ config: config() });
        expect(await main(["target", "web"], h.deps)).toBe(0);
        const text = h.out.join("\n");
        expect(h.out[0]).toMatch(/^FIELD {2,}VALUE$/);
        expect(text).toMatch(/^name {2,}web$/m);
        expect(text).toMatch(/^mode {2,}snapshot$/m);
        expect(text).toMatch(/^schedule\.interval {2,}day$/m);
        expect(text).toMatch(/^rsync\.ioTimeoutSec {2,}600$/m);
        expect(text).toMatch(/^minFree\.percent {2,}5$/m);
        // A list joins on one line; a null is a word, never the string "null".
        expect(text).toMatch(/^exclude {2,}node_modules, \.cache$/m);
        expect(text).toMatch(/^retention {2,}\(none\)$/m);
        // The derived fields are the remote three times over - not in the table.
        expect(text).not.toContain("remoteRef.");
        expect(text).not.toContain("src.");
        expect(h.out.at(-1)).toBe("Its remote: backupkit remote box");
    });

    it("renders an empty list as (none) rather than an empty column", async () => {
        const h = fakeDeps();
        expect(await main(["target", "web"], h.deps)).toBe(0);
        expect(h.out.join("\n")).toMatch(/^exclude {2,}\(none\)$/m);
    });

    it("--json prints the whole resolved target, derived endpoints included", async () => {
        const h = fakeDeps({ config: config() });
        expect(await main(["target", "web", "--json"], h.deps)).toBe(0);
        const parsed = JSON.parse(h.out.join("\n")) as Record<string, unknown>;
        expect(parsed.name).toBe("web");
        expect(parsed.remoteRef).toEqual(EXPLICIT);
        expect(parsed.src).toEqual({ kind: "remote", remote: EXPLICIT, path: "/data/src" });
        // JSON output is one document and nothing else - no footer to trip a parser.
        expect(h.out).toHaveLength(1);
    });

    it("honors --config", async () => {
        const h = fakeDeps({ config: config() });
        expect(await main(["target", "web", "--config", "/tmp/other.jsonc"], h.deps)).toBe(0);
        expect(h.loadedWith).toEqual(["/tmp/other.jsonc"]);
    });

    it("rejects an unknown target with exit 64 listing the configured names", async () => {
        const h = fakeDeps({ config: config() });
        expect(await main(["target", "nope"], h.deps)).toBe(64);
        expect(h.out).toEqual([]);
        expect(h.err[0]).toBe('Error: unknown target "nope" (configured: web)');
    });

    it.each([[[]], [["web", "db"]]])("rejects %j with a usage error naming the usage", async (names) => {
        const h = fakeDeps({ config: config() });
        expect(await main(["target", ...names], h.deps)).toBe(64);
        expect(h.err[0]).toBe("Error: expected exactly one name - usage: backupkit target <name>");
    });
});

describe("backupkit remote <name>", () => {
    it("prints an explicit remote's resolved fields and the targets using it", async () => {
        const h = fakeDeps({ config: config() });
        expect(await main(["remote", "box"], h.deps)).toBe(0);
        const text = h.out.join("\n");
        expect(text).toMatch(/^kind {2,}explicit$/m);
        expect(text).toMatch(/^host {2,}10\.0\.0\.9$/m);
        expect(text).toMatch(/^port {2,}2222$/m);
        expect(text).toMatch(/^passphrase {2,}\(none\)$/m);
        expect(h.out.at(-1)).toBe("Used by: web");
    });

    it("says so when no target uses the remote", async () => {
        const h = fakeDeps({ config: config() });
        expect(await main(["remote", "spare"], h.deps)).toBe(0);
        expect(h.out.join("\n")).toMatch(/^alias {2,}spare$/m);
        expect(h.out.at(-1)).toBe("Used by: no target");
    });

    it("--json prints the resolved remote and nothing else", async () => {
        const h = fakeDeps({ config: config() });
        expect(await main(["remote", "box", "--json"], h.deps)).toBe(0);
        expect(JSON.parse(h.out.join("\n"))).toEqual(EXPLICIT);
        expect(h.out).toHaveLength(1);
    });

    it("rejects an unknown remote with exit 64 listing the configured names", async () => {
        const h = fakeDeps({ config: config() });
        expect(await main(["remote", "nope"], h.deps)).toBe(64);
        expect(h.err[0]).toBe('Error: unknown remote "nope" (configured: box, spare)');
    });

    // `remotes` is a plain object literal, so a `!== undefined` lookup guard
    // would hand back Object.prototype.toString and dump a function.
    it.each([["toString"], ["constructor"]])("treats the inherited member %s as unknown", async (name) => {
        const h = fakeDeps({ config: config() });
        expect(await main(["remote", name], h.deps)).toBe(64);
        expect(h.out).toEqual([]);
    });
});
