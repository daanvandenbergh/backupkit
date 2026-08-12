import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConfigError } from "../../shared/errors.js";
import { loadConfig, resolveConfigPath } from "../config.js";

/** A minimal valid config text. */
const VALID_CONFIG = `{
    "remotes": { "r1": { "host": "10.0.0.11", "user": "u", "identityFile": "/k/id" } },
    "targets": { "t1": { "mode": "snapshot", "direction": "pull", "remote": "r1", "source": "/var/www", "destination": "/srv/backups" } },
}`;

let root: string;
let dirA: string;
let dirB: string;

beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "backupkit-config-"));
    dirA = join(root, "etc");
    dirB = join(root, "xdg");
    mkdirSync(dirA);
    mkdirSync(dirB);
});

afterEach(() => {
    rmSync(root, { recursive: true, force: true });
});

/** Resolve with the tmp probe dirs and a controlled env. */
function resolvePath(cliArg?: string, env: Record<string, string | undefined> = {}): string {
    return resolveConfigPath(cliArg, { env, probeDirs: [dirA, dirB] });
}

describe("resolveConfigPath", () => {
    it("uses --config verbatim when the file exists", () => {
        const file = join(root, "custom.conf");
        writeFileSync(file, VALID_CONFIG);
        expect(resolvePath(file)).toBe(file);
    });

    it("fails on a missing --config path - never a fallthrough", () => {
        writeFileSync(join(dirA, "config.jsonc"), VALID_CONFIG);
        expect(() => resolvePath(join(root, "missing.jsonc"))).toThrow(ConfigError);
        expect(() => resolvePath(join(root, "missing.jsonc"))).toThrow("config file not found");
    });

    it("uses $BACKUPKIT_CONFIG verbatim", () => {
        const file = join(root, "env.jsonc");
        writeFileSync(file, VALID_CONFIG);
        expect(resolvePath(undefined, { BACKUPKIT_CONFIG: file })).toBe(file);
    });

    it("fails on a missing $BACKUPKIT_CONFIG path", () => {
        expect(() => resolvePath(undefined, { BACKUPKIT_CONFIG: join(root, "gone.jsonc") })).toThrow(
            "config file not found",
        );
    });

    it("--config beats $BACKUPKIT_CONFIG", () => {
        const cli = join(root, "cli.jsonc");
        const env = join(root, "env.jsonc");
        writeFileSync(cli, VALID_CONFIG);
        writeFileSync(env, VALID_CONFIG);
        expect(resolvePath(cli, { BACKUPKIT_CONFIG: env })).toBe(cli);
    });

    it("probes config.jsonc first in the first directory", () => {
        writeFileSync(join(dirA, "config.jsonc"), VALID_CONFIG);
        writeFileSync(join(dirB, "config.jsonc"), VALID_CONFIG);
        expect(resolvePath()).toBe(join(dirA, "config.jsonc"));
    });

    it("accepts config.json when config.jsonc is absent", () => {
        writeFileSync(join(dirA, "config.json"), VALID_CONFIG);
        expect(resolvePath()).toBe(join(dirA, "config.json"));
    });

    it("falls through to the second directory", () => {
        writeFileSync(join(dirB, "config.jsonc"), VALID_CONFIG);
        expect(resolvePath()).toBe(join(dirB, "config.jsonc"));
    });

    it("fails when both filenames exist in one directory, naming both", () => {
        writeFileSync(join(dirA, "config.jsonc"), VALID_CONFIG);
        writeFileSync(join(dirA, "config.json"), VALID_CONFIG);
        const error = (() => {
            try {
                resolvePath();
            } catch (e) {
                return e as ConfigError;
            }
            return null;
        })();
        expect(error).toBeInstanceOf(ConfigError);
        expect(error!.message).toContain(join(dirA, "config.jsonc"));
        expect(error!.message).toContain(join(dirA, "config.json"));
        expect(error!.message).toContain("keep one");
    });

    it("the both-present error fires even when a later directory could satisfy the probe", () => {
        writeFileSync(join(dirA, "config.jsonc"), VALID_CONFIG);
        writeFileSync(join(dirA, "config.json"), VALID_CONFIG);
        writeFileSync(join(dirB, "config.jsonc"), VALID_CONFIG);
        expect(() => resolvePath()).toThrow("keep one");
    });

    it("lists every probed path and points at init when nothing is found", () => {
        const error = (() => {
            try {
                resolvePath();
            } catch (e) {
                return e as ConfigError;
            }
            return null;
        })();
        expect(error).toBeInstanceOf(ConfigError);
        for (const path of [
            join(dirA, "config.jsonc"),
            join(dirA, "config.json"),
            join(dirB, "config.jsonc"),
            join(dirB, "config.json"),
        ]) {
            expect(error!.message).toContain(path);
        }
        expect(error!.message).toContain('run "backupkit init" to create one');
    });

    // configPath is a ResolvedConfig member: dirname(configPath) becomes a
    // ReadWritePaths entry and the default known_hosts location, and the value
    // itself becomes the unit's ExecStart --config argument. Returned verbatim,
    // `--config config.jsonc` produced ReadWritePaths="." and a relative
    // ExecStart in a ROOT unit systemd starts with cwd / (a crash loop), and a
    // cwd-dependent host-key store.
    it("absolutizes a relative --config against the cwd", () => {
        const file = join(dirA, "config.jsonc");
        writeFileSync(file, VALID_CONFIG);
        const previous = process.cwd();
        try {
            process.chdir(dirA);
            expect(resolvePath("config.jsonc")).toBe(join(process.cwd(), "config.jsonc"));
            expect(resolvePath("./config.jsonc")).toBe(join(process.cwd(), "config.jsonc"));
        } finally {
            process.chdir(previous);
        }
    });

    it("normalizes '.', '..', and duplicate slashes out of the returned path", () => {
        const file = join(dirA, "config.jsonc");
        writeFileSync(file, VALID_CONFIG);
        expect(resolvePath(`${dirA}/./config.jsonc`)).toBe(file);
        expect(resolvePath(`${dirA}//config.jsonc`)).toBe(file);
        expect(resolvePath(`${dirB}/../etc/config.jsonc`)).toBe(file);
    });

    it("absolutizes $BACKUPKIT_CONFIG the same way", () => {
        const file = join(dirA, "config.jsonc");
        writeFileSync(file, VALID_CONFIG);
        expect(resolvePath(undefined, { BACKUPKIT_CONFIG: `${dirA}//./config.jsonc` })).toBe(file);
    });

    // A newline in configPath reaches systemdQuote, where it would close the
    // ExecStart directive and let the rest become an arbitrary further unit
    // directive. Rejected at the source as well as at the sink.
    it.each([["/etc/backupkit/config.jsonc\nExecStartPre=/bin/sh"], ["/etc/c\rx"], ["/etc/c\0x"]])(
        "rejects a config path containing a NUL or newline: %j",
        (value) => {
            expect(() => resolvePath(value)).toThrow(ConfigError);
            expect(() => resolvePath(value)).toThrow("NUL or newline");
            expect(() => resolvePath(undefined, { BACKUPKIT_CONFIG: value })).toThrow("NUL or newline");
        },
    );

    // ROOT CODE EXECUTION regression. `dirname(configPath)` is where the default
    // `knownHostsFile` is synthesized - DOWNSTREAM of validate.ts, so it never
    // saw the no-whitespace rule every other `-e` token obeys. rsync's `-e` value
    // is a COMMAND STRING it word-splits before exec, so
    // `--config "/tmp/a -o ProxyCommand=/tmp/evil/x/config.jsonc"` produced the
    // token `-o ProxyCommand=/tmp/evil/x/known_hosts`, which ssh then executed
    // through /bin/sh. The benign half is just as fatal: a config on
    // "/Volumes/My Disk" truncated UserKnownHostsFile and failed every remote
    // transfer while `check` still reported the host reachable.
    it.each([
        ["/tmp/a -o ProxyCommand=/tmp/evil/x/config.jsonc"],
        ["/Volumes/My Disk/backupkit/config.jsonc"],
        ["/etc/backupkit/con\tfig.jsonc"],
        ["/etc/backupkit/'config'.jsonc"],
        ['/etc/backupkit/"config".jsonc'],
    ])("rejects a config path containing whitespace or a quote character: %j", (value) => {
        expect(() => resolvePath(value)).toThrow(ConfigError);
        expect(() => resolvePath(value)).toThrow("whitespace or quote characters");
        expect(() => resolvePath(undefined, { BACKUPKIT_CONFIG: value })).toThrow("whitespace or quote characters");
    });
});

describe("loadConfig", () => {
    /** Load with the tmp probe dirs and a fixed non-root environment. */
    function load(cliArg?: string, env: Record<string, string | undefined> = {}) {
        return loadConfig(cliArg, { env, probeDirs: [dirA, dirB], euid: 501, homeDir: "/home/u" });
    }

    it("loads and fully resolves a JSONC config", () => {
        const file = join(dirA, "config.jsonc");
        writeFileSync(file, VALID_CONFIG);
        const config = load();
        expect(config.configPath).toBe(file);
        expect(config.name).toBe("backupkit");
        expect(config.targets).toHaveLength(1);
        expect(config.targets[0].name).toBe("t1");
        expect(config.remotes.r1.kind).toBe("explicit");
        // The default known_hosts lands next to the loaded config file.
        const remote = config.remotes.r1;
        expect(remote.kind === "explicit" && remote.knownHostsFile).toBe(join(dirA, "known_hosts"));
    });

    it("parses a config.json file as JSONC too (comments legal)", () => {
        const file = join(dirA, "config.json");
        writeFileSync(file, "// jsonc in a .json file\n" + VALID_CONFIG);
        expect(load().configPath).toBe(file);
    });

    it("propagates parse errors with the real path and position", () => {
        const file = join(dirA, "config.jsonc");
        writeFileSync(file, '{\n"remotes": {,}\n}');
        expect(() => load()).toThrow(ConfigError);
        expect(() => load()).toThrow(`${file}:2:`);
    });

    it("propagates validation errors with the real path", () => {
        const file = join(dirA, "config.jsonc");
        writeFileSync(file, '{"remotes": {"r1": {"alias": "a", "host": "h"}}, "targets": {}}');
        expect(() => load()).toThrow("alias remotes take no other fields");
    });

    it("fails with a ConfigError when the resolved path is unreadable", () => {
        const dir = join(dirA, "config.jsonc");
        mkdirSync(dir);
        expect(() => load()).toThrow(ConfigError);
        expect(() => load()).toThrow("cannot read config file");
    });

    it("is synchronous", () => {
        writeFileSync(join(dirA, "config.jsonc"), VALID_CONFIG);
        const result = load();
        expect(typeof (result as { then?: unknown }).then).toBe("undefined");
    });
});
