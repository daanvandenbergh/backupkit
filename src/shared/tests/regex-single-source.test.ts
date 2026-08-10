import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/** Absolute path to src/. */
const SRC_DIR = fileURLToPath(new URL("../..", import.meta.url));

/** Absolute path of the one file allowed to define the snapshot-name pattern. */
const CODEC_FILE = join(SRC_DIR, "shared", "snapshot-name.ts");

/** This guard file itself (its needle table would otherwise self-match). */
const GUARD_FILE = fileURLToPath(import.meta.url);

/** Recursively collect every .ts file under dir (tests included - a competing pattern in a test is a competing pattern). */
function allFiles(dir: string): string[] {
    const files: string[] = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
            files.push(...allFiles(full));
        } else if (entry.name.endsWith(".ts")) {
            files.push(full);
        }
    }
    return files;
}

// Needle strings assembled by concatenation so this file's own source cannot
// contain them verbatim (belt and suspenders next to the path exclusion).
const D = "\\" + "d";

/** Source-text fragments that betray a competing snapshot-name/timestamp pattern. */
const NEEDLES: { label: string; needle: string }[] = [
    { label: "an ISO-date regex literal", needle: `${D}{4}-${D}{2}-${D}{2}T` },
    { label: "a compact timestamp regex", needle: `${D}{8}T${D}{6}Z` },
    { label: "an all-digits (epoch) name matcher", needle: `^${D}+$` },
];

describe("regex single source guard: no competing snapshot-name pattern outside snapshot-name.ts", () => {
    it("finds the canonical pattern where it belongs", () => {
        expect(readFileSync(CODEC_FILE, "utf8")).toContain(`${D}{4}`);
    });

    it.each(NEEDLES)("no other file contains $label", ({ needle }) => {
        const offenders: string[] = [];
        for (const file of allFiles(SRC_DIR)) {
            if (file === CODEC_FILE || file === GUARD_FILE) {
                continue;
            }
            if (readFileSync(file, "utf8").includes(needle)) {
                offenders.push(file);
            }
        }
        expect(offenders).toEqual([]);
    });
});
