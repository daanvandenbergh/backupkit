/**
 * The file permission preflight (spec section 4): before any network I/O,
 * fail hard on permissive modes for every file backupkit owns. Rows marked
 * explicit-only are skipped entirely for alias remotes - ssh_config files,
 * the keys they name, and the user's known_hosts are ssh's own enforcement
 * domain (ssh already refuses world-readable keys itself); skipping them is
 * never a reason to skip checking backupkit's own files.
 */

import { mkdir as fsMkdir, stat as fsStat, writeFile } from "node:fs/promises";
import { SshError } from "../shared/errors.js";
import type { ResolvedRemote } from "../shared/types.js";

/** The slice of a stat result the permission matrix consumes. */
export interface FileStatInfo {
    /** Permission bits (mode & 0o7777). */
    mode: number;
    /** Owning uid. */
    uid: number;
    /** File kind: regular file, directory, or anything else. */
    kind: "file" | "directory" | "other";
}

/** Filesystem seam for the permission checks - injectable so tests drive the matrix with fabricated stats. */
export interface PermissionDeps {
    /** Stat a path; null when it does not exist. */
    stat(path: string): Promise<FileStatInfo | null>;
    /** Create a directory (with parents) at the given mode. */
    mkdir(path: string, mode: number): Promise<void>;
    /** Create an empty file at the given mode. */
    createFile(path: string, mode: number): Promise<void>;
    /** Effective uid the ownership rules compare against. */
    euid: number;
}

/** The real-filesystem implementation of the permission seam. */
export function defaultPermissionDeps(): PermissionDeps {
    return {
        stat: async (path) => {
            try {
                const s = await fsStat(path);
                return {
                    mode: s.mode & 0o7777,
                    uid: s.uid,
                    kind: s.isFile() ? "file" : s.isDirectory() ? "directory" : "other",
                };
            } catch {
                return null;
            }
        },
        mkdir: async (path, mode) => {
            await fsMkdir(path, { recursive: true, mode });
        },
        createFile: async (path, mode) => {
            await writeFile(path, "", { mode, flag: "wx" });
        },
        euid: process.geteuid?.() ?? 0,
    };
}

/** Everything the preflight inspects, resolved by the caller from config. */
export interface PermissionPreflightInput {
    /** The loaded config file path. */
    configPath: string;
    /** Run-report root directory (created 0700 if absent). */
    stateDir: string;
    /** Runtime directory holding the agent socket (created 0700 if absent). */
    runtimeDir: string;
    /** Local archive destination roots (remote roots are the jail's business). */
    localDestinationRoots: readonly string[];
    /** Every configured remote; explicit-only rows are skipped for alias remotes. */
    remotes: readonly ResolvedRemote[];
}

/** Render permission bits as a three-digit octal string for messages. */
function octal(mode: number): string {
    return (mode & 0o777).toString(8).padStart(3, "0");
}

/** Whether the owner is acceptable under the "owner euid or root" rule. */
function ownedByEuidOrRoot(info: FileStatInfo, euid: number): boolean {
    return info.uid === euid || info.uid === 0;
}

/**
 * Check a private file (key or passphrase file): must exist as a regular
 * file, carry no group/other bits (mode & 0o077 === 0), and be owned by the
 * effective uid or root.
 */
async function checkPrivateFile(path: string, label: string, deps: PermissionDeps): Promise<void> {
    const info = await deps.stat(path);
    if (info === null) {
        throw new SshError(`${label} ${path} does not exist`);
    }
    if (info.kind !== "file") {
        throw new SshError(`${label} ${path} is not a regular file`);
    }
    if ((info.mode & 0o077) !== 0) {
        throw new SshError(`${label} ${path} is group/other-accessible (mode ${octal(info.mode)}); run: chmod 600 ${path}`);
    }
    if (!ownedByEuidOrRoot(info, deps.euid)) {
        throw new SshError(`${label} ${path} is owned by uid ${info.uid}, not uid ${deps.euid} or root`);
    }
}

/**
 * Check that an existing path is not group/other-writable
 * (mode & 0o022 === 0). Ownership is checked only when `requireOwner` is set.
 */
function checkNotGroupOtherWritable(path: string, label: string, info: FileStatInfo, requireOwner: number | null): void {
    if ((info.mode & 0o022) !== 0) {
        throw new SshError(`${label} ${path} is group/other-writable (mode ${octal(info.mode)}); run: chmod go-w ${path}`);
    }
    if (requireOwner !== null && !(info.uid === requireOwner || info.uid === 0)) {
        throw new SshError(`${label} ${path} is owned by uid ${info.uid}, not uid ${requireOwner} or root`);
    }
}

/**
 * Ensure a backupkit-private directory (runtimeDir/stateDir) exists at 0700
 * owned by the effective uid, creating it 0700 when absent.
 */
async function ensurePrivateDir(path: string, label: string, deps: PermissionDeps): Promise<void> {
    const info = await deps.stat(path);
    if (info === null) {
        await deps.mkdir(path, 0o700);
        return;
    }
    if (info.kind !== "directory") {
        throw new SshError(`${label} ${path} exists but is not a directory`);
    }
    if ((info.mode & 0o077) !== 0) {
        throw new SshError(`${label} ${path} is group/other-accessible (mode ${octal(info.mode)}); run: chmod 700 ${path}`);
    }
    if (info.uid !== deps.euid) {
        throw new SshError(`${label} ${path} is owned by uid ${info.uid}, not uid ${deps.euid}`);
    }
}

/**
 * Run the full permission preflight matrix (spec section 4), failing hard on
 * the first violation. Always checked: the config file (not group/other-
 * writable, owner euid or root), runtimeDir and stateDir (0700, owner euid,
 * created so when absent), and every local destination root (exists, not
 * group/other-writable). Per EXPLICIT remote only: the private key and any
 * `file:` passphrase file (0600-class, owner euid or root), the `.pub`
 * sidecar when present (not group/other-writable), and the dedicated
 * known_hosts file (not group/other-writable; created 0600 when absent).
 * Alias remotes contribute no rows of their own.
 */
export async function checkFilePermissions(
    input: PermissionPreflightInput,
    deps: PermissionDeps = defaultPermissionDeps(),
): Promise<void> {
    const configInfo = await deps.stat(input.configPath);
    if (configInfo === null) {
        throw new SshError(`config file ${input.configPath} does not exist`);
    }
    checkNotGroupOtherWritable(input.configPath, "config file", configInfo, deps.euid);

    await ensurePrivateDir(input.runtimeDir, "runtime dir", deps);
    await ensurePrivateDir(input.stateDir, "state dir", deps);

    for (const root of input.localDestinationRoots) {
        const info = await deps.stat(root);
        if (info === null) {
            throw new SshError(`destination root ${root} does not exist; create it first`);
        }
        if (info.kind !== "directory") {
            throw new SshError(`destination root ${root} is not a directory`);
        }
        checkNotGroupOtherWritable(root, "destination root", info, null);
    }

    const checkedPaths = new Set<string>();
    for (const remote of input.remotes) {
        if (remote.kind !== "explicit") {
            continue;
        }
        if (!checkedPaths.has(remote.identityFile)) {
            checkedPaths.add(remote.identityFile);
            await checkPrivateFile(remote.identityFile, "private key", deps);
            const pubPath = `${remote.identityFile}.pub`;
            const pubInfo = await deps.stat(pubPath);
            if (pubInfo !== null) {
                checkNotGroupOtherWritable(pubPath, "public key", pubInfo, null);
            }
        }
        if (remote.passphrase !== null && remote.passphrase.kind === "file" && !checkedPaths.has(remote.passphrase.value)) {
            checkedPaths.add(remote.passphrase.value);
            await checkPrivateFile(remote.passphrase.value, "passphrase file", deps);
        }
        if (!checkedPaths.has(remote.knownHostsFile)) {
            checkedPaths.add(remote.knownHostsFile);
            const info = await deps.stat(remote.knownHostsFile);
            if (info === null) {
                await deps.createFile(remote.knownHostsFile, 0o600);
            } else {
                if (info.kind !== "file") {
                    throw new SshError(`known_hosts ${remote.knownHostsFile} exists but is not a regular file`);
                }
                checkNotGroupOtherWritable(remote.knownHostsFile, "known_hosts", info, null);
            }
        }
    }
}
