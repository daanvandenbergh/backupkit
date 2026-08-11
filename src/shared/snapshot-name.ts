/**
 * THE snapshot-name codec - the single source of truth for snapshot directory
 * names in the whole codebase. A guard test fails the build if any competing
 * timestamp pattern appears outside this file. `runId` reuses this codec.
 *
 * Name form: UTC ISO-basic without colons, e.g. "2026-08-10T031502Z" - the
 * human-facing `formatUtc` timestamp with the colons stripped, because `:` is
 * an illegal filename character on exFAT/NTFS/SMB destinations (a USB backup
 * drive, a NAS share). Lexical sort order equals chronological order by
 * construction, and seconds are load-bearing: the name is the uniqueness key,
 * so a minute-resolution form would make two runs in the same minute collide
 * at promote time - after a full transfer.
 */

import { formatUtc } from "./format.js";

/**
 * The one snapshot-name regex: `^\d{4}-\d{2}-\d{2}T\d{6}Z$` with capture
 * groups for year, month, day, hour, minute, second. Every destructive
 * operation in the codebase acts only on names matching this regex or its
 * `.partial`/`.deleting` suffixed forms.
 */
export const SNAPSHOT_NAME_REGEX: RegExp = /^(\d{4})-(\d{2})-(\d{2})T(\d{2})(\d{2})(\d{2})Z$/;

/**
 * Format a Date as a snapshot name: UTC, truncated to whole seconds,
 * e.g. "2026-08-10T031502Z". Derived from `formatUtc` so the filename form
 * and the displayed form cannot drift apart.
 */
export function formatSnapshotName(date: Date): string {
    return formatUtc(date).replaceAll(":", "");
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
