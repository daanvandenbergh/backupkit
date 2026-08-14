/**
 * `~` expansion for the LOCAL paths in a config file, and nothing else.
 *
 * Every path in a `ResolvedConfig` is absolute - the jail's prefix test, the
 * unit's `ReadWritePaths`, and the snapshot-root overlap check all compare
 * paths as strings, so a `~` that survived into one of them would silently
 * mean a different directory to each reader. Expanding here, at validation
 * time, keeps that invariant: `~` is a spelling a person may use in the file,
 * never a value the rest of the codebase can encounter.
 */

/** The outcome of one expansion: the expanded path, or the reason it cannot be expanded. */
export type HomeExpansion = { path: string } | { error: string };

/**
 * Expand a leading `~` (alone, or as the `~/...` prefix) against `home`.
 *
 * A path not starting with `~` is returned unchanged, so this is safe to run
 * over every path field. `~user/...` is refused rather than guessed: resolving
 * another account's home means reading the password database, and the value
 * would then depend on which machine parsed the config. An empty or relative
 * `home` is refused for the same reason a relative path is - the result would
 * not be absolute.
 */
export function expandHome(value: string, home: string): HomeExpansion {
    if (!value.startsWith("~")) {
        return { path: value };
    }
    if (value !== "~" && !value.startsWith("~/")) {
        return { error: '"~user" is not supported - write the absolute path' };
    }
    if (!home.startsWith("/")) {
        return {
            error:
                home === ""
                    ? '"~" cannot be expanded here - no home directory is known (HOME is unset); write the absolute path'
                    : `"~" cannot be expanded here - the home directory (${home}) is not absolute; write the absolute path`,
        };
    }
    // "~" -> the home itself; "~/rest" -> home + "/rest". Duplicate slashes from
    // a "/" home are collapsed by the caller's normalization.
    return { path: value === "~" ? home : `${home}/${value.slice(2)}` };
}
