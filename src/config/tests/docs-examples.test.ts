/**
 * Every COMPLETE config example published in the README and the docs corpus
 * has to validate against the current schema.
 *
 * This exists because of exactly one failure mode, and it is not hypothetical:
 * adding a required target field (`mode`) silently invalidated every example
 * on the website at once. Nothing else would have caught it - the examples are
 * prose to every other test, and a reader copying one gets a config error on
 * their first command. The starter config has its own parity test; this is the
 * same guarantee for the examples a reader is actually most likely to copy.
 *
 * Fenced blocks that are FRAGMENTS (a `"targets": {...}` excerpt rather than a
 * whole document) are skipped by construction - only a body starting with `{`
 * is a config. The per-file count assertion below is the vacuity guard: a file
 * whose examples were all renamed or removed fails here rather than passing by
 * checking nothing.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { parseJsonc } from "../internal/jsonc.js";
import { validateConfig } from "../internal/validate.js";

/** Repository root, from this file's location. */
const REPO_ROOT = join(import.meta.dirname, "..", "..", "..");

/** Every ```jsonc fence in a doc whose body is a whole config document. */
function wholeConfigs(path: string): string[] {
    const text = readFileSync(join(REPO_ROOT, path), "utf8");
    const bodies: string[] = [];
    for (const match of text.matchAll(/```jsonc\n([\s\S]*?)```/g)) {
        const body = match[1].trim();
        if (body.startsWith("{")) {
            bodies.push(body);
        }
    }
    return bodies;
}

describe("published config examples", () => {
    it.each([["README.md"], ["docs/content/getting-started/en.mdx"]])("%s validates as shipped", (path) => {
        const configs = wholeConfigs(path);
        expect(configs.length).toBeGreaterThan(0);
        for (const body of configs) {
            expect(() => validateConfig(parseJsonc(body, path), `/etc/backupkit/${path}`)).not.toThrow();
        }
    });
});
