import { describe, expect, it } from "vitest";
import { isBackupkitError } from "../../shared/errors.js";
import type { Endpoint } from "../../shared/types.js";
import { buildArgs, type BuildMode, type TransferOptions, type TransferSpec } from "../internal/args.js";

/** Default resolved rsync options (every config default filled). */
function defaultOptions(overrides?: Partial<TransferOptions>): TransferOptions {
    return {
        compress: true,
        bwlimit: null,
        ioTimeoutSec: 600,
        xattrs: false,
        preserveOwnership: true,
        preserveDevices: false,
        remoteRsyncBin: null,
        ...overrides,
    };
}

/** An explicit-remote endpoint on host 10.0.0.11 as user "backup". */
function explicitRemote(path: string, host = "10.0.0.11"): Endpoint {
    return {
        kind: "remote",
        remote: {
            kind: "explicit",
            name: "example",
            host,
            user: "backup",
            port: 22,
            identityFile: "/etc/backupkit/keys/k",
            passphrase: null,
            knownHostsFile: "/etc/backupkit/known_hosts",
        },
        path,
    };
}

/** An alias-remote endpoint via ssh_config alias "myserver". */
function aliasRemote(path: string): Endpoint {
    return { kind: "remote", remote: { kind: "alias", name: "srv", alias: "myserver" }, path };
}

/** A local endpoint. */
function local(path: string): Endpoint {
    return { kind: "local", path };
}

const MODES: BuildMode[] = ["transfer", "estimate", "verify"];

/** The mode-dependent argv suffix inserted before src/dst. */
function modeSuffix(mode: BuildMode): string[] {
    if (mode === "transfer") return [];
    if (mode === "estimate") return ["--dry-run"];
    return ["--dry-run", "--checksum", "--itemize-changes"];
}

describe("buildArgs: exact full-argv equality across all three modes", () => {
    const pullMinimal: TransferSpec = {
        src: explicitRemote("/var/www"),
        dst: local("/srv/backups/web/2026-08-10T031500Z.partial"),
        options: defaultOptions(),
        exclude: [],
        sshTokens: ["ssh", "-o", "BatchMode=yes", "-p", "22", "-i", "/etc/backupkit/keys/k"],
        linkDestBase: null,
        fakeSuper: false,
    };

    it.each(MODES)("pull + minimal options, mode %s", (mode) => {
        expect(buildArgs(pullMinimal, mode)).toEqual([
            "-a",
            "-H",
            "--numeric-ids",
            "--sparse",
            "--no-devices",
            "--no-specials",
            "--chmod=ug-s",
            "-z",
            "--delete",
            "--force",
            "--partial",
            "--timeout=600",
            "--info=stats2",
            "-e",
            "ssh -o BatchMode=yes -p 22 -i /etc/backupkit/keys/k",
            ...modeSuffix(mode),
            "backup@10.0.0.11:/var/www/",
            "/srv/backups/web/2026-08-10T031500Z.partial",
        ]);
    });

    const hostileExcludes = ["cache/", "*.tmp", "we ird $(rm -rf ~)", "--delete", "semi;colon'quo\"te"];

    const pushMaximal: TransferSpec = {
        src: local("/var/www"),
        dst: aliasRemote("/backups/web/2026-08-10T031500Z.partial"),
        options: defaultOptions({
            compress: false,
            bwlimit: "10M",
            ioTimeoutSec: 300,
            xattrs: true,
            preserveOwnership: false,
            preserveDevices: true,
            remoteRsyncBin: "/usr/local/bin/rsync",
        }),
        exclude: hostileExcludes,
        sshTokens: ["ssh", "-o", "BatchMode=yes"],
        linkDestBase: "2026-08-09T031500Z",
        fakeSuper: true,
    };

    it.each(MODES)("push + maximal options, mode %s", (mode) => {
        expect(buildArgs(pushMaximal, mode)).toEqual([
            "-a",
            "-H",
            "--numeric-ids",
            "--sparse",
            "--chmod=ug-s",
            "--delete",
            "--force",
            "--partial",
            "--timeout=300",
            "--info=stats2",
            "--no-owner",
            "--no-group",
            "--fake-super",
            "--xattrs",
            "--bwlimit=10M",
            "--exclude=cache/",
            "--exclude=*.tmp",
            "--exclude=we ird $(rm -rf ~)",
            "--exclude=--delete",
            "--exclude=semi;colon'quo\"te",
            "-e",
            "ssh -o BatchMode=yes",
            "--link-dest=../2026-08-09T031500Z",
            ...modeSuffix(mode),
            "/var/www/",
            "myserver:/backups/web/2026-08-10T031500Z.partial",
        ]);
    });

    it("hostile exclude strings stay single, unmodified argv elements", () => {
        const args = buildArgs(pushMaximal, "transfer");
        for (const pattern of hostileExcludes) {
            expect(args).toContain(`--exclude=${pattern}`);
        }
    });
});

describe("buildArgs: link-dest handling", () => {
    const base: TransferSpec = {
        src: explicitRemote("/data"),
        dst: local("/srv/backups/t/2026-08-10T031500Z.partial"),
        options: defaultOptions(),
        exclude: [],
        sshTokens: ["ssh"],
        linkDestBase: null,
        fakeSuper: false,
    };

    it("absent when linkDestBase is null (first snapshot)", () => {
        expect(buildArgs(base, "transfer").some((a) => a.startsWith("--link-dest"))).toBe(false);
    });

    it("present as exactly one single-level ../<base> token", () => {
        const args = buildArgs({ ...base, linkDestBase: "2026-08-09T031500Z" }, "transfer");
        expect(args.filter((a) => a.startsWith("--link-dest"))).toEqual(["--link-dest=../2026-08-09T031500Z"]);
    });

    it.each(["../evil", "2026-13-40T996699Z", "20260810T031500Z1", "x", "2026-08-09T031500Z.partial"])(
        "refuses a non-snapshot link-dest base: %s",
        (bad) => {
            expect.assertions(2);
            try {
                buildArgs({ ...base, linkDestBase: bad }, "transfer");
            } catch (error) {
                expect(isBackupkitError(error)).toBe(true);
                expect((error as { code: string }).code).toBe("transfer");
            }
        },
    );
});

describe("buildArgs: endpoints and -e", () => {
    const options = defaultOptions();

    it("local-to-local carries no -e", () => {
        const args = buildArgs(
            {
                src: local("/snap/2026-08-10T031500Z"),
                dst: local("/restore/out"),
                options,
                exclude: [],
                sshTokens: [],
                linkDestBase: null,
                fakeSuper: false,
            },
            "transfer",
        );
        expect(args).not.toContain("-e");
        expect(args.slice(-2)).toEqual(["/snap/2026-08-10T031500Z/", "/restore/out"]);
    });

    it("-e joins the ssh tokens with spaces when the destination is remote (push)", () => {
        const args = buildArgs(
            {
                src: local("/var/www"),
                dst: explicitRemote("/backups/web/2026-08-10T031500Z.partial"),
                options,
                exclude: [],
                sshTokens: ["ssh", "-o", "ConnectTimeout=15"],
                linkDestBase: null,
                fakeSuper: false,
            },
            "transfer",
        );
        const eIndex = args.indexOf("-e");
        expect(eIndex).toBeGreaterThan(-1);
        expect(args[eIndex + 1]).toBe("ssh -o ConnectTimeout=15");
    });

    it("builder is kind-blind: alias and explicit token sets are joined identically", () => {
        const tokens = ["ssh", "-o", "BatchMode=yes"];
        const viaAlias = buildArgs(
            { src: aliasRemote("/d"), dst: local("/s/t/2026-08-10T031500Z.partial"), options, exclude: [], sshTokens: tokens, linkDestBase: null, fakeSuper: false },
            "transfer",
        );
        const viaExplicit = buildArgs(
            { src: explicitRemote("/d"), dst: local("/s/t/2026-08-10T031500Z.partial"), options, exclude: [], sshTokens: tokens, linkDestBase: null, fakeSuper: false },
            "transfer",
        );
        expect(viaAlias[viaAlias.indexOf("-e") + 1]).toBe(viaExplicit[viaExplicit.indexOf("-e") + 1]);
    });

    it("IPv6 hosts arrive bracketed via the shared endpoint formatter", () => {
        const args = buildArgs(
            {
                src: explicitRemote("/var/www", "fd00::11"),
                dst: local("/srv/backups/web/2026-08-10T031500Z.partial"),
                options,
                exclude: [],
                sshTokens: ["ssh"],
                linkDestBase: null,
                fakeSuper: false,
            },
            "transfer",
        );
        expect(args.at(-2)).toBe("backup@[fd00::11]:/var/www/");
    });

    it("alias sources format as the bare alias:path with no user@ and no brackets", () => {
        const args = buildArgs(
            {
                src: aliasRemote("/var/www"),
                dst: local("/srv/backups/web/2026-08-10T031500Z.partial"),
                options,
                exclude: [],
                sshTokens: ["ssh"],
                linkDestBase: null,
                fakeSuper: false,
            },
            "transfer",
        );
        expect(args.at(-2)).toBe("myserver:/var/www/");
    });

    it("normalizes the source to exactly one trailing slash", () => {
        const args = buildArgs(
            {
                src: local("/var/www/"),
                dst: local("/s/t/2026-08-10T031500Z.partial"),
                options,
                exclude: [],
                sshTokens: [],
                linkDestBase: null,
                fakeSuper: false,
            },
            "transfer",
        );
        expect(args.at(-2)).toBe("/var/www/");
    });

    it("strips a stray trailing slash from the destination", () => {
        const args = buildArgs(
            {
                src: local("/var/www"),
                dst: local("/s/t/2026-08-10T031500Z.partial/"),
                options,
                exclude: [],
                sshTokens: [],
                linkDestBase: null,
                fakeSuper: false,
            },
            "transfer",
        );
        expect(args.at(-1)).toBe("/s/t/2026-08-10T031500Z.partial");
    });
});

describe("buildArgs: option toggles", () => {
    const spec = (options: TransferOptions, fakeSuper = false): TransferSpec => ({
        src: local("/a"),
        dst: local("/s/t/2026-08-10T031500Z.partial"),
        options,
        exclude: [],
        sshTokens: [],
        linkDestBase: null,
        fakeSuper,
    });

    it("--chmod=ug-s and --no-devices --no-specials are on by default", () => {
        const args = buildArgs(spec(defaultOptions()), "transfer");
        expect(args).toContain("--chmod=ug-s");
        expect(args).toContain("--no-devices");
        expect(args).toContain("--no-specials");
    });

    it("preserveDevices drops --no-devices --no-specials but never --chmod=ug-s", () => {
        const args = buildArgs(spec(defaultOptions({ preserveDevices: true })), "transfer");
        expect(args).toContain("--chmod=ug-s");
        expect(args).not.toContain("--no-devices");
        expect(args).not.toContain("--no-specials");
    });

    it("--fake-super appears only for a non-root receiver", () => {
        expect(buildArgs(spec(defaultOptions()), "transfer")).not.toContain("--fake-super");
        expect(buildArgs(spec(defaultOptions(), true), "transfer")).toContain("--fake-super");
    });

    it("compress false drops -z", () => {
        expect(buildArgs(spec(defaultOptions({ compress: false })), "transfer")).not.toContain("-z");
    });

    it("--bwlimit token is passed verbatim", () => {
        expect(buildArgs(spec(defaultOptions({ bwlimit: "512" })), "transfer")).toContain("--bwlimit=512");
    });
});

describe("buildArgs: remoteRsyncBin is a pull-only knob (jail compatibility)", () => {
    const bin = "/opt/homebrew/bin/rsync";

    it("emits --rsync-path for a pull (remote source)", () => {
        const args = buildArgs(
            {
                src: explicitRemote("/var/www"),
                dst: local("/srv/backups/web/2026-08-10T031500Z.partial"),
                options: defaultOptions({ remoteRsyncBin: bin }),
                exclude: [],
                sshTokens: ["ssh"],
                linkDestBase: null,
                fakeSuper: false,
            },
            "transfer",
        );
        expect(args).toContain(`--rsync-path=${bin}`);
    });

    it("never emits --rsync-path for a push (remote destination), even with remoteRsyncBin set", () => {
        // A push destination is the jailed archive server; a client-supplied
        // --rsync-path would make ssh run `<bin> --server ...`, which the jail
        // rejects. The forced command fixes the server binary instead.
        for (const mode of MODES) {
            const args = buildArgs(
                {
                    src: local("/var/www"),
                    dst: aliasRemote("/backups/web/2026-08-10T031500Z.partial"),
                    options: defaultOptions({ remoteRsyncBin: bin }),
                    exclude: [],
                    sshTokens: ["ssh"],
                    linkDestBase: null,
                    fakeSuper: false,
                },
                mode,
            );
            expect(args.some((a) => a.startsWith("--rsync-path"))).toBe(false);
        }
    });
});
