/**
 * Sanitization of untrusted strings before logging, report inclusion, or
 * classification. All remote-derived data (filenames, stderr) passes through
 * here so a hostile remote can never inject newlines or terminal escapes.
 */

/** Every C0 control character (0x00-0x1f, incl. NUL, \n, \r, \x1b) plus DEL. */
const CONTROL_CHARS = /[\x00-\x1f\x7f]/g;

/**
 * Strip every C0 control character (NUL, newline, carriage return, ESC, tab,
 * and the rest) and DEL from a string. Printable text and non-ASCII pass
 * through unchanged.
 */
export function sanitize(value: string): string {
    return value.replace(CONTROL_CHARS, "");
}
