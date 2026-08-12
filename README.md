# @daanvandenbergh/backupkit

![backupkit - automated, versioned rsync backups over SSH](.agentstore/scribekit-hero/readme/hero.png)

Automated, versioned backups over SSH - a thin, dependency-free TypeScript layer on top of `rsync`.

- **Versioned, or in place** - every target states its `mode`: `"snapshot"` makes each run a dated snapshot with unchanged files hard-linked against the previous one, so history costs almost nothing; `"mirror"` keeps one in-place copy of the source, for two clones of the same tree rather than an archive. Required on every target, with no default - the two have opposite recovery properties.
- **Push or pull** - the source host can push to the backup server, or the backup server can pull from the source. Pull is the safe default: a compromised source host holds no credentials to reach the archive.
- **Automated** - a scheduler runs each target on its own interval and prunes old snapshots on a GFS retention policy, under systemd or launchd.
- **Safe by construction** - snapshots are atomic (write to `<name>.partial`, rename on success), locked per destination, and only complete snapshots ever seed the next hard-link base. rsync and ssh are always spawned as argv arrays, never a shell string.

Full documentation: **https://daanvandenbergh.github.io/backupkit/**

## Install

```bash
npm install -g @daanvandenbergh/backupkit
```

Requires **rsync >= 3.2.5** and **ssh** on both hosts (macOS ships openrsync - `brew install rsync`). Node >= 20.

## Quick start

Three steps get a machine backing up:

```bash
backupkit init             # write a commented starter config.jsonc
backupkit check            # verify rsync/ssh versions, keys, and host reachability
backupkit start            # schedule it in this session (Ctrl-C stops it)
```

The last step is where the two run modes fork: `backupkit start` schedules in *your* session, `sudo backupkit service install` registers a root service instead. `check` ends by printing whichever of the two your config can use - a passphrase-protected key rules the service out - with the `--config` path already filled in. See [Two ways to run it](#two-ways-to-run-it).

A minimal **pull** config (`/etc/backupkit/config.jsonc`) - the backup server fetches from a source host that holds no archive credentials:

```jsonc
{
    "remotes": {
        // A remote is either explicit (host/user/identityFile) or an ssh_config alias ({ "alias": "..." }).
        "web1": {
            "host": "10.0.0.11",
            "user": "backup-reader",
            "identityFile": "/etc/backupkit/keys/web1_ed25519"
        }
    },
    "targets": {
        "web1-www": {
            "mode": "snapshot",            // versioned archive (the alternative is "mirror")
            "direction": "pull",           // this host fetches from the remote
            "remote": "web1",
            "source": "/var/www",          // path on the remote
            "destination": "/srv/backups", // local archive root -> /srv/backups/web1-www/<snapshot>/
            "schedule": { "interval": "day", "intervalCount": 1, "at": "03:00" },
            "retention": { "keepDaily": 14, "keepWeekly": 8, "keepMonthly": 12 }
        }
    }
}
```

Then `backupkit run` performs one pass over every due target; `backupkit start` (or the installed service) does it on schedule.

### Snapshot or mirror

`mode` is required on every target and has no default, because the two modes have opposite properties and a silent one is the wrong one to inherit:

```jsonc
"persistance": {
    "mode": "mirror",                     // <destination> IS the tree - one copy, no history
    "direction": "pull",                  // this host fetches; the source needs no access here
    "remote": "laptop",
    "source": "/Users/me/persistance",
    "destination": "/Volumes/persistance",
    "schedule": { "interval": "hour" }
}
```

A **mirror** keeps two clones of one directory in step - a working directory and its copy on another machine or an external volume. It writes the destination in place, so there is no snapshot subdirectory, no hard-link history, no retention (`retention` and `minFree` are config errors on a mirror rather than silent no-ops), and nothing for `list`, `prune`, or `restore` to work with. **Anything the source no longer has is deleted from the destination on the next run, with no earlier version to go back to** - that is the trade against a snapshot target.

The one guard that stays is the one a mirror cannot recover from without: before each run backupkit estimates the source, and refuses the transfer if it holds under half the files the last successful run moved, leaving the destination untouched. An unmounted volume or a half-restored directory therefore skips its run instead of deleting the good copy; `backupkit run --force <target>` performs it once you have checked. A push mirror must also set `"jail": false` - the jail pins every transfer to a scratch `<snapshot>.partial`, which is what confines the `--delete` it allows, so it cannot accept a mirror; prefer `"direction": "pull"` for a mirror wherever you can.

## CLI

| Command | What it does |
|---|---|
| `backupkit init` | Write a commented starter `config.jsonc` at the resolved path. |
| `backupkit check` | Validate config; verify rsync/ssh versions on both ends, probe each host, pin host keys (on a TTY), print the recommended push-jail `authorized_keys` lines (informational - the jail is never probed). |
| `backupkit run [TARGET...]` | Back up due targets now (`--force` ignores the schedule, `--dry-run` transfers nothing). |
| `backupkit status [TARGET...]` | One row per target: last run, next due, consecutive failures, lock state (`--json`). |
| `backupkit list [TARGET...]` | Complete snapshots, oldest first (alias `ls`, `--json`). |
| `backupkit restore TARGET SNAP` | Copy a snapshot (`--snapshot latest`) to a fresh `--output` path; never overwrites, never deletes. |
| `backupkit prune [TARGET...]` | Apply retention now (`--dry-run` prints the keep/prune plan; `--force` overrides the planted-snapshot guard). |
| `backupkit unlock [TARGET...]` | Clear a destination lock a killed run left behind. A live lock is reported, not removed, unless `--force`. |
| `backupkit service <verb>` | `install`/`uninstall`/`start`/`stop`/`restart`/`status` the systemd unit or launchd job. |
| `backupkit logs [-f] [-n N]` | Tail the daemon logs (journald on Linux, log files on macOS). |
| `backupkit start` | Foreground scheduler loop **in your own session**: starts an ssh-agent, adds every key (prompting for each passphrase), then schedules until Ctrl-C. `--force` runs every target once first. The supported home for passphrase-protected keys. |
| `backupkit daemon` | Foreground scheduler loop (what the installed service runs). Refuses to start if any configured key is passphrase-protected - a service has no terminal to unlock one on. |
| `backupkit jail install\|status` | Run **on an archive server** (config-free): atomically install/update the shipped `backupkit-remote` jail script at `/usr/local/bin/backupkit-remote`, or verify the installed copy matches this package version. |

`--config <path>` overrides the default lookup (`$BACKUPKIT_CONFIG`, then `/etc/backupkit/config.jsonc`, then `~/.backupkit/config.jsonc`). `init` writes at that same resolved path - `/etc/backupkit/` under `sudo`, `~/.backupkit/` as yourself - and since the daemon runs as root, a config kept in your home directory has to be named at install time: `sudo backupkit service install --config ~/.backupkit/config.jsonc`. See the [configuration reference](https://daanvandenbergh.github.io/backupkit/configuration) and [CLI reference](https://daanvandenbergh.github.io/backupkit/cli-reference).

## Two ways to run it

The same scheduler - same windows, same retention, same locking - runs in one of two modes. They differ in who supervises it, which config it reads, and whether a key may have a passphrase.

| | [Run it yourself](https://daanvandenbergh.github.io/backupkit/run-it-yourself) | [Run it as a service](https://daanvandenbergh.github.io/backupkit/daemon-setup) |
|---|---|---|
| Command | `backupkit start` | `sudo backupkit service install` + `start` |
| Runs as | you, in a terminal | root, under systemd/launchd |
| Config | `~/.backupkit/config.jsonc` | `/etc/backupkit/config.jsonc` |
| `stateDir` default | `~/.local/state/backupkit` | `/var/lib/backupkit` (`/var/db/backupkit` on macOS) |
| Passphrase-protected key | **yes**, prompts once per key | **no**, refuses to start |
| Survives logout/reboot | no | yes |
| Logs | this terminal (plus `logging.file`) | journald / `/var/log/backupkit`, via `backupkit logs` |

`backupkit daemon` - the loop the installed service runs - checks every configured key before it starts anything and **exits with an error if any of them is passphrase-protected**, naming the key and its remote. A launchd job or systemd unit has no terminal to type a passphrase on, and putting the passphrase in a file beside the key buys no secrecy while adding a second secret to lose. A key counts as protected when its remote declares a `passphrase` *or* when the key file itself turns out to be encrypted.

So either give the service its own key with no passphrase (`ssh-keygen -t ed25519 -N ""`), or run the scheduler yourself:

```bash
backupkit start   # ssh-agent + prompt once per key, then schedule until Ctrl-C
```

Alias remotes sit outside all of this: `ssh_config` and an agent are in charge of those, though a root service resolves them against *root's* ssh_config, not yours.

## Push vs pull

**Pull** (recommended) keeps every credential on the backup server: it reaches out and fetches, so a compromised source host holds nothing that can read or delete a stored snapshot. **Push** is for when the source cannot be reached inbound; by default the push key on the archive server is confined by a `backupkit-remote` forced command that jails it to one destination root, permits only rsync plus the snapshot lifecycle, pins each transfer's destination to the scratch `<snapshot>.partial` directory of the run, and validates a rename as a *pair* so a snapshot can never be renamed into a deletable name it did not already have - so no single command, and no pair of commands, can erase a target's archive history. `backupkit check` prints the exact `authorized_keys` line, and installing the script on the archive server is one command there: `npm install -g @daanvandenbergh/backupkit && sudo backupkit jail install` (rerun `jail install` after every package update; `backupkit jail status` tells you when the installed copy has fallen behind, and every `backupkit` command on that server warns on stderr while an installed copy is outdated). Installation is deliberately the server admin's local act - the push client never holds a credential that could rewrite the jail that confines it.

The jail is **recommended, not required**: set `"jail": false` on a push target to run without it - for a plain account whose risk you accept, or a restricted host (a storage-box style appliance) where a forced command cannot be installed. Transfers are identical either way: the client always speaks plain rsync plus POSIX file commands over ssh, and the jail only *filters* them, so nothing is installed on the happy path that the unjailed path lacks. What changes is authority: an unjailed push key can do whatever the account allows, including deleting the entire archive. Without the jail the account must accept these commands over ssh: `rsync --server`, `mkdir -p --`, `mkdir --`, `mv --`, `ls -A --`, `rm -rf --`, and `df -Pk --` - listing is the one command that differs by mode (a jailed target lists with the jail's `find <dir> -maxdepth 1 -mindepth 1 -print0`), because a restricted appliance shell often has no `find` at all. `backupkit check` never probes for the jail; it only prints the lines for jailed targets and notes each `"jail": false` one. An appliance whose shell parses no quoting at all - a Hetzner Storage Box reads `'mkdir'` as a command named `'mkdir'` - additionally needs `"restrictedShell": true` on the remote: backupkit then sends each command as bare words and refuses to send any element that is not already one inert shell word. Those bare words are exactly what the jail's quoted grammar rejects, so a `restrictedShell` remote's push targets must also set `"jail": false` - the config validator refuses the pair rather than letting it fail at run time.

What the jail **cannot** prevent is the authority push mode inherently grants: the pushing host runs retention, so a compromised push client can retire completed snapshots one at a time exactly as the legitimate client does. The archive server holds no retention policy of its own and cannot tell a policy-driven prune from a targeted deletion. That is the structural reason pull is the recommendation, and it is why `backupkit prune` is the only bulk path.

What neither direction can prevent is a source that lies about its own contents: a compromised source can present an emptied tree, and count-based retention would eventually age out the snapshots holding the real data. Backupkit trips a content-collapse guard when a snapshot's file count collapses against the previous one - the snapshot is still stored, but retention is skipped and the run is logged at error level until you confirm the shrink is real with `backupkit prune`. See the [security model](https://daanvandenbergh.github.io/backupkit/security-model).

## Library API

The CLI is a thin shell over the `Backupkit` class, which you can drive directly:

```ts
import { Backupkit } from "@daanvandenbergh/backupkit";

const kit = Backupkit.fromConfig(); // or Backupkit.fromConfig("/etc/backupkit/config.jsonc")

await kit.check();                       // readiness: binaries, keys, hosts, jail lines
await kit.run();                         // one pass over every due target
await kit.start();                       // foreground scheduler loop (stop() ends it)

const rows = await kit.status();         // last run, next due, failures, lock state
const snaps = await kit.listSnapshots(); // complete snapshots, oldest first
await kit.prune({ dryRun: true });       // retention plan without deleting
await kit.restore({ target: "web1-www", snapshot: "latest", output: "/tmp/restored" });
```

## License

UNLICENSED.
