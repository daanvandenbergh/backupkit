/**
 * Common cross-module types: the local/remote transfer seam (`Endpoint` and
 * `ResolvedRemote`) and the retention rule shape shared by the config and
 * retention modules (the dependency graph allows `retention -> shared` only).
 */

/**
 * Resolved remote identity. "explicit" carries every field filled from
 * config; "alias" carries only the ssh_config alias - ssh resolves host,
 * user, key, and port itself.
 */
export type ResolvedRemote =
    | {
          /** Discriminator: backupkit manages identity, key, and known_hosts. */
          kind: "explicit";
          /** The remote's short name (its key in config `remotes`). */
          name: string;
          /** Hostname or IP (IPv6 literals unbracketed here; the endpoint formatter brackets). */
          host: string;
          /** SSH username. */
          user: string;
          /** SSH port, default-filled to 22. */
          port: number;
          /** Absolute path to the private key. */
          identityFile: string;
          /** Parsed passphrase source, or null for an unencrypted key. */
          passphrase: {
              /** "file" reads the 0600 passphrase file via askpass; "prompt" uses ssh-add's TTY prompt. */
              kind: "file" | "prompt";
              /** Absolute passphrase-file path for kind "file"; empty string for "prompt". */
              value: string;
          } | null;
          /** Dedicated known_hosts file path (default `<configDir>/known_hosts`). */
          knownHostsFile: string;
          /** Whether this host's shell cannot parse quotes (see the alias variant). */
          restrictedShell: boolean;
      }
    | {
          /** Discriminator: ssh_config resolves everything; backupkit manages only its option baseline. */
          kind: "alias";
          /** The remote's short name (its key in config `remotes`). */
          name: string;
          /** Host alias exactly as written in ssh_config. */
          alias: string;
          /**
           * Whether this host runs an appliance shell that does NOT parse
           * quotes (a Hetzner Storage Box reads `'mkdir'` as a command named
           * `'mkdir'`). Remote commands are then sent as bare words, and any
           * element that is not provably one inert word is refused rather than
           * escaped. Default false.
           */
          restrictedShell: boolean;
      };

/**
 * One side of a transfer. Config resolution maps each target to {src, dst}
 * once; no code downstream of the resolver inspects direction.
 */
export type Endpoint =
    | {
          /** Discriminator: a path on this machine. */
          kind: "local";
          /** Absolute local path. */
          path: string;
      }
    | {
          /** Discriminator: a path on a remote host. */
          kind: "remote";
          /** The resolved remote the path lives on. */
          remote: ResolvedRemote;
          /** Absolute path on the remote. */
          path: string;
      };

/**
 * GFS retention rules. A snapshot survives if ANY rule claims it. Lives in
 * shared/ so the pure retention module can consume it without importing
 * config/ (the graph is `retention -> shared` only); `config/types.ts`
 * re-exports it as the public `RetentionConfig`.
 */
export interface RetentionRules {
    /** Keep the N newest snapshots unconditionally. */
    keepLast?: number;
    /** Keep the newest snapshot of each of the last N UTC hours. */
    keepHourly?: number;
    /** Keep the newest snapshot of each of the last N UTC days. */
    keepDaily?: number;
    /** Keep the newest snapshot of each of the last N ISO weeks (Monday start). */
    keepWeekly?: number;
    /** Keep the newest snapshot of each of the last N UTC months. */
    keepMonthly?: number;
    /** Keep the newest snapshot of each of the last N UTC years. */
    keepYearly?: number;
}
