/**
 * Sanitization of untrusted strings before logging, report inclusion, or
 * classification. All remote-derived data (filenames, stderr) passes through
 * here so a hostile remote can never inject newlines or terminal escapes.
 */

/**
 * Every C0 control (0x00-0x1f, incl. NUL, \n, \r, \x1b), DEL (0x7f), the C1
 * controls (0x80-0x9f, incl. U+009B CSI - a single-byte terminal-escape
 * introducer), and the bidi/line-separator codepoints U+2028 (LINE SEPARATOR),
 * U+2029 (PARAGRAPH SEPARATOR) and U+202E (RIGHT-TO-LEFT OVERRIDE). Escapes,
 * not literals: a literal U+2028/U+2029 is a JS line terminator in source.
 */
const CONTROL_CHARS = /[\x00-\x1f\x7f-\x9f\u2028\u2029\u202e]/g;

/**
 * Strip every C0/C1 control character (NUL, newline, carriage return, ESC, tab,
 * DEL, the C1 CSI introducer, and the rest) plus the bidi/line-separator
 * codepoints that can spoof or reflow a log line. Printable text and ordinary
 * non-ASCII pass through unchanged.
 */
export function sanitize(value: string): string {
    return value.replace(CONTROL_CHARS, "");
}
