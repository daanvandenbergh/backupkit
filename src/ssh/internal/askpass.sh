#!/bin/sh
# backupkit SSH_ASKPASS helper: emit the passphrase from the 0600 file the
# parent names via BACKUPKIT_PASSPHRASE_FILE. The passphrase itself never
# appears in argv or the environment.
cat "$BACKUPKIT_PASSPHRASE_FILE"
