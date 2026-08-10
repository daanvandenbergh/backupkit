import { describe, expect, it } from "vitest";
import { isBackupkitError } from "../../shared/errors.js";
import { quoteShellArg } from "../internal/quote.js";

describe("quoteShellArg", () => {
    it.each([
        ["plain word", "abc", "'abc'"],
        ["empty string", "", "''"],
        ["space", "a b", "'a b'"],
        ["dollar", "$HOME", "'$HOME'"],
        ["backtick", "`id`", "'`id`'"],
        ["double quote", 'say "hi"', "'say \"hi\"'"],
        ["semicolon chain", "x; rm -rf /", "'x; rm -rf /'"],
        ["glob and pipes", "*|&&>", "'*|&&>'"],
        ["backslash", "a\\b", "'a\\b'"],
        ["single quote", "it's", "'it'\\''s'"],
        ["only quotes", "'''", "''\\'''\\'''\\'''"],
        ["leading dash", "-rf", "'-rf'"],
        ["unicode", "snäpshot", "'snäpshot'"],
        ["tab stays quoted data", "a\tb", "'a\tb'"],
    ])("wraps %s as exactly one shell word", (_label, input, expected) => {
        expect(quoteShellArg(input)).toBe(expected);
    });

    it.each([
        ["NUL", "a\0b"],
        ["newline", "a\nb"],
        ["carriage return", "a\rb"],
    ])("rejects %s with an SshError", (_label, input) => {
        expect(() => quoteShellArg(input)).toThrowError(/NUL or newline/);
        try {
            quoteShellArg(input);
        } catch (error) {
            expect(isBackupkitError(error) && error.code === "ssh").toBe(true);
        }
    });
});
