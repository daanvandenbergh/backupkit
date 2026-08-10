/**
 * The single rsync argv builder: `buildArgs(spec, mode)` produces the exact,
 * fixed-order argument vector from spec section 3 for all three modes
 * ("transfer", "estimate", "verify"). Pure - no fs, no process state; every
 * environment-dependent fact (fake-super, ssh tokens, link-dest base) arrives
 * as data on the TransferSpec.
 */

import { TransferError } from "../../shared/errors.js";
import { formatEndpoint } from "../../shared/format.js";
import { parseSnapshotName } from "../../shared/snapshot-name.js";
import type { Endpoint } from "../../shared/types.js";

/**
 * Rsync tuning consumed by the argv builder. Structurally satisfied by
 * config's `ResolvedRsyncOptions` (which adds `verify`, irrelevant here - the
 * mode parameter carries that decision); declared locally because the module
 * graph is `rsync -> ssh, exec, shared` and never `rsync -> config`.
 */
export interface TransferOptions {
    /** -z compression. */
    compress: boolean;
    /** Validated --bwlimit token passed verbatim, or null for unlimited. */
    bwlimit: string | null;
    /** rsync --timeout seconds. */
    ioTimeoutSec: number;
    /** --xattrs. */
    xattrs: boolean;
    /** Receive owner/group; false adds --no-owner --no-group. */
    preserveOwnership: boolean;
    /** Allow device/special files; false adds --no-devices --no-specials. */
    preserveDevices: boolean;
    /**
     * Absolute remote rsync binary path (`--rsync-path`), or null for the
     * remote default. Honored only for a pull (remote source); on a push the
     * jail's forced command fixes the server binary and this is not emitted
     * (see `buildArgs`).
     */
    remoteRsyncBin: string | null;
}

/** Everything one rsync invocation needs, resolved and validated upstream. */
export interface TransferSpec {
    /** Transfer source endpoint (formatted with exactly one trailing slash - contents are synced). */
    src: Endpoint;
    /** Transfer destination endpoint - the `<destination>/<name>/<snap>.partial` directory. */
    dst: Endpoint;
    /** Resolved rsync tuning. */
    options: TransferOptions;
    /** Exclude patterns; each becomes one `--exclude=<p>` argv element, verbatim. */
    exclude: string[];
    /**
     * Prebuilt ssh token array from ssh/'s `sshArgs` (explicit or alias form -
     * this module is kind-blind). Joined with spaces into one `-e` value
     * whenever either endpoint is remote; every token is pre-validated
     * whitespace/quote-free upstream.
     */
    sshTokens: string[];
    /**
     * Complete previous snapshot name for `--link-dest=../<base>`, or null for
     * the first snapshot. Must match the snapshot-name codec (defense in depth
     * against a hostile store listing).
     */
    linkDestBase: string | null;
    /** True when the receiving side runs as non-root (spec: `process.getuid() !== 0` on the receiver): adds --fake-super. */
    fakeSuper: boolean;
}

/** Argv flavor: "estimate" = transfer + --dry-run; "verify" = transfer + --dry-run --checksum --itemize-changes. */
export type BuildMode = "transfer" | "estimate" | "verify";

/** Ensure a formatted endpoint ends with exactly one "/" (rsync contents-of semantics). */
function withTrailingSlash(formatted: string): string {
    return formatted.endsWith("/") ? formatted : formatted + "/";
}

/**
 * Strip one trailing "/" from a formatted destination, except when removing it
 * would change meaning ("/" itself, or a remote home-dir form ending in ":").
 */
function withoutTrailingSlash(formatted: string): string {
    if (formatted.length > 1 && formatted.endsWith("/") && !formatted.endsWith(":/")) {
        return formatted.slice(0, -1);
    }
    return formatted;
}

/**
 * Build the full rsync argv (excluding the binary itself) for one transfer
 * spec in the given mode. The order is fixed by spec section 3's table; a mode
 * can never inherit a flag the table does not give it. Throws TransferError on
 * a linkDestBase that fails the snapshot-name codec.
 */
export function buildArgs(spec: TransferSpec, mode: BuildMode): string[] {
    const o = spec.options;
    const args: string[] = ["-a", "-H", "--numeric-ids", "--sparse"];
    if (!o.preserveDevices) {
        args.push("--no-devices", "--no-specials");
    }
    args.push("--chmod=ug-s");
    if (o.compress) {
        args.push("-z");
    }
    args.push("--delete", "--force", "--partial");
    args.push(`--timeout=${o.ioTimeoutSec}`);
    args.push("--info=stats2");
    if (!o.preserveOwnership) {
        args.push("--no-owner", "--no-group");
    }
    if (spec.fakeSuper) {
        args.push("--fake-super");
    }
    if (o.xattrs) {
        args.push("--xattrs");
    }
    if (o.bwlimit !== null) {
        args.push(`--bwlimit=${o.bwlimit}`);
    }
    for (const pattern of spec.exclude) {
        args.push(`--exclude=${pattern}`);
    }
    // --rsync-path selects the server binary on the FAR side, so it is honored
    // only for a pull (remote SOURCE). A push destination is the jailed archive
    // server whose forced command (`backupkit-remote`) already fixes the server
    // binary; a client-supplied `--rsync-path=<bin>` would make ssh's original
    // command `<bin> --server ...`, which the jail rejects by design (it must
    // never exec a client-chosen binary - that is a shell escape). So on a push
    // target `remoteRsyncBin` is a no-op at the wire: the operator points the
    // jail account's own PATH at a rsync >= 3.2.5. ponytail: pull-only knob.
    if (o.remoteRsyncBin !== null && spec.src.kind === "remote") {
        args.push(`--rsync-path=${o.remoteRsyncBin}`);
    }
    if (spec.src.kind === "remote" || spec.dst.kind === "remote") {
        args.push("-e", spec.sshTokens.join(" "));
    }
    if (spec.linkDestBase !== null) {
        if (parseSnapshotName(spec.linkDestBase) === null) {
            throw new TransferError(`invalid link-dest base "${spec.linkDestBase}": not a snapshot name`, {
                exitCode: null,
                retriable: false,
                stderrTail: "",
            });
        }
        args.push(`--link-dest=../${spec.linkDestBase}`);
    }
    if (mode !== "transfer") {
        args.push("--dry-run");
    }
    if (mode === "verify") {
        args.push("--checksum", "--itemize-changes");
    }
    args.push(withTrailingSlash(formatEndpoint(spec.src)), withoutTrailingSlash(formatEndpoint(spec.dst)));
    return args;
}
