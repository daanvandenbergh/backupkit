/**
 * Human formatting (bytes, durations), the size grammar shared by `minFree`
 * and `bwlimit`, and `formatEndpoint` - the ONLY place `user@host:` prefixing
 * and IPv6 bracketing happen in the codebase.
 */

import type { Endpoint } from "./types.js";

/** Binary multiplier per size-suffix letter. */
const SIZE_MULTIPLIER: Record<string, number> = {
    K: 1024,
    M: 1024 ** 2,
    G: 1024 ** 3,
    T: 1024 ** 4,
};

/** Absolute size token: digits (optional decimal) + one of K/M/G/T (binary units). */
const SIZE_REGEX = /^([0-9]+(?:\.[0-9]+)?)([KMGT])$/;

/** Percent token: digits (optional decimal) + "%". */
const PERCENT_REGEX = /^([0-9]+(?:\.[0-9]+)?)%$/;

/** rsync bwlimit token: digits (optional decimal) + optional K/M/G suffix. */
const BWLIMIT_REGEX = /^[0-9]+(\.[0-9]+)?[KMG]?$/;

/**
 * Parse an absolute size token ("500M", "10G", "1.5T") into bytes using
 * binary units. Returns null when the token does not match the grammar.
 */
export function parseSize(text: string): number | null {
    const match = SIZE_REGEX.exec(text);
    if (match === null) {
        return null;
    }
    return Number(match[1]) * SIZE_MULTIPLIER[match[2]];
}

/** Parsed minFree floor: a percentage of the filesystem or an absolute byte count. */
export type MinFree =
    | {
          /** Discriminator: percentage of the archive filesystem. */
          kind: "percent";
          /** Percentage value, 0-50. */
          percent: number;
      }
    | {
          /** Discriminator: absolute byte floor. */
          kind: "bytes";
          /** Byte count (binary units). */
          bytes: number;
      };

/**
 * Parse a minFree token: "N%" (0-50) or an absolute size "10G"/"500M"
 * (binary units, K/M/G/T). Returns null for anything outside the grammar,
 * including a percentage above 50.
 */
export function parseMinFree(text: string): MinFree | null {
    const percentMatch = PERCENT_REGEX.exec(text);
    if (percentMatch !== null) {
        const percent = Number(percentMatch[1]);
        return percent <= 50 ? { kind: "percent", percent } : null;
    }
    const bytes = parseSize(text);
    return bytes === null ? null : { kind: "bytes", bytes };
}

/**
 * Whether a bwlimit token matches the rsync-compatible grammar: a bare number
 * (KiB/s) or a number with a K/M/G suffix. The validated token is passed to
 * rsync verbatim as one `--bwlimit=<v>` argv element.
 */
export function isValidBwlimit(text: string): boolean {
    return BWLIMIT_REGEX.test(text);
}

/** Binary byte-unit labels, ascending. */
const BYTE_UNITS = ["B", "KiB", "MiB", "GiB", "TiB", "PiB"] as const;

/**
 * Format a byte count for humans using binary units: "812 B", "10.0 MiB",
 * "1.5 GiB". One decimal from KiB upward.
 */
export function formatBytes(bytes: number): string {
    let value = bytes;
    let unit = 0;
    while (value >= 1024 && unit < BYTE_UNITS.length - 1) {
        value /= 1024;
        unit += 1;
    }
    return unit === 0 ? `${value} B` : `${value.toFixed(1)} ${BYTE_UNITS[unit]}`;
}

/**
 * Format a duration for humans: "743ms", "41s", "2m 5s", "1h 4m", "2d 3h".
 * Two largest applicable units, integer values.
 */
export function formatDuration(ms: number): string {
    if (ms < 1000) {
        return `${Math.round(ms)}ms`;
    }
    const seconds = Math.floor(ms / 1000);
    if (seconds < 60) {
        return `${seconds}s`;
    }
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) {
        const rest = seconds % 60;
        return rest === 0 ? `${minutes}m` : `${minutes}m ${rest}s`;
    }
    const hours = Math.floor(minutes / 60);
    if (hours < 24) {
        const rest = minutes % 60;
        return rest === 0 ? `${hours}h` : `${hours}h ${rest}m`;
    }
    const days = Math.floor(hours / 24);
    const rest = hours % 24;
    return rest === 0 ? `${days}d` : `${days}d ${rest}h`;
}

/**
 * Format an endpoint for rsync/display - the single owner of `user@host:`
 * prefixing and IPv6 bracketing. Local endpoints are the bare path. Explicit
 * remotes are `user@host:path` with an IPv6 host bracketed. Alias remotes are
 * `alias:path` - no `user@`, no brackets (the alias charset cannot contain
 * `:` or `@`, so rsync's host split is unambiguous). Ports never appear here;
 * they travel in the ssh tokens.
 */
export function formatEndpoint(endpoint: Endpoint): string {
    if (endpoint.kind === "local") {
        return endpoint.path;
    }
    const remote = endpoint.remote;
    if (remote.kind === "alias") {
        return `${remote.alias}:${endpoint.path}`;
    }
    const host = remote.host.includes(":") ? `[${remote.host}]` : remote.host;
    return `${remote.user}@${host}:${endpoint.path}`;
}
