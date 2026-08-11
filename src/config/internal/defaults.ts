/**
 * Defaults resolution: turns a ValidatedConfig into the ResolvedConfig the
 * rest of the codebase consumes - every optional filled, schedules
 * normalized, remotes resolved to their discriminated shapes, and each target
 * mapped once to its {src, dst} endpoint pair (no downstream direction
 * branching). Pure - environment inputs (euid, env, home) are parameters.
 */

import { dirname, join } from "node:path";
import type { Endpoint, ResolvedRemote } from "../../shared/types.js";
import { parseMinFree } from "../../shared/format.js";
import type { ResolvedConfig, ResolvedTarget, ScheduleConfig, ScheduleInput } from "../types.js";
import type { ValidatedConfig } from "./validate.js";

/** Environment inputs the resolution depends on (injectable for tests). */
export interface ResolveEnvironment {
    /** Effective uid, or null when unavailable (e.g. Windows). */
    euid: number | null;
    /** Environment variables (XDG_STATE_HOME is read). */
    env: Record<string, string | undefined>;
    /** The user's home directory. */
    homeDir: string;
    /** Host platform, for the root stateDir default (Linux /var/lib vs macOS /var/db). */
    platform: NodeJS.Platform;
}

/** Fill every schedule default: intervalCount 1, at "00:00", on "mon", dayOfMonth 1. */
export function resolveSchedule(input: ScheduleInput | undefined): ScheduleConfig {
    return {
        interval: input?.interval ?? "day",
        intervalCount: input?.intervalCount ?? 1,
        at: input?.at ?? "00:00",
        on: input?.on ?? "mon",
        dayOfMonth: input?.dayOfMonth ?? 1,
    };
}

/**
 * The default stateDir for root: /var/lib/backupkit on Linux, /var/db/backupkit
 * on macOS (which has no /var/lib - the same Linux-ism the runtime dir avoids;
 * /var/db is macOS's own system-daemon data location). Non-root:
 * ${XDG_STATE_HOME:-~/.local/state}/backupkit on both.
 */
function defaultStateDir(environment: ResolveEnvironment): string {
    if (environment.euid === 0) {
        return environment.platform === "darwin" ? "/var/db/backupkit" : "/var/lib/backupkit";
    }
    const stateHome = environment.env.XDG_STATE_HOME ?? join(environment.homeDir, ".local", "state");
    return join(stateHome, "backupkit");
}

/**
 * Resolve a validated config into its normal form. `configPath` feeds the
 * default known_hosts location (`<configDir>/known_hosts`).
 */
export function resolveConfig(
    validated: ValidatedConfig,
    configPath: string,
    environment: ResolveEnvironment,
): ResolvedConfig {
    const configDir = dirname(configPath);
    const remotes: Record<string, ResolvedRemote> = {};
    for (const { name, remote } of validated.remotes) {
        if ("alias" in remote) {
            remotes[name] = { kind: "alias", name, alias: remote.alias };
        } else {
            remotes[name] = {
                kind: "explicit",
                name,
                host: remote.host,
                user: remote.user,
                port: remote.port ?? 22,
                identityFile: remote.identityFile,
                passphrase:
                    remote.passphrase === undefined
                        ? null
                        : remote.passphrase === "prompt"
                          ? { kind: "prompt", value: "" }
                          : { kind: "file", value: remote.passphrase.slice("file:".length) },
                knownHostsFile: remote.knownHostsFile ?? join(configDir, "known_hosts"),
            };
        }
    }

    const topRetention = validated.retention ?? null;
    const targets: ResolvedTarget[] = validated.targets.map(({ name, target }) => {
        const remoteRef = remotes[target.remote];
        /** Build a remote endpoint on this target's remote. */
        const remoteEndpoint = (path: string): Endpoint => ({ kind: "remote", remote: remoteRef, path });
        /** Build a local endpoint. */
        const localEndpoint = (path: string): Endpoint => ({ kind: "local", path });
        const src = target.direction === "pull" ? remoteEndpoint(target.source) : localEndpoint(target.source);
        const dst =
            target.direction === "pull" ? localEndpoint(target.destination) : remoteEndpoint(target.destination);
        const minFreeText = target.minFree === undefined ? "5%" : target.minFree;
        return {
            name,
            direction: target.direction,
            remoteName: target.remote,
            remoteRef,
            source: target.source,
            destination: target.destination,
            exclude: target.exclude ?? [],
            schedule: resolveSchedule(target.schedule),
            retention: target.retention === false ? null : (target.retention ?? topRetention),
            retry: { attempts: target.retry?.attempts ?? 5 },
            minFree: minFreeText === false ? null : parseMinFree(minFreeText),
            rsync: {
                compress: target.rsync?.compress ?? true,
                bwlimit: target.rsync?.bwlimit ?? null,
                ioTimeoutSec: target.rsync?.ioTimeoutSec ?? 600,
                xattrs: target.rsync?.xattrs ?? false,
                preserveOwnership: target.rsync?.preserveOwnership ?? true,
                preserveDevices: target.rsync?.preserveDevices ?? false,
                remoteRsyncBin: target.rsync?.remoteRsyncBin ?? null,
                verify: target.rsync?.verify ?? false,
            },
            jail: target.direction === "push" ? (target.jail ?? true) : false,
            enabled: target.enabled ?? true,
            src,
            dst,
        };
    });

    return {
        name: validated.name ?? "backupkit",
        remotes,
        targets,
        retention: topRetention,
        stateDir: validated.stateDir ?? defaultStateDir(environment),
        logging: {
            level: validated.logging?.level ?? "info",
            file: validated.logging?.file ?? null,
        },
        rsyncBin: validated.rsyncBin ?? null,
        sshBin: validated.sshBin ?? null,
        configPath,
        warnings: validated.warnings,
    };
}
