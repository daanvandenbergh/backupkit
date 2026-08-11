/**
 * THE shell quoter (security invariant 2): every remote command argv element
 * passes through here before it is joined into the single command string ssh
 * receives. No other code in the codebase constructs remote commands.
 */

import { SshError } from "../../shared/errors.js";

/** Characters a quoted value may never contain: NUL and newline-class chars break the single-token guarantee. */
const FORBIDDEN = /[\0\n\r]/;

/**
 * The only characters a BARE (unquoted) argv element may contain. Deliberately
 * an allowlist of inert ones: no whitespace, no quote, no `$`, backtick,
 * backslash, glob, redirect, or separator character can appear, so the value
 * survives word-splitting as exactly one token and carries no shell meaning in
 * any POSIX-ish parser. Everything backupkit sends bare is already narrower
 * than this (absolute paths without whitespace - the config validator refuses
 * others - plus fixed flags and regex-fixed snapshot names).
 */
const BARE_SAFE = /^[A-Za-z0-9._/@:=+,-]+$/;

/**
 * Quote one argv element for a POSIX shell: reject NUL/newline outright, then
 * wrap in single quotes with embedded single quotes escaped as `'\''`. The
 * result is always exactly one shell word, whatever the input contains.
 */
export function quoteShellArg(value: string): string {
    if (FORBIDDEN.test(value)) {
        throw new SshError("refusing to shell-quote a value containing NUL or newline characters");
    }
    return "'" + value.replaceAll("'", "'\\''") + "'";
}

/**
 * The quoter for a remote whose shell cannot parse quotes at all: return the
 * element unchanged, but ONLY if it is provably one inert shell word
 * ({@link BARE_SAFE}) - otherwise refuse to send the command.
 *
 * Restricted appliance shells (a Hetzner Storage Box) treat `'mkdir'` as a
 * command literally named `'mkdir'` and answer "Command not found", so quoting
 * makes every lifecycle command fail there. There is no escaping mechanism such
 * a shell would honour, so the safety has to come from the value instead of
 * from the encoding: refuse-on-doubt, never escape-and-hope. That inverts the
 * usual quoter's contract - `quoteShellArg` makes ANY value one word, this one
 * only passes values that already are - which is why it is opt-in per remote
 * (`"restrictedShell": true`) and never the default.
 */
export function bareShellArg(value: string): string {
    if (!BARE_SAFE.test(value)) {
        throw new SshError(
            "refusing to send an unquotable value to a restrictedShell remote: " +
                "only [A-Za-z0-9._/@:=+,-] may appear in a bare argument",
        );
    }
    return value;
}
