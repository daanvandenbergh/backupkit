/**
 * Config loading: `resolveConfigPath` (the 4-step resolution order, identical
 * for every command) and the synchronous `loadConfig` (read -> parseJsonc ->
 * validate -> resolve defaults). The only filesystem the config module ever
 * touches is the config file itself (plus existence probes of the two
 * candidate filenames).
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { ConfigError } from "../shared/errors.js";
import { parseJsonc } from "./internal/jsonc.js";
import { validateConfig } from "./internal/validate.js";
import { resolveConfig } from "./internal/defaults.js";
import type { ResolvedConfig } from "./types.js";

/** Injectable inputs for path resolution (tests never touch /etc). */
export interface ResolvePathOptions {
    /** Environment variables (BACKUPKIT_CONFIG, XDG_CONFIG_HOME, HOME are read). Default process.env. */
    env?: Record<string, string | undefined>;
    /**
     * Directories probed for config.jsonc/config.json, in order. Default:
     * /etc/backupkit, then ${XDG_CONFIG_HOME:-~/.config}/backupkit.
     */
    probeDirs?: string[];
}

/** Injectable inputs for loadConfig (superset of path resolution). */
export interface LoadConfigOptions extends ResolvePathOptions {
    /** Effective uid for the stateDir default. Default: process.getuid?.(). */
    euid?: number | null;
    /** Home directory for the stateDir default. Default: os.homedir(). */
    homeDir?: string;
}

/** The default probe directories for the given environment. */
function defaultProbeDirs(env: Record<string, string | undefined>): string[] {
    const configHome = env.XDG_CONFIG_HOME ?? join(env.HOME ?? homedir(), ".config");
    return ["/etc/backupkit", join(configHome, "backupkit")];
}

/**
 * Put one config-path candidate into the single normal form every path in a
 * ResolvedConfig is in: NUL/newline refused, then made absolute against the
 * current working directory and normalized (`.`/`..`/duplicate slashes gone).
 *
 * `configPath` is not just a file to read - it is a ResolvedConfig member, and
 * `dirname(configPath)` feeds the unit's `ReadWritePaths`, the default
 * `knownHostsFile` location, and the unit's `ExecStart`. A relative
 * `--config config.jsonc` therefore produced `ReadWritePaths="."` and
 * `ExecStart=... "--config" "config.jsonc"` in a ROOT unit that systemd starts
 * with cwd `/` (a crash loop), and a cwd-dependent host-key store where an
 * interactive `check` from another directory pins a fresh key instead of
 * comparing against the pinned one.
 */
function normalizeConfigPath(value: string): string {
    if (/[\0\n\r]/.test(value)) {
        throw new ConfigError("config file path may not contain NUL or newline characters");
    }
    return resolve(value);
}

/**
 * Resolve the config file path using the fixed order: (1) the CLI --config
 * argument, (2) $BACKUPKIT_CONFIG, (3) /etc/backupkit/,
 * (4) ${XDG_CONFIG_HOME:-~/.config}/backupkit/ - the directory steps probe
 * config.jsonc then config.json and fail loudly when BOTH exist ("keep one").
 * A missing path from steps 1-2 is a ConfigError, never a fallthrough;
 * nothing found anywhere is a ConfigError listing every probed path. Whatever
 * the source, the returned path is absolute and normalized
 * (`normalizeConfigPath`).
 */
export function resolveConfigPath(cliArg?: string, options?: ResolvePathOptions): string {
    const env = options?.env ?? process.env;
    const verbatim = cliArg ?? env.BACKUPKIT_CONFIG;
    if (verbatim !== undefined && verbatim !== "") {
        const path = normalizeConfigPath(verbatim);
        if (!existsSync(path)) {
            throw new ConfigError(`config file not found: ${path}`);
        }
        return path;
    }
    const probeDirs = options?.probeDirs ?? defaultProbeDirs(env);
    const probed: string[] = [];
    for (const dir of probeDirs) {
        const jsonc = join(dir, "config.jsonc");
        const json = join(dir, "config.json");
        const hasJsonc = existsSync(jsonc);
        const hasJson = existsSync(json);
        if (hasJsonc && hasJson) {
            throw new ConfigError(`both ${jsonc} and ${json} exist - keep one`);
        }
        if (hasJsonc) {
            return normalizeConfigPath(jsonc);
        }
        if (hasJson) {
            return normalizeConfigPath(json);
        }
        probed.push(jsonc, json);
    }
    throw new ConfigError(`no config file found (looked for ${probed.join(", ")}) - run "backupkit init" to create one`);
}

/**
 * Load, parse, validate, and resolve the config - synchronous, no I/O beyond
 * the config file. Any extension is parsed as JSONC (valid JSON is a strict
 * subset). Throws ConfigError on every failure mode.
 */
export function loadConfig(cliArg?: string, options?: LoadConfigOptions): ResolvedConfig {
    const path = resolveConfigPath(cliArg, options);
    let text: string;
    try {
        text = readFileSync(path, "utf8");
    } catch (error) {
        throw new ConfigError(`cannot read config file ${path}: ${(error as Error).message}`, { file: path });
    }
    const root = parseJsonc(text, path);
    const validated = validateConfig(root, path);
    return resolveConfig(validated, path, {
        euid: options?.euid !== undefined ? options.euid : (process.getuid?.() ?? null),
        env: options?.env ?? process.env,
        homeDir: options?.homeDir ?? homedir(),
    });
}
