/**
 * Guard: `describeError` is the ONE renderer that turns a thrown value into
 * user-facing text.
 *
 * `String(someError)` prefixes the class name, so a single one of them put
 * `SshError: ssh archive timed out` into `backupkit status` - a reader is shown
 * an implementation detail of ours where a sentence should be, and it survived
 * into a stored run report, so it kept being displayed long after the run.
 * `describeError` exists precisely to strip that and to append the meaning of
 * an errno; every path that builds text a person will read has to go through
 * it.
 *
 * Mechanical, so it lives here rather than in a document: one grep and a count.
 */

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/** Absolute path to src/. */
const SRC_DIR = fileURLToPath(new URL("../..", import.meta.url));

/** This guard file itself (its needles would otherwise self-match). */
const GUARD_FILE = fileURLToPath(import.meta.url);

/** `shared/errors.ts` owns the one legitimate coercion - it IS `describeError`'s fallback. */
const RENDERER_FILE = join(SRC_DIR, "shared", "errors.ts");

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

// Needle assembled by concatenation so this file cannot self-match.
const COERCE = "String" + "(";

/** `String(x)` where x is named like a thrown value - the class-name leak. */
const ERROR_COERCION = new RegExp(`${COERCE.replace("(", "\\(")}\\s*\\w*(error|Error|err|Err)\\w*\\s*\\)`);

describe("error rendering guard: describeError is the single renderer", () => {
    it("no file coerces a thrown value with String() - describeError does that", () => {
        const offenders = allFiles(SRC_DIR).filter(
            (file) =>
                file !== GUARD_FILE &&
                file !== RENDERER_FILE &&
                !file.includes(`${join("", "tests", "")}`) &&
                ERROR_COERCION.test(readFileSync(file, "utf8")),
        );
        expect(offenders).toEqual([]);
    });

    it("the scan is not vacuous: it reads the real tree, and describeError is genuinely in use", () => {
        // Without these a renamed directory or a broken regex would leave the
        // guard above passing while checking nothing at all.
        const files = allFiles(SRC_DIR);
        expect(files.length).toBeGreaterThan(40);
        const callers = files.filter(
            (file) => file !== GUARD_FILE && readFileSync(file, "utf8").includes("describeError("),
        );
        expect(callers.length).toBeGreaterThan(8);
        // And the needle really does match the shape it is hunting.
        expect(ERROR_COERCION.test("error: String(releaseError),")).toBe(true);
        expect(ERROR_COERCION.test('const name = String(target.name);')).toBe(false);
    });
});
