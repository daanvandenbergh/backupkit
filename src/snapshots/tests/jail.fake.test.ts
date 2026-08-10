import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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

    describe("allowed rsync forms (fake rsync records the argv)", () => {
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
