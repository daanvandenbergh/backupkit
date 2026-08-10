#!/bin/sh
# backupkit-remote - the push-mode forced-command jail (spec section 4).
#
# Installed on the archive server (e.g. /usr/local/bin/backupkit-remote) and
# wired into authorized_keys by `backupkit check` as:
#
#   restrict,command="/usr/local/bin/backupkit-remote <jailRoot>" ssh-ed25519 AAAA...
#
# Reads $SSH_ORIGINAL_COMMAND and permits EXACTLY:
#   - rsync --server invocations whose single path operand resolves under
#     <jailRoot>/ (absolute-prefix check, no ".." components), and
#   - the canonical single-quoted lifecycle argv forms backupkit's remote
#     store issues: `mkdir -p --`, `mkdir --`,
#     `find <p> -maxdepth 1 -mindepth 1 -print0`, `mv --`, `rm -rf --`,
#     `df -Pk --`, and `rsync --version`, where every path operand is under
#     <jailRoot>/ and every leaf component is a snapshot name
#     ([0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{6}Z), its .partial/.deleting form,
#     .backupkit.lock, or a target-name-charset component. `rm -rf` is narrower
#     still: its FINAL component must be `<snap>.partial`, `<snap>.deleting`,
#     or `.backupkit.lock` - never a bare target directory or a complete
#     snapshot, so no single permitted command can erase an archive's history.
#
# Everything else exits 1. There is no eval anywhere: validated operands are
# exec'd directly, so no shell ever re-parses attacker-controlled text.

set -f
unset IFS

# Reject the command and exit 1. Never echoes the command back.
fail() {
    echo "backupkit-remote: rejected" >&2
    exit 1
}

ROOT=$1
case $ROOT in
    /*) ;;
    *) fail ;;
esac
ROOT=${ROOT%/}
[ -n "$ROOT" ] || fail
case $ROOT in
    *\'* | *\\* | *..*) fail ;;
esac

CMD=$SSH_ORIGINAL_COMMAND
[ -n "$CMD" ] || fail
NL='
'
case $CMD in
    *"$NL"*) fail ;;
esac

# True when $1 is a snapshot name (the single codec form).
is_snap() {
    case $1 in
        [0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9][0-9][0-9][0-9][0-9]Z) return 0 ;;
    esac
    return 1
}

# True when leaf component $1 is permitted: the snapshot regex family
# (including .partial/.deleting forms), .backupkit.lock, or a
# target-name-charset component ([a-z0-9][a-z0-9._-]*, max 64).
check_component() {
    comp=$1
    [ -n "$comp" ] || return 1
    if [ "$comp" = ".backupkit.lock" ]; then
        return 0
    fi
    compbase=$comp
    case $comp in
        *.partial) compbase=${comp%.partial} ;;
        *.deleting) compbase=${comp%.deleting} ;;
    esac
    if is_snap "$compbase"; then
        return 0
    fi
    case $comp in
        *[!a-z0-9._-]*) return 1 ;;
        [!a-z0-9]*) return 1 ;;
    esac
    [ ${#comp} -le 64 ]
}

# True when FINAL component $1 is a leaf the client legitimately `rm -rf`s:
# `<snap>.partial`, `<snap>.deleting`, or `.backupkit.lock` (the only three
# shapes remote-store.ts ever removes). A bare target-name component or a
# COMPLETE snapshot name is deliberately NOT accepted here: check_component
# permits both, so sharing it with the `rm -rf` verb would let a compromised
# push client delete a target's entire archive history in one command.
check_delete_component() {
    dcomp=$1
    if [ "$dcomp" = ".backupkit.lock" ]; then
        return 0
    fi
    case $dcomp in
        *.partial) is_snap "${dcomp%.partial}" && return 0 ;;
        *.deleting) is_snap "${dcomp%.deleting}" && return 0 ;;
    esac
    return 1
}

# True when NO existing prefix component of the (already string-validated,
# under-$ROOT) path operand $1 is a symlink. The string checks only bound the
# LITERAL path; this bounds the RESOLVED path. Walk from $ROOT down, appending
# one component at a time: if any existing prefix is a symlink (`-L`, incl. a
# broken one) reject, so mv/mkdir/rsync can never dereference an
# attacker-planted intermediate symlink and land the write OUTSIDE the jail.
# The final component may not exist yet (a mkdir/mv target) - once a prefix does
# not exist, nothing deeper can, so accept.
check_no_symlink_prefix() {
    sp=$ROOT
    srest=${1#"$ROOT"/}
    while [ -n "$srest" ]; do
        case $srest in
            */*)
                scomp=${srest%%/*}
                srest=${srest#*/}
                ;;
            *)
                scomp=$srest
                srest=
                ;;
        esac
        sp=$sp/$scomp
        [ -L "$sp" ] && return 1
        [ -e "$sp" ] || return 0
    done
    return 0
}

# True when lifecycle path operand $1 is strictly under $ROOT with every
# component permitted AND no existing prefix is a symlink (the resolved path
# stays under $ROOT). $2 selects the FINAL component's policy: empty (the
# default, used by mkdir/mv/find/df, which legitimately name a bare target
# directory or a complete snapshot) applies check_component; "delete" (used by
# `rm -rf` only) applies the far narrower check_delete_component. Prefix
# components always use check_component.
check_lifecycle_path() {
    lpath=$1
    lmode=$2
    case $lpath in
        *\'* | *\\*) return 1 ;;
    esac
    case $lpath in
        "$ROOT"/?*) ;;
        *) return 1 ;;
    esac
    lrest=${lpath#"$ROOT"/}
    while [ -n "$lrest" ]; do
        case $lrest in
            */*)
                lcomp=${lrest%%/*}
                lrest=${lrest#*/}
                ;;
            *)
                lcomp=$lrest
                lrest=
                ;;
        esac
        if [ -z "$lrest" ] && [ "$lmode" = delete ]; then
            check_delete_component "$lcomp" || return 1
        else
            check_component "$lcomp" || return 1
        fi
    done
    check_no_symlink_prefix "$lpath"
}

# True when rsync path operand $1 is strictly under $ROOT with no ".." or
# empty components (the rsync destination check: absolute prefix, no escape).
check_rsync_path() {
    rpath=${1%/}
    case $rpath in
        *\'* | *\\*) return 1 ;;
    esac
    case $rpath in
        "$ROOT"/?*) ;;
        *) return 1 ;;
    esac
    rrest=${rpath#"$ROOT"/}
    while [ -n "$rrest" ]; do
        case $rrest in
            */*)
                rcomp=${rrest%%/*}
                rrest=${rrest#*/}
                ;;
            *)
                rcomp=$rrest
                rrest=
                ;;
        esac
        case $rcomp in
            "" | ..) return 1 ;;
        esac
    done
    check_no_symlink_prefix "$rpath"
}

# Validate an IFS-split "rsync --server ..." argv: option tokens only until
# the lone ".", then exactly one path operand under the jail root
# (check_rsync_path). The path operand bounds WHERE rsync reads/writes; this
# function bounds what the OPTION flags can make rsync do with it, default-deny
# on every escape vector:
#
#   - The compact short-flag bundle rsync sends (e.g. -logDtpre.iLsfxC): the
#     letters BEFORE the first "." are the active flags. L (--copy-links),
#     K (--keep-dirlinks) and k (--copy-dirlinks) there make the SERVER follow
#     a symlink out of the jail (read escape via --sender+L, write escape via
#     K) - reject them. Anything after "." is the -e capability advertisement
#     (its L means "symlinks supported", inert) and is left alone. The pre-dot
#     part must be flag letters only.
#   - Symlink-following, command-exec (--rsync-path/--rsh/-e/--daemon), batch
#     replay, and out-of-jail path-valued long options are rejected outright.
#   - The ONE path-valued option our client legitimately sends, --link-dest
#     with a ../<snapshotName> value - in BOTH the `=` form and the
#     space-separated two-token form real rsync sends - is allowed and stays
#     inside the jail by construction; any other long option is a benign flag
#     confined to the bounded path operand, but still may carry no absolute
#     path or ".." value.
validate_rsync() {
    [ "$1" = "rsync" ] || return 1
    [ "$2" = "--server" ] || return 1
    shift 2
    while [ $# -gt 0 ]; do
        if [ "$1" = "." ]; then
            shift
            [ $# -eq 1 ] || return 1
            check_rsync_path "$1"
            return $?
        fi
        # No shell metacharacter in any option token (defense in depth: nothing
        # is ever re-parsed by a shell, but keep the surface clean).
        case $1 in
            *\'* | *\"* | *\`* | *\$* | *\;* | *\\* | *\** | *\[*) return 1 ;;
        esac
        case $1 in
            # The one path-valued option our client sends: link into the
            # sibling snapshot, which stays inside the jail by construction.
            --link-dest=*)
                linkdest=${1#--link-dest=}
                case $linkdest in
                    ../*) is_snap "${linkdest#../}" || return 1 ;;
                    *) return 1 ;;
                esac
                ;;
            # The SPACE-separated form real rsync actually sends over the wire
            # (3.4.x: `--link-dest ../<snap>`). Same validation as the `=` form.
            # The value token is consumed HERE and the loop's own shift steps
            # past it, so it can never be re-parsed as an option nor counted as
            # the path operand.
            --link-dest)
                shift
                [ $# -gt 0 ] || return 1
                case $1 in
                    ../*) is_snap "${1#../}" || return 1 ;;
                    *) return 1 ;;
                esac
                ;;
            # Options that would let the server follow a symlink out of the jail,
            # run a client-chosen binary/shell, replay a batch, or redirect I/O
            # to an out-of-jail path. Default-deny, listed explicitly.
            --copy-links | --copy-unsafe-links | --copy-dirlinks | --keep-dirlinks \
                | --munge-links | --no-munge-links | --rsync-path | --rsync-path=* \
                | --rsh | --rsh=* | -e | --daemon | --files-from | --files-from=* \
                | --read-batch | --read-batch=* | --write-batch=* | --only-write-batch=* \
                | --compare-dest=* | --copy-dest=* | --partial-dir=* | --backup-dir=* \
                | --temp-dir=* | -T | --log-file=* | --config=*)
                return 1
                ;;
            # Any other long option: a benign flag (--numeric-ids, --delete,
            # --partial, --timeout=N, --chmod=..., --no-D, ...), but never with
            # an absolute-path or ".." value.
            --*)
                case $1 in
                    *=/*) return 1 ;;
                    *..*) return 1 ;;
                esac
                ;;
            # The compact short-flag bundle: reject the symlink-following flags
            # (L/K/k) in the pre-"." active-flags section; leave the "." and the
            # -e capability chars after it. The pre-"." part is flag letters only.
            -*)
                pre=${1#-}
                pre=${pre%%.*}
                case $pre in
                    "" | *[!A-Za-z]* | *L* | *K* | *k*) return 1 ;;
                esac
                ;;
            *) return 1 ;;
        esac
        shift
    done
    return 1
}

case $CMD in
    "'rsync' '--version'" | "rsync --version")
        exec rsync --version
        ;;
    "'mkdir' '-p' '--' '"*"'")
        P=${CMD#"'mkdir' '-p' '--' '"}
        P=${P%"'"}
        case $P in *\'*) fail ;; esac
        check_lifecycle_path "$P" || fail
        exec mkdir -p -- "$P"
        ;;
    "'mkdir' '--' '"*"'")
        P=${CMD#"'mkdir' '--' '"}
        P=${P%"'"}
        case $P in *\'*) fail ;; esac
        check_lifecycle_path "$P" || fail
        exec mkdir -- "$P"
        ;;
    "'find' '"*"' '-maxdepth' '1' '-mindepth' '1' '-print0'")
        P=${CMD#"'find' '"}
        P=${P%"' '-maxdepth' '1' '-mindepth' '1' '-print0'"}
        case $P in *\'*) fail ;; esac
        check_lifecycle_path "$P" || fail
        exec find "$P" -maxdepth 1 -mindepth 1 -print0
        ;;
    "'mv' '--' '"*"' '"*"'")
        REST=${CMD#"'mv' '--' '"}
        REST=${REST%"'"}
        A=${REST%%"' '"*}
        B=${REST#*"' '"}
        case $A in *\'*) fail ;; esac
        case $B in *\'*) fail ;; esac
        check_lifecycle_path "$A" || fail
        check_lifecycle_path "$B" || fail
        exec mv -- "$A" "$B"
        ;;
    "'rm' '-rf' '--' '"*"'")
        P=${CMD#"'rm' '-rf' '--' '"}
        P=${P%"'"}
        case $P in *\'*) fail ;; esac
        check_lifecycle_path "$P" delete || fail
        exec rm -rf -- "$P"
        ;;
    "'df' '-Pk' '--' '"*"'")
        P=${CMD#"'df' '-Pk' '--' '"}
        P=${P%"'"}
        case $P in *\'*) fail ;; esac
        check_lifecycle_path "$P" || fail
        exec df -Pk -- "$P"
        ;;
    "rsync --server "*)
        # Word-split the raw command (set -f: no globbing, and the split
        # results are never variable-expanded again), validate, then exec the
        # argv directly - no shell re-parse, no eval.
        set -- $CMD
        validate_rsync "$@" || fail
        exec "$@"
        ;;
    *)
        fail
        ;;
esac
