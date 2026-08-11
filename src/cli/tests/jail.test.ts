/**
 * `backupkit jail` behavior against the fake filesystem: install (root gate,
 * fresh install, update, idempotent no-op with mode re-assert, atomic
 * temp+rename, missing shipped script, --path override and validation) and
 * status (up to date / outdated / not installed exit codes). Config-free by
 * design: no test here ever calls loadContext.
 */

import { describe, expect, it } from "vitest";

import { main } from "../main.js";
import { fakeDeps } from "./fakes.js";

/** The shipped script path implied by the fake deps' cliPath (/opt/backupkit/dist/cli/main.js). */
const SHIPPED = "/opt/backupkit/dist/snapshots/internal/backupkit-remote.sh";

/** The default install destination. */
const DEST = "/usr/local/bin/backupkit-remote";

/** Fake deps with the shipped script present (and optional extra files). */
function jailDeps(options: Parameters<typeof fakeDeps>[0] = {}) {
    return fakeDeps({ ...options, files: { [SHIPPED]: "#!/bin/sh\nv2\n", ...options.files } });
}

describe("jail install", () => {
    it("requires root", async () => {
        const h = jailDeps({ euid: 501 });
        expect(await main(["jail", "install"], h.deps)).toBe(1);
        expect(h.err[0]).toContain("needs root");
        expect(h.fileMap.has(DEST)).toBe(false);
    });

    it("installs fresh: temp write, chmod 755, atomic rename, guidance line", async () => {
        const h = jailDeps();
        expect(await main(["jail", "install"], h.deps)).toBe(0);
        expect(h.fileMap.get(DEST)).toBe("#!/bin/sh\nv2\n");
        expect(h.fileMap.has(`${DEST}.backupkit-install`)).toBe(false);
        expect(h.renames).toEqual([{ from: `${DEST}.backupkit-install`, to: DEST }]);
        expect(h.chmods).toEqual([{ path: `${DEST}.backupkit-install`, mode: 0o755 }]);
        expect(h.out[0]).toBe(`Jail script installed at ${DEST}.`);
        expect(h.out[1]).toContain("backupkit check");
    });

    it("updates an outdated copy and says so", async () => {
        const h = jailDeps({ files: { [DEST]: "#!/bin/sh\nv1\n" } });
        expect(await main(["jail", "install"], h.deps)).toBe(0);
        expect(h.fileMap.get(DEST)).toBe("#!/bin/sh\nv2\n");
        expect(h.out[0]).toBe(`Jail script at ${DEST} updated.`);
    });

    it("is a no-op on an up-to-date copy, apart from re-asserting the mode", async () => {
        const h = jailDeps({ files: { [DEST]: "#!/bin/sh\nv2\n" } });
        expect(await main(["jail", "install"], h.deps)).toBe(0);
        expect(h.renames).toEqual([]);
        expect(h.chmods).toEqual([{ path: DEST, mode: 0o755 }]);
        expect(h.out[0]).toBe(`Jail script at ${DEST} is already up to date.`);
    });

    it("fails with a reinstall hint when the package's own script is missing", async () => {
        const h = fakeDeps();
        expect(await main(["jail", "install"], h.deps)).toBe(1);
        expect(h.err[0]).toContain("missing its jail script");
        expect(h.err[0]).toContain(SHIPPED);
    });

    it("honors --path and creates its directory", async () => {
        const h = jailDeps();
        expect(await main(["jail", "install", "--path", "/opt/bin/backupkit-remote"], h.deps)).toBe(0);
        expect(h.fileMap.get("/opt/bin/backupkit-remote")).toBe("#!/bin/sh\nv2\n");
        expect(h.mkdirs).toEqual([{ path: "/opt/bin", mode: undefined }]);
    });

    it("rejects a relative --path", async () => {
        const h = jailDeps();
        expect(await main(["jail", "install", "--path", "bin/backupkit-remote"], h.deps)).toBe(64);
        expect(h.err[0]).toContain("--path must be absolute");
    });
});

describe("jail status", () => {
    it("reports up to date with exit 0, without root", async () => {
        const h = jailDeps({ euid: 501, files: { [DEST]: "#!/bin/sh\nv2\n" } });
        expect(await main(["jail", "status"], h.deps)).toBe(0);
        expect(h.out[0]).toContain("up to date");
        expect(h.out[0]).toContain("0.1.0-test");
    });

    it("reports not installed with exit 1 and the install command", async () => {
        const h = jailDeps();
        expect(await main(["jail", "status"], h.deps)).toBe(1);
        expect(h.out[0]).toContain("not installed");
        expect(h.out[0]).toContain("sudo backupkit jail install");
    });

    it("reports an outdated copy with exit 1 and the update command", async () => {
        const h = jailDeps({ files: { [DEST]: "#!/bin/sh\nv1\n" } });
        expect(await main(["jail", "status"], h.deps)).toBe(1);
        expect(h.out[0]).toContain("differs");
        expect(h.out[0]).toContain("sudo backupkit jail install");
    });

    it("fails when the package's own script is missing", async () => {
        const h = fakeDeps();
        expect(await main(["jail", "status"], h.deps)).toBe(1);
        expect(h.err[0]).toContain("missing its jail script");
    });

    // Every "run this to fix it" line under --path has to CARRY the --path, or
    // it names a command that writes to a different file than the one just
    // reported on - follow it and the reported path stays exactly as broken.
    it.each([
        ["not installed", {}],
        ["outdated", { "/opt/bk/backupkit-remote": "#!/bin/sh\nv1\n" }],
    ])("carries --path into the fix command it prints (%s)", async (_case, files) => {
        const h = jailDeps({ files });
        expect(await main(["jail", "status", "--path", "/opt/bk/backupkit-remote"], h.deps)).toBe(1);
        expect(h.out[0]).toContain("sudo backupkit jail install --path /opt/bk/backupkit-remote");
    });

    it("carries --path into the needs-root refusal too", async () => {
        const h = jailDeps({ euid: 501 });
        expect(await main(["jail", "install", "--path", "/opt/bk/backupkit-remote"], h.deps)).toBe(1);
        expect(h.err[0]).toContain("sudo backupkit jail install --path /opt/bk/backupkit-remote");
    });
});

describe("jail drift warning (every command)", () => {
    it("warns on stderr when an installed copy differs from the shipped script", async () => {
        const h = jailDeps({ files: { [DEST]: "#!/bin/sh\nv1\n" } });
        expect(await main(["list"], h.deps)).toBe(0);
        expect(h.err[0]).toContain(`jail script at ${DEST} does not match`);
        expect(h.err[0]).toContain("sudo backupkit jail install");
    });

    it("warns even on --version, and only on stderr", async () => {
        const h = jailDeps({ files: { [DEST]: "#!/bin/sh\nv1\n" } });
        expect(await main(["--version"], h.deps)).toBe(0);
        expect(h.out).toEqual(["0.1.0-test"]);
        expect(h.err[0]).toContain("does not match");
    });

    it("stays silent when no script is installed", async () => {
        const h = jailDeps();
        expect(await main(["list"], h.deps)).toBe(0);
        expect(h.err).toEqual([]);
    });

    it("stays silent when the installed copy is up to date", async () => {
        const h = jailDeps({ files: { [DEST]: "#!/bin/sh\nv2\n" } });
        expect(await main(["list"], h.deps)).toBe(0);
        expect(h.err).toEqual([]);
    });

    it("stays silent when the package's own script is missing (nothing to compare)", async () => {
        const h = fakeDeps({ files: { [DEST]: "#!/bin/sh\nv1\n" } });
        expect(await main(["list"], h.deps)).toBe(0);
        expect(h.err).toEqual([]);
    });

    it("is skipped for the jail command itself", async () => {
        const h = jailDeps({ files: { [DEST]: "#!/bin/sh\nv1\n" } });
        expect(await main(["jail", "status"], h.deps)).toBe(1);
        expect(h.err).toEqual([]);
        expect(h.out[0]).toContain("differs");
    });
});

describe("jail usage", () => {
    it("rejects a missing or unknown verb and extra positionals", async () => {
        for (const argv of [["jail"], ["jail", "wipe"], ["jail", "install", "status"]]) {
            const h = jailDeps();
            expect(await main(argv, h.deps)).toBe(64);
            expect(h.err[0]).toContain("jail needs one verb");
        }
    });

    it.each([["--help"], ["-h"]])("prints help with %s", async (flag) => {
        const h = jailDeps();
        expect(await main(["jail", flag], h.deps)).toBe(0);
        const text = h.out.join("\n");
        expect(text).toContain("Usage: backupkit jail [options] <verb>");
        // Both verbs listed as commands - the page is what tells an operator
        // that `status` exists at all.
        expect(text).toContain("Commands:");
        expect(text).toMatch(/^ {2}install {2}/m);
        expect(text).toMatch(/^ {2}status {2}/m);
    });
});
