#!/usr/bin/env bash
#
# backupkit manual release-gate smoke test (spec section 9, "Manual smoke
# script"). NEVER run in CI - this is the gate a human runs, once, before
# the first production use of backupkit (and after any change that touches
# ssh/, snapshots/, rsync/, engine/, or cli/internal/service/).
#
# What it does: drives the real backupkit CLI against two live SSH
# destinations - a "source" host (pull side) and an "archive" host (push
# side; either may be "localhost" or a throwaway container) - to exercise,
# end to end, the eight things a unit or integration test cannot see: a
# passphrase-protected key loading unattended, the backupkit-remote push
# jail (including a deliberate escape attempt), a pull that leaves zero
# credentials on the source, a mid-transfer kill and its recovery, the OS
# service lifecycle and crash-restart behavior, a disk-low skip, and a
# restore that diffs byte-identical against the snapshot it came from.
#
# Prerequisites:
#   - two SSH destinations (may be the same host, may be localhost/containers)
#     each with: ssh access for the invoking operator, rsync >= 3.2.5, and a
#     POSIX shell
#   - node >= 20, ssh, ssh-keygen, and rsync >= 3.2.5 on THIS machine
#   - a built backupkit: either run from inside a repo checkout with
#     dist/cli/main.js present (npm run build), or have `backupkit` on PATH
#   - an interactive terminal - this script pauses for operator confirmation
#     at every point that needs a remote-side change or human judgment
#
# Usage:
#   scripts/smoke-test.sh SOURCE_HOST ARCHIVE_HOST SCRATCH_DIR
#
#   SOURCE_HOST, ARCHIVE_HOST  "[user@]host[:port]" SSH destinations
#   SCRATCH_DIR                a directory this script may create files under
#
# Safety: every config.jsonc, ed25519 key, and passphrase this script uses
# is generated fresh under SCRATCH_DIR and removed on exit (trap EXIT),
# together with the two throwaway directories it creates on the remote hosts.
# It never reads or writes /etc, the operator's real backupkit config, or the
# operator's real SSH keys.
#
# What it CANNOT undo: the three things it asks the OPERATOR to install by
# hand on a remote host - the pull key line in the source host's
# authorized_keys (comment "backupkit-smoke-pull"), the push jail line in the
# archive host's authorized_keys (comment "backupkit-smoke-push"), and
# /usr/local/bin/backupkit-remote on the archive host. Those are the things
# that must legitimately live there, so this script only prints the exact text
# and waits - it has no way to revoke them afterwards. The summary at the end
# of every run prints the exact revocation commands; RUN THEM, or the run
# leaves live SSH trust behind.
#
# Exit status: 0 when every step passed, nonzero otherwise. A summary table
# is always printed, even when a step fails - a failed step is recorded and
# the script moves on to the rest, it does not die silently partway through.

set -euo pipefail

# ---------------------------------------------------------------------------
# small helpers
# ---------------------------------------------------------------------------

log() {
    printf '%s\n' "$*"
}

usage() {
    cat <<'EOF'
usage: smoke-test.sh SOURCE_HOST ARCHIVE_HOST SCRATCH_DIR

  SOURCE_HOST   "[user@]host[:port]" - the pull-side data source
  ARCHIVE_HOST  "[user@]host[:port]" - the push-side archive server
  SCRATCH_DIR   a directory this script may create throwaway files under

Either host may be "localhost". Run from an interactive terminal; this is
the manual release gate (spec section 9), never run it in CI.
EOF
}

# Resolve a path (following symlinks) using node, which is a required
# prerequisite anyway - avoids depending on GNU/BSD-specific `readlink -f`.
resolve_path() {
    node -e '
        const fs = require("node:fs");
        try {
            process.stdout.write(fs.realpathSync(process.argv[1]));
        } catch {
            process.stdout.write(process.argv[1]);
        }
    ' "$1"
}

# Split "[user@]host[:port]" into the P_USER/P_HOST/P_PORT globals.
parse_dest() {
    local dest=$1 user host port
    if [[ "$dest" == *@* ]]; then
        user=${dest%%@*}
        host=${dest#*@}
    else
        user=$(whoami)
        host=$dest
    fi
    if [[ "$host" == *:* ]]; then
        port=${host##*:}
        host=${host%%:*}
    else
        port=22
    fi
    P_USER=$user
    P_HOST=$host
    P_PORT=$port
}

# True when version string $1 (e.g. "3.2.7") is >= $2 (e.g. "3.2.5").
version_ge() {
    local a=$1 b=$2 i x y
    local IFS=.
    # shellcheck disable=SC2206  # deliberate IFS split, not glob
    local -a va=($a) vb=($b)
    for i in 0 1 2; do
        x=${va[i]:-0}
        y=${vb[i]:-0}
        if [ "$x" -gt "$y" ]; then
            return 0
        fi
        if [ "$x" -lt "$y" ]; then
            return 1
        fi
    done
    return 0
}

# True when a "rsync  version X.Y.Z  protocol ..." line meets the 3.2.5 floor.
check_rsync_version() {
    local line=$1 ver
    ver=$(printf '%s' "$line" | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -n1)
    [ -n "$ver" ] || return 1
    version_ge "$ver" "3.2.5"
}

# The newest complete (non-.partial, non-.deleting, non-lock) snapshot name
# directly under a local target directory, or empty when none exist.
# Snapshot names are fixed-width and lexically sortable by construction
# (shared/snapshot-name.ts), so a plain string-max walk finds the newest one.
get_latest_snapshot() {
    local dir=$1 entry name latest=""
    [ -d "$dir" ] || return 0
    for entry in "$dir"/*; do
        [ -e "$entry" ] || continue
        name=$(basename "$entry")
        case "$name" in
            *.partial | *.deleting | .backupkit.lock) continue ;;
        esac
        if [ -z "$latest" ] || [[ "$name" > "$latest" ]]; then
            latest=$name
        fi
    done
    printf '%s' "$latest"
}

# Pause for the operator to make a remote-side change this script will not
# make itself. Returns 1 (failing the enclosing step) if they type "skip".
ask_enter() {
    local prompt=$1 reply
    log "$prompt"
    read -r -p "press ENTER when done (or type 'skip' to fail this step): " reply
    [ "$reply" != "skip" ]
}

# Pause for a pass/fail verdict on something only a human can judge.
ask_pass_fail() {
    local prompt=$1 reply
    while true; do
        read -r -p "$prompt [pass/fail]: " reply
        case "$reply" in
            pass | PASS | p | P)
                return 0
                ;;
            fail | FAIL | f | F)
                return 1
                ;;
            *)
                log "please answer 'pass' or 'fail'"
                ;;
        esac
    done
}

# ---------------------------------------------------------------------------
# result tracking + step wrapper
#
# Each of the 8 spec steps is one function, run through run_step(). set -e
# is deliberately suspended only around the step's own invocation: a failing
# step is caught, recorded, and the script continues to the rest - it is
# never left to kill the whole run silently. Any OTHER unexpected error
# (outside a step, e.g. during setup) still trips set -e, and the EXIT trap
# below still cleans up before the script exits.
# ---------------------------------------------------------------------------

RESULTS=()
OVERALL_FAIL=0

step_header() {
    log ""
    log "---- step $1: $2 ----"
}

run_step() {
    local num=$1 name=$2 fn=$3 rc
    step_header "$num" "$name"
    set +e
    "$fn"
    rc=$?
    set -e
    if [ "$rc" -eq 0 ]; then
        RESULTS+=("$(printf 'PASS  step %d  %s' "$num" "$name")")
    else
        RESULTS+=("$(printf 'FAIL  step %d  %s (exit %d)' "$num" "$name" "$rc")")
        OVERALL_FAIL=1
    fi
}

# The remote-side trust this script asked the operator to install by hand.
# cleanup() cannot remove it (it lives in another user's authorized_keys and
# under /usr/local/bin, installed with sudo), so the run ends by printing the
# exact commands that revoke it. Printed unconditionally: a step that failed
# may still have installed its key before failing.
print_manual_cleanup() {
    # One drop-the-tagged-line command, with TAG substituted per host below.
    # shellcheck disable=SC2016  # printed for the operator to paste - expanded there, not here
    local ak='f=~/.ssh/authorized_keys; { grep -v TAG "$f" || true; } >"$f.new" && mv "$f.new" "$f" && chmod 600 "$f"'
    log ""
    log "-------- MANUAL CLEANUP (this script cannot do it for you) --------"
    log "If you got as far as installing them, these outlive the run:"
    log ""
    log "1. the pull key in ~/.ssh/authorized_keys of $SRC_USER on $SRC_HOST"
    log "   (the line whose key comment is 'backupkit-smoke-pull'):"
    log "     ssh -p $SRC_PORT $SRC_USER@$SRC_HOST '${ak/TAG/backupkit-smoke-pull}'"
    log ""
    log "2. the push jail line in ~/.ssh/authorized_keys of $DST_USER on $DST_HOST"
    log "   (the line whose key comment is 'backupkit-smoke-push'):"
    log "     ssh -p $DST_PORT $DST_USER@$DST_HOST '${ak/TAG/backupkit-smoke-push}'"
    log ""
    log "3. /usr/local/bin/backupkit-remote on $DST_HOST is STILL INSTALLED (you put it"
    log "   there with sudo). Keep it if that host is a real archive server; otherwise:"
    log "     ssh -p $DST_PORT $DST_USER@$DST_HOST 'sudo rm -f /usr/local/bin/backupkit-remote'"
    log ""
    log "Verify 1 and 2 - both must print 0:"
    log "     ssh -p $SRC_PORT $SRC_USER@$SRC_HOST 'grep -c backupkit-smoke-pull ~/.ssh/authorized_keys || true'"
    log "     ssh -p $DST_PORT $DST_USER@$DST_HOST 'grep -c backupkit-smoke-push ~/.ssh/authorized_keys || true'"
    log ""
    log "Step 1 connected with StrictHostKeyChecking=accept-new, so your own"
    log "known_hosts (~/.ssh/known_hosts) may have gained these hosts: remove with"
    log "'ssh-keygen -R $SRC_HOST' / 'ssh-keygen -R $DST_HOST' if you do not want them."
    log "-------------------------------------------------------------------"
}

print_summary() {
    log ""
    log "==================== smoke test summary ===================="
    local r
    for r in "${RESULTS[@]}"; do
        log "$r"
    done
    log "==============================================================="
    if [ "$OVERALL_FAIL" -eq 0 ]; then
        log "ALL STEPS PASSED"
    else
        log "ONE OR MORE STEPS FAILED - do not ship on this result"
    fi
    print_manual_cleanup
}

# ---------------------------------------------------------------------------
# cleanup - trap EXIT, always runs, never touches anything but what this
# script itself created
# ---------------------------------------------------------------------------

cleanup() {
    local rc=$?
    set +e
    if [ -n "${SRC_HOST:-}" ] && [ -n "${REMOTE_SRC_DIR:-}" ]; then
        local src_key_opt=()
        [ -f "${KEY_PULL:-}" ] && src_key_opt=(-i "$KEY_PULL")
        ssh -o BatchMode=yes -o ConnectTimeout=5 -p "${SRC_PORT:-22}" "${src_key_opt[@]}" \
            "$SRC_USER@$SRC_HOST" "rm -rf -- '$REMOTE_SRC_DIR'" >/dev/null 2>&1
    fi
    if [ -n "${DST_HOST:-}" ] && [ -n "${REMOTE_ARCHIVE_DIR:-}" ]; then
        local dst_key_opt=()
        [ -f "${KEY_PUSH:-}" ] && dst_key_opt=(-i "$KEY_PUSH")
        ssh -o BatchMode=yes -o ConnectTimeout=5 -p "${DST_PORT:-22}" "${dst_key_opt[@]}" \
            "$DST_USER@$DST_HOST" "rm -rf -- '$REMOTE_ARCHIVE_DIR'" >/dev/null 2>&1
    fi
    if [ -n "${WORK:-}" ] && [ -d "$WORK" ]; then
        rm -rf -- "$WORK"
    fi
    exit "$rc"
}

# ---------------------------------------------------------------------------
# prerequisites + CLI/path setup
# ---------------------------------------------------------------------------

check_prereqs() {
    local bin missing=0
    for bin in node ssh ssh-keygen rsync; do
        if ! command -v "$bin" >/dev/null 2>&1; then
            log "error: required binary not found: $bin"
            missing=1
        fi
    done
    [ "$missing" -eq 0 ] || exit 1
    local ver
    ver=$(rsync --version | head -n1)
    if ! check_rsync_version "$ver"; then
        log "error: local rsync does not meet the required >= 3.2.5 floor ($ver)"
        exit 1
    fi
}

# Autodetect the backupkit CLI: prefer a repo build next to this script,
# else fall back to an installed `backupkit` on PATH. Sets BACKUPKIT_CMD
# (an argv array) and JAIL_SH (the shipped backupkit-remote.sh path).
detect_backupkit() {
    local script_dir repo_root main_js
    script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)
    repo_root=$(cd "$script_dir/.." && pwd -P)
    if [ -f "$repo_root/dist/cli/main.js" ]; then
        BACKUPKIT_CMD=(node "$repo_root/dist/cli/main.js")
        main_js="$repo_root/dist/cli/main.js"
        log "using repo build: $main_js"
    elif command -v backupkit >/dev/null 2>&1; then
        BACKUPKIT_CMD=(backupkit)
        main_js=$(resolve_path "$(command -v backupkit)")
        log "using installed backupkit: $main_js"
    else
        log "error: no backupkit CLI found - run 'npm run build' in the repo"
        log "       (dist/cli/main.js is missing), or 'npm install -g @daanvandenbergh/backupkit'"
        exit 1
    fi
    JAIL_SH=$(resolve_path "$(dirname "$main_js")/../snapshots/internal/backupkit-remote.sh")
    if [ ! -f "$JAIL_SH" ]; then
        log "error: cannot find backupkit-remote.sh next to $main_js (looked at $JAIL_SH)"
        exit 1
    fi
}

# Run the detected backupkit CLI against this run's throwaway config.
bk() {
    "${BACKUPKIT_CMD[@]}" "$@" --config "$CONFIG_PATH"
}

# Compute every path/host/port variable this run needs, create the scratch
# work directory, and seed the local push-source content.
setup_paths() {
    local src_arg=$1 archive_arg=$2 scratch_arg=$3 run_id
    mkdir -p -- "$scratch_arg"
    SCRATCH_DIR=$(cd "$scratch_arg" && pwd -P)
    run_id="$(date +%Y%m%d%H%M%S)-$$"
    WORK="$SCRATCH_DIR/backupkit-smoke-$run_id"
    mkdir -p -- "$WORK/keys" "$WORK/archive" "$WORK/push-src" "$WORK/state" "$WORK/restore"

    parse_dest "$src_arg"
    SRC_USER=$P_USER
    SRC_HOST=$P_HOST
    SRC_PORT=$P_PORT
    parse_dest "$archive_arg"
    DST_USER=$P_USER
    DST_HOST=$P_HOST
    DST_PORT=$P_PORT

    KEY_PULL="$WORK/keys/pull_ed25519"
    KEY_PULL_PASS_FILE="$WORK/keys/pull.pass"
    KEY_PUSH="$WORK/keys/push_ed25519"
    LOCAL_ARCHIVE_DIR="$WORK/archive"
    LOCAL_PUSH_SRC_DIR="$WORK/push-src"
    STATE_DIR="$WORK/state"
    CONFIG_PATH="$WORK/config.jsonc"
    REMOTE_SRC_DIR="/tmp/backupkit-smoke-src-$run_id"
    REMOTE_ARCHIVE_DIR="/tmp/backupkit-smoke-archive-$run_id"

    printf 'hello from backupkit smoke test\n' >"$LOCAL_PUSH_SRC_DIR/hello.txt"
    mkdir -p -- "$LOCAL_PUSH_SRC_DIR/subdir"
    printf 'nested file\n' >"$LOCAL_PUSH_SRC_DIR/subdir/nested.txt"
}

# Generate both throwaway ed25519 keys up front (one passphrase-protected
# for the pull remote, one unencrypted for the push remote). Both must exist
# before ANY step calls `backupkit check` or `backupkit run`: check() loads
# and primes every explicit remote's key in one pass, so a config that
# names a not-yet-generated identityFile would fail the whole check, not
# just the remote that legitimately isn't ready yet.
setup_keys() {
    log "generating a throwaway passphrase-protected ed25519 key for the pull remote..."
    local pass
    pass=$(LC_ALL=C tr -dc 'A-Za-z0-9' </dev/urandom | head -c 24)
    printf '%s' "$pass" >"$KEY_PULL_PASS_FILE"
    chmod 600 "$KEY_PULL_PASS_FILE"
    ssh-keygen -q -t ed25519 -N "$pass" -C "backupkit-smoke-pull" -f "$KEY_PULL"
    chmod 600 "$KEY_PULL"

    log "generating a throwaway ed25519 key for the push remote..."
    ssh-keygen -q -t ed25519 -N "" -C "backupkit-smoke-push" -f "$KEY_PUSH"
    chmod 600 "$KEY_PUSH"
}

# Write the throwaway config.jsonc (section 2 schema). Written after
# setup_keys() so every identityFile it names already exists.
write_config() {
    cat >"$CONFIG_PATH" <<CONF
{
    // backupkit release-gate smoke test - throwaway, written by scripts/smoke-test.sh
    "name": "backupkit-smoke",
    "remotes": {
        "smoke-src": {
            "host": "$SRC_HOST",
            "user": "$SRC_USER",
            "port": $SRC_PORT,
            "identityFile": "$KEY_PULL",
            "passphrase": "file:$KEY_PULL_PASS_FILE"
        },
        "smoke-dst": {
            "host": "$DST_HOST",
            "user": "$DST_USER",
            "port": $DST_PORT,
            "identityFile": "$KEY_PUSH"
        }
    },
    "targets": {
        "pull-target": {
            "direction": "pull",
            "remote": "smoke-src",
            "source": "$REMOTE_SRC_DIR",
            "destination": "$LOCAL_ARCHIVE_DIR",
            "retention": false,
            "minFree": "5%"
        },
        "push-target": {
            "direction": "push",
            "remote": "smoke-dst",
            "source": "$LOCAL_PUSH_SRC_DIR",
            "destination": "$REMOTE_ARCHIVE_DIR",
            "retention": false
        },
        "diskguard-target": {
            "direction": "pull",
            "remote": "smoke-src",
            "source": "$REMOTE_SRC_DIR",
            "destination": "$LOCAL_ARCHIVE_DIR",
            "retention": false,
            "minFree": "1000000T"
        }
    },
    "stateDir": "$STATE_DIR",
    "logging": { "level": "info" }
}
CONF
}

# ---------------------------------------------------------------------------
# step 1: two hosts/containers - reachability, rsync floor, seed data
# ---------------------------------------------------------------------------

probe_host() {
    local user=$1 host=$2 port=$3 label=$4 ver_line
    if ! ssh -o BatchMode=yes -o ConnectTimeout=8 -o StrictHostKeyChecking=accept-new \
        -p "$port" "$user@$host" "true"; then
        log "  ssh to $label host failed (check connectivity / host key)"
        return 1
    fi
    ver_line=$(ssh -o BatchMode=yes -p "$port" "$user@$host" "rsync --version" 2>/dev/null | head -n1)
    log "  $label rsync: ${ver_line:-<not found>}"
    if ! check_rsync_version "$ver_line"; then
        log "  $label rsync does not meet the required >= 3.2.5 floor"
        return 1
    fi
    return 0
}

step1_verify_hosts() {
    log "probing source host $SRC_USER@$SRC_HOST:$SRC_PORT ..."
    probe_host "$SRC_USER" "$SRC_HOST" "$SRC_PORT" "source" || return 1
    log "probing archive host $DST_USER@$DST_HOST:$DST_PORT ..."
    probe_host "$DST_USER" "$DST_HOST" "$DST_PORT" "archive" || return 1

    log "seeding test data on the source host at $REMOTE_SRC_DIR ..."
    ssh -o BatchMode=yes -p "$SRC_PORT" "$SRC_USER@$SRC_HOST" \
        "mkdir -p -- '$REMOTE_SRC_DIR' \
         && printf 'hello world\n' > '$REMOTE_SRC_DIR/hello.txt' \
         && dd if=/dev/urandom of='$REMOTE_SRC_DIR/blob.bin' bs=1M count=1 2>/dev/null"
    return $?
}

# ---------------------------------------------------------------------------
# step 2: passphrase-protected key end to end via `backupkit check`
# ---------------------------------------------------------------------------

# The authorized_keys restriction prefix for the pull key. A pull needs no pty
# and no forwarding, so `restrict` costs nothing, and `from=` pins the key to
# this machine's address as the SOURCE host sees it (asked over the operator's
# own ssh session, which step 1 already proved works).
#
# ponytail: deliberately no `command=` forced command on the pull side. The
# only robust one is rsync's own rrsync helper, and it refuses any
# SSH_ORIGINAL_COMMAND that is not `rsync --server ...` - which would kill
# backupkit's remote rsync floor probe (`rsync --version`, rsync/rsync.ts),
# failing every check and run made with this key. Hand-pinning
# `command="rsync --server --sender -<flags> . <dir>"` is no better: the flag
# string varies with the target's options. Upgrade path: if the jail script
# ever learns a read-only `--sender` mode, force that command here.
pull_key_prefix() {
    local addr
    addr=$(ssh -o BatchMode=yes -o ConnectTimeout=8 -p "$SRC_PORT" "$SRC_USER@$SRC_HOST" \
        'set -- $SSH_CLIENT; printf "%s" "${1:-}"' 2>/dev/null) || addr=""
    if [ -n "$addr" ]; then
        printf 'restrict,from="%s"' "$addr"
    else
        printf 'restrict,from="<this machine, as %s sees it - FILL THIS IN>"' "$SRC_HOST"
    fi
}

step2_passphrase_key() {
    log "append this EXACT line to ~/.ssh/authorized_keys for $SRC_USER on $SRC_HOST"
    log "(the restriction prefix is part of the line - never install the bare key;"
    log " 'restrict' needs OpenSSH >= 7.2, on an older sshd replace it with"
    log " no-pty,no-agent-forwarding,no-port-forwarding,no-X11-forwarding)."
    log "A dedicated read-only account is still recommended for a pull source:"
    log ""
    log "$(pull_key_prefix) $(cat "$KEY_PULL.pub")"
    log ""
    ask_enter "add the line above on $SRC_HOST, then continue" || return 1

    log "running: backupkit check"
    log "(expects the passphrase to be primed unattended via the file: askpass path - no TTY prompt)"
    log "(the push remote is not jailed yet at this point and will show NOT reachable - expected;"
    log " this step only judges the pull remote and the local prereqs)"
    local out
    out=$(bk check) || true
    log "$out"
    if ! printf '%s' "$out" | grep -Eq "^remote smoke-src \[.*\]: reachable"; then
        log "expected the pull remote (smoke-src) to show reachable in the check output above"
        return 1
    fi
    if printf '%s' "$out" | grep -q "^local rsync: NOT OK"; then
        log "local rsync check failed"
        return 1
    fi
    if ! printf '%s' "$out" | grep -q "^local ssh: ok"; then
        log "local ssh check failed"
        return 1
    fi
    log "passphrase-protected key loaded unattended and the pull remote is reachable"
    return 0
}

# ---------------------------------------------------------------------------
# step 3: push through the backupkit-remote jail, incl. a rejected escape
# ---------------------------------------------------------------------------

step3_push_jail() {
    log "running: backupkit check to compute the push-target jail line"
    log "(the archive host will show as NOT reachable until the jail below is installed - expected)"
    # run_step already runs this whole function with errexit off, so a
    # nonzero check here (expected - the jail is not installed yet) just
    # falls through; no need to toggle set -e (doing so would re-arm
    # errexit for the rest of this step and defeat run_step's isolation).
    bk check | tee "$WORK/check-push.out"
    local jail_line
    jail_line=$(awk '/^# target push-target /{getline; print; exit}' "$WORK/check-push.out")
    if [ -z "$jail_line" ]; then
        log "could not read a jail line for push-target from 'backupkit check' output"
        return 1
    fi

    log ""
    log "on $DST_HOST as $DST_USER:"
    log "  1. install the jail script:"
    log "       scp \"$JAIL_SH\" \"$DST_USER@$DST_HOST:/tmp/backupkit-remote\""
    log "       ssh \"$DST_USER@$DST_HOST\" 'sudo install -m 755 /tmp/backupkit-remote /usr/local/bin/backupkit-remote'"
    log "  2. append this EXACT line to ~/.ssh/authorized_keys for $DST_USER:"
    log ""
    log "$jail_line"
    log ""
    ask_enter "install the jail script and authorized_keys line above, then continue" || return 1

    log "running: backupkit run push-target --force"
    bk run push-target --force

    log "confirming the jail rejects an arbitrary command (the escape attempt)..."
    local out rc
    out=$(ssh -o BatchMode=yes -o ConnectTimeout=8 -p "$DST_PORT" -i "$KEY_PUSH" \
        "$DST_USER@$DST_HOST" "id; cat /etc/passwd" 2>&1)
    rc=$?
    if [ "$rc" -eq 0 ]; then
        log "ESCAPE NOT BLOCKED: an arbitrary command succeeded through the jail"
        log "$out"
        return 1
    fi
    if ! printf '%s' "$out" | grep -q "rejected"; then
        log "jail refused the command (exit $rc) but did not print the expected 'rejected' message:"
        log "$out"
        return 1
    fi
    log "jail correctly rejected the escape attempt: $out"
    return 0
}

# ---------------------------------------------------------------------------
# step 4: pull with zero credentials on the source
# ---------------------------------------------------------------------------

step4_pull_zero_creds() {
    log "running: backupkit run pull-target --force"
    bk run pull-target --force

    log "verifying the pulled content matches the source..."
    local remote_sum local_sum latest
    remote_sum=$(ssh -o BatchMode=yes -p "$SRC_PORT" "$SRC_USER@$SRC_HOST" \
        "cd '$REMOTE_SRC_DIR' && find . -type f -exec cksum {} \; | sort")
    latest=$(get_latest_snapshot "$LOCAL_ARCHIVE_DIR/pull-target")
    if [ -z "$latest" ]; then
        log "no complete pull-target snapshot after the run"
        return 1
    fi
    local_sum=$(cd "$LOCAL_ARCHIVE_DIR/pull-target/$latest" && find . -type f -exec cksum {} \; | sort)
    if [ "$remote_sum" != "$local_sum" ]; then
        log "content mismatch between the source and the pulled snapshot"
        return 1
    fi
    log "content verified identical: $latest"
    log "$SRC_HOST holds no backupkit credential beyond the single authorized_keys line you added -"
    log "the private key and its passphrase live only under $WORK on this machine"
    return 0
}

# ---------------------------------------------------------------------------
# step 5: mid-transfer kill and recovery
# ---------------------------------------------------------------------------

step5_mid_transfer_kill() {
    local kill_file_mb=${SMOKE_KILL_FILE_MB:-40}
    local kill_delay_sec=${SMOKE_KILL_DELAY_SEC:-3}

    log "seeding a ${kill_file_mb}MiB file on the source to widen the transfer window..."
    ssh -o BatchMode=yes -p "$SRC_PORT" "$SRC_USER@$SRC_HOST" \
        "dd if=/dev/urandom of='$REMOTE_SRC_DIR/killtest.bin' bs=1M count=$kill_file_mb 2>/dev/null"

    log "starting: backupkit run pull-target --force (backgrounded)"
    "${BACKUPKIT_CMD[@]}" run pull-target --force --config "$CONFIG_PATH" >"$WORK/run-kill.log" 2>&1 &
    local run_pid=$!
    sleep "$kill_delay_sec"
    if ! kill -0 "$run_pid" 2>/dev/null; then
        log "the run already finished before the kill - lower SMOKE_KILL_DELAY_SEC or raise SMOKE_KILL_FILE_MB"
        return 1
    fi
    log "SIGKILL-ing the run (pid $run_pid) mid-transfer..."
    kill -9 "$run_pid" 2>/dev/null || true
    wait "$run_pid" 2>/dev/null || true

    local partial="" entry
    for entry in "$LOCAL_ARCHIVE_DIR/pull-target"/*.partial; do
        [ -e "$entry" ] && partial=$(basename "$entry")
        break
    done
    if [ -z "$partial" ]; then
        log "no .partial snapshot found after the kill - expected exactly one"
        return 1
    fi
    log "found the expected partial snapshot: $partial"

    log "re-running to confirm recovery (claimPartial resumes and promotes it)..."
    bk run pull-target --force

    local latest
    latest=$(get_latest_snapshot "$LOCAL_ARCHIVE_DIR/pull-target")
    if [ -z "$latest" ]; then
        log "no complete snapshot found after recovery"
        return 1
    fi
    if [ ! -f "$LOCAL_ARCHIVE_DIR/pull-target/$latest/killtest.bin" ]; then
        log "recovered snapshot is missing killtest.bin"
        return 1
    fi
    log "recovery produced a complete snapshot: $latest"
    return 0
}

# ---------------------------------------------------------------------------
# step 6: service install / start / stop / restart / status, crash-restart
#
# This step deliberately does NOT run `service install` itself: that verb
# writes a real systemd unit or launchd plist and requires root - doing it
# from this script would mean touching /etc, which this script promises
# never to do. Run it yourself, ideally in a disposable VM/container.
# ---------------------------------------------------------------------------

step6_service_lifecycle() {
    log "service install/start/stop/restart/status and crash-restart need root and write"
    log "real systemd/launchd units - this script will not do that on your behalf."
    log "Run these yourself (ideally in a disposable VM/container), pointed at the"
    log "throwaway config generated by this run:"
    log ""
    log "    sudo backupkit service install --config \"$CONFIG_PATH\""
    log "    sudo backupkit service start   --config \"$CONFIG_PATH\""
    log "    backupkit service status       --config \"$CONFIG_PATH\""
    log "    backupkit logs -f              --config \"$CONFIG_PATH\"     # in another terminal"
    log "    # find the daemon pid from 'service status', then:"
    log "    sudo kill -9 <daemon pid>"
    log "    # wait about 15s, then re-check status - it should be active again"
    log "    sudo backupkit service restart --config \"$CONFIG_PATH\""
    log "    sudo backupkit service stop    --config \"$CONFIG_PATH\""
    log "    sudo backupkit service uninstall --config \"$CONFIG_PATH\""
    log ""

    local ok=0
    ask_pass_fail "install + start succeeded, 'service status' showed active with a pid" || ok=1
    ask_pass_fail "kill -9 on the daemon: it came back within ~15s, and it resumed/caught up cleanly" || ok=1
    ask_pass_fail "restart/stop/status behaved idempotently with the documented messages, uninstall removed the unit" || ok=1
    return "$ok"
}

# ---------------------------------------------------------------------------
# step 7: disk-low skip
#
# ponytail: the disk-guard decision (engine/internal/disk-guard.ts) is pure
# arithmetic over free bytes vs. a configured floor - it does not care
# whether the underlying filesystem is actually small. Forcing minFree to a
# floor no real (or loopback) filesystem will ever satisfy exercises the
# exact same skip path a genuine tiny loopback mount would, without the
# platform-specific, usually-root-requiring ceremony of hdiutil/losetup.
# Add a real loopback mount here if a future bug is specifically in the
# statfs/percent-of-total-bytes arithmetic rather than the skip decision.
# ---------------------------------------------------------------------------

step7_disk_low() {
    log "running: backupkit run diskguard-target --force"
    log "(minFree is set to an unreachable 1000000T floor - this must skip, never delete anything)"
    local out
    out=$(bk run diskguard-target --force)
    log "$out"
    if ! printf '%s' "$out" | grep -q "diskguard-target: skipped reason=disk-low"; then
        log "expected 'diskguard-target: skipped reason=disk-low' in the run output"
        return 1
    fi
    if [ -d "$LOCAL_ARCHIVE_DIR/diskguard-target" ] && [ -n "$(ls -A "$LOCAL_ARCHIVE_DIR/diskguard-target" 2>/dev/null)" ]; then
        log "the disk-guard skip should not have written anything under $LOCAL_ARCHIVE_DIR/diskguard-target"
        return 1
    fi
    log "confirming backupkit stays alive after the skip (a second run behaves the same)..."
    bk run diskguard-target --force >/dev/null
    log "disk-low skip verified: nothing deleted, nothing written, backupkit kept running"
    return 0
}

# ---------------------------------------------------------------------------
# step 8: restore + diff
# ---------------------------------------------------------------------------

step8_restore_diff() {
    local latest out_dir
    latest=$(get_latest_snapshot "$LOCAL_ARCHIVE_DIR/pull-target")
    if [ -z "$latest" ]; then
        log "no complete pull-target snapshot to restore"
        return 1
    fi
    out_dir="$WORK/restore/pull-target-$latest"
    log "running: backupkit restore pull-target $latest --output \"$out_dir\" --verify"
    bk restore pull-target "$latest" --output "$out_dir" --verify

    log "diffing the restored copy against the snapshot store..."
    if ! diff -r "$LOCAL_ARCHIVE_DIR/pull-target/$latest" "$out_dir"; then
        log "the restored copy differs from the snapshot"
        return 1
    fi
    log "restore verified byte-identical: --verify passed and diff -r found no differences"
    return 0
}

# ---------------------------------------------------------------------------
# main
# ---------------------------------------------------------------------------

main() {
    if [ "$#" -ge 1 ] && { [ "$1" = "--help" ] || [ "$1" = "-h" ]; }; then
        usage
        exit 0
    fi
    if [ "$#" -lt 3 ]; then
        usage
        exit 64
    fi
    if [ ! -t 0 ]; then
        log "error: smoke-test.sh is interactive - run it from a terminal"
        exit 64
    fi

    check_prereqs
    detect_backupkit
    setup_paths "$1" "$2" "$3"
    setup_keys
    write_config

    log ""
    log "backupkit release-gate smoke test"
    log "source host:  $SRC_USER@$SRC_HOST:$SRC_PORT"
    log "archive host: $DST_USER@$DST_HOST:$DST_PORT"
    log "scratch dir:  $WORK"
    log "config:       $CONFIG_PATH"

    run_step 1 "two hosts reachable, rsync >= 3.2.5, test data seeded" step1_verify_hosts
    run_step 2 "passphrase-protected key end to end via backupkit check" step2_passphrase_key
    run_step 3 "push through the backupkit-remote jail, incl. rejected escape" step3_push_jail
    run_step 4 "pull with zero credentials on the source host" step4_pull_zero_creds
    run_step 5 "mid-transfer kill and recovery" step5_mid_transfer_kill
    run_step 6 "service install/start/stop/restart/status, crash-restart" step6_service_lifecycle
    run_step 7 "disk-low skip" step7_disk_low
    run_step 8 "restore and diff" step8_restore_diff

    print_summary
    [ "$OVERALL_FAIL" -eq 0 ]
}

trap cleanup EXIT

main "$@"
