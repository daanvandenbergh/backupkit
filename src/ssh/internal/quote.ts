/**
 * THE shell quoter (security invariant 2): every remote command argv element
 * passes through here before it is joined into the single command string ssh
 * receives. No other code in the codebase constructs remote commands.
 */

import { SshError } from "../../shared/errors.js";

/** Characters a quoted value may never contain: NUL and newline-class chars break the single-token guarantee. */
const FORBIDDEN = /[\0\n\r]/;

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
