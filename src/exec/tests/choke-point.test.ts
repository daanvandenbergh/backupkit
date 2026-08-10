import { readFileSync, readdirSync } from "node:fs";
import { join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/** Absolute path to src/. */
const SRC_DIR = fileURLToPath(new URL("../..", import.meta.url));

/** This guard file itself (its needle table would otherwise self-match). */
const GUARD_FILE = fileURLToPath(import.meta.url);

/** Recursively collect every .ts file under dir. */
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

/** Whether a file lives inside src/exec/. */
function isExecModule(file: string): boolean {
    return file.startsWith(join(SRC_DIR, "exec") + sep);
}

// Needles assembled by concatenation so this file cannot self-match.
const CHILD_PROCESS = "child_" + "process";
const SHELL_TRUE = "shell:" + " true";
const SHELL_TRUE_TIGHT = "shell:" + "true";

/** Import/require statements pulling in child_process (with or without node: prefix). */
const CHILD_PROCESS_IMPORT = new RegExp(`(from\\s+|require\\(\\s*)["'](node:)?${CHILD_PROCESS}["']`);

describe("choke-point guard: exec/ is the only child_process importer", () => {
    it("no file outside exec/ imports child_process", () => {
        const offenders = allFiles(SRC_DIR).filter(
            (file) =>
                file !== GUARD_FILE && !isExecModule(file) && CHILD_PROCESS_IMPORT.test(readFileSync(file, "utf8")),
        );
        expect(offenders).toEqual([]);
    });

    it("exec/ itself imports only spawn from node:child_process", () => {
        const source = readFileSync(join(SRC_DIR, "exec", "exec.ts"), "utf8");
        const importLines = source.split("\n").filter((line) => CHILD_PROCESS_IMPORT.test(line));
        expect(importLines).toEqual([`import { spawn } from "node:${CHILD_PROCESS}";`]);
    });

    it("shell: true appears nowhere in src/", () => {
        const offenders = allFiles(SRC_DIR).filter((file) => {
            if (file === GUARD_FILE) {
                return false;
            }
            const source = readFileSync(file, "utf8");
            return source.includes(SHELL_TRUE) || source.includes(SHELL_TRUE_TIGHT);
        });
        expect(offenders).toEqual([]);
    });

    it("execSync/spawnSync/execFile appear nowhere in src/", () => {
        const banned = ["exec" + "Sync(", "spawn" + "Sync(", "exec" + "File("];
        const offenders = allFiles(SRC_DIR).filter((file) => {
            if (file === GUARD_FILE) {
                return false;
            }
            const source = readFileSync(file, "utf8");
            return banned.some((needle) => source.includes(needle));
        });
        expect(offenders).toEqual([]);
    });
});
