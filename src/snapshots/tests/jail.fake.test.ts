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
 * Note what the wire does NOT carry: `--chmod=ug-s`, `--xattrs`, `--no-D`,
 * `--no-owner`, `--dry-run`, `--checksum`, `--itemize-changes` and
 * `--exclude=` are all absent as long options - rsync either folds them into
 * the short bundle (`X`, the missing `D`/`o`/`g`, `n`, `c`), rewrites them
 * (`--itemize-changes` -> `--log-format=%i`) or sends them over the protocol
 * stream instead. A jail test that feeds them by hand tests nothing real.
 */
const CAPTURED_ARGV: ReadonlyArray<readonly [string, string]> = [
    ["first push", `rsync --server -logtprze.iLsfxCIvu --numeric-ids . <ROOT>/web/${SNAP}.partial`],
    [
        "incremental push",
        `rsync --server -logtprze.iLsfxCIvu --numeric-ids --link-dest ../${BASE} . <ROOT>/web/${SNAP}.partial`,
    ],
    [
        "full production push",
        `rsync --server -lHtpXrSze.iLsfxCIvu --timeout=600 --bwlimit=10240 --delete --force --partial ` +
            `--numeric-ids --link-dest ../${BASE} --info=STATS2 . <ROOT>/web/${SNAP}.partial`,
    ],
    ["estimate (dry-run)", `rsync --server -nlogDtprze.iLsfxCIvu --stats --numeric-ids . <ROOT>/web/${SNAP}.partial`],
    [
        "verify (dry-run, checksum, itemize)",
        `rsync --server -nlHogDtprcSe.iLsfxCIvu --log-format=%i --timeout=600 --delete --force --partial ` +
            `--numeric-ids --info=STATS2 . <ROOT>/web/${SNAP}.partial`,
    ],
    ["restore read (--sender, complete snapshot)", `rsync --server --sender -logtpre.iLsfxCIvu --numeric-ids . <ROOT>/web/${BASE}/`],
];

describe("backupkit-remote jail script", () => {
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
            const root = `${jailRoot}/web`;

            const mk = await jail(quoted(["mkdir", "-p", "--", `${root}/${SNAP}.partial`]));
            expect(mk.exitCode).toBe(0);
            expect(existsSync(`${root}/${SNAP}.partial`)).toBe(true);

            const find = await jail(quoted(["find", root, "-maxdepth", "1", "-mindepth", "1", "-print0"]));
            expect(find.exitCode).toBe(0);
            expect(find.stdout).toContain(`${root}/${SNAP}.partial\0`);

            const mv = await jail(quoted(["mv", "--", `${root}/${SNAP}.partial`, `${root}/${SNAP}`]));
            expect(mv.exitCode).toBe(0);
            expect(existsSync(`${root}/${SNAP}`)).toBe(true);

            const df = await jail(quoted(["df", "-Pk", "--", root]));
            expect(df.exitCode).toBe(0);
            expect(df.stdout).toMatch(/[0-9]+%/);

            const lockMk = await jail(quoted(["mkdir", "--", `${root}/.backupkit.lock`]));
            expect(lockMk.exitCode).toBe(0);
            const lockAgain = await jail(quoted(["mkdir", "--", `${root}/.backupkit.lock`]));
            expect(lockAgain.exitCode).not.toBe(0);
            const marker = await jail(quoted(["mkdir", "-p", "--", `${root}/.backupkit.lock/${SNAP}`]));
            expect(marker.exitCode).toBe(0);
            const lockRm = await jail(quoted(["rm", "-rf", "--", `${root}/.backupkit.lock`]));
            expect(lockRm.exitCode).toBe(0);
            expect(existsSync(`${root}/.backupkit.lock`)).toBe(false);

            const rmSnap = await jail(quoted(["rm", "-rf", "--", `${root}/${SNAP}.deleting`]));
            expect(rmSnap.exitCode).toBe(0);
        });

        it("accepts .deleting operands and target-name-charset leaves", async () => {
            const result = await jail(quoted(["mkdir", "-p", "--", `${jailRoot}/my-target.01/${SNAP}.deleting`]));
            expect(result.exitCode).toBe(0);
        });
    });

    describe("rm -rf is narrower than every other verb (the delete-component policy)", () => {
        // The Critical: `rm -rf` used to share check_component with mkdir/mv/find/df,
        // so a compromised push client could erase a target's ENTIRE archive
        // history with one permitted command. check_delete_component now pins the
        // FINAL component to the only three shapes the client ever removes.
        it.each([
            ["a bare target directory (the Critical)", () => `${jailRoot}/web`],
            ["a COMPLETE snapshot", () => `${jailRoot}/web/${BASE}`],
            ["a complete snapshot under a nested target", () => `${jailRoot}/my-target.01/${SNAP}`],
            ["the lock's snapshot-named marker", () => `${jailRoot}/web/.backupkit.lock/${SNAP}`],
        ])("rejects rm -rf of %s", async (_label, build) => {
            const path = build();
            await mkdir(path, { recursive: true });
            await expectRejected(quoted(["rm", "-rf", "--", path]));
            expect(existsSync(path)).toBe(true);
        });

        it.each([
            ["<snap>.partial", () => `${jailRoot}/web/${SNAP}.partial`],
            ["<snap>.deleting", () => `${jailRoot}/web/${SNAP}.deleting`],
            [".backupkit.lock", () => `${jailRoot}/web/.backupkit.lock`],
        ])("accepts rm -rf of %s (prune and lock release break without it)", async (_label, build) => {
            const path = build();
            await mkdir(path, { recursive: true });
            const result = await jail(quoted(["rm", "-rf", "--", path]));
            expect(result.stderr).not.toContain("backupkit-remote: rejected");
            expect(result.exitCode).toBe(0);
            expect(existsSync(path)).toBe(false);
        });

        it("the broader policy the other verbs need is untouched", async () => {
            const target = `${jailRoot}/web`;
            const lock = `${target}/.backupkit.lock`;
            await mkdir(`${target}/${BASE}`, { recursive: true });
            await mkdir(`${target}/${SNAP}.partial`, { recursive: true });
            const shapes: string[][] = [
                // A bare target dir and a lock marker: mkdir must still accept both.
                ["mkdir", "-p", "--", target],
                ["mkdir", "--", lock],
                ["mkdir", "-p", "--", `${lock}/${SNAP}`],
                // Both mv forms: retire a COMPLETE snapshot, and promote a .partial.
                ["mv", "--", `${target}/${BASE}`, `${target}/${BASE}.deleting`],
                ["mv", "--", `${target}/${SNAP}.partial`, `${target}/${SNAP}`],
                // find and df name a bare target dir.
                ["find", target, "-maxdepth", "1", "-mindepth", "1", "-print0"],
                ["df", "-Pk", "--", target],
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
        // check_component, which accepts a bare target name and .backupkit.lock.
        // So `mv -- <root>/<target> <root>/<snap>.deleting` was legal, and the
        // resulting `.deleting` leaf is precisely what `rm -rf` is allowed to
        // remove: two permitted commands erased a target's entire archive
        // history, defeating the narrowed rm -rf policy completely. Narrowing a
        // VERB is not the same as enforcing the PROPERTY.
        it.each([
            [
                "renames a whole target into a .deleting leaf that rm -rf may then remove",
                () => [`${jailRoot}/web`, `${jailRoot}/${SNAP}.deleting`],
            ],
            [
                "renames a target into a .deleting leaf beside itself",
                () => [`${jailRoot}/web`, `${jailRoot}/web.deleting`],
            ],
            [
                "moves the remote mutex aside so two pipelines run on one archive",
                () => [`${jailRoot}/web/.backupkit.lock`, `${jailRoot}/web/${SNAP}`],
            ],
            [
                "renames a snapshot into the lock directory to hide it",
                () => [`${jailRoot}/web/${BASE}`, `${jailRoot}/web/.backupkit.lock`],
            ],
            [
                "carries a snapshot across into another target's directory",
                () => [`${jailRoot}/web/${SNAP}.partial`, `${jailRoot}/web2/${SNAP}.partial`],
            ],
            [
                "nests a snapshot inside another snapshot instead of renaming it",
                () => [`${jailRoot}/web/${SNAP}.partial`, `${jailRoot}/web/${BASE}/${SNAP}`],
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
            const target = `${jailRoot}/web`;
            await mkdir(`${target}/${from}`, { recursive: true });
            const result = await jail(quoted(["mv", "--", `${target}/${from}`, `${target}/${to}`]));
            expect({ stderr: result.stderr, exit: result.exitCode }).toEqual({ stderr: "", exit: 0 });
            expect(existsSync(`${target}/${to}`)).toBe(true);
        });

        it("the two-command gadget no longer erases real archived data (real mv, real rm)", async () => {
            // End-to-end against the fixture jail root ONLY, with the script's
            // real mv/rm: the exact sequence that used to destroy a target.
            const target = `${jailRoot}/web`;
            const payload = `${target}/${BASE}/data.txt`;
            await mkdir(`${target}/${BASE}`, { recursive: true });
            await writeFile(payload, "the only copy");

            // Step 1: rename the whole target to a leaf rm -rf is allowed to take.
            await expectRejected(quoted(["mv", "--", target, `${jailRoot}/${SNAP}.deleting`]));
            // Step 2: the rm the gadget relied on. The jail permits this shape by
            // design, but step 1 never produced its operand, so it removes nothing.
            const step2 = await jail(quoted(["rm", "-rf", "--", `${jailRoot}/${SNAP}.deleting`]));
            expect(step2.stderr).not.toContain("backupkit-remote: rejected");

            expect(existsSync(payload)).toBe(true);
            expect(existsSync(`${target}/${BASE}`)).toBe(true);
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
            await mkdir(join(jailRoot, "web", BASE), { recursive: true });
            await writeFile(join(jailRoot, "web", BASE, "verified.txt"), "already promoted\n");
            await mkdir(join(jailRoot, "web", `${BASE}.partial`), { recursive: true });

            await expectRejected(quoted(["mv", "--", `${jailRoot}/web/${BASE}.partial`, `${jailRoot}/web/${BASE}`]));

            // The existing snapshot is untouched and nothing was buried in it.
            expect(await readdir(join(jailRoot, "web", BASE))).toEqual(["verified.txt"]);
        });

        it("still allows the real promote, whose destination does not exist yet", async () => {
            await mkdir(join(jailRoot, "web", `${SNAP}.partial`), { recursive: true });

            const result = await jail(quoted(["mv", "--", `${jailRoot}/web/${SNAP}.partial`, `${jailRoot}/web/${SNAP}`]));

            expect(result.exitCode).toBe(0);
            expect(await readdir(join(jailRoot, "web"))).toContain(SNAP);
        });
    });

    describe("the two-component rsync rule must not leak into the lifecycle verbs", () => {
        it("keeps the three-deep lock marker, the marker listing, and the root mkdir working", async () => {
            // The rsync destination policy is exactly two components under $ROOT.
            // The LIFECYCLE policy is not: the lock marker lives three components
            // deep (<target>/.backupkit.lock/<snap>), and copying the rsync rule
            // across would make every remote lock acquisition fail.
            const target = `${jailRoot}/web`;
            const lock = `${target}/.backupkit.lock`;
            const shapes: string[][] = [
                ["mkdir", "-p", "--", target],
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
            const cmd = `rsync --server -logDtpre.iLsfxC ${build()} . ${jailRoot}/web/${SNAP}.partial`;
            expect((await jail(cmd)).exitCode).toBe(0);
        });

        it.each([
            ["a non-snapshot sibling", "../evil"],
            ["an absolute path", "/etc"],
            ["the bare cwd", "."],
            ["a deeper traversal", "../../etc"],
        ])("rejects the space-separated --link-dest %s, and it never reaches rsync", async (_label, value) => {
            await expectRejected(`rsync --server -logDtpre.iLsfxC --link-dest ${value} . ${jailRoot}/web/${SNAP}.partial`);
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
            await expectRejected(`rsync --server ${opts} . ${jailRoot}/web/${SNAP}.partial`);
            expect(await fake.calls()).toEqual([]);
        });

        it("permits the quoted and unquoted version probe", async () => {
            expect((await jail("'rsync' '--version'")).exitCode).toBe(0);
            expect((await jail("rsync --version")).exitCode).toBe(0);
            const calls = await fake.calls();
            expect(calls.map((call) => call.argv)).toEqual([["--version"], ["--version"]]);
        });

        it("permits a receiving --server invocation whose destination is inside the jail", async () => {
            const cmd = `rsync --server -logDtpre.iLsfxC --partial --timeout=600 --link-dest=../${BASE} . ${jailRoot}/web/${SNAP}.partial`;
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
                `${jailRoot}/web/${SNAP}.partial`,
            ]);
        });

        it("permits a sending --server invocation (restore pull) from inside the jail", async () => {
            const cmd = `rsync --server --sender -logDtpre.iLsfxC . ${jailRoot}/web/${SNAP}/`;
            const result = await jail(cmd);
            expect(result.exitCode).toBe(0);
        });

        it("permits capital S (--sparse) inside a real measured bundle", async () => {
            // S is sent on every production push (see CAPTURED_ARGV): a bundle
            // rule that swept up capital letters would refuse every real run.
            const cmd = `rsync --server -lHtpXrSze.iLsfxCIvu --numeric-ids . ${jailRoot}/web/${SNAP}.partial`;
            expect((await jail(cmd)).exitCode).toBe(0);
        });
    });

    describe("the rsync path operand is pinned to the run's own .partial (destination policy)", () => {
        // The Critical: check_rsync_path used to accept ANY path under $ROOT with
        // no "..", while the option grammar permits the --delete --force the real
        // client sends on every run. `--delete --force` against the TARGET
        // directory with an empty file list therefore erased every snapshot of
        // that target in one permitted command, and a write could land in an
        // already-verified snapshot or in a dot-directory like $ROOT/.ssh.
        it.each([
            [
                "--delete --force aimed at the target dir erases a whole archive history in ONE command",
                () =>
                    `rsync --server -lHtpXrSze.iLsfxCIvu --delete --force --partial --numeric-ids . ${jailRoot}/web`,
            ],
            [
                "--delete --force aimed at the jail root erases every target",
                () => `rsync --server -lHtpXrSze.iLsfxCIvu --delete --force --partial --numeric-ids . ${jailRoot}`,
            ],
            [
                "a write into a COMPLETE snapshot rewrites verified history",
                () => `rsync --server -logtprze.iLsfxCIvu --numeric-ids . ${jailRoot}/web/${BASE}`,
            ],
            [
                "a write into $ROOT/.ssh plants authorized_keys",
                () => `rsync --server -logtprze.iLsfxCIvu --numeric-ids . ${jailRoot}/.ssh`,
            ],
            [
                "a write into $ROOT/.ssh/<snap>.partial hides a dot-target behind a legal leaf",
                () => `rsync --server -logtprze.iLsfxCIvu --numeric-ids . ${jailRoot}/.ssh/${SNAP}.partial`,
            ],
            [
                "a three-component destination writes inside a snapshot instead of building one",
                () => `rsync --server -logtprze.iLsfxCIvu --numeric-ids . ${jailRoot}/web/${SNAP}.partial/sub`,
            ],
            [
                "a one-component destination names a bare target with no leaf at all",
                () => `rsync --server -logtprze.iLsfxCIvu --numeric-ids . ${jailRoot}/${SNAP}.partial`,
            ],
        ])("rejects the write that %s", async (_label, build) => {
            await expectRejected(build());
            expect(await fake.calls()).toEqual([]);
        });

        it("still permits a --sender read of a COMPLETE snapshot, so restore keeps working", async () => {
            // The policy is DIRECTION-aware: a complete snapshot is a legal read
            // source and never a write destination. Pinning the leaf to .partial
            // in both directions would break every restore.
            const cmd = `rsync --server --sender -logtpre.iLsfxCIvu --numeric-ids . ${jailRoot}/web/${BASE}`;
            const result = await jail(cmd);
            expect({ stderr: result.stderr, exit: result.exitCode }).toEqual({ stderr: "", exit: 0 });
        });
    });

    describe("unmeasured rsync options are refused by default (the option allowlist)", () => {
        const DEST = () => `${jailRoot}/web/${SNAP}.partial`;

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
            // Default-deny: an option nobody has measured must not pass merely
            // for lacking an absolute path or "..".
            ["an option no capture has ever produced", "--some-future-option"],
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

    describe("a short bundle may not smuggle an attached option VALUE (bundle grammar)", () => {
        const DEST = () => `${jailRoot}/web/${SNAP}.partial`;

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
        const DST = () => `${jailRoot}/web/${SNAP}.partial`;

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
            await expectRejected(quoted(["rm", "-rf", "--", `${jailRoot}/web/../../pwn`]));
        });

        it("rejects the jail root itself as an rm operand", async () => {
            await expectRejected(quoted(["rm", "-rf", "--", jailRoot]));
        });

        it("rejects leaf components outside the allowed families", async () => {
            await expectRejected(quoted(["mkdir", "-p", "--", `${jailRoot}/web/EVIL NAME`]));
            await expectRejected(quoted(["mkdir", "-p", "--", `${jailRoot}/web/Uppercase`]));
            await expectRejected(quoted(["rm", "-rf", "--", `${jailRoot}/.ssh`]));
            await expectRejected(quoted(["mkdir", "-p", "--", `${jailRoot}/${"a".repeat(65)}`]));
        });

        it("rejects command smuggling around the canonical quoting", async () => {
            await expectRejected(`'rm' '-rf' '--' '/x'; rm -rf /`);
            await expectRejected(`'rm' '-rf' '--' '${jailRoot}/web' '${jailRoot}/web2'`);
            await expectRejected(`'mkdir' '-p' '--' '${jailRoot}/web/$(boom)'`);
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
            await expectRejected(`rsync --server -a . ${jailRoot}/web/${SNAP} ${jailRoot}/web/extra`);
            await expectRejected(`rsync --server -a extra . ${jailRoot}/web/${SNAP}`);
            await expectRejected(`rsync --server --link-dest=/etc . ${jailRoot}/web/${SNAP}`);
            await expectRejected(`rsync --server --link-dest=../evil . ${jailRoot}/web/${SNAP}`);
            await expectRejected(`rsync --server --partial-dir=/tmp/x . ${jailRoot}/web/${SNAP}`);
            await expectRejected("rsync --server -a`boom` . " + `${jailRoot}/web/${SNAP}`);
            await expectRejected(`rsync --server -a . `);
            await expectRejected(`rsync --server . `);
        });

        it("a rejected rsync command never reaches the rsync binary", async () => {
            await expectRejected(`rsync --server -a . /etc`);
            expect(await fake.calls()).toEqual([]);
        });
    });

    describe("symlink-component traversal escape (resolved path must stay under the jail)", () => {
        // The string checks permit an attacker-named symlink whose leaf is in the
        // allowed charset (e.g. "evil"); rsync's default --links bundle writes one
        // INTO the jail. A second command then traverses it so the kernel
        // dereferences the intermediate symlink and the write lands OUTSIDE the
        // jail. check_no_symlink_prefix rejects any operand whose existing prefix
        // is a symlink, closing this.
        it("blocks the /etc/cron.d/pwn write via an intermediate symlink for mv, mkdir, and rsync dest", async () => {
            const web = `${jailRoot}/web`;
            await mkdir(`${web}/${SNAP}.partial`, { recursive: true });
            await writeFile(`${web}/${SNAP}.partial/payload`, "x");
            // Attacker-planted symlink INSIDE the jail, leaf passes the charset check.
            await symlink("/", `${web}/evil`);

            // mv the payload through the symlink toward /etc/cron.d/pwn: rejected.
            await expectRejected(quoted(["mv", "--", `${web}/${SNAP}.partial/payload`, `${web}/evil/etc/cron.d/pwn`]));
            // mkdir -p through the symlink: rejected.
            await expectRejected(quoted(["mkdir", "-p", "--", `${web}/evil/etc/cron.d`]));
            // rsync --server destination through the symlink: rejected, never reaches rsync.
            await expectRejected(`rsync --server -logDtpre.iLsfxC . ${web}/evil/etc`);
            expect(await fake.calls()).toEqual([]);
            // Nothing escaped the jail.
            expect(existsSync("/etc/cron.d/pwn")).toBe(false);
        });

        it("rejects an operand whose LEAF itself is a symlink (broken symlink included)", async () => {
            const web = `${jailRoot}/web`;
            await mkdir(web, { recursive: true });
            await symlink("/nonexistent-target", `${web}/${SNAP}`); // broken symlink: -L true, -e false
            await expectRejected(quoted(["rm", "-rf", "--", `${web}/${SNAP}`]));
        });

        it("still accepts legitimate operations on real (non-symlink) paths under the jail", async () => {
            const web = `${jailRoot}/web`;
            await mkdir(`${web}/${SNAP}.partial`, { recursive: true });
            // mkdir a not-yet-existing target (final component absent): must pass.
            expect((await jail(quoted(["mkdir", "-p", "--", `${web}/${SNAP}`]))).exitCode).toBe(0);
            // mv real .partial -> a fresh final name: must pass.
            expect((await jail(quoted(["mv", "--", `${web}/${SNAP}.partial`, `${web}/${BASE}`]))).exitCode).toBe(0);
            // rsync --server into a partial under a real tree: must pass.
            expect((await jail(`rsync --server -logDtpre.iLsfxC . ${web}/${SNAP}.partial`)).exitCode).toBe(0);
        });
    });

    describe("jail/store argv consistency", () => {
        it("every command shape the remote store issues is accepted by the jail", async () => {
            const storeRoot = `${jailRoot}/web`;
            const lock = `${storeRoot}/.backupkit.lock`;
            const shapes: string[][] = [
                ["mkdir", "-p", "--", storeRoot],
                ["find", storeRoot, "-maxdepth", "1", "-mindepth", "1", "-print0"],
                ["rm", "-rf", "--", `${storeRoot}/${BASE}.deleting`],
                ["rm", "-rf", "--", `${storeRoot}/${BASE}.partial`],
                ["mv", "--", `${storeRoot}/${BASE}.partial`, `${storeRoot}/${SNAP}.partial`],
                ["mv", "--", `${storeRoot}/${SNAP}.partial`, `${storeRoot}/${SNAP}`],
                ["mv", "--", `${storeRoot}/${BASE}`, `${storeRoot}/${BASE}.deleting`],
                ["df", "-Pk", "--", storeRoot],
                ["mkdir", "--", lock],
                ["mkdir", "-p", "--", `${lock}/${SNAP}`],
                ["find", lock, "-maxdepth", "1", "-mindepth", "1", "-print0"],
                ["rm", "-rf", "--", lock],
            ];
            // Pre-create the operands mv needs so the real mv calls succeed.
            await mkdir(`${storeRoot}/${BASE}.partial`, { recursive: true });
            await writeFile(`${storeRoot}/${BASE}.partial/f`, "x");
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
