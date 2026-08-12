/**
 * The hand-rolled config validator: walks the JSONC node tree, fails on the
 * FIRST error with a ConfigError shaped `<file>:<line>: <dotted.path>:
 * <problem>`, rejects unknown keys at every object level, and enforces the
 * full cross-field matrix (remote alias-XOR-explicit shape, the schedule
 * anchor matrix, path rules, grammars). Touches no filesystem - the config
 * file's text is the only input. Non-fatal findings (unreferenced remotes)
 * become warnings.
 */

import { ConfigError } from "../../shared/errors.js";
import { isValidBwlimit, parseMinFree } from "../../shared/format.js";
import type {
    AliasRemoteConfig,
    ExplicitRemoteConfig,
    LogLevel,
    RemoteConfig,
    RetentionConfig,
    ScheduleInput,
    TargetConfig,
} from "../types.js";
import type { JsoncArrayNode, JsoncNode, JsoncObjectNode } from "./jsonc.js";

/** One validated remote with its document-order position preserved. */
export interface ValidatedRemote {
    /** The remote's key in the `remotes` record. */
    name: string;
    /** The validated remote shape. */
    remote: RemoteConfig;
}

/** One validated target with its document-order position preserved. */
export interface ValidatedTarget {
    /** The target's key in the `targets` record. */
    name: string;
    /** The validated target shape. */
    target: TargetConfig;
}

/**
 * Validator output: the config with grammar and cross-field rules enforced,
 * remotes/targets as document-ordered arrays, defaults NOT yet filled
 * (that is `defaults.ts`'s job).
 */
export interface ValidatedConfig {
    /** Instance label, if written. */
    name?: string;
    /** Remotes in document order. */
    remotes: ValidatedRemote[];
    /** Targets in document order (= run order). */
    targets: ValidatedTarget[];
    /** Top-level default retention, if written. */
    retention?: RetentionConfig;
    /** Run-report root override, if written. */
    stateDir?: string;
    /** Logging settings, if written. */
    logging?: {
        /** Minimum level to emit, if written. */
        level?: LogLevel;
        /** Log file path, if written. */
        file?: string;
    };
    /** Local rsync binary override, if written. */
    rsyncBin?: string;
    /** Local ssh binary override, if written. */
    sshBin?: string;
    /** Non-fatal findings for the caller to log (e.g. unreferenced remotes). */
    warnings: string[];
}

/** Record-key charset for remote and target names. */
const NAME_REGEX = /^[a-z0-9][a-z0-9._-]*$/;

/** ssh_config alias charset - excludes whitespace, quotes, ':', '@', '/', and a leading '-' by construction. */
const ALIAS_REGEX = /^[a-z0-9_][a-z0-9._-]*$/i;

/**
 * Hostname / IPv4 charset - a POSITIVE charset, mirroring ALIAS_REGEX: letters,
 * digits, '.', '-', '_', never a leading '-'.
 *
 * A blacklist is not enough here. `host` reaches `formatEndpoint`, which emits
 * `user@host:path`, and rsync treats an argument whose first '/' precedes the
 * first ':' as a LOCAL path - so a host of "10.0.0.5/x" silently turned a push
 * target's destination into a local relative directory. A leading '-' becomes
 * an ssh OPTION ("-oProxyCommand=..."), a NUL makes spawn throw a raw
 * ERR_INVALID_ARG_VALUE instead of a config error, and a control character
 * reaches the operator's terminal through error messages.
 */
const HOST_REGEX = /^[a-z0-9_][a-z0-9._-]*$/i;

/**
 * Unbracketed IPv6 literal, with an optional zone id - the documented form for
 * `host` (formatEndpoint adds the brackets, so a pre-bracketed "[::1]" would be
 * double-bracketed and is rejected).
 */
const HOST_IPV6_REGEX = /^[0-9a-f:]+(%[a-z0-9._-]+)?$/i;

/** SSH username charset. */
const USER_REGEX = /^[a-z_][a-z0-9._-]{0,31}$/i;

/** "HH:MM" 24-hour anchor. */
const AT_REGEX = /^([01][0-9]|2[0-3]):[0-5][0-9]$/;

/** Passphrase source grammar: "file:/abs/path". */
const PASSPHRASE_FILE_REGEX = /^file:\/.+/;

/** The seven weekday short names, Monday first. */
const WEEKDAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;

/** The five schedule intervals. */
const INTERVALS = ["minute", "hour", "day", "week", "month"] as const;

/** The four log levels. */
const LOG_LEVELS = ["error", "warn", "info", "debug"] as const;

/** The six retention rule keys. */
const RETENTION_KEYS = ["keepLast", "keepHourly", "keepDaily", "keepWeekly", "keepMonthly", "keepYearly"] as const;

/**
 * Normalize a validated absolute path: collapse duplicate slashes and strip a
 * trailing slash. This is the ONE normal form every path in a ResolvedConfig
 * is in - see `expectPath`, which applies it to every path it returns, and
 * `checkSnapshotRoots`, which relies on it for prefix comparison.
 */
function normalizePath(value: string): string {
    const collapsed = value.replace(/\/{2,}/g, "/");
    return collapsed.length > 1 ? collapsed.replace(/\/$/, "") : collapsed;
}

/** Stateful single-pass validator bound to one file. */
class Validator {
    /** Non-fatal findings accumulated during validation. */
    readonly warnings: string[] = [];

    /** Bind the validator to the reporting filename. */
    constructor(private readonly file: string) {}

    /** Throw the fail-first ConfigError: `<file>:<line>: <dotted.path>: <problem>`. */
    private fail(node: JsoncNode, path: string, problem: string): never {
        throw new ConfigError(`${this.file}:${node.line}: ${path}: ${problem}`, {
            file: this.file,
            line: node.line,
            path,
        });
    }

    /** Require an object node. */
    private expectObject(node: JsoncNode, path: string): JsoncObjectNode {
        if (node.kind !== "object") {
            this.fail(node, path, "expected an object");
        }
        return node;
    }

    /** Require a string node and return its value. */
    private expectString(node: JsoncNode, path: string): string {
        if (node.kind !== "string") {
            this.fail(node, path, "expected a string");
        }
        return node.value;
    }

    /** Require a boolean node and return its value. */
    private expectBool(node: JsoncNode, path: string): boolean {
        if (node.kind !== "boolean") {
            this.fail(node, path, "expected a boolean");
        }
        return node.value;
    }

    /** Require an integer node within [min, max] and return its value. */
    private expectInt(node: JsoncNode, path: string, min: number, max: number, problem: string): number {
        if (node.kind !== "number" || !Number.isInteger(node.value) || node.value < min || node.value > max) {
            this.fail(node, path, problem);
        }
        return node.value;
    }

    /** Require a string node whose value is one of the given options. */
    private expectEnum<T extends string>(node: JsoncNode, path: string, options: readonly T[]): T {
        const value = this.expectString(node, path);
        if (!(options as readonly string[]).includes(value)) {
            this.fail(node, path, `expected one of ${options.map((option) => `"${option}"`).join(", ")}`);
        }
        return value as T;
    }

    /** Reject any key of `obj` not in the allowed list (first offender, document order). */
    private rejectUnknownKeys(obj: JsoncObjectNode, path: string, allowed: readonly string[]): void {
        for (const [key, valueNode] of obj.entries) {
            if (!allowed.includes(key)) {
                this.fail(valueNode, path === "" ? key : `${path}.${key}`, `unknown key "${key}"`);
            }
        }
    }

    /**
     * Require an absolute path with the universal path rules: no `~`, no NUL
     * or newline, absolute, and no `.` or `..` component. With
     * `noWhitespaceQuotes` (paths that enter rsync's -e string or a remote
     * command) whitespace and quote characters are also rejected. The RETURNED
     * value is normalized (duplicate slashes collapsed, trailing slash
     * stripped).
     *
     * Normalizing HERE, once, is load-bearing rather than cosmetic. A target's
     * `destination` reaches the push jail twice by two different routes: the
     * literal string is baked into the `authorized_keys` forced command as
     * `$ROOT`, while every path operand sent to that jail is built with
     * `posix.join`, which normalizes. The jail compares them as literal string
     * prefixes, so any non-normal form ("/srv/backups//archive") makes every
     * remote command fail the prefix test and be rejected - after the config
     * validated and `check` reported OK. A `..` component is worse: the jail
     * refuses to start at all, so even the version probe is rejected. Both
     * cases are unrepresentable once every path leaves this function in the
     * same normal form the operands are built in.
     */
    private expectPath(node: JsoncNode, path: string, noWhitespaceQuotes: boolean): string {
        return this.checkPath(node, path, this.expectString(node, path), noWhitespaceQuotes);
    }

    /**
     * `expectPath`'s rules applied to a path that is only PART of the node's
     * string - today the remainder of a `"file:/abs/path"` passphrase source,
     * which is published as an absolute path in the ResolvedConfig and so must
     * be in the same normal form as every other path there. Errors are reported
     * against the node, at the field's dotted path.
     */
    private checkPath(node: JsoncNode, path: string, value: string, noWhitespaceQuotes: boolean): string {
        if (value.startsWith("~")) {
            this.fail(node, path, '"~" is not expanded - use an absolute path');
        }
        if (/[\0\n\r]/.test(value)) {
            this.fail(node, path, "path may not contain NUL or newline characters");
        }
        if (!value.startsWith("/")) {
            this.fail(node, path, "must be an absolute path");
        }
        if (noWhitespaceQuotes && /[\s'"]/.test(value)) {
            this.fail(node, path, "path may not contain whitespace or quote characters");
        }
        const normalized = normalizePath(value);
        if (normalized.split("/").some((component) => component === "." || component === "..")) {
            this.fail(node, path, 'path may not contain a "." or ".." component - write the resolved absolute path');
        }
        return normalized;
    }

    /** Require a record key to match the shared name charset. */
    private checkName(node: JsoncNode, path: string, key: string): void {
        if (!NAME_REGEX.test(key) || key.length > 64) {
            this.fail(
                node,
                path,
                `invalid name "${key}" - names must match /^[a-z0-9][a-z0-9._-]*$/ and be at most 64 characters`,
            );
        }
    }

    /** Validate one remote object: the alias XOR explicit discriminated shape. */
    private validateRemote(node: JsoncNode, path: string): RemoteConfig {
        const obj = this.expectObject(node, path);
        if (obj.entries.has("alias")) {
            // `restrictedShell` is the one companion field: it describes the
            // remote's SHELL (which ssh_config cannot express), not an ssh
            // option, so the "put it in ssh_config" answer does not apply.
            for (const [key, valueNode] of obj.entries) {
                if (key !== "alias" && key !== "restrictedShell") {
                    this.fail(
                        valueNode,
                        `${path}.${key}`,
                        "alias remotes take no other fields - host, user, key, and port come from ssh_config; use an explicit remote for per-field control",
                    );
                }
            }
            const aliasNode = obj.entries.get("alias")!;
            const alias = this.expectString(aliasNode, `${path}.alias`);
            if (!ALIAS_REGEX.test(alias) || alias.length > 64) {
                this.fail(
                    aliasNode,
                    `${path}.alias`,
                    "invalid alias - must match /^[a-z0-9_][a-z0-9._-]*$/i and be at most 64 characters (no whitespace, quotes, ':', '@', or '/')",
                );
            }
            const remote: AliasRemoteConfig = { alias };
            const aliasShellNode = obj.entries.get("restrictedShell");
            if (aliasShellNode !== undefined) {
                remote.restrictedShell = this.expectBool(aliasShellNode, `${path}.restrictedShell`);
            }
            return remote;
        }
        this.rejectUnknownKeys(obj, path, [
            "host",
            "user",
            "port",
            "identityFile",
            "passphrase",
            "knownHostsFile",
            "restrictedShell",
        ]);
        for (const required of ["host", "user", "identityFile"]) {
            if (!obj.entries.has(required)) {
                this.fail(obj, `${path}.${required}`, "required field missing");
            }
        }
        const hostNode = obj.entries.get("host")!;
        const host = this.expectString(hostNode, `${path}.host`);
        if (host.length > 253 || !(HOST_REGEX.test(host) || HOST_IPV6_REGEX.test(host))) {
            this.fail(
                hostNode,
                `${path}.host`,
                "invalid host - must be a hostname or IPv4 matching /^[a-z0-9_][a-z0-9._-]*$/i, or an " +
                    "unbracketed IPv6 literal, at most 253 characters (no whitespace, quotes, '@', '/', " +
                    "control characters, or a leading '-')",
            );
        }
        const userNode = obj.entries.get("user")!;
        const user = this.expectString(userNode, `${path}.user`);
        if (!USER_REGEX.test(user)) {
            this.fail(userNode, `${path}.user`, "invalid ssh user - must match /^[a-z_][a-z0-9._-]{0,31}$/i");
        }
        const remote: ExplicitRemoteConfig = {
            host,
            user,
            identityFile: this.expectPath(obj.entries.get("identityFile")!, `${path}.identityFile`, true),
        };
        const portNode = obj.entries.get("port");
        if (portNode !== undefined) {
            remote.port = this.expectInt(portNode, `${path}.port`, 1, 65535, "expected an integer between 1 and 65535");
        }
        const passphraseNode = obj.entries.get("passphrase");
        if (passphraseNode !== undefined) {
            const passphrase = this.expectString(passphraseNode, `${path}.passphrase`);
            if (passphrase !== "prompt" && !PASSPHRASE_FILE_REGEX.test(passphrase)) {
                this.fail(
                    passphraseNode,
                    `${path}.passphrase`,
                    'passphrase must be "file:/path" or "prompt" - never the passphrase itself',
                );
            }
            // The remainder of "file:..." is published as an absolute path
            // (defaults.ts slices the prefix off), so it gets the SAME treatment
            // identityFile gets - the prefix test alone accepted ".." escapes,
            // duplicate slashes, spaces, quotes, and embedded newlines.
            remote.passphrase =
                passphrase === "prompt"
                    ? passphrase
                    : `file:${this.checkPath(passphraseNode, `${path}.passphrase`, passphrase.slice("file:".length), true)}`;
        }
        const knownHostsNode = obj.entries.get("knownHostsFile");
        if (knownHostsNode !== undefined) {
            remote.knownHostsFile = this.expectPath(knownHostsNode, `${path}.knownHostsFile`, true);
        }
        const shellNode = obj.entries.get("restrictedShell");
        if (shellNode !== undefined) {
            remote.restrictedShell = this.expectBool(shellNode, `${path}.restrictedShell`);
        }
        return remote;
    }

    /** Validate a retention rules object (non-empty, non-negative integer counts). */
    private validateRetention(node: JsoncNode, path: string): RetentionConfig {
        const obj = this.expectObject(node, path);
        this.rejectUnknownKeys(obj, path, RETENTION_KEYS);
        if (obj.entries.size === 0) {
            this.fail(
                obj,
                path,
                "empty retention {} - omit retention to keep everything forever, or set retention: false on a target",
            );
        }
        const retention: RetentionConfig = {};
        for (const key of RETENTION_KEYS) {
            const valueNode = obj.entries.get(key);
            if (valueNode !== undefined) {
                retention[key] = this.expectInt(
                    valueNode,
                    `${path}.${key}`,
                    0,
                    Number.MAX_SAFE_INTEGER,
                    "expected a non-negative integer",
                );
            }
        }
        return retention;
    }

    /** Validate a schedule object against the interval/anchor matrix. */
    private validateSchedule(node: JsoncNode, path: string): ScheduleInput {
        const obj = this.expectObject(node, path);
        this.rejectUnknownKeys(obj, path, ["interval", "intervalCount", "at", "on", "dayOfMonth"]);
        const intervalNode = obj.entries.get("interval");
        if (intervalNode === undefined) {
            this.fail(obj, `${path}.interval`, "required field missing");
        }
        const schedule: ScheduleInput = { interval: this.expectEnum(intervalNode, `${path}.interval`, INTERVALS) };
        const countNode = obj.entries.get("intervalCount");
        if (countNode !== undefined) {
            schedule.intervalCount = this.expectInt(
                countNode,
                `${path}.intervalCount`,
                1,
                Number.MAX_SAFE_INTEGER,
                "expected a positive integer",
            );
        }
        const atNode = obj.entries.get("at");
        if (atNode !== undefined) {
            if (schedule.interval === "minute" || schedule.interval === "hour") {
                this.fail(atNode, `${path}.at`, '"at" is only valid for intervals "day", "week", and "month"');
            }
            const at = this.expectString(atNode, `${path}.at`);
            if (!AT_REGEX.test(at)) {
                this.fail(atNode, `${path}.at`, '"at" must be "HH:MM" (24-hour UTC, e.g. "03:00")');
            }
            schedule.at = at;
        }
        const onNode = obj.entries.get("on");
        if (onNode !== undefined) {
            if (schedule.interval !== "week") {
                this.fail(onNode, `${path}.on`, '"on" is only valid for interval "week"');
            }
            schedule.on = this.expectEnum(onNode, `${path}.on`, WEEKDAYS);
        }
        const dayNode = obj.entries.get("dayOfMonth");
        if (dayNode !== undefined) {
            if (schedule.interval !== "month") {
                this.fail(dayNode, `${path}.dayOfMonth`, '"dayOfMonth" is only valid for interval "month"');
            }
            schedule.dayOfMonth = this.expectInt(
                dayNode,
                `${path}.dayOfMonth`,
                1,
                28,
                "expected an integer between 1 and 28",
            );
        }
        return schedule;
    }

    /** Validate a per-target rsync options object. */
    private validateRsyncOptions(node: JsoncNode, path: string): TargetConfig["rsync"] {
        const obj = this.expectObject(node, path);
        this.rejectUnknownKeys(obj, path, [
            "compress",
            "bwlimit",
            "ioTimeoutSec",
            "xattrs",
            "preserveOwnership",
            "preserveDevices",
            "remoteRsyncBin",
            "verify",
        ]);
        const options: NonNullable<TargetConfig["rsync"]> = {};
        for (const key of ["compress", "xattrs", "preserveOwnership", "preserveDevices", "verify"] as const) {
            const valueNode = obj.entries.get(key);
            if (valueNode !== undefined) {
                options[key] = this.expectBool(valueNode, `${path}.${key}`);
            }
        }
        const bwlimitNode = obj.entries.get("bwlimit");
        if (bwlimitNode !== undefined) {
            const bwlimit = this.expectString(bwlimitNode, `${path}.bwlimit`);
            if (!isValidBwlimit(bwlimit)) {
                this.fail(
                    bwlimitNode,
                    `${path}.bwlimit`,
                    "bwlimit must be a number with an optional K/M/G suffix (a bare number is KiB/s)",
                );
            }
            options.bwlimit = bwlimit;
        }
        const timeoutNode = obj.entries.get("ioTimeoutSec");
        if (timeoutNode !== undefined) {
            options.ioTimeoutSec = this.expectInt(
                timeoutNode,
                `${path}.ioTimeoutSec`,
                1,
                Number.MAX_SAFE_INTEGER,
                "expected a positive integer",
            );
        }
        const remoteRsyncNode = obj.entries.get("remoteRsyncBin");
        if (remoteRsyncNode !== undefined) {
            options.remoteRsyncBin = this.expectPath(remoteRsyncNode, `${path}.remoteRsyncBin`, true);
        }
        return options;
    }

    /** Validate an exclude-pattern array. */
    private validateExclude(node: JsoncNode, path: string): string[] {
        if (node.kind !== "array") {
            this.fail(node, path, "expected an array of strings");
        }
        const arrayNode: JsoncArrayNode = node;
        return arrayNode.items.map((item, index) => {
            const pattern = this.expectString(item, `${path}[${index}]`);
            if (/[\0\n\r]/.test(pattern)) {
                this.fail(item, `${path}[${index}]`, "exclude pattern may not contain NUL or newline characters");
            }
            return pattern;
        });
    }

    /** Validate one target object. */
    private validateTarget(node: JsoncNode, path: string): TargetConfig {
        const obj = this.expectObject(node, path);
        this.rejectUnknownKeys(obj, path, [
            "mode",
            "direction",
            "remote",
            "source",
            "destination",
            "exclude",
            "schedule",
            "retention",
            "retry",
            "minFree",
            "rsync",
            "jail",
            "enabled",
        ]);
        // `mode` is required with NO default, unlike every other optional knob:
        // "snapshot" keeps every previous version, "mirror" overwrites and
        // deletes in place, and a config that forgot to say which one it wants
        // must not be resolved into either by silence.
        for (const required of ["mode", "direction", "remote", "source", "destination"]) {
            if (!obj.entries.has(required)) {
                this.fail(obj, `${path}.${required}`, "required field missing");
            }
        }
        const target: TargetConfig = {
            mode: this.expectEnum(obj.entries.get("mode")!, `${path}.mode`, ["snapshot", "mirror"] as const),
            direction: this.expectEnum(obj.entries.get("direction")!, `${path}.direction`, ["pull", "push"] as const),
            remote: this.expectString(obj.entries.get("remote")!, `${path}.remote`),
            source: this.expectPath(obj.entries.get("source")!, `${path}.source`, false),
            destination: this.expectPath(obj.entries.get("destination")!, `${path}.destination`, false),
        };
        // Cross-field rule: a PUSH destination becomes $ROOT inside the archive
        // host's forced command, whose `set -- $CMD` word-splits the remote
        // command - and real rsync backslash-escapes a space in the path it
        // sends. Every rsync through the jail is then rejected while the
        // lifecycle commands still succeed, so the config validates, `backupkit
        // check` reports OK, and no backup ever completes. With the jail
        // disabled the remote LOGIN SHELL word-splits the same command string,
        // so the restriction holds for every push target, jailed or not. A PULL
        // destination is purely local and works fine with spaces.
        if (target.direction === "push" && /[\s'"]/.test(target.destination)) {
            this.fail(
                obj.entries.get("destination")!,
                `${path}.destination`,
                "a push destination may not contain whitespace or quote characters - the remote command " +
                    "layer (the jail's parser, or the login shell when the jail is disabled) word-splits it",
            );
        }
        const excludeNode = obj.entries.get("exclude");
        if (excludeNode !== undefined) {
            target.exclude = this.validateExclude(excludeNode, `${path}.exclude`);
        }
        const scheduleNode = obj.entries.get("schedule");
        if (scheduleNode !== undefined) {
            target.schedule = this.validateSchedule(scheduleNode, `${path}.schedule`);
        }
        const retentionNode = obj.entries.get("retention");
        if (retentionNode !== undefined) {
            // Rejected, never ignored: a mirror keeps exactly one copy, so a
            // retention block on it describes history that will never exist -
            // and silently dropping it would read as "my snapshots are kept
            // for a year" to whoever wrote it.
            if (target.mode === "mirror") {
                this.fail(
                    retentionNode,
                    `${path}.retention`,
                    'retention is only valid on a "snapshot" target - a mirror keeps no history to prune',
                );
            }
            if (retentionNode.kind === "boolean" && !retentionNode.value) {
                target.retention = false;
            } else if (retentionNode.kind === "boolean") {
                this.fail(retentionNode, `${path}.retention`, "expected a retention object or false");
            } else {
                target.retention = this.validateRetention(retentionNode, `${path}.retention`);
            }
        }
        const retryNode = obj.entries.get("retry");
        if (retryNode !== undefined) {
            const retryObj = this.expectObject(retryNode, `${path}.retry`);
            this.rejectUnknownKeys(retryObj, `${path}.retry`, ["attempts"]);
            const attemptsNode = retryObj.entries.get("attempts");
            target.retry = {};
            if (attemptsNode !== undefined) {
                target.retry.attempts = this.expectInt(
                    attemptsNode,
                    `${path}.retry.attempts`,
                    1,
                    10,
                    "expected an integer between 1 and 10",
                );
            }
        }
        const minFreeNode = obj.entries.get("minFree");
        if (minFreeNode !== undefined) {
            // The disk guard's premise is a destination that GROWS by one
            // snapshot per run; a mirror replaces its tree in place and frees
            // as much as it writes, so the floor has nothing to protect.
            if (target.mode === "mirror") {
                this.fail(
                    minFreeNode,
                    `${path}.minFree`,
                    'minFree is only valid on a "snapshot" target - a mirror replaces its destination in place ' +
                        "rather than adding a snapshot to it",
                );
            }
            if (minFreeNode.kind === "boolean" && !minFreeNode.value) {
                target.minFree = false;
            } else {
                const minFree = this.expectString(minFreeNode, `${path}.minFree`);
                if (parseMinFree(minFree) === null) {
                    this.fail(
                        minFreeNode,
                        `${path}.minFree`,
                        'minFree must be "N%" (0-50) or an absolute size like "10G"/"500M", or false',
                    );
                }
                target.minFree = minFree;
            }
        }
        const rsyncNode = obj.entries.get("rsync");
        if (rsyncNode !== undefined) {
            const rsyncOptions: NonNullable<TargetConfig["rsync"]> =
                this.validateRsyncOptions(rsyncNode, `${path}.rsync`) ?? {};
            target.rsync = rsyncOptions;
            if (target.direction === "push" && rsyncOptions.remoteRsyncBin !== undefined) {
                const remoteRsyncNode = (rsyncNode.kind === "object"
                    ? rsyncNode.entries.get("remoteRsyncBin")
                    : undefined) ?? rsyncNode;
                this.fail(
                    remoteRsyncNode,
                    `${path}.rsync.remoteRsyncBin`,
                    "remoteRsyncBin is not allowed on a push target - the archive host's forced " +
                        "command fixes the remote rsync binary; set it on the jail account's PATH instead",
                );
            }
        }
        const jailNode = obj.entries.get("jail");
        if (jailNode !== undefined) {
            if (target.direction === "pull") {
                this.fail(
                    jailNode,
                    `${path}.jail`,
                    "jail is only valid on a push target - pull mode keeps every credential local and has no jail",
                );
            }
            target.jail = this.expectBool(jailNode, `${path}.jail`);
        }
        // Cross-field rule: a JAILED push cannot be a mirror, and this has to be
        // refused here or it fails as a mystery at run time. The jail's forced
        // command pins every rsync destination to `$ROOT/<target>/<snap>.partial`
        // - that pin is precisely what makes the `--delete --force` it also
        // permits harmless, since a delete can then only reach inside the scratch
        // partial of the run in flight. A mirror's destination IS `$ROOT`, so the
        // jail rejects its every transfer; and it could not safely be taught to
        // accept one, because "delete anything under $ROOT the sender no longer
        // has" is the exact command the jail exists to refuse.
        //
        // So a push mirror is an unjailed key by construction, and it must SAY so:
        // `jail` defaults to true on push, and silently flipping that default for
        // a mirror would downgrade the archive host's protection without the
        // operator ever writing it down.
        if (target.mode === "mirror" && target.direction === "push" && (target.jail ?? true)) {
            this.fail(
                jailNode ?? obj,
                `${path}.jail`,
                'a "mirror" push cannot be jailed: the forced command pins every transfer to ' +
                    "<destination>/<target>/<snapshot>.partial, which is what keeps its permitted --delete " +
                    "confined - a mirror writes the destination root itself. Set \"jail\": false to accept " +
                    "that this key has whatever access the server grants it, or use \"mode\": \"snapshot\", " +
                    "or mirror in the other direction with \"direction\": \"pull\"",
            );
        }
        const enabledNode = obj.entries.get("enabled");
        if (enabledNode !== undefined) {
            target.enabled = this.expectBool(enabledNode, `${path}.enabled`);
        }
        return target;
    }

    /**
     * Cross-field rule: no target's write root may equal or nest inside
     * another's within the same storage location (local for pull, the target's
     * remote for push). The root is `<destination>/<name>` for a snapshot
     * target and `<destination>` itself for a mirror.
     *
     * Mirrors are why this rule is now load-bearing rather than tidy: a mirror
     * transfers with `--delete --force`, so a mirror whose destination CONTAINS
     * another target's archive deletes that archive on its first run - the one
     * config mistake in this file that destroys data rather than failing.
     */
    private checkSnapshotRoots(targets: ValidatedTarget[], nodes: Map<string, JsoncNode>): void {
        const roots: { name: string; scope: string; root: string }[] = targets.map(({ name, target }) => ({
            name,
            scope: target.direction === "pull" ? "local" : `remote:${target.remote}`,
            root: target.mode === "mirror" ? normalizePath(target.destination) : `${normalizePath(target.destination)}/${name}`,
        }));
        for (let i = 0; i < roots.length; i += 1) {
            for (let j = 0; j < i; j += 1) {
                const a = roots[j];
                const b = roots[i];
                if (a.scope !== b.scope) {
                    continue;
                }
                const nested =
                    a.root === b.root || a.root.startsWith(`${b.root}/`) || b.root.startsWith(`${a.root}/`);
                if (nested) {
                    const node = nodes.get(b.name)!;
                    this.fail(
                        node,
                        `targets.${b.name}.destination`,
                        `write root ${b.root} collides with targets.${a.name}'s write root ${a.root} - choose a distinct destination`,
                    );
                }
            }
        }
    }

    /**
     * Cross-field rule: a `restrictedShell` remote cannot serve a JAILED push
     * target. The jail's grammar matches the single-quoted lifecycle commands
     * (`'mkdir' '-p' '--' '...'`), while a restricted shell is sent bare words -
     * so every mkdir/mv/rm is answered with a bare `backupkit-remote: rejected`
     * while rsync itself keeps working, which reads as a mystery failure rather
     * than a misconfiguration. `jail` defaults to true on push, so the pair has
     * to be refused here or it fails silently at run time.
     */
    private checkRestrictedShellJail(
        targets: ValidatedTarget[],
        remotes: { name: string; remote: RemoteConfig }[],
        nodes: Map<string, JsoncNode>,
    ): void {
        const restricted = new Set(
            remotes.filter(({ remote }) => remote.restrictedShell === true).map(({ name }) => name),
        );
        for (const { name, target } of targets) {
            if (target.direction !== "push" || (target.jail ?? true) === false) {
                continue;
            }
            if (restricted.has(target.remote)) {
                this.fail(
                    nodes.get(name)!,
                    `targets.${name}.jail`,
                    `remote "${target.remote}" sets restrictedShell, whose bare-word commands the jail's ` +
                        'quoted grammar rejects - set "jail": false on this target, or drop restrictedShell',
                );
            }
        }
    }

    /** Validate the whole document. */
    validate(root: JsoncNode): ValidatedConfig {
        const obj = this.expectObject(root, "config");
        this.rejectUnknownKeys(obj, "", [
            "name",
            "remotes",
            "targets",
            "retention",
            "stateDir",
            "logging",
            "rsyncBin",
            "sshBin",
        ]);
        const result: ValidatedConfig = { remotes: [], targets: [], warnings: this.warnings };

        const nameNode = obj.entries.get("name");
        if (nameNode !== undefined) {
            const name = this.expectString(nameNode, "name");
            if (name.length === 0 || /[\0\n\r]/.test(name)) {
                this.fail(nameNode, "name", "must be a non-empty single-line string");
            }
            result.name = name;
        }

        const remotesNode = obj.entries.get("remotes");
        if (remotesNode === undefined) {
            this.fail(obj, "remotes", "required field missing");
        }
        const remotesObj = this.expectObject(remotesNode, "remotes");
        if (remotesObj.entries.size === 0) {
            this.fail(remotesObj, "remotes", "at least one remote is required");
        }
        for (const [key, valueNode] of remotesObj.entries) {
            this.checkName(valueNode, `remotes.${key}`, key);
            result.remotes.push({ name: key, remote: this.validateRemote(valueNode, `remotes.${key}`) });
        }

        const targetsNode = obj.entries.get("targets");
        if (targetsNode === undefined) {
            this.fail(obj, "targets", "required field missing");
        }
        const targetsObj = this.expectObject(targetsNode, "targets");
        if (targetsObj.entries.size === 0) {
            this.fail(targetsObj, "targets", "at least one target is required");
        }
        const targetNodes = new Map<string, JsoncNode>();
        for (const [key, valueNode] of targetsObj.entries) {
            this.checkName(valueNode, `targets.${key}`, key);
            const target = this.validateTarget(valueNode, `targets.${key}`);
            const remoteNames = result.remotes.map((entry) => entry.name);
            if (!remoteNames.includes(target.remote)) {
                const remoteNode = this.expectObject(valueNode, `targets.${key}`).entries.get("remote")!;
                this.fail(
                    remoteNode,
                    `targets.${key}.remote`,
                    `unknown remote "${target.remote}" - configured remotes: ${remoteNames.join(", ")}`,
                );
            }
            result.targets.push({ name: key, target });
            targetNodes.set(key, valueNode);
        }
        this.checkSnapshotRoots(result.targets, targetNodes);
        this.checkRestrictedShellJail(result.targets, result.remotes, targetNodes);

        const retentionNode = obj.entries.get("retention");
        if (retentionNode !== undefined) {
            result.retention = this.validateRetention(retentionNode, "retention");
        }
        const stateDirNode = obj.entries.get("stateDir");
        if (stateDirNode !== undefined) {
            result.stateDir = this.expectPath(stateDirNode, "stateDir", false);
        }
        const loggingNode = obj.entries.get("logging");
        if (loggingNode !== undefined) {
            const loggingObj = this.expectObject(loggingNode, "logging");
            this.rejectUnknownKeys(loggingObj, "logging", ["level", "file"]);
            result.logging = {};
            const levelNode = loggingObj.entries.get("level");
            if (levelNode !== undefined) {
                result.logging.level = this.expectEnum(levelNode, "logging.level", LOG_LEVELS);
            }
            const fileNode = loggingObj.entries.get("file");
            if (fileNode !== undefined) {
                result.logging.file = this.expectPath(fileNode, "logging.file", false);
            }
        }
        const rsyncBinNode = obj.entries.get("rsyncBin");
        if (rsyncBinNode !== undefined) {
            result.rsyncBin = this.expectPath(rsyncBinNode, "rsyncBin", true);
        }
        const sshBinNode = obj.entries.get("sshBin");
        if (sshBinNode !== undefined) {
            result.sshBin = this.expectPath(sshBinNode, "sshBin", true);
        }

        const referenced = new Set(result.targets.map((entry) => entry.target.remote));
        for (const { name } of result.remotes) {
            if (!referenced.has(name)) {
                this.warnings.push(`remote "${name}" is not referenced by any target`);
            }
        }
        return result;
    }
}

/**
 * Validate a parsed JSONC document as a backupkit config. Fails on the first
 * violation with a `<file>:<line>: <dotted.path>: <problem>` ConfigError;
 * collects non-fatal findings as warnings on the returned object.
 */
export function validateConfig(root: JsoncNode, file: string): ValidatedConfig {
    return new Validator(file).validate(root);
}
