#!/bin/sh
# backupkit-remote - the push-mode forced-command jail (spec section 4).
#
# Installed on the archive server (e.g. /usr/local/bin/backupkit-remote) and
# wired into authorized_keys by `backupkit check` as:
#
#   restrict,command="/usr/local/bin/backupkit-remote <jailRoot>" ssh-ed25519 AAAA...
#
# <jailRoot> is ONE target's archive root - the target's `destination`, verbatim.
# It holds that target's snapshots directly (<jailRoot>/<snapshot>/), so a key
# jailed here reaches one archive and no other: two targets on the same server
# get two roots and two authorized_keys lines.
#
# Reads $SSH_ORIGINAL_COMMAND and permits EXACTLY:
#   - rsync --server invocations whose options are on a measured ALLOWLIST and
#     whose single path operand is exactly <jailRoot>/<snapshot>.partial for a
#     write, or <jailRoot>/<snapshot>[.partial] for a --sender read
#     (absolute-prefix check, no ".." components, no symlinked prefix), and
#   - the canonical single-quoted lifecycle argv forms backupkit's remote
#     store issues: `mkdir -p --`, `mkdir --`,
#     `find <p> -maxdepth 1 -mindepth 1 -print0`, `mv --`, `rm -rf --`,
#     `df -Pk --`, and `rsync --version`, where every path operand is
#     <jailRoot> itself or under <jailRoot>/ with every component a snapshot
#     name ([0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{6}Z), its .partial/.deleting form,
#     or .backupkit.lock. `rm -rf` is narrower still: its FINAL component must
#     be `<snap>.partial`, `<snap>.deleting`, or `.backupkit.lock` - never a
#     complete snapshot and never the root itself, so no single permitted
#     command can erase an archive's history.
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

# True when component $1 is permitted: the snapshot regex family (including the
# .partial/.deleting forms) or .backupkit.lock. Those are the only names that
# exist inside an archive root.
#
# A target-name-charset component ([a-z0-9][a-z0-9._@-]*, max 64) used to be
# accepted here, because the root was shared by every target and each one owned
# a <target> subdirectory under it. The root is now ONE target's archive, so no
# path the client sends names a target - and an accepted shape nothing sends is
# an accepted shape only an attacker has a use for. Keeping it would have left
# `mkdir <root>/.ssh`-class writes legal inside the archive.
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
    is_snap "$compbase"
}

# True when the `mv` (source, destination) PAIR is one of the three renames the
# snapshot store actually issues: promote (`<snap>.partial` -> `<snap>`), delete
# phase 1 (`<snap>` -> `<snap>.deleting`), and the partial re-claim
# (`<snap>.partial` -> `<snap>.partial`). Both operands must be SNAPSHOT-shaped
# and SIBLINGS in one directory.
#
# Checking the two operands independently (each with check_component) was a
# CRITICAL hole: `check_component` accepts a bare target-name component, so
# `mv -- <root>/<target> <root>/<snap>.deleting` was legal, and the resulting
# `.deleting` leaf is exactly what check_delete_component then permits
# `rm -rf` to remove. Two permitted commands therefore erased a target's whole
# archive history - the precise outcome invariant 23 narrowed `rm -rf` to
# prevent. Narrowing a VERB is not the same as enforcing the PROPERTY: the
# rename gadget has to be closed too, or the delete policy is decoration.
# Requiring a snapshot-shaped SOURCE is what closes it (a target directory and
# `.backupkit.lock` are both unshaped), and the same-parent rule additionally
# stops a snapshot being nested inside another directory or the lock being
# moved out of the way to defeat the remote mutex.
check_mv_pair() {
    mvsrc=$1
    mvdst=$2
    [ "${mvsrc%/*}" = "${mvdst%/*}" ] || return 1
    mvs=${mvsrc##*/}
    mvd=${mvdst##*/}
    case $mvs in
        *.partial) is_snap "${mvs%.partial}" || return 1 ;;
        *) is_snap "$mvs" || return 1 ;;
    esac
    case $mvd in
        *.partial) is_snap "${mvd%.partial}" || return 1 ;;
        *.deleting) is_snap "${mvd%.deleting}" || return 1 ;;
        *) is_snap "$mvd" || return 1 ;;
    esac
    # The destination must NOT already exist. POSIX `mv` moves the source INSIDE
    # an existing directory instead of replacing it, so `mv <snap>.partial <snap>`
    # against a complete snapshot that is already there does not rename - it
    # buries the partial at <snap>/<snap>.partial, i.e. a write into
    # already-verified history, which the rsync destination policy above refuses
    # outright. Every legitimate rename names a destination that does not exist
    # (the store sweeps stray `.deleting`/`.partial` entries before it renames),
    # so requiring absence costs the honest client nothing. The client's own
    # promote() has a post-check for the nested outcome, but a compromised client
    # simply omits it - which is why this belongs here, on the server.
    [ -e "$mvdst" ] && return 1
    return 0
}

# True when FINAL component $1 is a leaf the client legitimately `rm -rf`s:
# `<snap>.partial`, `<snap>.deleting`, or `.backupkit.lock` (the only three
# shapes remote-store.ts ever removes). A COMPLETE snapshot name is deliberately
# NOT accepted here: check_component permits one (promote and delete-phase-1
# both name it), so sharing it with the `rm -rf` verb would let a compromised
# push client delete verified history one snapshot at a time. The archive root
# itself is refused by check_lifecycle_path before this is ever reached.
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

# True when lifecycle path operand $1 is $ROOT itself or strictly under $ROOT
# with every component permitted AND no existing prefix is a symlink (the
# resolved path stays under $ROOT). $2 selects the FINAL component's policy:
# empty (the default, used by mkdir/mv/find/df, which legitimately name a
# complete snapshot) applies check_component; "delete" (used by `rm -rf` only)
# applies the far narrower check_delete_component. Prefix components always use
# check_component.
#
# $ROOT ITSELF is a legal operand now that the root is one target's archive
# rather than a shared parent: `mkdir -p --`, `find`, and `df -Pk --` all name it
# directly (they used to name <root>/<target>). It is legal ONLY in the default
# mode - `rm -rf -- $ROOT` would erase the whole archive in one command, which is
# the outcome the delete policy exists to prevent, so it is refused here rather
# than left to check_delete_component (which never sees a final component at all
# when the operand IS the root). `mv` is safe by its own pair rule: both operands
# must be snapshot-shaped siblings, and the root is neither.
check_lifecycle_path() {
    lpath=$1
    lmode=$2
    case $lpath in
        *\'* | *\\*) return 1 ;;
    esac
    if [ "$lpath" = "$ROOT" ]; then
        [ "$lmode" = delete ] && return 1
        return 0
    fi
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

# True when rsync path operand $1 is a path the legitimate client really names:
# exactly `$ROOT/<leaf>`, where <leaf> depends on the transfer DIRECTION ($2):
#
#   recv (a write, no --sender)  -> only `<snap>.partial`
#   send (a read, --sender)      -> `<snap>` or `<snap>.partial`
#
# Bounding the operand only by "somewhere under $ROOT with no .." - which is all
# this function used to do - was a CRITICAL hole, because the option grammar
# permits `--delete --force` (the legitimate client sends them on every run).
# `rsync --server ... --delete --force . $ROOT` with an empty file list therefore
# deleted every snapshot of that target in ONE command, and
# `. $ROOT/<complete-snap>` let an attacker overwrite an already-verified
# snapshot, or write a dot-directory such as $ROOT/.ssh. Pinning the destination
# is what makes the permitted `--delete` harmless: it can only ever delete inside
# the scratch partial the run is building. The shape below is not a guess - it is
# what rsync 3.4.4 really sends (see the parity test).
#
# The operand is ONE component under $ROOT (it was `<target>/<leaf>` while a
# root was shared by every target). $ROOT itself is not a legal rsync operand in
# either direction - that is exactly the "delete everything the sender does not
# have" transfer above - which is also why a push MIRROR, whose destination IS
# the root, cannot be jailed and the config validator refuses one.
check_rsync_path() {
    rpath=${1%/}
    rpmode=$2
    case $rpath in
        *\'* | *\\*) return 1 ;;
    esac
    case $rpath in
        "$ROOT"/?*) ;;
        *) return 1 ;;
    esac
    rleaf=${rpath#"$ROOT"/}
    # Exactly one component. Deeper or shallower is not a shape the client ever
    # produces.
    case $rleaf in
        */*) return 1 ;;
    esac
    case $rleaf in
        *.partial) is_snap "${rleaf%.partial}" || return 1 ;;
        *)
            # A complete snapshot is a legal READ source (restore/verify pull
            # from the archive) and never a write destination.
            [ "$rpmode" = send ] || return 1
            is_snap "$rleaf" || return 1
            ;;
    esac
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
    rsmode=recv
    while [ $# -gt 0 ]; do
        if [ "$1" = "." ]; then
            shift
            [ $# -eq 1 ] || return 1
            check_rsync_path "$1" "$rsmode"
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
            # --sender means the server SENDS: a read (restore/verify pull from
            # the archive). It widens the legal leaf shapes, so record it.
            --sender)
                rsmode=send
                ;;
            # THE LONG-OPTION ALLOWLIST. Everything not named here is refused by
            # the final `*)` arm.
            #
            # This was a DENY list with a `--*` catch-all that accepted any
            # unlisted long option as "benign" if it carried no absolute path or
            # "..". That default-allow shape let three destructive options
            # through: `--remove-source-files` (the archive-side sender unlinks
            # every file it sends - a delete primitive that never touches the
            # `rm -rf` verb), `--inplace` (writes THROUGH a --link-dest hardlink,
            # mutating already-promoted snapshots), and `--protect-args`/`-s`
            # (rsync then takes its file arguments from the protocol stream, so
            # the validated argv operand is not the operand that governs the
            # transfer - which nullifies every path check at once; rsync's own
            # rrsync wrapper refuses it for exactly this reason). A deny list
            # cannot be complete against a tool that keeps adding options. But a
            # pure allowlist has the opposite failure: the FIRST time an rsync
            # upgrade forwards a new option, every push dies with a bare
            # "rejected" and no operator can tell why - invariant 24's hazard,
            # arriving via a dependency bump nobody connected to backupkit.
            #
            # So the rule is shaped by what actually makes an option dangerous
            # rather than by whether we have seen it before. Three explicit
            # groups are refused (below): options that NAME A PATH, options that
            # EXECUTE something, options that FOLLOW SYMLINKS, and options that
            # make the argv non-authoritative. Everything else is allowed if it
            # is valueless or carries a value with no path characters in it -
            # because with the destination pinned to the run's own
            # `<snap>.partial` (check_rsync_path), an option that cannot name a
            # file cannot reach outside that directory.
            #
            # Measured on rsync 3.4.4 across backupkit's five real invocations
            # (transfer, incremental, estimate, verify, restore-read), the
            # forwarded set is: --sender --numeric-ids --delete-excluded --force
            # --partial --timeout=N --bwlimit=N --info=X --log-format=%i
            # --link-dest ../X. (The client sends --delete AND --delete-excluded;
            # rsync forwards only the latter, which implies the former. --delete
            # stays in the allowlist below: it is what an older client sends, and
            # both are equally bounded by the pinned path operand.)
            # The parity test feeds those captured argv strings to this script;
            # they are documentation of the happy path, not the security boundary.
            #
            # The residual this accepts, stated plainly: a future rsync could add
            # a VALUELESS destructive option and it would pass. That is why the
            # deny list below still has to be maintained, and why the three
            # already known (--remove-source-files, --inplace, --append) are named
            # there rather than left to shape inference.
            --numeric-ids | --delete | --delete-excluded | --force | --partial | --sparse | --stats)
                ;;
            # Path-naming, command-executing, symlink-following, and
            # argv-defeating options. Both the `=value` and the bare
            # (space-separated) spellings are listed: the bare form is refused
            # here, and its value token then has nowhere to go anyway - a bare
            # `/tmp/x` falls through to the final `*)` arm.
            --rsync-path | --rsync-path=* | --rsh | --rsh=* | -e | --daemon \
                | --copy-links | --copy-unsafe-links | --copy-dirlinks | --keep-dirlinks \
                | --munge-links | --no-munge-links \
                | --protect-args | --secluded-args \
                | --files-from | --files-from=* | --read-batch | --read-batch=* \
                | --write-batch | --write-batch=* | --only-write-batch | --only-write-batch=* \
                | --temp-dir | --temp-dir=* | -T | --partial-dir | --partial-dir=* \
                | --compare-dest | --compare-dest=* | --copy-dest | --copy-dest=* \
                | --backup-dir | --backup-dir=* | --log-file | --log-file=* \
                | --config | --config=* | --exclude-from | --exclude-from=* \
                | --include-from | --include-from=* \
                | --remove-source-files | --remove-sent-files \
                | --inplace | --append | --append-verify)
                return 1
                ;;
            # Both must be a NONZERO number: rsync reads 0 as "unlimited" for
            # each, so `--timeout=0` lets a jailed client pin a server-side rsync
            # open forever, and with the lock's 24 h TTL that is a cheap way to
            # deny a target its backups. backupkit always sends a real
            # ioTimeoutSec (600 by default) and only sends --bwlimit when the
            # operator configured one, so a zero never comes from the client.
            --timeout=* | --bwlimit=*)
                nval=${1#*=}
                # Digits only, AND at least one nonzero digit. Both checks are
                # needed: a glob cannot express "not zero" in one pattern, and
                # `0`, `00`, `000` are all rsync's "unlimited".
                case $nval in "" | *[!0-9]*) return 1 ;; esac
                case $nval in *[1-9]*) ;; *) return 1 ;; esac
                ;;
            # Any other long option, known or not. A valueless flag cannot
            # redirect I/O. A value is allowed only when it CANNOT NAME A FILE:
            # no "/", no "..", and nothing outside a conservative token charset,
            # which admits --info=STATS2, --log-format=%i, --iconv=utf-8 and
            # whatever an rsync upgrade invents next, while refusing
            # --anything=/etc/shadow and --anything=../escape.
            --*)
                case $1 in
                    *=*)
                        oval=${1#*=}
                        case $oval in "" | *..* | *[!A-Za-z0-9_,.:%+-]*) return 1 ;; esac
                        ;;
                esac
                ;;
            # The compact short-flag bundle. Exactly `-<letters>` or
            # `-<letters>.<letters>`: the pre-"." letters are the active flags and
            # the post-"." part is the -e capability advertisement (inert).
            #
            # The old rule took `pre=${pre%%.*}` and never looked at the rest,
            # which discarded the VALUE of a value-taking short option: `-T../../tmp`
            # yielded pre="T" (pure letters, accepted) while meaning
            # `--temp-dir=../../tmp`, so rsync wrote its temp files outside the
            # jail root. `-T` was in the deny list as a bare token, which is dead
            # weight when the attached-value form walks past. Requiring the WHOLE
            # token to be letters (plus at most one "." separator) closes the
            # attached-value form for every short option at once.
            #
            # L (--copy-links), K (--keep-dirlinks) and k (--copy-dirlinks) make
            # the server follow a symlink out of the jail; lowercase s
            # (--protect-args) moves the file arguments off the command line.
            # None appears pre-"." in any measured argv. Capital S (--sparse) is
            # sent and is fine.
            -*)
                pre=${1#-}
                case $pre in
                    *.*)
                        post=${pre#*.}
                        pre=${pre%%.*}
                        case $post in "" | *[!A-Za-z]*) return 1 ;; esac
                        ;;
                esac
                case $pre in
                    "" | *[!A-Za-z]* | *L* | *K* | *k* | *s*) return 1 ;;
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
        check_mv_pair "$A" "$B" || fail
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
