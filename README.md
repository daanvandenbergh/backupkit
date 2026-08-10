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

```ts
import {} from "@daanvandenbergh/backupkit";
```

_Nothing is exported yet - this is the initial scaffold._

## Development

```bash
npm run typecheck   # tsc --noEmit
npm test            # vitest
npm run build       # emit dist/
```
