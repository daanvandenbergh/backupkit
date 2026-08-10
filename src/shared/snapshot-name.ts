/**
 * THE snapshot-name codec - the single source of truth for snapshot directory
 * names in the whole codebase. A guard test fails the build if any competing
 * timestamp pattern appears outside this file. `runId` reuses this codec.
 *
 * Name form: UTC ISO-basic without colons, e.g. "2026-08-10T031502Z".
 * Lexical sort order equals chronological order by construction.
 */

/**
 * The one snapshot-name regex: `^\d{4}-\d{2}-\d{2}T\d{6}Z$` with capture
 * groups for year, month, day, hour, minute, second. Every destructive
 * operation in the codebase acts only on names matching this regex or its
 * `.partial`/`.deleting` suffixed forms.
 */
export const SNAPSHOT_NAME_REGEX: RegExp = /^(\d{4})-(\d{2})-(\d{2})T(\d{2})(\d{2})(\d{2})Z$/;

/** Left-pad a non-negative integer with zeros to the given width. */
function pad(value: number, width: number): string {
    return String(value).padStart(width, "0");
}

/**
 * Format a Date as a snapshot name: UTC, truncated to whole seconds,
 * e.g. "2026-08-10T031502Z".
 */
export function formatSnapshotName(date: Date): string {
    return (
        pad(date.getUTCFullYear(), 4) +
        "-" +
        pad(date.getUTCMonth() + 1, 2) +
        "-" +
        pad(date.getUTCDate(), 2) +
        "T" +
        pad(date.getUTCHours(), 2) +
        pad(date.getUTCMinutes(), 2) +
        pad(date.getUTCSeconds(), 2) +
        "Z"
    );
}

/**
 * Parse a snapshot name back to its UTC Date. Strict: the name must match
 * SNAPSHOT_NAME_REGEX AND denote a real calendar date-time (a round-trip
 * through formatSnapshotName must reproduce it, so "2026-02-30..." and hour
 * 25 are rejected). Returns null for anything else - including legacy
 * epoch-second names, which never match the regex.
 */
export function parseSnapshotName(name: string): Date | null {
    const match = SNAPSHOT_NAME_REGEX.exec(name);
    if (match === null) {
        return null;
    }
    const [, year, month, day, hour, minute, second] = match;
    const date = new Date(
        Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second)),
    );
    return formatSnapshotName(date) === name ? date : null;
}

/**
 * True when a directory entry is an in-progress snapshot: a valid snapshot
 * name followed by exactly ".partial".
 */
export function isPartialName(entry: string): boolean {
    const suffix = ".partial";
    return entry.endsWith(suffix) && parseSnapshotName(entry.slice(0, -suffix.length)) !== null;
}

/**
 * True when a directory entry is a snapshot mid two-phase delete: a valid
 * snapshot name followed by exactly ".deleting".
 */
export function isDeletingName(entry: string): boolean {
    const suffix = ".deleting";
    return entry.endsWith(suffix) && parseSnapshotName(entry.slice(0, -suffix.length)) !== null;
}
