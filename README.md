# @daanvandenbergh/backupkit

![backupkit - automated, versioned rsync backups over SSH](claude/scribekit-hero/readme/hero.png)

Automated, versioned backups over SSH - a thin TypeScript layer on top of `rsync`.

- **Versioned** - each run is a dated snapshot, unchanged files hard-linked against the previous one, so history costs almost nothing.
- **Push or pull** - the source host can push to the backup server, or the backup server can pull from the source. Pull is the safe default: a compromised source host has no credentials to reach the archive.
- **Automated** - schedule runs and prune old snapshots on a retention policy.

## Install

```bash
npm install @daanvandenbergh/backupkit
```

Requires `rsync` and `ssh` on both hosts.

## Usage

Write a `config.jsonc` (remotes, targets, schedules, retention), then drive the
engine through the `Backupkit` class:

```ts
import { Backupkit } from "@daanvandenbergh/backupkit";

const kit = Backupkit.fromConfig(); // or Backupkit.fromConfig("/etc/backupkit/config.jsonc")

await kit.check();                       // readiness: binaries, keys, hosts, jail lines
await kit.run();                         // one pass over every due target
await kit.start();                       // foreground scheduler loop (stop() ends it)

const rows = await kit.status();         // last run, next due, failures, lock state
const snaps = await kit.listSnapshots(); // complete snapshots, oldest first
await kit.prune({ dryRun: true });       // retention plan without deleting
await kit.restore({ target: "web", snapshot: "latest", output: "/tmp/restored" });
```

Requires rsync >= 3.2.5 on both ends (macOS ships openrsync - `brew install rsync`).
The `backupkit` CLI ships in a later phase; the library surface above is stable.

## Development

```bash
npm run typecheck   # tsc --noEmit
npm test            # vitest
npm run build       # emit dist/
```
