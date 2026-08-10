/**
 * Package root: the full public API surface (spec section 1). The engine's
 * `Backupkit` class plus the config, snapshot, error, and logger exports.
 * Internal modules (exec, ssh, rsync, the snapshot store's write surface,
 * retention) are deliberately not re-exported.
 */

export { Backupkit } from "./engine/backupkit.js";
export type {
    RunReport,
    TargetRunReport,
    RestoreReport,
    PruneReport,
    CheckReport,
    TargetStatus,
} from "./engine/types.js";
export { loadConfig, resolveConfigPath } from "./config/config.js";
export type {
    BackupkitConfig,
    ResolvedConfig,
    TargetConfig,
    RemoteConfig,
    ExplicitRemoteConfig,
    AliasRemoteConfig,
    ScheduleInput,
    ScheduleConfig,
    RetentionConfig,
    RsyncOptions,
    LogLevel,
    Weekday,
    Interval,
} from "./config/types.js";
export type { SnapshotInfo } from "./snapshots/types.js";
export {
    BackupkitError,
    ConfigError,
    SshError,
    TransferError,
    SnapshotStoreError,
    LockHeldError,
    DiskSpaceError,
    RestoreError,
    isBackupkitError,
} from "./shared/errors.js";
export type { BackupkitErrorCode } from "./shared/errors.js";
export { Logger } from "./shared/logger.js";
