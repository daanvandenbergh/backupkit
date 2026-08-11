import { describe, expect, it } from "vitest";
import { parseJsonc } from "../internal/jsonc.js";
import { validateConfig } from "../internal/validate.js";
import { resolveConfig, resolveSchedule, type ResolveEnvironment } from "../internal/defaults.js";
import type { ResolvedConfig } from "../types.js";

/** A minimal valid explicit remote object. */
const REMOTE = { host: "10.0.0.11", user: "backup-reader", identityFile: "/etc/backupkit/keys/id" };

/** A minimal valid pull target referencing remote "r1". */
const TARGET = { direction: "pull", remote: "r1", source: "/var/www", destination: "/srv/backups" };

/** Default non-root environment fixture. */
const USER_ENV: ResolveEnvironment = { euid: 501, env: {}, homeDir: "/home/u", platform: "linux" };

/** Validate + resolve a plain object config with a fixed config path. */
function resolve(config: unknown, environment: ResolveEnvironment = USER_ENV): ResolvedConfig {
    const validated = validateConfig(parseJsonc(JSON.stringify(config), "test.jsonc"), "test.jsonc");
    return resolveConfig(validated, "/etc/backupkit/config.jsonc", environment);
}

/** The minimal config with optional patches. */
function minimal(patch?: {
    remote?: Record<string, unknown>;
    target?: Record<string, unknown>;
    top?: Record<string, unknown>;
}): unknown {
    return {
        remotes: { r1: { ...REMOTE, ...patch?.remote } },
        targets: { t1: { ...TARGET, ...patch?.target } },
        ...patch?.top,
    };
}

describe("resolveSchedule", () => {
    it("fills every default for an absent schedule", () => {
        expect(resolveSchedule(undefined)).toEqual({
            interval: "day",
            intervalCount: 1,
            at: "00:00",
            on: "mon",
            dayOfMonth: 1,
        });
    });

    it.each([
        [{ interval: "minute" }, { interval: "minute", intervalCount: 1, at: "00:00", on: "mon", dayOfMonth: 1 }],
        [
            { interval: "week", on: "sun", at: "01:00" },
            { interval: "week", intervalCount: 1, at: "01:00", on: "sun", dayOfMonth: 1 },
        ],
        [
            { interval: "month", intervalCount: 2, dayOfMonth: 15 },
            { interval: "month", intervalCount: 2, at: "00:00", on: "mon", dayOfMonth: 15 },
        ],
        [
            { interval: "hour", intervalCount: 6 },
            { interval: "hour", intervalCount: 6, at: "00:00", on: "mon", dayOfMonth: 1 },
        ],
    ] as const)("resolves %j to the exact normal form", (input, expected) => {
        expect(resolveSchedule(input)).toEqual(expected);
    });
});

describe("resolveConfig defaults", () => {
    it("fills every top-level default", () => {
        const result = resolve(minimal());
        expect(result.name).toBe("backupkit");
        expect(result.retention).toBeNull();
        expect(result.logging).toEqual({ level: "info", file: null });
        expect(result.rsyncBin).toBeNull();
        expect(result.sshBin).toBeNull();
        expect(result.configPath).toBe("/etc/backupkit/config.jsonc");
        expect(result.warnings).toEqual([]);
    });

    it("fills every per-target default", () => {
        const target = resolve(minimal()).targets[0];
        expect(target.name).toBe("t1");
        expect(target.exclude).toEqual([]);
        expect(target.schedule).toEqual({ interval: "day", intervalCount: 1, at: "00:00", on: "mon", dayOfMonth: 1 });
        expect(target.retention).toBeNull();
        expect(target.retry).toEqual({ attempts: 5 });
        expect(target.minFree).toEqual({ kind: "percent", percent: 5 });
        expect(target.rsync).toEqual({
            compress: true,
            bwlimit: null,
            ioTimeoutSec: 600,
            xattrs: false,
            preserveOwnership: true,
            preserveDevices: false,
            remoteRsyncBin: null,
            verify: false,
        });
        expect(target.enabled).toBe(true);
        expect(target.jail).toBe(false);
    });

    it("defaults jail to true for a push target and honors an explicit false", () => {
        expect(resolve(minimal({ target: { direction: "push" } })).targets[0].jail).toBe(true);
        expect(resolve(minimal({ target: { direction: "push", jail: false } })).targets[0].jail).toBe(false);
    });

    it("resolves an explicit remote with port 22 and the configDir known_hosts default", () => {
        const remote = resolve(minimal()).remotes.r1;
        expect(remote).toEqual({
            kind: "explicit",
            restrictedShell: false,
            name: "r1",
            host: "10.0.0.11",
            user: "backup-reader",
            port: 22,
            identityFile: "/etc/backupkit/keys/id",
            passphrase: null,
            knownHostsFile: "/etc/backupkit/known_hosts",
        });
    });

    it("keeps an explicit knownHostsFile override", () => {
        const remote = resolve(minimal({ remote: { knownHostsFile: "/x/kh" } })).remotes.r1;
        expect(remote.kind === "explicit" && remote.knownHostsFile).toBe("/x/kh");
    });

    it('parses passphrase "file:/p" into { kind: "file", value: "/p" }', () => {
        const remote = resolve(minimal({ remote: { passphrase: "file:/etc/backupkit/pass" } })).remotes.r1;
        expect(remote.kind === "explicit" && remote.passphrase).toEqual({
            kind: "file",
            value: "/etc/backupkit/pass",
        });
    });

    it('parses passphrase "prompt" into { kind: "prompt" }', () => {
        const remote = resolve(minimal({ remote: { passphrase: "prompt" } })).remotes.r1;
        expect(remote.kind === "explicit" && remote.passphrase).toEqual({ kind: "prompt", value: "" });
    });

    it("resolves an alias remote to its discriminated shape", () => {
        const result = resolve({
            remotes: { m: { alias: "myserver" } },
            targets: { t1: { ...TARGET, remote: "m" } },
        });
        expect(result.remotes.m).toEqual({ kind: "alias", restrictedShell: false, name: "m", alias: "myserver" });
        expect(result.targets[0].remoteRef).toBe(result.remotes.m);
    });
});

describe("stateDir default", () => {
    it("is /var/lib/backupkit for root on linux", () => {
        expect(resolve(minimal(), { euid: 0, env: {}, homeDir: "/root", platform: "linux" }).stateDir).toBe("/var/lib/backupkit");
    });

    it("is /var/db/backupkit for root on macOS, which has no /var/lib", () => {
        expect(resolve(minimal(), { euid: 0, env: {}, homeDir: "/var/root", platform: "darwin" }).stateDir).toBe(
            "/var/db/backupkit",
        );
    });

    it("honors XDG_STATE_HOME for non-root", () => {
        expect(resolve(minimal(), { euid: 501, env: { XDG_STATE_HOME: "/xdg/state" }, homeDir: "/home/u", platform: "linux" }).stateDir).toBe(
            "/xdg/state/backupkit",
        );
    });

    it("falls back to ~/.local/state for non-root without XDG_STATE_HOME", () => {
        expect(resolve(minimal(), USER_ENV).stateDir).toBe("/home/u/.local/state/backupkit");
    });

    it("a configured stateDir wins over every default", () => {
        expect(resolve(minimal({ top: { stateDir: "/data/state" } }), { euid: 0, env: {}, homeDir: "/root", platform: "linux" }).stateDir).toBe(
            "/data/state",
        );
    });
});

describe("retention resolution", () => {
    it("target false resolves to null even with a top-level default", () => {
        const result = resolve(minimal({ top: { retention: { keepLast: 7 } }, target: { retention: false } }));
        expect(result.targets[0].retention).toBeNull();
        expect(result.retention).toEqual({ keepLast: 7 });
    });

    it("a target retention overrides the top-level wholesale (no merge)", () => {
        const result = resolve(
            minimal({ top: { retention: { keepLast: 7, keepDaily: 14 } }, target: { retention: { keepHourly: 24 } } }),
        );
        expect(result.targets[0].retention).toEqual({ keepHourly: 24 });
    });

    it("a silent target inherits the top-level retention", () => {
        const result = resolve(minimal({ top: { retention: { keepLast: 7 } } }));
        expect(result.targets[0].retention).toEqual({ keepLast: 7 });
    });
});

describe("minFree resolution", () => {
    it("false disables the guard (null)", () => {
        expect(resolve(minimal({ target: { minFree: false } })).targets[0].minFree).toBeNull();
    });

    it("an absolute size resolves to bytes", () => {
        expect(resolve(minimal({ target: { minFree: "10G" } })).targets[0].minFree).toEqual({
            kind: "bytes",
            bytes: 10 * 1024 ** 3,
        });
    });
});

describe("endpoint mapping", () => {
    it("pull: remote source -> local destination", () => {
        const target = resolve(minimal()).targets[0];
        expect(target.src).toEqual({ kind: "remote", remote: target.remoteRef, path: "/var/www" });
        expect(target.dst).toEqual({ kind: "local", path: "/srv/backups" });
    });

    it("push: local source -> remote destination", () => {
        const target = resolve(minimal({ target: { direction: "push" } })).targets[0];
        expect(target.src).toEqual({ kind: "local", path: "/var/www" });
        expect(target.dst).toEqual({ kind: "remote", remote: target.remoteRef, path: "/srv/backups" });
    });

    it("alias remotes flow into endpoints unchanged", () => {
        const result = resolve({
            remotes: { m: { alias: "myserver" } },
            targets: { t1: { ...TARGET, remote: "m" } },
        });
        const src = result.targets[0].src;
        expect(src.kind === "remote" && src.remote.kind).toBe("alias");
    });
});

describe("warnings passthrough", () => {
    it("unreferenced-remote warnings survive resolution", () => {
        const result = resolve({
            remotes: { r1: REMOTE, spare: { alias: "spare" } },
            targets: { t1: TARGET },
        });
        expect(result.warnings).toEqual(['remote "spare" is not referenced by any target']);
    });
});
