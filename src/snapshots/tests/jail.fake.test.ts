import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { exec, type ExecResult } from "../../exec/exec.js";
import { quoteShellArg } from "../../ssh/internal/quote.js";
import { FakeBinDir } from "../../ssh/tests/fake-bin.js";

/** Absolute path of the shipped jail script. */
const SCRIPT = fileURLToPath(new URL("../internal/backupkit-remote.sh", import.meta.url));

/** Render an argv array exactly the way runRemote does: one quoted shell word each. */
function quoted(argv: string[]): string {
    return argv.map(quoteShellArg).join(" ");
}

/** A snapshot name used throughout. */
const SNAP = "2026-08-10T031502Z";

/** An older snapshot name for mv/link-dest cases. */
const BASE = "2026-08-01T000000Z";

/**
 * The `rsync --server` argv rsync 3.4.4 REALLY sends for each of backupkit's
 * modes, captured by pointing `-e` at a recorder script - never hand-written
 * (security invariant 24: a grammar written from the client's intent passes
 * every synthetic test and refuses every real push with a bare "rejected").
 * `<ROOT>` is substituted with the fixture jail root at run time.
 *
 * The OPTION tokens are the captured part and are never edited. The path
 * operand is the client's own and moved with it when `destination` became one
 * target's archive root: it was `<ROOT>/<target>/<snap>.partial` and is now
 * `<ROOT>/<snap>.partial`, one component under the root.
 *
 * Note what the wire does NOT carry: `--chmod=ug-s`, `--xattrs`, `--no-D`,
 * `--no-owner`, `--dry-run`, `--checksum`, `--itemize-changes` and
 * `--exclude=` are all absent as long options - rsync either folds them into
 * the short bundle (`X`, the missing `D`/`o`/`g`, `n`, `c`), rewrites them
 * (`--itemize-changes` -> `--log-format=%i`) or sends them over the protocol
 * stream instead. A jail test that feeds them by hand tests nothing real.
 */
const CAPTURED_ARGV: ReadonlyArray<readonly [string, string]> = [
    ["first push", `rsync --server -logtprze.iLsfxCIvu --numeric-ids . <ROOT>/${SNAP}.partial`],
    [
        "incremental push",
        `rsync --server -logtprze.iLsfxCIvu --numeric-ids --link-dest ../${BASE} . <ROOT>/${SNAP}.partial`,
    ],
    [
        "full production push",
        `rsync --server -lHtpXrSze.iLsfxCIvu --timeout=600 --bwlimit=10240 --delete-excluded --force --partial ` +
            `--numeric-ids --link-dest ../${BASE} --info=STATS2 . <ROOT>/${SNAP}.partial`,
    ],
    ["estimate (dry-run)", `rsync --server -nlogDtprze.iLsfxCIvu --stats --numeric-ids . <ROOT>/${SNAP}.partial`],
    [
        "verify (dry-run, checksum, itemize)",
        `rsync --server -nlHogDtprcSe.iLsfxCIvu --log-format=%i --timeout=600 --delete-excluded --force --partial ` +
            `--numeric-ids --info=STATS2 . <ROOT>/${SNAP}.partial`,
    ],
    ["restore read (--sender, complete snapshot)", `rsync --server --sender -logtpre.iLsfxCIvu --numeric-ids . <ROOT>/${BASE}/`],
];

describe("backupkit-remote jail script", () => {
    /**
     * The jail root, which IS one target's archive root: its snapshots sit
     * directly in it. A second target on the same server gets a second root and
     * a second authorized_keys line, so no path here ever names a target.
     */
    let jailRoot: string;
    let fake: FakeBinDir;

    beforeEach(async () => {
        jailRoot = await mkdtemp(join(tmpdir(), "backupkit-jail-"));
        fake = await FakeBinDir.create();
        await fake.install("rsync");
    });

    afterEach(async () => {
        await rm(jailRoot, { recursive: true, force: true });
        await fake.dispose();
    });

    /** Run the jail with the given SSH_ORIGINAL_COMMAND (fake rsync on PATH, real coreutils). */
    async function jail(command: string, args: string[] = [jailRoot]): Promise<ExecResult> {
        return exec("sh", [SCRIPT, ...args], {
            env: { ...fake.env({ rsync: [{ exit: 0 }] }), SSH_ORIGINAL_COMMAND: command },
            timeoutMs: 10_000,
        });
    }

    /** Assert a command is rejected: exit 1 and the rejection marker on stderr. */
    async function expectRejected(command: string, args: string[] = [jailRoot]): Promise<void> {
        const result = await jail(command, args);
        expect(result.exitCode).toBe(1);
        expect(result.stderr).toContain("backupkit-remote: rejected");
    }

    describe("allowed lifecycle forms (executed for real against the tmp jail)", () => {
        it("runs the full store lifecycle: mkdir -p, find, mv, df, rm, and the lock forms", async () => {
            const mk = await jail(quoted(["mkdir", "-p", "--", `${jailRoot}/${SNAP}.partial`]));
            expect(mk.exitCode).toBe(0);
            expect(existsSync(`${jailRoot}/${SNAP}.partial`)).toBe(true);

            const find = await jail(quoted(["find", jailRoot, "-maxdepth", "1", "-mindepth", "1", "-print0"]));
            expect(find.exitCode).toBe(0);
            expect(find.stdout).toContain(`${jailRoot}/${SNAP}.partial\0`);

            const mv = await jail(quoted(["mv", "--", `${jailRoot}/${SNAP}.partial`, `${jailRoot}/${SNAP}`]));
            expect(mv.exitCode).toBe(0);
            expect(existsSync(`${jailRoot}/${SNAP}`)).toBe(true);

            const df = await jail(quoted(["df", "-Pk", "--", jailRoot]));
            expect(df.exitCode).toBe(0);
            expect(df.stdout).toMatch(/[0-9]+%/);

            const lockMk = await jail(quoted(["mkdir", "--", `${jailRoot}/.backupkit.lock`]));
            expect(lockMk.exitCode).toBe(0);
            const lockAgain = await jail(quoted(["mkdir", "--", `${jailRoot}/.backupkit.lock`]));
            expect(lockAgain.exitCode).not.toBe(0);
            const marker = await jail(quoted(["mkdir", "-p", "--", `${jailRoot}/.backupkit.lock/${SNAP}`]));
            expect(marker.exitCode).toBe(0);
            const lockRm = await jail(quoted(["rm", "-rf", "--", `${jailRoot}/.backupkit.lock`]));
            expect(lockRm.exitCode).toBe(0);
            expect(existsSync(`${jailRoot}/.backupkit.lock`)).toBe(false);

            const rmSnap = await jail(quoted(["rm", "-rf", "--", `${jailRoot}/${SNAP}.deleting`]));
            expect(rmSnap.exitCode).toBe(0);
        });

        it("accepts a .deleting operand", async () => {
            const result = await jail(quoted(["mkdir", "-p", "--", `${jailRoot}/${SNAP}.deleting`]));
            expect(result.exitCode).toBe(0);
        });

        it("the ROOT ITSELF is a legal operand for mkdir, find and df (it is the archive)", async () => {
            // It used to be `<root>/<target>` that these named, so the root was
            // only ever a prefix. The store now issues them against the root
            // directly (ensureRoot, listEntries, freeBytes): a jail that still
            // demanded a component under the root would reject every push at
            // its very first command.
            for (const argv of [
                ["mkdir", "-p", "--", jailRoot],
                ["find", jailRoot, "-maxdepth", "1", "-mindepth", "1", "-print0"],
                ["df", "-Pk", "--", jailRoot],
            ]) {
                const result = await jail(quoted(argv));
                expect({ argv, stderr: result.stderr, exit: result.exitCode }).toEqual({ argv, stderr: "", exit: 0 });
            }
        });

        it("rejects a target-name component: no path the client sends holds one", async () => {
            // The pre-2.0 layout put every target in its own subdirectory of a
            // SHARED root, so the jail had to accept a target-name-charset
            // component. A root is one target's archive now, so that shape is
            // one nothing legitimate sends - and an accepted shape only an
            // attacker has a use for (`mkdir <root>/.ssh` was the same hole).
            for (const path of [
                `${jailRoot}/web`,
                `${jailRoot}/mail@srv1`,
                `${jailRoot}/my-target.01`,
                `${jailRoot}/web/${SNAP}.partial`,
            ]) {
                await expectRejected(quoted(["mkdir", "-p", "--", path]));
                expect(existsSync(path)).toBe(false);
            }
        });
    });

    describe("rm -rf is narrower than every other verb (the delete-component policy)", () => {
        // The Critical: `rm -rf` used to share check_component with mkdir/mv/find/df,
        // so a compromised push client could erase a target's ENTIRE archive
        // history with one permitted command. check_delete_component now pins the
        // FINAL component to the only three shapes the client ever removes, and
        // check_lifecycle_path refuses the root itself for this verb alone.
        it.each([
            ["the archive root itself (the Critical)", () => jailRoot],
            ["a COMPLETE snapshot", () => `${jailRoot}/${BASE}`],
            ["the lock's snapshot-named marker", () => `${jailRoot}/.backupkit.lock/${SNAP}`],
            ["a target-name-shaped directory (the pre-2.0 archive of a whole target)", () => `${jailRoot}/web`],
        ])("rejects rm -rf of %s", async (_label, build) => {
            const path = build();
            await mkdir(path, { recursive: true });
            await expectRejected(quoted(["rm", "-rf", "--", path]));
            expect(existsSync(path)).toBe(true);
        });

        it.each([
            ["<snap>.partial", () => `${jailRoot}/${SNAP}.partial`],
            ["<snap>.deleting", () => `${jailRoot}/${SNAP}.deleting`],
            [".backupkit.lock", () => `${jailRoot}/.backupkit.lock`],
        ])("accepts rm -rf of %s (prune and lock release break without it)", async (_label, build) => {
            const path = build();
            await mkdir(path, { recursive: true });
            const result = await jail(quoted(["rm", "-rf", "--", path]));
            expect(result.stderr).not.toContain("backupkit-remote: rejected");
            expect(result.exitCode).toBe(0);
            expect(existsSync(path)).toBe(false);
        });

        it("the broader policy the other verbs need is untouched", async () => {
            const lock = `${jailRoot}/.backupkit.lock`;
            await mkdir(`${jailRoot}/${BASE}`, { recursive: true });
            await mkdir(`${jailRoot}/${SNAP}.partial`, { recursive: true });
            const shapes: string[][] = [
                // The archive root and a lock marker: mkdir must still accept both.
                ["mkdir", "-p", "--", jailRoot],
                ["mkdir", "--", lock],
                ["mkdir", "-p", "--", `${lock}/${SNAP}`],
                // Both mv forms: retire a COMPLETE snapshot, and promote a .partial.
                ["mv", "--", `${jailRoot}/${BASE}`, `${jailRoot}/${BASE}.deleting`],
                ["mv", "--", `${jailRoot}/${SNAP}.partial`, `${jailRoot}/${SNAP}`],
                // find and df name the archive root.
                ["find", jailRoot, "-maxdepth", "1", "-mindepth", "1", "-print0"],
                ["df", "-Pk", "--", jailRoot],
            ];
            for (const argv of shapes) {
                const result = await jail(quoted(argv));
                expect({ argv, stderr: result.stderr, exit: result.exitCode }).toEqual({
                    argv,
                    stderr: "",
                    exit: 0,
                });
            }
        });
    });

    describe("the mv PAIR is one of three real renames (closing the rename gadget)", () => {
        // The Critical: the two operands were checked INDEPENDENTLY with
        // check_component, so `mv -- <root>/<x> <root>/<snap>.deleting` was legal
        // and the resulting `.deleting` leaf is precisely what `rm -rf` is allowed
        // to remove: two permitted commands erased a target's entire archive
        // history, defeating the narrowed rm -rf policy completely. Narrowing a
        // VERB is not the same as enforcing the PROPERTY.
        it.each([
            [
                "renames the archive root into a .deleting leaf that rm -rf may then remove",
                () => [jailRoot, `${jailRoot}/${SNAP}.deleting`],
            ],
            [
                "moves the remote mutex aside so two pipelines run on one archive",
                () => [`${jailRoot}/.backupkit.lock`, `${jailRoot}/${SNAP}`],
            ],
            [
                "renames a snapshot into the lock directory to hide it",
                () => [`${jailRoot}/${BASE}`, `${jailRoot}/.backupkit.lock`],
            ],
            [
                "carries a snapshot out of the archive root into the lock",
                () => [`${jailRoot}/${SNAP}.partial`, `${jailRoot}/.backupkit.lock/${SNAP}.partial`],
            ],
            [
                "nests a snapshot inside another snapshot instead of renaming it",
                () => [`${jailRoot}/${SNAP}.partial`, `${jailRoot}/${BASE}/${SNAP}`],
            ],
            [
                "carries a snapshot out of the jail root entirely",
                () => [`${jailRoot}/${SNAP}.partial`, `${jailRoot}.deleting`],
            ],
        ])("rejects the mv that %s", async (_label, build) => {
            const [src, dst] = build();
            await mkdir(src, { recursive: true });
            await expectRejected(quoted(["mv", "--", src, dst]));
            expect(existsSync(src)).toBe(true);
            expect(existsSync(dst)).toBe(false);
        });

        it.each([
            ["promote", () => [`${SNAP}.partial`, SNAP]],
            ["delete phase 1", () => [BASE, `${BASE}.deleting`]],
            ["partial re-claim", () => [`${BASE}.partial`, `${SNAP}.partial`]],
        ])("still permits the %s rename the remote store issues", async (_label, build) => {
            const [from, to] = build();
            await mkdir(`${jailRoot}/${from}`, { recursive: true });
            const result = await jail(quoted(["mv", "--", `${jailRoot}/${from}`, `${jailRoot}/${to}`]));
            expect({ stderr: result.stderr, exit: result.exitCode }).toEqual({ stderr: "", exit: 0 });
            expect(existsSync(`${jailRoot}/${to}`)).toBe(true);
        });

        it("the two-command gadget no longer erases real archived data (real mv, real rm)", async () => {
            // End-to-end against the fixture jail root ONLY, with the script's
            // real mv/rm: the exact sequence that used to destroy a target.
            const payload = `${jailRoot}/${BASE}/data.txt`;
            await mkdir(`${jailRoot}/${BASE}`, { recursive: true });
            await writeFile(payload, "the only copy");

            // Step 1: rename the whole archive to a leaf rm -rf is allowed to take.
            await expectRejected(quoted(["mv", "--", jailRoot, `${jailRoot}/${SNAP}.deleting`]));
            // Step 2: the rm the gadget relied on. The jail permits this shape by
            // design, but step 1 never produced its operand, so it removes nothing.
            const step2 = await jail(quoted(["rm", "-rf", "--", `${jailRoot}/${SNAP}.deleting`]));
            expect(step2.stderr).not.toContain("backupkit-remote: rejected");

            expect(existsSync(payload)).toBe(true);
            expect(existsSync(`${jailRoot}/${BASE}`)).toBe(true);
        });
    });

    describe("a rename may not bury its source inside an existing directory", () => {
        // POSIX `mv` does not replace an existing directory - it moves the source
        // INSIDE it. So `mv <snap>.partial <snap>` against a complete snapshot
        // that already exists writes into already-verified history, which the
        // rsync destination policy refuses outright for a transfer. Both operands
        // are snapshot-shaped siblings, so the pair policy alone lets it through;
        // absence of the destination is the missing half. The client's promote()
        // has a post-check for the nested outcome, but a compromised client just
        // omits it, which is why the server has to enforce it.
        it("refuses a promote onto a complete snapshot that already exists (a write into verified history)", async () => {
            await mkdir(join(jailRoot, BASE), { recursive: true });
            await writeFile(join(jailRoot, BASE, "verified.txt"), "already promoted\n");
            await mkdir(join(jailRoot, `${BASE}.partial`), { recursive: true });

            await expectRejected(quoted(["mv", "--", `${jailRoot}/${BASE}.partial`, `${jailRoot}/${BASE}`]));

            // The existing snapshot is untouched and nothing was buried in it.
            expect(await readdir(join(jailRoot, BASE))).toEqual(["verified.txt"]);
        });

        it("still allows the real promote, whose destination does not exist yet", async () => {
            await mkdir(join(jailRoot, `${SNAP}.partial`), { recursive: true });

            const result = await jail(quoted(["mv", "--", `${jailRoot}/${SNAP}.partial`, `${jailRoot}/${SNAP}`]));

            expect(result.exitCode).toBe(0);
            expect(await readdir(jailRoot)).toContain(SNAP);
        });
    });

    describe("the one-component rsync rule must not leak into the lifecycle verbs", () => {
        it("keeps the two-deep lock marker, the marker listing, and the root mkdir working", async () => {
            // The rsync destination policy is exactly one component under $ROOT.
            // The LIFECYCLE policy is not: the lock marker lives two components
            // deep (.backupkit.lock/<snap>), and copying the rsync rule across
            // would make every remote lock acquisition fail.
            const lock = `${jailRoot}/.backupkit.lock`;
            const shapes: string[][] = [
                ["mkdir", "-p", "--", jailRoot],
                ["mkdir", "--", lock],
                ["mkdir", "-p", "--", `${lock}/${SNAP}`],
                ["find", lock, "-maxdepth", "1", "-mindepth", "1", "-print0"],
            ];
            for (const argv of shapes) {
                const result = await jail(quoted(argv));
                expect({ argv, stderr: result.stderr, exit: result.exitCode }).toEqual({
                    argv,
                    stderr: "",
                    exit: 0,
                });
            }
            const listing = await jail(quoted(["find", lock, "-maxdepth", "1", "-mindepth", "1", "-print0"]));
            expect(listing.stdout).toContain(`${lock}/${SNAP}\0`);
        });
    });

    describe("allowed rsync forms (fake rsync records the argv)", () => {
        it.each(CAPTURED_ARGV)(
            "a real %s is not refused with a bare \"rejected\" (grammar written from the wire, not from intent)",
            async (_mode, template) => {
                const cmd = template.replaceAll("<ROOT>", jailRoot);
                const result = await jail(cmd);
                expect({ cmd, stderr: result.stderr, exit: result.exitCode }).toEqual({ cmd, stderr: "", exit: 0 });
                // Every token reaches rsync unchanged: the jail execs the argv it
                // validated, it does not rebuild it.
                const calls = await fake.calls();
                expect(calls.map((call) => call.argv)).toEqual([cmd.split(" ").slice(1)]);
            },
        );

        it.each([
            ["the = form", () => `--link-dest=../${BASE}`],
            ["the space-separated form", () => `--link-dest ../${BASE}`],
        ])("permits %s of --link-dest", async (_label, build) => {
            const cmd = `rsync --server -logDtpre.iLsfxC ${build()} . ${jailRoot}/${SNAP}.partial`;
            expect((await jail(cmd)).exitCode).toBe(0);
        });

        it.each([
            ["a non-snapshot sibling", "../evil"],
            ["an absolute path", "/etc"],
            ["the bare cwd", "."],
            ["a deeper traversal", "../../etc"],
        ])("rejects the space-separated --link-dest %s, and it never reaches rsync", async (_label, value) => {
            await expectRejected(`rsync --server -logDtpre.iLsfxC --link-dest ${value} . ${jailRoot}/${SNAP}.partial`);
            expect(await fake.calls()).toEqual([]);
        });

        it("the consumed --link-dest value can never be mistaken for the path operand", async () => {
            // The value token is eaten inside the --link-dest branch; a command
            // whose ONLY trailing path is that value has no operand at all.
            await expectRejected(`rsync --server -logDtpre.iLsfxC --link-dest ../${BASE} .`);
            expect(await fake.calls()).toEqual([]);
        });

        it.each([
            ["--rsync-path=/bin/sh still runs a client-chosen binary", "--rsync-path=/bin/sh -a"],
            ["a short bundle containing L still follows symlinks out", "-logDtpreL.iLsfxC"],
        ])("regression: %s", async (_label, opts) => {
            await expectRejected(`rsync --server ${opts} . ${jailRoot}/${SNAP}.partial`);
            expect(await fake.calls()).toEqual([]);
        });

        it("permits the quoted and unquoted version probe", async () => {
            expect((await jail("'rsync' '--version'")).exitCode).toBe(0);
            expect((await jail("rsync --version")).exitCode).toBe(0);
            const calls = await fake.calls();
            expect(calls.map((call) => call.argv)).toEqual([["--version"], ["--version"]]);
        });

        it("permits a receiving --server invocation whose destination is inside the jail", async () => {
            const cmd = `rsync --server -logDtpre.iLsfxC --partial --timeout=600 --link-dest=../${BASE} . ${jailRoot}/${SNAP}.partial`;
            const result = await jail(cmd);
            expect(result.exitCode).toBe(0);
            const calls = await fake.calls();
            expect(calls[0].argv).toEqual([
                "--server",
                "-logDtpre.iLsfxC",
                "--partial",
                "--timeout=600",
                `--link-dest=../${BASE}`,
                ".",
                `${jailRoot}/${SNAP}.partial`,
            ]);
        });

        it("permits a sending --server invocation (restore pull) from inside the jail", async () => {
            const cmd = `rsync --server --sender -logDtpre.iLsfxC . ${jailRoot}/${SNAP}/`;
            const result = await jail(cmd);
            expect(result.exitCode).toBe(0);
        });

        it("permits capital S (--sparse) inside a real measured bundle", async () => {
            // S is sent on every production push (see CAPTURED_ARGV): a bundle
            // rule that swept up capital letters would refuse every real run.
            const cmd = `rsync --server -lHtpXrSze.iLsfxCIvu --numeric-ids . ${jailRoot}/${SNAP}.partial`;
            expect((await jail(cmd)).exitCode).toBe(0);
        });
    });

    describe("the rsync path operand is pinned to the run's own .partial (destination policy)", () => {
        // The Critical: check_rsync_path used to accept ANY path under $ROOT with
        // no "..", while the option grammar permits the --delete --force the real
        // client sends on every run. `--delete --force` against the archive root
        // with an empty file list therefore erased every snapshot in one permitted
        // command, and a write could land in an already-verified snapshot or in a
        // dot-directory like $ROOT/.ssh.
        it.each([
            [
                "--delete --force aimed at the archive root erases its whole history in ONE command",
                () => `rsync --server -lHtpXrSze.iLsfxCIvu --delete --force --partial --numeric-ids . ${jailRoot}`,
            ],
            [
                "a write into a COMPLETE snapshot rewrites verified history",
                () => `rsync --server -logtprze.iLsfxCIvu --numeric-ids . ${jailRoot}/${BASE}`,
            ],
            [
                "a write into $ROOT/.ssh plants authorized_keys",
                () => `rsync --server -logtprze.iLsfxCIvu --numeric-ids . ${jailRoot}/.ssh`,
            ],
            [
                "a two-component destination writes inside a snapshot instead of building one",
                () => `rsync --server -logtprze.iLsfxCIvu --numeric-ids . ${jailRoot}/${SNAP}.partial/sub`,
            ],
            [
                "the pre-2.0 <target>/<snap>.partial shape now names a directory the archive has no level for",
                () => `rsync --server -logtprze.iLsfxCIvu --numeric-ids . ${jailRoot}/web/${SNAP}.partial`,
            ],
            [
                "a write into $ROOT/.ssh/<snap>.partial hides a dot-directory behind a legal leaf",
                () => `rsync --server -logtprze.iLsfxCIvu --numeric-ids . ${jailRoot}/.ssh/${SNAP}.partial`,
            ],
            [
                "a write into the lock directory defeats the remote mutex through the transfer verb",
                () => `rsync --server -logtprze.iLsfxCIvu --numeric-ids . ${jailRoot}/.backupkit.lock`,
            ],
        ])("rejects the write that %s", async (_label, build) => {
            await expectRejected(build());
            expect(await fake.calls()).toEqual([]);
        });

        it("still permits a --sender read of a COMPLETE snapshot, so restore keeps working", async () => {
            // The policy is DIRECTION-aware: a complete snapshot is a legal read
            // source and never a write destination. Pinning the leaf to .partial
            // in both directions would break every restore.
            const cmd = `rsync --server --sender -logtpre.iLsfxCIvu --numeric-ids . ${jailRoot}/${BASE}`;
            const result = await jail(cmd);
            expect({ stderr: result.stderr, exit: result.exitCode }).toEqual({ stderr: "", exit: 0 });
        });

        it("the root itself is not a legal --sender source either", async () => {
            // A read of the root would hand a compromised client every snapshot
            // in one command. Only a named snapshot is readable.
            await expectRejected(`rsync --server --sender -logtpre.iLsfxCIvu --numeric-ids . ${jailRoot}`);
            expect(await fake.calls()).toEqual([]);
        });
    });

    describe("unmeasured rsync options are refused by default (the option allowlist)", () => {
        const DEST = () => `${jailRoot}/${SNAP}.partial`;

        it.each([
            // --protect-args moves the file arguments off the command line into
            // the protocol stream, so the validated operand stops governing the
            // transfer: it nullifies every path check at once.
            ["--protect-args makes the validated path operand irrelevant", "--protect-args"],
            ["-s (the short --protect-args) does the same from inside the bundle", "-logDtpres.iLsfxC"],
            // The archive-side sender unlinks every file it sends: a delete
            // primitive that never touches the `rm -rf` verb.
            ["--remove-source-files deletes through the sender", "--remove-source-files"],
            // Writes THROUGH a --link-dest hardlink, mutating promoted snapshots.
            ["--inplace writes through a --link-dest hardlink", "--inplace"],
            // A value that can name a file is refused whatever the option is
            // called - this is what replaced a pure allowlist, which would have
            // broken every push the first time an rsync upgrade forwarded a new
            // option (invariant 24's hazard, arriving via a dependency bump).
            ["an unknown option carrying an absolute path", "--future-opt=/etc/shadow"],
            ["an unknown option carrying a traversal", "--future-opt=../escape"],
            ["a path-valued option in its bare, space-separated spelling", "--temp-dir /tmp/x"],
            ["a non-numeric --timeout value", "--timeout=abc"],
            ["a non-numeric --bwlimit value", "--bwlimit=x"],
            // rsync reads 0 as "unlimited" for both, so a zero is not a tighter
            // bound but the absence of one: --timeout=0 lets a jailed client pin
            // a server-side rsync open indefinitely, and with the lock's 24 h TTL
            // that denies the target its backups for a day per session. backupkit
            // always sends a real ioTimeoutSec, so a zero never comes from it.
            ["--timeout=0, which means no timeout at all", "--timeout=0"],
            ["--bwlimit=0, which means unlimited", "--bwlimit=0"],
            ["a leading-zero --timeout that is still zero", "--timeout=00"],
        ])("rejects %s", async (_label, option) => {
            await expectRejected(`rsync --server ${option} --numeric-ids . ${DEST()}`);
            expect(await fake.calls()).toEqual([]);
        });
    });

    describe("an rsync upgrade that forwards a new option must not break every push", () => {
        // The counterweight to the deny list. A pure allowlist is the safer
        // shape in the abstract and the wrong one here: the jail is a copy
        // deployed out-of-band, so the first rsync that forwards an option we
        // never measured would reject every push on every archive host at once,
        // with a bare "rejected" and nothing connecting it to an rsync bump.
        // What makes an option dangerous is naming a path, executing something,
        // following a symlink, or moving the file args off the command line -
        // not being unfamiliar. So unknown-but-shapeless is allowed, and the
        // destination pinning is what bounds it.
        const DEST = () => `${jailRoot}/${SNAP}.partial`;

        it.each([
            ["a valueless option no capture has produced", "--some-future-option"],
            ["an unknown option with a numeric value", "--future-opt=42"],
            ["an unknown option with a token value", "--future-opt=SOME_MODE"],
            ["--iconv, which rsync forwards when configured", "--iconv=utf-8"],
            ["--compress-level, a future default", "--compress-level=9"],
        ])("still accepts %s", async (_label, option) => {
            const dest = DEST();
            const result = await jail(`rsync --server -logDtpre.iLsfxC ${option} --numeric-ids . ${dest}`);

            expect(result.exitCode).toBe(0);
            expect(await fake.calls()).toHaveLength(1);
        });
    });

    describe("a short bundle may not smuggle an attached option VALUE (bundle grammar)", () => {
        const DEST = () => `${jailRoot}/${SNAP}.partial`;

        it.each([
            // `pre=${pre%%.*}` discarded everything after the first dot, so the
            // whole attached --temp-dir value vanished and only the letter "T"
            // was checked: rsync then wrote its temp files outside the jail.
            ["a bare -T with an attached out-of-jail --temp-dir value", "-T../../../../tmp"],
            ["the same value attached to the end of a real bundle", "-logDtpreT../../tmp.iLsfxC"],
            ["an attached value hidden after the capability dot", "-logDtpre.iLsfxC../../tmp"],
            // L/K/k inside a REAL measured bundle: the existing rows use a
            // synthetic bundle, these use one rsync actually sends.
            ["copy-links L inside the measured production bundle", "-lHtpXrSzLe.iLsfxCIvu"],
            ["keep-dirlinks K inside the measured production bundle", "-lHtpXrSzKe.iLsfxCIvu"],
            ["copy-dirlinks k inside the measured production bundle", "-lHtpXrSzke.iLsfxCIvu"],
        ])("rejects %s", async (_label, bundle) => {
            await expectRejected(`rsync --server ${bundle} --numeric-ids . ${DEST()}`);
            expect(await fake.calls()).toEqual([]);
        });
    });

    describe("rejected rsync --server symlink-following / escape options (jail confinement)", () => {
        const DST = () => `${jailRoot}/${SNAP}.partial`;

        it.each([
            // Symlink-following short flags in the compact bundle's active section.
            ["-L copy-links in bundle (read escape)", () => `rsync --server -logDtpreL.iLsfxC . ${DST()}`],
            ["-L with --sender (read escape)", () => `rsync --server --sender -logDtpreL.iLsfxC . ${DST()}`],
            ["-K keep-dirlinks in bundle (write escape)", () => `rsync --server -logDtpreK.iLsfxC . ${DST()}`],
            ["-k copy-dirlinks in bundle", () => `rsync --server -logDtprek.iLsfxC . ${DST()}`],
            // Symlink-following long options.
            ["--copy-links long form", () => `rsync --server --copy-links -logDtpre.iLsfxC . ${DST()}`],
            ["--copy-unsafe-links long form", () => `rsync --server --copy-unsafe-links -a . ${DST()}`],
            ["--keep-dirlinks long form", () => `rsync --server --keep-dirlinks -a . ${DST()}`],
            ["--copy-dirlinks long form", () => `rsync --server --copy-dirlinks -a . ${DST()}`],
            // Command-exec / daemon escapes.
            ["--rsync-path abuse (server binary)", () => `rsync --server --rsync-path=/bin/sh -a . ${DST()}`],
            ["--rsh abuse", () => `rsync --server --rsh=/bin/sh -a . ${DST()}`],
            ["-e rsh abuse", () => `rsync --server -e sh . ${DST()}`],
            ["--daemon", () => `rsync --server --daemon`],
            // Batch replay and out-of-jail path-valued options.
            ["--files-from out of jail", () => `rsync --server --files-from=/etc/x -a . ${DST()}`],
            ["--write-batch out of jail", () => `rsync --server --write-batch=/tmp/b -a . ${DST()}`],
            ["--compare-dest out of jail", () => `rsync --server --compare-dest=/etc -a . ${DST()}`],
            ["--copy-dest out of jail", () => `rsync --server --copy-dest=/etc -a . ${DST()}`],
            ["--partial-dir (relative, now denied)", () => `rsync --server --partial-dir=escape -a . ${DST()}`],
            ["--temp-dir out of jail", () => `rsync --server --temp-dir=/tmp -a . ${DST()}`],
            ["--backup-dir out of jail", () => `rsync --server --backup-dir=/etc -a . ${DST()}`],
        ])("rejects %s", async (_label, build) => {
            await expectRejected(build());
            expect(await fake.calls()).toEqual([]);
        });
    });

    describe("rejected commands", () => {
        it.each([
            ["unlisted command", "ls -la /"],
            ["shell reading a file", "cat /etc/passwd"],
            ["unquoted lifecycle form", `mkdir -p -- ${"/tmp/x"}`],
            ["rsync without --server", "rsync -av . /tmp/x"],
            ["bare rsync", "rsync"],
        ])("%s", async (_label, command) => {
            await expectRejected(command);
        });

        it("rejects lifecycle paths outside the jail root", async () => {
            await expectRejected(quoted(["mkdir", "-p", "--", "/etc/pwn"]));
            expect(existsSync("/etc/pwn")).toBe(false);
        });

        it("rejects .. traversal in lifecycle paths", async () => {
            await expectRejected(quoted(["mkdir", "-p", "--", `${jailRoot}/../pwn`]));
            await expectRejected(quoted(["rm", "-rf", "--", `${jailRoot}/${SNAP}/../../pwn`]));
        });

        it("rejects the jail root itself as an rm operand", async () => {
            await expectRejected(quoted(["rm", "-rf", "--", jailRoot]));
        });

        it("rejects components outside the allowed families", async () => {
            await expectRejected(quoted(["mkdir", "-p", "--", `${jailRoot}/@leading`]));
            await expectRejected(quoted(["mkdir", "-p", "--", `${jailRoot}/EVIL NAME`]));
            await expectRejected(quoted(["mkdir", "-p", "--", `${jailRoot}/Uppercase`]));
            await expectRejected(quoted(["rm", "-rf", "--", `${jailRoot}/.ssh`]));
            await expectRejected(quoted(["mkdir", "-p", "--", `${jailRoot}/${"a".repeat(65)}`]));
        });

        it("rejects command smuggling around the canonical quoting", async () => {
            await expectRejected(`'rm' '-rf' '--' '/x'; rm -rf /`);
            await expectRejected(`'rm' '-rf' '--' '${jailRoot}/${SNAP}.partial' '${jailRoot}/${BASE}.partial'`);
            await expectRejected(`'mkdir' '-p' '--' '${jailRoot}/$(boom)'`);
            await expectRejected(`'mv' '--' '${jailRoot}/a' '${jailRoot}/b' '${jailRoot}/c'`);
            await expectRejected(`'find' '${jailRoot}' '-delete'`);
            await expectRejected(`'find' '${jailRoot}' '-maxdepth' '1' '-mindepth' '1' '-print0' '-delete'`);
        });

        it("rejects a command containing a newline", async () => {
            await expectRejected(`'rsync' '--version'\nrm -rf /`);
        });

        it("rejects an empty SSH_ORIGINAL_COMMAND", async () => {
            await expectRejected("");
        });

        it("rejects a missing or relative jail root argument", async () => {
            await expectRejected(quoted(["rsync", "--version"]), []);
            await expectRejected(quoted(["rsync", "--version"]), ["relative/root"]);
        });

        it("rejects rsync --server escapes", async () => {
            await expectRejected(`rsync --server -a . /etc`);
            await expectRejected(`rsync --server -a . ${jailRoot}/../pwn`);
            await expectRejected(`rsync --server -a . ${jailRoot}/${SNAP} ${jailRoot}/${BASE}`);
            await expectRejected(`rsync --server -a extra . ${jailRoot}/${SNAP}`);
            await expectRejected(`rsync --server --link-dest=/etc . ${jailRoot}/${SNAP}`);
            await expectRejected(`rsync --server --link-dest=../evil . ${jailRoot}/${SNAP}`);
            await expectRejected(`rsync --server --partial-dir=/tmp/x . ${jailRoot}/${SNAP}`);
            await expectRejected("rsync --server -a`boom` . " + `${jailRoot}/${SNAP}`);
            await expectRejected(`rsync --server -a . `);
            await expectRejected(`rsync --server . `);
        });

        it("a rejected rsync command never reaches the rsync binary", async () => {
            await expectRejected(`rsync --server -a . /etc`);
            expect(await fake.calls()).toEqual([]);
        });
    });

    describe("symlink-component traversal escape (resolved path must stay under the jail)", () => {
        // The string checks bound the LITERAL path only. An attacker who can write
        // into the archive (rsync's default --links bundle writes a symlink INTO
        // it) plants one whose name passes the component grammar - which now means
        // a snapshot-shaped name - and a second command traverses it, so the
        // kernel dereferences the intermediate symlink and the write lands OUTSIDE
        // the jail. check_no_symlink_prefix rejects any operand whose existing
        // prefix is a symlink, closing this.
        it("blocks a write through an intermediate symlink for mkdir, mv, and the rsync destination", async () => {
            const escape = await mkdtemp(join(tmpdir(), "backupkit-escape-"));
            try {
                await mkdir(`${jailRoot}/${SNAP}.deleting`, { recursive: true });
                await writeFile(`${jailRoot}/${SNAP}.deleting/payload`, "x");
                // Attacker-planted symlink INSIDE the archive, snapshot-shaped so
                // the component grammar alone would let it through.
                await symlink(escape, `${jailRoot}/${BASE}`);

                // mkdir -p through the symlink: rejected.
                await expectRejected(quoted(["mkdir", "-p", "--", `${jailRoot}/${BASE}/${SNAP}`]));
                // mv into the symlinked directory: rejected.
                await expectRejected(quoted(["mv", "--", `${jailRoot}/${SNAP}.deleting`, `${jailRoot}/${BASE}/${SNAP}`]));
                // rsync --server writing through the symlink: rejected, never reaches rsync.
                await expectRejected(`rsync --server -logDtpre.iLsfxC . ${jailRoot}/${BASE}`);
                expect(await fake.calls()).toEqual([]);
                // Nothing escaped the jail.
                expect(await readdir(escape)).toEqual([]);
            } finally {
                await rm(escape, { recursive: true, force: true });
            }
        });

        it("rejects an operand whose LEAF itself is a symlink (broken symlink included)", async () => {
            // `<snap>.deleting` is a leaf `rm -rf` is otherwise allowed to take,
            // so only the symlink check can refuse this one.
            await symlink("/nonexistent-target", `${jailRoot}/${SNAP}.deleting`); // -L true, -e false
            await expectRejected(quoted(["rm", "-rf", "--", `${jailRoot}/${SNAP}.deleting`]));
        });

        it("still accepts legitimate operations on real (non-symlink) paths under the jail", async () => {
            await mkdir(`${jailRoot}/${SNAP}.partial`, { recursive: true });
            // mkdir a not-yet-existing snapshot (final component absent): must pass.
            expect((await jail(quoted(["mkdir", "-p", "--", `${jailRoot}/${SNAP}`]))).exitCode).toBe(0);
            // mv real .partial -> a fresh final name: must pass.
            expect((await jail(quoted(["mv", "--", `${jailRoot}/${SNAP}.partial`, `${jailRoot}/${BASE}`]))).exitCode).toBe(0);
            // rsync --server into a partial under a real tree: must pass.
            expect((await jail(`rsync --server -logDtpre.iLsfxC . ${jailRoot}/${SNAP}.partial`)).exitCode).toBe(0);
        });
    });

    describe("jail/store argv consistency", () => {
        it("every command shape the remote store issues is accepted by the jail", async () => {
            const lock = `${jailRoot}/.backupkit.lock`;
            const shapes: string[][] = [
                ["mkdir", "-p", "--", jailRoot],
                ["find", jailRoot, "-maxdepth", "1", "-mindepth", "1", "-print0"],
                ["rm", "-rf", "--", `${jailRoot}/${BASE}.deleting`],
                ["rm", "-rf", "--", `${jailRoot}/${BASE}.partial`],
                ["mv", "--", `${jailRoot}/${BASE}.partial`, `${jailRoot}/${SNAP}.partial`],
                ["mv", "--", `${jailRoot}/${SNAP}.partial`, `${jailRoot}/${SNAP}`],
                ["mv", "--", `${jailRoot}/${BASE}`, `${jailRoot}/${BASE}.deleting`],
                ["df", "-Pk", "--", jailRoot],
                ["mkdir", "--", lock],
                ["mkdir", "-p", "--", `${lock}/${SNAP}`],
                ["find", lock, "-maxdepth", "1", "-mindepth", "1", "-print0"],
                ["rm", "-rf", "--", lock],
            ];
            // Pre-create the operands mv needs so the real mv calls succeed.
            await mkdir(`${jailRoot}/${BASE}.partial`, { recursive: true });
            await writeFile(`${jailRoot}/${BASE}.partial/f`, "x");
            for (const argv of shapes) {
                const result = await jail(quoted(argv));
                if (argv[0] === "mv" && result.exitCode !== 0) {
                    // The mv operand may have been consumed by an earlier shape;
                    // what matters here is that the JAIL accepted it (no marker).
                    expect(result.stderr).not.toContain("backupkit-remote: rejected");
                    continue;
                }
                expect(result.stderr).not.toContain("backupkit-remote: rejected");
                expect(result.exitCode).toBe(0);
            }
        });
    });
});
