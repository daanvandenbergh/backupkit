import { describe, expect, it } from "vitest";
import { sanitize } from "../sanitize.js";

describe("sanitize", () => {
    it.each([
        ["newlines", "a\nb", "ab"],
        ["carriage returns", "a\rb", "ab"],
        ["CRLF", "a\r\nb", "ab"],
        ["escape (ANSI injection)", "a\x1b[31mred", "a[31mred"],
        ["NUL", "a\0b", "ab"],
        ["tab", "a\tb", "ab"],
        ["bell", "a\x07b", "ab"],
        ["backspace", "a\x08b", "ab"],
        ["vertical tab and form feed", "a\v\fb", "ab"],
        ["DEL", "a\x7fb", "ab"],
        ["every C0 at once", "\x00\x01\x02\x03\x1e\x1fx", "x"],
    ] as const)("strips %s", (_label, input, expected) => {
        expect(sanitize(input)).toBe(expected);
    });

    it.each([
        ["plain text", "hello world"],
        ["the empty string", ""],
        ["printable punctuation", "a-b_c.d/e:f@g'h\"i"],
        ["non-ASCII text", "naïve café 日本語 🙂"],
        ["a snapshot name", "2026-08-10T031502Z"],
    ] as const)("passes %s through unchanged", (_label, input) => {
        expect(sanitize(input)).toBe(input);
    });

    it("neutralizes a hostile remote filename end to end", () => {
        const hostile = "ok\x1b]0;pwned\x07\r\nfake log line";
        expect(sanitize(hostile)).toBe("ok]0;pwnedfake log line");
    });
});
