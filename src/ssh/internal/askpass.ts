/**
 * The SSH_ASKPASS wiring for `file:` passphrase keys (security invariant 3):
 * the passphrase itself never appears in config values, env, argv, or logs -
 * only the 0600 passphrase FILE PATH travels in the environment, and the
 * shipped askpass.sh helper cats it when ssh-add asks.
 */

import { fileURLToPath } from "node:url";

/**
 * Absolute path to the shipped askpass.sh helper, co-located with this module
 * (src/ssh/internal/ in dev; dist/ssh/internal/ once built - the build script
 * copies the asset next to the compiled file).
 */
export function askpassScriptPath(): string {
    return fileURLToPath(new URL("./askpass.sh", import.meta.url));
}

/**
 * The three environment variables that make ssh-add read an encrypted key's
 * passphrase from a file via the shipped helper: SSH_ASKPASS points at
 * askpass.sh, SSH_ASKPASS_REQUIRE=force makes ssh-add use it even with a TTY,
 * and BACKUPKIT_PASSPHRASE_FILE names the 0600 file the helper cats.
 */
export function askpassEnv(passphraseFile: string): Record<string, string> {
    return {
        SSH_ASKPASS: askpassScriptPath(),
        SSH_ASKPASS_REQUIRE: "force",
        BACKUPKIT_PASSPHRASE_FILE: passphraseFile,
    };
}
