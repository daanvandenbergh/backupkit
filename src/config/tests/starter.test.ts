import { describe, expect, it } from "vitest";
import { parseJsonc } from "../internal/jsonc.js";
import { validateConfig } from "../internal/validate.js";
import { resolveConfig } from "../internal/defaults.js";
import { STARTER_CONFIG } from "../internal/starter.js";

/** Validate the given starter text and resolve it like loadConfig would. */
function resolveStarter(text: string) {
    const validated = validateConfig(parseJsonc(text, "config.jsonc"), "config.jsonc");
    return resolveConfig(validated, "/etc/backupkit/config.jsonc", { euid: 0, env: {}, homeDir: "/root" });
}

describe("the starter config", () => {
    it("parses and validates - the shipped example can never drift from the schema", () => {
        expect(() => resolveStarter(STARTER_CONFIG)).not.toThrow();
    });

    it("resolves to the documented example values", () => {
        const config = resolveStarter(STARTER_CONFIG);
        expect(config.name).toBe("backupkit");
        expect(Object.keys(config.remotes)).toEqual(["example"]);
        const remote = config.remotes.example;
        expect(remote.kind).toBe("explicit");
        if (remote.kind === "explicit") {
            expect(remote.host).toBe("10.0.0.11");
            expect(remote.user).toBe("backup-reader");
            expect(remote.port).toBe(22);
            expect(remote.identityFile).toBe("/etc/backupkit/keys/example_ed25519");
            expect(remote.passphrase).toBeNull();
        }
        expect(config.targets).toHaveLength(1);
        const target = config.targets[0];
        expect(target.name).toBe("example-var-www");
        expect(target.direction).toBe("pull");
        expect(target.source).toBe("/var/www");
        expect(target.destination).toBe("/srv/backups");
        expect(target.exclude).toEqual(["cache/", "*.tmp"]);
        expect(target.schedule).toEqual({ interval: "day", intervalCount: 1, at: "03:00", on: "mon", dayOfMonth: 1 });
        expect(target.retention).toEqual({ keepLast: 7, keepDaily: 14, keepWeekly: 8, keepMonthly: 12 });
        expect(config.logging).toEqual({ level: "info", file: null });
        expect(config.warnings).toEqual([]);
    });

    it("validates with the commented alias remote example uncommented", () => {
        const uncommented = STARTER_CONFIG.replace('// "myserver": { "alias": "myserver" },', '"myserver": { "alias": "myserver" },');
        expect(uncommented).not.toBe(STARTER_CONFIG);
        const config = resolveStarter(uncommented);
        expect(config.remotes.myserver).toEqual({ kind: "alias", name: "myserver", alias: "myserver" });
        // Unreferenced by the example target - a warning, never an error.
        expect(config.warnings).toEqual(['remote "myserver" is not referenced by any target']);
    });

    it("validates with the commented passphrase example uncommented", () => {
        const uncommented = STARTER_CONFIG.replace(
            '// "passphrase": "file:/etc/backupkit/keys/example.pass",',
            '"passphrase": "file:/etc/backupkit/keys/example.pass",',
        );
        expect(uncommented).not.toBe(STARTER_CONFIG);
        const config = resolveStarter(uncommented);
        const remote = config.remotes.example;
        expect(remote.kind === "explicit" && remote.passphrase).toEqual({
            kind: "file",
            value: "/etc/backupkit/keys/example.pass",
        });
    });

    it("mentions the three JSONC tolerances and ends with a newline", () => {
        expect(STARTER_CONFIG).toContain("Comments (// and /* */) and trailing commas are allowed");
        expect(STARTER_CONFIG.endsWith("\n")).toBe(true);
    });
});
