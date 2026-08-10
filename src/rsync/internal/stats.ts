/**
 * Parser for rsync `--info=stats2` output. Every rsync child runs under
 * LC_ALL=C (exec/'s minimal env), so the labels are stable English and the
 * numbers use comma thousands-grouping - the parser strips commas and nothing
 * else. Pure string work; the caller decides what a null (unparsable) means.
 */

/** The numbers backupkit consumes from one stats2 block. */
export interface RsyncStats {
    /** "Number of regular files transferred". */
    filesTransferred: number;
    /** "Number of files" (all types, both sides' file list). */
    totalFiles: number;
    /**
     * "Total transferred file size" in bytes - the real delta. From an
     * estimate (--dry-run) pass this is `deltaBytes` for the disk guard; from
     * the transfer pass it is the report's `bytesTransferred`.
     */
    totalTransferredSize: number;
}

/**
 * Extract the integer following `<label>:` on its own stats line. Tolerates
 * comma grouping and trailing text ("bytes", "(reg: ..., dir: ...)"). Returns
 * null when the label is absent or its value is not a number.
 */
function statValue(output: string, label: string): number | null {
    const pattern = new RegExp(`^${label}:\\s+([0-9][0-9,]*)`, "m");
    const match = pattern.exec(output);
    if (match === null) {
        return null;
    }
    const value = Number(match[1].replaceAll(",", ""));
    return Number.isFinite(value) ? value : null;
}

/**
 * Parse one rsync --info=stats2 output block. Returns null when any required
 * line is missing (truncated output, wrong locale, not a stats block).
 */
export function parseStats2(output: string): RsyncStats | null {
    const filesTransferred = statValue(output, "Number of regular files transferred");
    const totalFiles = statValue(output, "Number of files");
    const totalTransferredSize = statValue(output, "Total transferred file size");
    if (filesTransferred === null || totalFiles === null || totalTransferredSize === null) {
        return null;
    }
    return { filesTransferred, totalFiles, totalTransferredSize };
}
