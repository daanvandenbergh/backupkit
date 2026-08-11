/**
 * The file permission preflight (spec section 4): before any network I/O,
 * fail hard on permissive modes for every file backupkit owns. Rows marked
 * explicit-only are skipped entirely for alias remotes - ssh_config files,
 * the keys they name, and the user's known_hosts are ssh's own enforcement
 * domain (ssh already refuses world-readable keys itself); skipping them is
 * never a reason to skip checking backupkit's own files.
 *
 * MODE checks (no group/other access) ALWAYS run - they are the confidentiality
 * boundary. OWNERSHIP checks are skipped when the process runs as root (euid 0):
 * root can read/write/chown anything, so requiring files be chown'd to root buys
 * nothing and only forces operators to copy keys around. A root daemon therefore
 * uses the operator's own user-owned keys, config, and stateDir as-is. See
 * `ownershipOk` and security invariant 8; this exception is locked by tests.
 */

import { mkdir as fsMkdir, stat as fsStat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
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
    /** Resolved `logging.file` path, or null when file logging is off. Checked with its directory. */
    loggingFile: string | null;
}

/** Render permission bits as a three-digit octal string for messages. */
function octal(mode: number): string {
    return (mode & 0o777).toString(8).padStart(3, "0");
}

/**
 * Whether the file's OWNER is acceptable. Ownership is a confidentiality
 * boundary only for a NON-root process: a daemon running as uid N that trusts a
 * file owned by a DIFFERENT unprivileged uid is a confused deputy - that other
 * user can rewrite the key / passphrase / known_hosts out from under it. There
 * the check stays strict (owner is euid, or root who provisioned it).
 *
 * When the process runs as ROOT (euid 0) that reasoning collapses: root can
 * already read, write, and chown EVERY file on the system regardless of who
 * owns it, so demanding the file already be chown'd to root adds no security at
 * all - it is pure friction that forced operators to copy keys into a root-owned
 * tree (e.g. /etc/backupkit/keys) for zero gain. So when euid is 0 we accept any
 * owner here; the MODE check (no group/other access), which always runs, is what
 * actually keeps other unprivileged users out of the secret.
 *
 * DO NOT re-add a "root must own it" rule. It is friction, not protection, and
 * it is deliberately locked by tests (permissions.test: "root (euid 0) accepts a
 * foreign-owned ..."), so a revert turns them red. See security invariant 8,
 * which records this exception explicitly.
 */
function ownershipOk(info: FileStatInfo, euid: number): boolean {
    return euid === 0 || info.uid === euid || info.uid === 0;
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
    if (!ownershipOk(info, deps.euid)) {
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
    if (requireOwner !== null && !ownershipOk(info, requireOwner)) {
        throw new SshError(`${label} ${path} is owned by uid ${info.uid}, not uid ${requireOwner} or root`);
    }
}

/**
 * Check that the directory CONTAINING `path` exists, is a directory, and is
 * not group/other-writable. A file's own mode says nothing about who may
 * UNLINK it: a writable parent lets any local user swap backupkit's config,
 * key, known_hosts, or `.pub` sidecar for one of their own, mode 0600 and all.
 * `label` names the checked file, so the message reads "the directory holding
 * the <label>, <parent>, is group/other-writable ..." - it has to say WHOSE
 * parent it is talking about, because the path in the message is never the path
 * the caller passed in. Spelled "<label> directory <parent>" it produced
 * "runtime dir directory /home/u/.backupkit does not exist", which reads as a
 * typo and names a path the user never configured.
 *
 * OWNERSHIP is part of that, not an extra: a directory's owner holds full
 * write+unlink rights over every child name whatever the mode says, so
 * `/opt/bk` owned by uid 1000 at mode 0700 grants that uid exactly the swap
 * this function exists to deny - and it used to pass, because `requireOwner`
 * was null on every directory row while `checkPrivateFile`/`checkLoggingFile`
 * already required euid-or-root on the files inside them.
 */
async function checkParentDir(path: string, label: string, deps: PermissionDeps): Promise<void> {
    const parent = dirname(path);
    const info = await deps.stat(parent);
    if (info === null) {
        throw new SshError(`the directory holding the ${label} does not exist: ${parent}`);
    }
    if (info.kind !== "directory") {
        throw new SshError(`the directory holding the ${label} is not a directory: ${parent}`);
    }
    checkNotGroupOtherWritable(parent, `the directory holding the ${label},`, info, deps.euid);
}

/**
 * Check the `logging.file` path the daemon appends to (as root, following
 * symlinks, with the process umask): its directory must exist and not be
 * group/other-writable, and when the file already exists it must be a regular
 * file, not group/other-writable, owned by the effective uid or root, and no
 * more accessible than mode 0640. The file is never created here - logging owns
 * that.
 *
 * The 0640 floor (`mode & 0o037`), not the 0600 of `checkPrivateFile`: the
 * sink CREATES this file 0600, but macOS rotation recreates it as
 * `root:wheel 640` (`NEWSYSLOG_CONF`), so a 0600 floor would fail every
 * preflight after the first rotation. Anything looser is not acceptable either -
 * accepting a pre-existing 0644 log and appending to it forever published every
 * target name, remote name, jail root and private-key path in it to every local
 * user, while backupkit's own creation mode said the opposite.
 */
async function checkLoggingFile(path: string, deps: PermissionDeps): Promise<void> {
    await checkParentDir(path, "log file", deps);
    const info = await deps.stat(path);
    if (info === null) {
        return;
    }
    if (info.kind !== "file") {
        throw new SshError(`log file ${path} is not a regular file`);
    }
    checkNotGroupOtherWritable(path, "log file", info, deps.euid);
    if ((info.mode & 0o037) !== 0) {
        throw new SshError(
            `log file ${path} is group/other-accessible (mode ${octal(info.mode)}); run: chmod 640 ${path}`,
        );
    }
}

/**
 * Ensure a backupkit-private directory (runtimeDir/stateDir) exists at 0700,
 * creating it 0700 when absent. Ownership follows `ownershipOk`: a non-root
 * process requires the dir be its own (or root's); root accepts any owner
 * (root can access it regardless, and the 0700 mode check still runs). This is
 * what lets a root daemon use a user-owned stateDir without a chown.
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
    if (!ownershipOk(info, deps.euid)) {
        throw new SshError(`${label} ${path} is owned by uid ${info.uid}, not uid ${deps.euid}`);
    }
}

/**
 * Run the full permission preflight matrix (spec section 4), failing hard on
 * the first violation. Always checked: the config file (not group/other-
 * writable, owner euid or root), runtimeDir and stateDir (0700, owner euid,
 * created so when absent), every local destination root (exists, is a
 * directory, not group/other-writable, owner euid or root), and `logging.file`
 * when configured (0640-class, owner euid or root). Per EXPLICIT
 * remote only: the private key and any `file:` passphrase file (0600-class,
 * owner euid or root), the `.pub` sidecar when present (not group/other-
 * writable, owner euid or root - the engine prints its content as the archive
 * server's authorized_keys line, so a foreign-owned sidecar installs a foreign
 * key), and the dedicated known_hosts file (not group/other-writable, owner
 * euid or root - a foreign-owned known_hosts pins a host key of the attacker's
 * choosing and StrictHostKeyChecking=yes then accepts the MITM silently;
 * created 0600 when absent). Alias remotes contribute no rows of their own.
 *
 * Every one of those paths - destination roots included - is ALSO checked
 * through its containing directory (`checkParentDir`): a group/other-writable
 * or foreign-OWNED parent makes the path's own mode irrelevant, since whoever
 * holds the parent can unlink it and put their own there.
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
    await checkParentDir(input.configPath, "config file", deps);

    // CREATE, then judge the parent - not the other way round. These two are
    // backupkit's OWN private directories, and the default runtime dir for a
    // non-root user is `~/.backupkit/run`, whose parent `~/.backupkit` exists on
    // no fresh machine. Checking the parent first meant the FIRST command any
    // user ever ran died on "~/.backupkit does not exist", naming a directory
    // they never chose and never had a reason to create. `deps.mkdir` is
    // recursive at 0700, so the intermediate is made by us, owned by us, and
    // unreadable to anyone else - then checked like any other parent. A
    // PRE-EXISTING group/other-writable parent still fails exactly as before:
    // creating a 0700 directory inside it stores nothing and leaks nothing.
    await ensurePrivateDir(input.runtimeDir, "runtime dir", deps);
    await checkParentDir(input.runtimeDir, "runtime dir", deps);
    await ensurePrivateDir(input.stateDir, "state dir", deps);
    await checkParentDir(input.stateDir, "state dir", deps);

    if (input.loggingFile !== null) {
        await checkLoggingFile(input.loggingFile, deps);
    }

    for (const root of input.localDestinationRoots) {
        const info = await deps.stat(root);
        if (info === null) {
            throw new SshError(`destination root ${root} does not exist; create it first`);
        }
        if (info.kind !== "directory") {
            throw new SshError(`destination root ${root} is not a directory`);
        }
        checkNotGroupOtherWritable(root, "destination root", info, deps.euid);
        // Destination roots were the one always-row with no parent check, so
        // invariant 8's "AND THE PARENT DIRECTORY OF EACH" read as satisfied
        // while checking nothing here: the parent's owner can rename the whole
        // archive aside and put their own tree in its place, which the next run
        // then happily promotes snapshots into.
        await checkParentDir(root, "destination root", deps);
    }

    const checkedPaths = new Set<string>();
    for (const remote of input.remotes) {
        if (remote.kind !== "explicit") {
            continue;
        }
        if (!checkedPaths.has(remote.identityFile)) {
            checkedPaths.add(remote.identityFile);
            await checkPrivateFile(remote.identityFile, "private key", deps);
            await checkParentDir(remote.identityFile, "private key", deps);
            const pubPath = `${remote.identityFile}.pub`;
            const pubInfo = await deps.stat(pubPath);
            if (pubInfo !== null) {
                checkNotGroupOtherWritable(pubPath, "public key", pubInfo, deps.euid);
            }
        }
        if (remote.passphrase !== null && remote.passphrase.kind === "file" && !checkedPaths.has(remote.passphrase.value)) {
            checkedPaths.add(remote.passphrase.value);
            await checkPrivateFile(remote.passphrase.value, "passphrase file", deps);
            await checkParentDir(remote.passphrase.value, "passphrase file", deps);
        }
        if (!checkedPaths.has(remote.knownHostsFile)) {
            checkedPaths.add(remote.knownHostsFile);
            await checkParentDir(remote.knownHostsFile, "known_hosts", deps);
            const info = await deps.stat(remote.knownHostsFile);
            if (info === null) {
                await deps.createFile(remote.knownHostsFile, 0o600);
            } else {
                if (info.kind !== "file") {
                    throw new SshError(`known_hosts ${remote.knownHostsFile} exists but is not a regular file`);
                }
                checkNotGroupOtherWritable(remote.knownHostsFile, "known_hosts", info, deps.euid);
            }
        }
    }
}
