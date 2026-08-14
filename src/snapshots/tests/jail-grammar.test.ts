/**
 * Guard: the push jail's SHELL re-implementation of the snapshot-name grammar
 * stays in step with the TypeScript that owns it - and never grows a target
 * level back.
 *
 * `backupkit-remote.sh` cannot import anything - it is a POSIX shell script
 * installed on the archive server - so it re-implements the snapshot-name codec
 * (`is_snap`) as globs. The single-source guard in
 * `shared/tests/regex-single-source.test.ts` scans only `.ts`, so that copy is
 * invisible to it, and `jail.fake.test.ts` feeds the script LITERAL names -
 * which keep matching the shell glob no matter what the codec does. So widening
 * the codec in TypeScript would ship a client whose every push operation an
 * already-deployed jail rejects, reporting a bare "backupkit-remote: rejected"
 * and no hint why.
 *
 * The second half is the reverse direction. A jail root is ONE target's archive
 * root, so a target name is no part of any path the client sends; the shell used
 * to re-implement the target-name charset too, and that arm is gone. This file
 * pins it gone: every name the config validator accepts as a target must be
 * REJECTED as a path component, or the pre-2.0 `<root>/<target>/<snap>` layout
 * would quietly still be reachable through a jail that claims to confine one
 * archive.
 *
 * Every case is DERIVED - snapshot names from `formatSnapshotName`, target-name
 * legality from `validateConfig` itself - and run against the shipped script.
 * Nothing is restated here, which would only add another copy to drift.
 * Path-escape, `..`, and symlink cases belong to `jail.fake.test.ts` and are not
 * repeated.
 */

import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { parseJsonc } from "../../config/internal/jsonc.js";
import { validateConfig } from "../../config/internal/validate.js";
import { exec } from "../../exec/exec.js";
import { formatSnapshotName, parseSnapshotName } from "../../shared/snapshot-name.js";

/** The shipped jail script (the build copies it verbatim into dist/). */
const JAIL_SCRIPT = fileURLToPath(new URL("../internal/backupkit-remote.sh", import.meta.url));

/** Target-name candidates spanning the charset boundary in both directions. */
const NAME_CANDIDATES = [
    "web",
    "db2",
    "a",
    "my.host_x",
    "x-y.z",
    "0start",
    "a".repeat(64),
    "Web",
    "-lead",
    ".hidden",
    "has space",
    "a".repeat(65),
];

/** Whether the config validator accepts `name` as a target name. */
function validatorAccepts(name: string): boolean {
    const config = {
        remotes: { r1: { host: "h", user: "backup", identityFile: "/k/id" } },
        targets: { [name]: { mode: "snapshot", direction: "pull", remote: "r1", source: "/s", destination: "/d" } },
    };
    try {
        validateConfig(parseJsonc(JSON.stringify(config), "test.jsonc"), "test.jsonc");
        return true;
    } catch {
        return false;
    }
}

describe("push jail grammar parity (executes the shipped backupkit-remote.sh)", () => {
    let dir: string;
    let root: string;

    beforeEach(async () => {
        dir = await mkdtemp(join(tmpdir(), "backupkit-jail-grammar-"));
        root = join(dir, "jail");
        await mkdir(root, { recursive: true });
    });

    afterEach(async () => {
        await rm(dir, { recursive: true, force: true });
    });

    /**
     * Whether the jail accepts a path operand. A `find` on an existing
     * directory is the cheapest probe that exercises the full path grammar
     * without mutating anything.
     */
    async function jailAccepts(path: string): Promise<boolean> {
        const result = await exec("/bin/sh", [JAIL_SCRIPT, root], {
            env: {
                PATH: "/usr/bin:/bin",
                LC_ALL: "C",
                SSH_ORIGINAL_COMMAND: `'find' '${path}' '-maxdepth' '1' '-mindepth' '1' '-print0'`,
            },
            timeoutMs: 10_000,
        });
        return result.exitCode === 0;
    }

    /** Create a directory under the jail root and return its path. */
    async function make(...components: string[]): Promise<string> {
        const path = join(root, ...components);
        await mkdir(path, { recursive: true });
        return path;
    }

    it("accepts every name the snapshot codec produces, in all three suffix forms", async () => {
        const names = [
            new Date("2026-01-01T00:00:00Z"),
            new Date("2026-08-10T03:15:02Z"),
            new Date("2026-12-31T23:59:59Z"),
            new Date("1999-06-15T12:30:45Z"),
        ].map(formatSnapshotName);
        expect(names).toHaveLength(4); // vacuity guard
        for (const name of names) {
            expect(parseSnapshotName(name)).not.toBeNull();
            for (const leaf of [name, `${name}.partial`, `${name}.deleting`]) {
                expect({ leaf, accepted: await jailAccepts(await make(leaf)) }).toEqual({
                    leaf,
                    accepted: true,
                });
            }
        }
    });

    it("accepts the lock directory and its snapshot-named marker", async () => {
        expect(await jailAccepts(await make(".backupkit.lock"))).toBe(true);
        const marker = formatSnapshotName(new Date("2026-08-10T03:15:02Z"));
        expect(await jailAccepts(await make(".backupkit.lock", marker))).toBe(true);
    });

    it("accepts the archive root itself - the store's mkdir, find and df all name it", async () => {
        expect(await jailAccepts(root)).toBe(true);
    });

    it.each(NAME_CANDIDATES)("rejects the target name %j as a path component", async (name) => {
        // Both verdicts of the validator matter here, and for the same reason:
        // no target name reaches a path at all, so a name it ACCEPTS must be
        // just as unreachable as one it refuses.
        await make(name).catch(() => undefined);
        expect({ name, jail: await jailAccepts(join(root, name)) }).toEqual({ name, jail: false });
    });

    it("the candidate set really spans both validator verdicts", () => {
        const verdicts = NAME_CANDIDATES.map(validatorAccepts);
        expect(verdicts).toContain(true);
        expect(verdicts).toContain(false);
    });
});
