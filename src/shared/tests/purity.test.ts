import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/** Absolute path to src/. */
const SRC_DIR = fileURLToPath(new URL("../..", import.meta.url));

/** Recursively collect .ts files under dir, skipping tests/ directories. */
function sourceFiles(dir: string): string[] {
    const files: string[] = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
            if (entry.name !== "tests") {
                files.push(...sourceFiles(full));
            }
        } else if (entry.name.endsWith(".ts")) {
            files.push(full);
        }
    }
    return files;
}

/** Import/require statements pulling in fs or child_process (with or without node: prefix). */
const FORBIDDEN_IMPORT = /(from\s+|require\(\s*)["'](node:)?(fs|fs\/promises|child_process)["']/;

describe("purity guard: shared/ and retention/ are fs-free and child_process-free", () => {
    // ponytail: retention/ does not exist yet (a later phase builds it); the filter keeps this
    // guard binding on it from the day it lands.
    const modules = ["shared", "retention"]
        .map((name) => join(SRC_DIR, name))
        .filter((dir) => existsSync(dir));

    it("covers at least the shared module", () => {
        expect(modules.length).toBeGreaterThanOrEqual(1);
    });

    it("imports no node:fs or node:child_process in any non-test source file", () => {
        const offenders: string[] = [];
        for (const moduleDir of modules) {
            for (const file of sourceFiles(moduleDir)) {
                if (FORBIDDEN_IMPORT.test(readFileSync(file, "utf8"))) {
                    offenders.push(file);
                }
            }
        }
        expect(offenders).toEqual([]);
    });
});
