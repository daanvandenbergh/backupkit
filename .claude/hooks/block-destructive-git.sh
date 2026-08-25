#!/usr/bin/env bash
#
# Refuse the git commands that DESTROY OR HIJACK THE SHARED WORKING TREE.
#
# This repo routinely carries 700-1000 uncommitted files belonging to several agent sessions running
# at once. Every command below throws that work away or moves it somewhere the other sessions cannot
# see, and each one does it INSTANTLY, with no confirmation and no undo that git will offer you.
#
# It exists because the documentation did not work. `.agentstore/` memory and CLAUDE.md have both carried
# "never run git stash here" for weeks, and it was run anyway - twice - each time as a reflex while
# chasing something else ("are these test failures mine?"). A rule you have to remember is a rule you
# forget exactly when you are busy, so this is the same rule enforced by the harness instead.
#
# WHAT IS BLOCKED, and why each one is on the list:
#   git stash / push / save   takes ALL of it, every session's work, into a stash only you know about
#   git stash drop / clear    deletes that stash - the thing recovery depends on
#   git restore <path>        discards the file's uncommitted changes, no backup, no prompt
#   git checkout -- <path>    the same, in older spelling; already destroyed another session's work once
#   git reset --hard          discards the whole tree
#   git clean -f              deletes UNTRACKED files, which here is ~600 files of new, unsaved work
#   git add -A/--all/-u/. /*  stages EVERY session's half-done work as if it were yours; the commit
#                             that follows publishes files their owners never finished. Scoped
#                             commits are ALLOWED (CLAUDE.md's Git section) - stage explicit paths.
#   git commit -a/-am/--all   the same sweep, hidden inside the commit itself
#
# WHAT IS DELIBERATELY ALLOWED, because it is the recovery path and blocking it would make a bad day
# unrecoverable: `git stash list`, `git stash show`, `git stash pop`, `git stash apply`.
#
# WHAT THIS HOOK HAS NOTHING TO DO WITH: `git push` and `npm publish`. Neither has ever been in the
# blocked list above - this hook guards the LOCAL working tree, and those two touch a remote instead.
# They are governed by `permissions` in .claude/settings.json. Recorded here because the hook's name
# reads like it covers them, and that guess cost a debugging round once: a denied `git push` was
# blamed on this file when the deny rule was in settings.json all along. If push or publish is
# refused, read settings.json, not this script.
#
# It scans the WHOLE command string, so `cd apps/devsuite && git stash` is caught too - that compound
# form is exactly what slipped past a prefix-matching permission rule.
#
# THERE IS NO SELF-SERVICE BYPASS, and that is the point. An env-var escape hatch is one more thing to
# type in the same reflex that caused the problem. When one of these is genuinely needed, the human
# runs it themselves (`! git clean -fd` in the prompt) - which is a deliberate act by the person who
# owns the work.
#
# To answer "is this failure mine?" - the question behind both incidents - read the committed version
# directly (`git show HEAD:<path>`) or use a separate worktree. Neither touches the shared tree.

set -uo pipefail

input=$(cat)
command=$(printf '%s' "$input" | jq -r '.tool_input.command // ""' 2>/dev/null || printf '')

if [ -z "$command" ]; then
    exit 0
fi

# Blank out the READ-ONLY and RESTORATIVE stash forms before looking for a stash at all, so
# `git stash list` passes while `git stash list && git stash` - which would otherwise satisfy a naive
# "does it mention an allowed form?" test - still gets caught on its second half.
scrubbed=$(printf '%s' "$command" | sed -E 's/git[[:space:]]+stash[[:space:]]+(list|show|pop|apply)/GIT_STASH_ALLOWED/g')

refusal=""
case "$scrubbed" in
    *git*stash*)
        if printf '%s' "$scrubbed" | grep -qE 'git[[:space:]]+stash'; then
            refusal="git stash takes EVERY uncommitted file in this repo - right now that is hundreds of files belonging to other agent sessions running at the same time. Popping it back is then blocked by whatever they wrote in the meantime."
        fi
        ;;
esac

if [ -z "$refusal" ]; then
    if printf '%s' "$scrubbed" | grep -qE 'git[[:space:]]+restore([[:space:]]|$)'; then
        refusal="git restore discards a file's uncommitted changes with no backup and no prompt - and in this repo those changes are very likely another session's in-flight work."
    elif printf '%s' "$scrubbed" | grep -qE 'git[[:space:]]+checkout[[:space:]]+[^;&|]*--([[:space:]]|$)'; then
        refusal="git checkout -- <path> discards that path's uncommitted changes. This has already destroyed another session's work in this repo once."
    elif printf '%s' "$scrubbed" | grep -qE 'git[[:space:]]+checkout[[:space:]]+\.([[:space:]]|$)'; then
        refusal="git checkout . discards every uncommitted change in the tree."
    elif printf '%s' "$scrubbed" | grep -qE 'git[[:space:]]+reset[[:space:]]+[^;&|]*--hard'; then
        refusal="git reset --hard throws away the entire working tree, which here is hundreds of files of unsaved work across several sessions."
    elif printf '%s' "$scrubbed" | grep -qE 'git[[:space:]]+clean[[:space:]]+[^;&|]*-[a-zA-Z]*f'; then
        refusal="git clean -f DELETES untracked files. This repo currently carries ~600 untracked files that exist nowhere else - no commit, no stash, no backup."
    elif printf '%s' "$scrubbed" | grep -qE 'git[[:space:]]+add[[:space:]]+([^;&|]*[[:space:]])?(-A|--all|-u|--update)([[:space:]]|$)' \
        || printf '%s' "$scrubbed" | grep -qE 'git[[:space:]]+add[[:space:]]+[^;&|]*(\.|\*)([[:space:]]|$|/)'; then
        refusal="a sweeping git add (-A, --all, -u, ., *) stages EVERY session's half-done work in this shared tree, not just yours. Stage the explicit paths you edited instead: git add <file> <file> (see CLAUDE.md's Git section)."
    elif printf '%s' "$scrubbed" | grep -qE 'git[[:space:]]+commit[[:space:]]+([^;&|]*[[:space:]])?-a(m)?([[:space:]]|$)' \
        || printf '%s' "$scrubbed" | grep -qE 'git[[:space:]]+commit[[:space:]]+([^;&|]*[[:space:]])?--all([[:space:]]|$)'; then
        refusal="git commit -a/-am/--all sweeps every tracked modification in this shared tree into your commit - including other sessions' half-done work. Stage your explicit paths with git add <file>, then git commit -m (see CLAUDE.md's Git section)."
    fi
fi

if [ -n "$refusal" ]; then
    reason="BLOCKED by .claude/hooks/block-destructive-git.sh. ${refusal}

Do this instead:
  - To compare against the committed version: git show HEAD:<path>
  - To decide whether a failing test is yours: read what it asserts and which paths it names.
  - To work against a clean tree: use a separate git worktree, never the shared one.
  - To revert your OWN edit: use the Edit tool to put it back, or write the committed content with
    'git show HEAD:<path> > <path>' after backing up what is there.

If this command is genuinely necessary, ask the person you are working with to run it themselves
(they can type '! <command>' in the prompt). Do not look for another way around this block."

    jq -n --arg reason "$reason" '{
        hookSpecificOutput: {
            hookEventName: "PreToolUse",
            permissionDecision: "deny",
            permissionDecisionReason: $reason
        }
    }'
    exit 0
fi

exit 0
