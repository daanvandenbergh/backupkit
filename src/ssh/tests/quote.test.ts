import { describe, expect, it } from "vitest";
import { isBackupkitError } from "../../shared/errors.js";
import { bareShellArg, quoteShellArg } from "../internal/quote.js";

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

// The restricted-shell quoter cannot make a value safe (the appliance shell
// strips nothing and honours no escape), so it must REFUSE anything that is not
// already one inert word. Every element backupkit sends bare is narrower than
// this charset by construction, so a rejection here means a bug upstream, not a
// legitimate path the operator should work around.
describe("bareShellArg", () => {
    it.each([
        ["absolute path", "/home/backupkit/persistance"],
        ["snapshot name", "2026-08-11T031502Z.partial"],
        ["flag", "--"],
        ["short flag", "-Pk"],
        ["rsync path form", "u625054@host:/home/x"],
        ["option with value", "--maxdepth=1"],
        ["dotted", "..backupkit.lock"],
    ])("passes %s through unchanged", (_label, input) => {
        expect(bareShellArg(input)).toBe(input);
    });

    it.each([
        ["a space", "/home/my backups"],
        ["a single quote", "/home/it's"],
        ["a double quote", '/home/"x"'],
        ["a dollar", "$HOME"],
        ["a backtick", "`id`"],
        ["a semicolon", "x;rm"],
        ["a pipe", "a|b"],
        ["a glob", "/home/*"],
        ["a redirect", "a>b"],
        ["a backslash", "a\\b"],
        ["a newline", "a\nb"],
        ["a NUL", "a\0b"],
        ["a tab", "a\tb"],
        ["non-ascii", "snäpshot"],
        ["the empty string", ""],
    ])("refuses %s rather than escaping it", (_label, input) => {
        expect(() => bareShellArg(input)).toThrowError(/unquotable/);
        try {
            bareShellArg(input);
        } catch (error) {
            expect(isBackupkitError(error) && error.code === "ssh").toBe(true);
        }
    });
});
