/**
 * `SnapshotStore` - archive access for one target - and `openStore`, which
 * returns the local (pull) or remote (push) implementation based on which
 * endpoint the target's destination is. Package-internal (only `SnapshotInfo`
 * is exported from the package root): all mutation flows through `Backupkit`
 * verbs, so no library user can bypass the lock, the retention floors, or the
 * newest-snapshot invariant.
 */

import { join, posix } from "node:path";

import { SnapshotStoreError } from "../shared/errors.js";
import type { Logger } from "../shared/logger.js";
import type { RetryPolicy } from "../shared/retry.js";
import type { Endpoint } from "../shared/types.js";
import { runRemote, type SshContext } from "../ssh/ssh.js";
import { LocalSnapshotStore } from "./internal/local-store.js";
import { RemoteSnapshotStore } from "./internal/remote-store.js";

/**
 * Archive access for one target. The newest complete snapshot is
 * `(await listComplete()).at(-1) ?? null` - no redundant method on this seam.
 * Locking is scope-shaped (`withLock`), so leaking a lock is unrepresentable.
 */
export interface SnapshotStore {
    /** Complete snapshot names, lexically ascending. Ignores anything failing the regex. */
    listComplete(): Promise<string[]>;
    /** Rename the single existing `.partial` (if any) to `<newName>.partial`; delete stray partials/`.deleting` entries. */
    claimPartial(newName: string): Promise<{ resumed: boolean }>;
    /** Atomic rename `<name>.partial` -> `<name>`. */
    promote(name: string): Promise<void>;
    /** Two-phase delete: rename to `<name>.deleting`, then recursive delete. Never the newest complete snapshot. */
    remove(name: string): Promise<void>;
    /** Free bytes on the archive filesystem (statfs locally, `df -Pk --` remotely). */
    freeBytes(): Promise<number>;
    /**
     * Free inodes on the archive filesystem, or null when this store cannot
     * know (the remote store's `df -Pk --` reports no inode columns and the
     * jail's command grammar is fixed). Null means "skip the inode half of the
     * disk guard" - never "plenty free".
     */
    freeInodes(): Promise<number | null>;
    /**
     * Acquire the per-destination-root lock, run `fn`, release in `finally` -
     * leaking a lock is unrepresentable. Throws `LockHeldError` on live
     * contention without running `fn`.
     */
    withLock<T>(fn: () => Promise<T>): Promise<T>;
}

/**
 * The slice of a resolved target the store needs: its name (the snapshot
 * subdirectory under the destination root) and the archive-root endpoint.
 * Structurally satisfied by `ResolvedTarget`, keeping the module graph at
 * `snapshots -> ssh, exec, shared` (no config dependency).
 */
export interface StoreTarget {
    /** Target name: the snapshot subdirectory under the destination root. */
    name: string;
    /** The archive-root endpoint (the transfer destination side). */
    dst: Endpoint;
}

/** ssh invocation settings for a remote (push-mode) store. */
export interface StoreSshOptions {
    /** Absolute path (or PATH-resolvable name) of the local ssh binary. */
    sshBin: string;
    /** Invocation context deciding the StrictHostKeyChecking policy. */
    context: SshContext;
    /** SSH_AUTH_SOCK for spawned ssh (backupkit agent sock for explicit remotes, inherited value or null for aliases). */
    authSock: string | null;
    /** Complete base child environment override (tests). */
    env?: Record<string, string>;
    /** Retry policy override for tests ONLY - production callers always use the control policy. */
    retryPolicy?: RetryPolicy;
    /**
     * Graceful-shutdown signal for every remote command this store issues. The
     * pipeline threads its rsync children's signal here too, so a stop is
     * bounded on the store path (list, claim, promote, prune, lock) and not
     * only on the transfer - otherwise the store alone can outlast the service
     * unit's stop timeout and be SIGKILLed mid-lock.
     */
    signal?: AbortSignal;
}

/** Everything `openStore` needs beyond the target itself. */
export interface SnapshotStoreDeps {
    /** Logger for lock warnings and retry attempts. */
    log: Logger;
    /** Clock, injectable for tests. Default `() => new Date()`. */
    now?: () => Date;
    /** ssh settings; required when the target's destination endpoint is remote. */
    ssh?: StoreSshOptions;
}

/**
 * Open the snapshot store for one target: the local fs implementation when the
 * destination endpoint is local (pull mode), the jailed-remote-command
 * implementation when it is remote (push mode). The store root is
 * `<destination>/<targetName>`.
 */
export function openStore(target: StoreTarget, deps: SnapshotStoreDeps): SnapshotStore {
    const now = deps.now ?? (() => new Date());
    if (target.dst.kind === "local") {
        return new LocalSnapshotStore(join(target.dst.path, target.name), deps.log, now);
    }
    const ssh = deps.ssh;
    if (ssh === undefined) {
        throw new SnapshotStoreError(`target ${target.name} has a remote destination but no ssh settings were provided`);
    }
    const remote = target.dst.remote;
    const root = posix.join(target.dst.path, target.name);
    return new RemoteSnapshotStore(
        root,
        // A per-call retryPolicy (the store's NO_RETRY on every mutating
        // command) always wins over the test-only store-wide override: it is a
        // correctness requirement, not a knob.
        (argv, callOptions) =>
            runRemote(remote, argv, {
                sshBin: ssh.sshBin,
                context: ssh.context,
                authSock: ssh.authSock,
                env: ssh.env,
                retryPolicy: callOptions?.retryPolicy ?? ssh.retryPolicy,
                signal: ssh.signal,
                log: deps.log,
            }),
        deps.log,
        now,
    );
}
