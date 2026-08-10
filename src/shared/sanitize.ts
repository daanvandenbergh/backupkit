/**
 * Sanitization of untrusted strings before logging, report inclusion, or
 * classification. All remote-derived data (filenames, stderr) passes through
 * here so a hostile remote can never inject newlines or terminal escapes.
 */

/**
 * Every C0 control (0x00-0x1f, incl. NUL, \n, \r, \x1b), DEL (0x7f), the C1
 * controls (0x80-0x9f, incl. U+009B CSI - a single-byte terminal-escape
 * introducer), the line separators U+2028 and U+2029, and the COMPLETE bidi
 * control set: U+061C (ALM), U+200E/U+200F (LRM/RLM), U+202A-U+202E
 * (LRE/RLE/PDF/LRO/RLO) and U+2066-U+2069 (LRI/RLI/FSI/PDI). All of them
 * reorder operator-facing text the way U+202E does, so stripping only the
 * famous one leaves the spoof intact ("invoice<RLI>gpj.exe"). Escapes, not
 * literals: a literal U+2028/U+2029 is a JS line terminator in source, and the
 * bidi controls are invisible in an editor.
 */
const CONTROL_CHARS = /[\x00-\x1f\x7f-\x9f\u061c\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g;

/**
 * Strip every C0/C1 control character (NUL, newline, carriage return, ESC, tab,
 * DEL, the C1 CSI introducer, and the rest) plus the line separators and every
 * bidi control that can spoof or reflow a log line. Printable text and ordinary
 * non-ASCII (accents, CJK, emoji) pass through unchanged.
 */
export function sanitize(value: string): string {
    return value.replace(CONTROL_CHARS, "");
}
