import { describe, expect, it } from "vitest";
import type { ResolvedRemote } from "../../shared/types.js";
import {
    checkFilePermissions,
    type FileStatInfo,
    type PermissionDeps,
    type PermissionPreflightInput,
} from "../permissions.js";

/** One path creation a fake deps recorded. */
interface Created {
    /** Created path. */
    path: string;
    /** Mode it was created with. */
    mode: number;
    /** "dir" for mkdir, "file" for createFile. */
    kind: "dir" | "file";
}

/** Build injectable deps over a fabricated stat table, recording creations. */
function makeDeps(euid: number, entries: Record<string, FileStatInfo>): { deps: PermissionDeps; created: Created[] } {
    const created: Created[] = [];
    return {
        created,
        deps: {
            stat: async (path) => entries[path] ?? null,
            mkdir: async (path, mode) => {
                created.push({ path, mode, kind: "dir" });
            },
            createFile: async (path, mode) => {
                created.push({ path, mode, kind: "file" });
            },
            euid,
        },
    };
}

/** Shorthand stat entries. */
function file(mode: number, uid: number): FileStatInfo {
    return { mode, uid, kind: "file" };
}

/** Shorthand directory stat entry. */
function dir(mode: number, uid: number): FileStatInfo {
    return { mode, uid, kind: "directory" };
}

/** The explicit remote fixture. */
const EXPLICIT: ResolvedRemote = {
    kind: "explicit",
    name: "example",
    host: "10.0.0.11",
    user: "backup",
    port: 22,
    identityFile: "/keys/id_ed25519",
    passphrase: { kind: "file", value: "/keys/id.pass" },
    knownHostsFile: "/cfg/known_hosts",
};

/** The alias remote fixture. */
const ALIAS: ResolvedRemote = { kind: "alias", name: "myserver", alias: "myserver" };

/** A baseline input where every always-row passes for euid 501. */
function baseInput(remotes: ResolvedRemote[]): PermissionPreflightInput {
    return {
        configPath: "/cfg/config.jsonc",
        stateDir: "/state",
        runtimeDir: "/run/backupkit",
        localDestinationRoots: ["/srv/backups"],
        remotes,
    };
}

/** A stat table where every row of the full matrix passes for the given euid. */
function goodEntries(euid: number): Record<string, FileStatInfo> {
    return {
        "/cfg/config.jsonc": file(0o644, euid),
        "/state": dir(0o700, euid),
        "/run/backupkit": dir(0o700, euid),
        "/srv/backups": dir(0o755, euid),
        "/keys/id_ed25519": file(0o600, euid),
        "/keys/id_ed25519.pub": file(0o644, euid),
        "/keys/id.pass": file(0o600, euid),
        "/cfg/known_hosts": file(0o600, euid),
    };
}

describe("checkFilePermissions - passing matrices", () => {
    it.each([
        ["non-root", 501],
        ["root", 0],
    ])("full explicit matrix passes (%s)", async (_label, euid) => {
        const { deps, created } = makeDeps(euid, goodEntries(euid));
        await expect(checkFilePermissions(baseInput([EXPLICIT]), deps)).resolves.toBeUndefined();
        expect(created).toEqual([]);
    });

    it("non-root euid accepts root-owned key, passphrase file, and config", async () => {
        const entries = goodEntries(501);
        entries["/cfg/config.jsonc"] = file(0o600, 0);
        entries["/keys/id_ed25519"] = file(0o600, 0);
        entries["/keys/id.pass"] = file(0o600, 0);
        const { deps } = makeDeps(501, entries);
        await expect(checkFilePermissions(baseInput([EXPLICIT]), deps)).resolves.toBeUndefined();
    });

    it("creates runtimeDir and stateDir 0700 when absent", async () => {
        const entries = goodEntries(501);
        delete entries["/state"];
        delete entries["/run/backupkit"];
        const { deps, created } = makeDeps(501, entries);
        await checkFilePermissions(baseInput([EXPLICIT]), deps);
        expect(created).toEqual([
            { path: "/run/backupkit", mode: 0o700, kind: "dir" },
            { path: "/state", mode: 0o700, kind: "dir" },
        ]);
    });

    it("creates the dedicated known_hosts 0600 when absent", async () => {
        const entries = goodEntries(501);
        delete entries["/cfg/known_hosts"];
        const { deps, created } = makeDeps(501, entries);
        await checkFilePermissions(baseInput([EXPLICIT]), deps);
        expect(created).toEqual([{ path: "/cfg/known_hosts", mode: 0o600, kind: "file" }]);
    });

    it("missing .pub sidecar is fine (checked only when present)", async () => {
        const entries = goodEntries(501);
        delete entries["/keys/id_ed25519.pub"];
        const { deps } = makeDeps(501, entries);
        await expect(checkFilePermissions(baseInput([EXPLICIT]), deps)).resolves.toBeUndefined();
    });
});

describe("checkFilePermissions - failing rows", () => {
    it.each([
        ["config file group-writable", "/cfg/config.jsonc", file(0o664, 501), /group\/other-writable/],
        ["config file foreign-owned", "/cfg/config.jsonc", file(0o644, 777), /owned by uid 777/],
        ["runtime dir group-readable", "/run/backupkit", dir(0o750, 501), /group\/other-accessible/],
        ["runtime dir foreign-owned", "/run/backupkit", dir(0o700, 777), /owned by uid 777/],
        ["state dir other-accessible", "/state", dir(0o701, 501), /group\/other-accessible/],
        ["destination root other-writable", "/srv/backups", dir(0o757, 501), /group\/other-writable/],
        ["destination root a file", "/srv/backups", file(0o644, 501), /not a directory/],
        ["private key group-readable", "/keys/id_ed25519", file(0o640, 501), /group\/other-accessible/],
        ["private key foreign-owned", "/keys/id_ed25519", file(0o600, 777), /owned by uid 777/],
        ["private key a directory", "/keys/id_ed25519", dir(0o700, 501), /not a regular file/],
        ["pub sidecar other-writable", "/keys/id_ed25519.pub", file(0o646, 501), /group\/other-writable/],
        ["passphrase file world-readable", "/keys/id.pass", file(0o604, 501), /group\/other-accessible/],
        ["passphrase file foreign-owned", "/keys/id.pass", file(0o600, 777), /owned by uid 777/],
        ["known_hosts group-writable", "/cfg/known_hosts", file(0o620, 501), /group\/other-writable/],
        ["known_hosts a directory", "/cfg/known_hosts", dir(0o700, 501), /not a regular file/],
    ])("fails hard on %s", async (_label, path, info, message) => {
        const entries = goodEntries(501);
        entries[path] = info;
        const { deps } = makeDeps(501, entries);
        await expect(checkFilePermissions(baseInput([EXPLICIT]), deps)).rejects.toThrowError(message);
    });

    it("root branch: euid 0 rejects a key owned by a non-root uid", async () => {
        const entries = goodEntries(0);
        entries["/keys/id_ed25519"] = file(0o600, 501);
        const { deps } = makeDeps(0, entries);
        await expect(checkFilePermissions(baseInput([EXPLICIT]), deps)).rejects.toThrowError(/owned by uid 501/);
    });

    it.each([
        ["config file", "/cfg/config.jsonc", /config file .* does not exist/],
        ["private key", "/keys/id_ed25519", /private key .* does not exist/],
        ["passphrase file", "/keys/id.pass", /passphrase file .* does not exist/],
        ["destination root", "/srv/backups", /destination root .* does not exist/],
    ])("fails when the %s is missing", async (_label, path, message) => {
        const entries = goodEntries(501);
        delete entries[path];
        const { deps } = makeDeps(501, entries);
        await expect(checkFilePermissions(baseInput([EXPLICIT]), deps)).rejects.toThrowError(message);
    });
});

describe("checkFilePermissions - alias scoping", () => {
    it("alias config skips every explicit-only row but still checks config, dirs, and destinations", async () => {
        // Only backupkit-owned rows exist in the stat table: an alias config
        // must never stat keys, passphrase files, or known_hosts.
        const statted: string[] = [];
        const entries: Record<string, FileStatInfo> = {
            "/cfg/config.jsonc": file(0o644, 501),
            "/state": dir(0o700, 501),
            "/run/backupkit": dir(0o700, 501),
            "/srv/backups": dir(0o755, 501),
        };
        const deps: PermissionDeps = {
            stat: async (path) => {
                statted.push(path);
                return entries[path] ?? null;
            },
            mkdir: async () => {},
            createFile: async () => {},
            euid: 501,
        };
        await expect(checkFilePermissions(baseInput([ALIAS]), deps)).resolves.toBeUndefined();
        expect(statted.sort()).toEqual(["/cfg/config.jsonc", "/run/backupkit", "/srv/backups", "/state"]);
    });

    it("alias mode still fails closed on backupkit's own files", async () => {
        const { deps } = makeDeps(501, {
            "/cfg/config.jsonc": file(0o666, 501),
            "/state": dir(0o700, 501),
            "/run/backupkit": dir(0o700, 501),
            "/srv/backups": dir(0o755, 501),
        });
        await expect(checkFilePermissions(baseInput([ALIAS]), deps)).rejects.toThrowError(/group\/other-writable/);
    });

    it("mixed remotes check explicit rows exactly once per unique path", async () => {
        const statted: string[] = [];
        const entries = goodEntries(501);
        const deps: PermissionDeps = {
            stat: async (path) => {
                statted.push(path);
                return entries[path] ?? null;
            },
            mkdir: async () => {},
            createFile: async () => {},
            euid: 501,
        };
        const twice = baseInput([EXPLICIT, ALIAS, { ...EXPLICIT, name: "again" }]);
        await checkFilePermissions(twice, deps);
        expect(statted.filter((p) => p === "/keys/id_ed25519")).toHaveLength(1);
        expect(statted.filter((p) => p === "/keys/id.pass")).toHaveLength(1);
        expect(statted.filter((p) => p === "/cfg/known_hosts")).toHaveLength(1);
    });
});
