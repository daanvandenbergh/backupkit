/**
 * `backupkit init` tests: writes the starter (the exact text from
 * config/internal/starter.ts - never a second copy), refuses overwrite
 * without --force (also for a sibling config.json), resolves the write path
 * per identity/env, and prints exactly three lines. Uses the in-memory file
 * seam - nothing is written outside the fake map.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { STARTER_CONFIG } from "../../config/internal/starter.js";
import { initPath } from "../internal/commands/init.js";
import { main } from "../main.js";
import { fakeDeps } from "./fakes.js";

describe("path resolution", () => {
    it("uses --config, then $BACKUPKIT_CONFIG, then the identity default", () => {
        const root = fakeDeps({ euid: 0, env: { BACKUPKIT_CONFIG: "/env/config.jsonc" } });
        expect(initPath("/cli/config.jsonc", root.deps)).toBe("/cli/config.jsonc");
        expect(initPath(undefined, root.deps)).toBe("/env/config.jsonc");

        const plainRoot = fakeDeps({ euid: 0 });
        expect(initPath(undefined, plainRoot.deps)).toBe("/etc/backupkit/config.jsonc");

        const user = fakeDeps({ euid: 501, env: { HOME: "/home/dev" } });
        expect(initPath(undefined, user.deps)).toBe("/home/dev/.config/backupkit/config.jsonc");

        const xdg = fakeDeps({ euid: 501, env: { XDG_CONFIG_HOME: "/xdg" } });
        expect(initPath(undefined, xdg.deps)).toBe("/xdg/backupkit/config.jsonc");
    });

    it("falls back to os.homedir() (never a literal '~') when HOME is unset", () => {
        const noHome = fakeDeps({ euid: 501, env: {} });
        expect(initPath(undefined, noHome.deps)).toBe(join(homedir(), ".config", "backupkit", "config.jsonc"));
    });
});

describe("writing", () => {
    it("writes the starter verbatim and prints three lines", async () => {
        const h = fakeDeps();
        expect(await main(["init", "--config", "/tmp/bk/config.jsonc"], h.deps)).toBe(0);
        expect(h.fileMap.get("/tmp/bk/config.jsonc")).toBe(STARTER_CONFIG);
        expect(h.out).toEqual([
            "Wrote a starter config to /tmp/bk/config.jsonc",
            "Next, edit it to describe your backups, then check it with: backupkit check",
            "Then register the daemon with: sudo backupkit service install",
        ]);
        expect(h.err).toEqual([]);
    });

    it("refuses to overwrite an existing config without --force", async () => {
        const h = fakeDeps({ files: { "/tmp/bk/config.jsonc": "old" } });
        expect(await main(["init", "--config", "/tmp/bk/config.jsonc"], h.deps)).toBe(1);
        expect(h.err).toEqual(["A config already exists at /tmp/bk/config.jsonc. Pass --force to overwrite it."]);
        expect(h.fileMap.get("/tmp/bk/config.jsonc")).toBe("old");
    });

    it("refuses when a sibling config.json exists (would trip the keep-one rule)", async () => {
        const h = fakeDeps({ files: { "/tmp/bk/config.json": "old" } });
        expect(await main(["init", "--config", "/tmp/bk/config.jsonc"], h.deps)).toBe(1);
        expect(h.err).toEqual(["A config already exists at /tmp/bk/config.json. Pass --force to overwrite it."]);
    });

    it("overwrites with --force", async () => {
        const h = fakeDeps({ files: { "/tmp/bk/config.jsonc": "old" } });
        expect(await main(["init", "--config", "/tmp/bk/config.jsonc", "--force"], h.deps)).toBe(0);
        expect(h.fileMap.get("/tmp/bk/config.jsonc")).toBe(STARTER_CONFIG);
    });
});
