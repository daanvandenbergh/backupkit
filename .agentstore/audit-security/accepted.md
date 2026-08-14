# Accepted risks

Risks this project has looked at and decided to carry, each with the compensating control that
makes it tolerable and the `wrong_if:` observation that would reopen it. A rule that cannot be
satisfied belongs here with a reason - never quietly deleted from `rules.md` to make an audit pass.

Reprinted in every `/audit-security` report. Reviewed whenever the code they name moves.

---

## A1. ~~One jail root per `destination`, so push targets sharing an archive host are not isolated~~ - FIXED in 2.0.0

- **Status: no longer accepted - the risk is gone.** Kept as a record of what closed it, not as a
  risk to reprint. Delete this entry once 2.0.0 is the oldest version anyone runs.
- **What it was.** `backupkit check` generated `command="/usr/local/bin/backupkit-remote
  <destination>"` while the store operated at `<destination>/<targetName>`, so two push targets
  sharing a `destination` shared one jail root: a compromised `web1` could `find` (enumerate
  `db1`'s snapshot history) and write a `<snap>.partial` under `db1-data/`, because `db1-data` was
  a legal target-name component.
- **What closed it.** 2.0.0 made `destination` the archive root itself in both modes, so the jail
  root `check` emits IS one target's archive - the fix this entry named
  (`posix.join(destination, name)`), reached by moving the level rather than adding one. Two
  targets may no longer share a destination at all (`checkSnapshotRoots` refuses it), and the
  target-name-charset arm of `check_component` is deleted with the level it served, so no path a
  jailed key may name can carry a foreign target's name. Cross-tenant *enumerate and inject* is
  therefore gone along with the shared root.
- **The migration cost this entry was deferring** - a changed `authorized_keys` line on every
  archive server - was paid deliberately: it is the breaking half of a major version, documented in
  the README and `configuration#upgrading-a-1x-config`, and it fails loudly (an old jail plus a 2.x
  client rejects every push with a bare `rejected`, which `backupkit jail status` and the per-command
  drift warning both name).
- **wrong_if:** a future change re-introduces a shared jail root - a `<target>` level under
  `destination`, or a `jailCommandPrefix` built from anything but the target's own destination.
  `src/snapshots/tests/jail-grammar.test.ts` ("rejects the target name %j as a path component") is
  the guard that turns red first.

## A1b. `"jail": false` opts a push target out of every jail-side control at once

- **Rule in play:** invariant 10 (the jail is the default; opting out is explicit).
- **What is accepted.** A push target may set `"jail": false` for an account whose risk the operator
  accepts, or a restricted appliance (a storage-box style host) where a forced command cannot be
  installed. The key then has whatever authority the account has.
- **Why this entry exists.** Everything invariants 23, 29, 30 and 31 buy is enforced *by the forced
  command*. On an opted-out target none of it applies: the destination pinning, the rename-pair rule,
  the option allowlist and the narrowed delete are all absent, so a compromised source can delete the
  entire archive with one `rm -rf`. The audit's jail hardening therefore raises the floor for jailed
  targets and does nothing for unjailed ones - that asymmetry is the point of the flag, and it should
  stay explicit in config rather than becoming a default anyone can drift into.
- **Compensating controls.** The opt-out is explicit per target and never implicit; `backupkit check`
  notes each `"jail": false` target rather than silently omitting it; the client-side guards
  (newest-snapshot floor, two-phase delete, content-collapse tripwire, path normal form) still apply
  because they live in the client, though a *compromised* client simply skips them.
- **wrong_if:** `"jail": false` ever becomes the default, or is reachable by omission rather than by
  an explicit value; or `check` stops distinguishing jailed from unjailed targets in its output.

## A2. A jailed push key can retire completed snapshots the same way the honest client does

- **Rule in play:** invariants 7 and 23 (the client-side newest-snapshot floor binds only code that
  goes through the store).
- **What is accepted.** In push mode the pushing host runs retention, so the jail must permit the
  two-phase delete (`mv <snap> <snap>.deleting`, then `rm -rf` that leaf). The archive server holds
  no retention policy of its own and therefore cannot tell "prune the oldest, per policy" from
  "delete this one specific snapshot". A compromised push client can retire completed snapshots one
  at a time, exactly as the legitimate client does.
- **Why it is not fixed.** Closing it means moving retention to the archive server - a different
  product shape, not a patch. It is the structural reason **pull is the recommended direction**, and
  it is the honest limit of what a forced command can enforce.
- **Compensating controls.** The blast radius is bounded to one snapshot per command pair rather
  than a whole history (invariants 29, 30), and the newest complete snapshot is refused by the
  server-side delete-component policy plus the client-side floor. `backupkit prune` is the only
  bulk path and it is operator-invoked. Pull removes the authority entirely.
- **wrong_if:** the README or the security-model page ever claims a compromised push client cannot
  remove a completed snapshot. The docs must describe the bounded property, not an absolute one.

## A3. The jail's `is_snap` accepts calendar-impossible snapshot names

- **Rule in play:** invariant 21 (the jail re-implements the snapshot-name codec in POSIX shell).
- **What is accepted.** `is_snap` is a POSIX glob, so it accepts `9999-99-99T999999Z` while
  `parseSnapshotName` (regex plus a `formatSnapshotName` round-trip) rejects it. The jail grammar is
  therefore strictly wider than the client codec in the calendar dimension.
- **Why it is not fixed.** A POSIX `case` glob cannot express calendar validity, and hand-rolling
  date arithmetic in the forced command would add a parser to the most security-critical file in the
  project to buy a property that no longer has a consumer.
- **Compensating controls.** The names this widens are ones the client can never create, and with
  invariant 30 in place they are no longer usable as a rename-gadget destination: a `.deleting` leaf
  is only reachable from a snapshot-shaped source in the same directory. Invariant 21's parity test
  pins the other, dangerous direction - the jail must never be NARROWER than the codec.
- **wrong_if:** a verb is added whose policy keys on a snapshot name being *real* (rather than
  merely snapshot-shaped), or the client starts trusting a name the jail accepted.

## A4. The disk-guard estimate and the transfer it authorises are separate spawns

- **Rule in play:** invariant 34 (remote-supplied numbers feeding a safety decision).
- **What is accepted.** The pre-transfer `--dry-run` estimate and the real transfer are two rsync
  invocations, both driven by the peer. A source can present a small tree to the estimate and a
  large one to the transfer, so the free-space reservation can be under-computed.
- **Why it is not fixed.** Eliminating it needs a byte budget enforced *during* the transfer, which
  rsync does not offer.
- **Compensating controls.** The guard can only ever *skip* a run, never delete; the estimate is
  parsed last-match with a safe-integer bound (invariant 34); the margin is `delta * 1.2 + 256 MiB`
  plus inode headroom; and the failure mode is a full filesystem, which is loud, not silent data
  loss.
- **wrong_if:** the estimate is ever used for anything other than a skip decision - in particular,
  to size a deletion or to choose what to prune.

## A5. Archive content is stored verbatim and never screened

- **What is accepted.** A backup archive holds whatever the source presented, byte for byte. There
  is no malware scanning on ingest or on `restore`, and `restore` deliberately writes outside every
  archive root - i.e. outside the `nosuid`/`nodev` mount the docs prescribe for the archive.
- **Why it is not fixed.** Screening backup content is the wrong product boundary: a scanner that
  silently declines to store a file makes the backup incomplete, which is a worse failure than
  storing a hostile file.
- **Compensating controls.** setuid/setgid stripping and device/special-file refusal on **both**
  crossings, ingest and restore (invariant 12); `restore` never overwrites and never deletes; the
  documented `nosuid`/`nodev` archive mount.
- **wrong_if:** `restore` gains a path that executes, serves, or auto-imports restored content, or
  the docs stop telling operators that a restored tree is untrusted until scanned.
