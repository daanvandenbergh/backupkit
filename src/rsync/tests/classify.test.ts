import { describe, expect, it } from "vitest";
import { isPermanentSshStderr } from "../../ssh/classify.js";
import { classifyExit, type ExitClass, describeRsyncStderr } from "../internal/classify.js";

/** One row of the exit-code matrix: input exit + stderr tail, expected classification. */
interface MatrixRow {
    exitCode: number | null;
    stderr: string;
    cls: ExitClass;
    retriable: boolean;
    promote: boolean;
}

const MATRIX: MatrixRow[] = [
    { exitCode: 0, stderr: "", cls: "ok", retriable: false, promote: true },
    { exitCode: 24, stderr: "file has vanished: x", cls: "warning", retriable: false, promote: true },
    { exitCode: 23, stderr: "rsync: opendir failed", cls: "warning", retriable: false, promote: true },
    { exitCode: 10, stderr: "", cls: "transient", retriable: true, promote: false },
    { exitCode: 12, stderr: "", cls: "transient", retriable: true, promote: false },
    // 13/14/21 are the same dropped link as 10/12, seen from the message pipe,
    // the IPC layer and the child reaper. Falling through to the fatal default
    // lost the run on exactly the flaky networks retrying exists for.
    { exitCode: 13, stderr: "rsync error: errors with program diagnostics", cls: "transient", retriable: true, promote: false },
    { exitCode: 14, stderr: "rsync error: error in IPC code", cls: "transient", retriable: true, promote: false },
    { exitCode: 21, stderr: "rsync error: some error returned by waitpid()", cls: "transient", retriable: true, promote: false },
    { exitCode: 30, stderr: "", cls: "transient", retriable: true, promote: false },
    { exitCode: 35, stderr: "", cls: "transient", retriable: true, promote: false },
    { exitCode: 11, stderr: "write failed: No space left on device", cls: "disk", retriable: false, promote: false },
    { exitCode: 1, stderr: "", cls: "hard", retriable: false, promote: false },
    { exitCode: 2, stderr: "", cls: "hard", retriable: false, promote: false },
    { exitCode: 4, stderr: "", cls: "hard", retriable: false, promote: false },
    { exitCode: 5, stderr: "", cls: "hard", retriable: false, promote: false },
    { exitCode: 6, stderr: "", cls: "hard", retriable: false, promote: false },
    { exitCode: 20, stderr: "", cls: "signal", retriable: false, promote: false },
    { exitCode: null, stderr: "", cls: "signal", retriable: false, promote: false },
    { exitCode: 3, stderr: "", cls: "fatal", retriable: false, promote: false },
    { exitCode: 42, stderr: "", cls: "fatal", retriable: false, promote: false },
];

describe("classifyExit: the full exit-code matrix", () => {
    it.each(MATRIX)("exit $exitCode -> $cls (retriable=$retriable, promote=$promote)", (row) => {
        const result = classifyExit(row.exitCode, row.stderr);
        expect(result.class).toBe(row.cls);
        expect(result.retriable).toBe(row.retriable);
        expect(result.promote).toBe(row.promote);
        expect(result.message.length).toBeGreaterThan(0);
    });
});

describe("classifyExit: the 255 x stderr cross-table", () => {
    const permanentTails = [
        "backup@10.0.0.11: Permission denied (publickey,password).",
        "Host key verification failed.",
        "@@@ WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED! @@@ someone could be eavesdropping",
    ];

    it.each(permanentTails)("permanent pattern -> fatal, never retried: %s", (tail) => {
        const result = classifyExit(255, tail);
        expect(result.class).toBe("fatal");
        expect(result.retriable).toBe(false);
        expect(result.promote).toBe(false);
    });

    it.each([
        "",
        "Connection reset by peer",
        "kex_exchange_identification: read: Connection reset",
        "banner exchange: Connection timed out",
        "total garbage éè output",
        "permission denied lowercase does not match",
    ])("anything else -> transient, retried: %j", (tail) => {
        const result = classifyExit(255, tail);
        expect(result.class).toBe("transient");
        expect(result.retriable).toBe(true);
    });

    it("a permanent pattern buried in a longer tail still wins", () => {
        const tail = "warning: something first Permission denied (publickey). trailing noise";
        expect(classifyExit(255, tail).retriable).toBe(false);
    });

    it("permanent patterns only apply to exit 255, not to transient rsync exits", () => {
        expect(classifyExit(10, "Permission denied (publickey).").retriable).toBe(true);
    });

    // These substrings used to be duplicated here AND in ssh/classify.ts. Two
    // copies agreeing today is not the same as one source: adding a fourth
    // permanent class to the owner would leave a transfer's exit 255 retrying
    // it for the target's whole attempt budget while runRemote gave up at once.
    // ssh/classify.ts is now the single owner; this pins the two in agreement.
    it("agrees with ssh/classify.ts on every tail - one owner for what 'permanent' means", () => {
        const tails = [
            ...permanentTails,
            "",
            "Connection reset by peer",
            "permission denied lowercase does not match",
            "Host key verification failed.",
        ];
        for (const tail of tails) {
            expect({ tail, permanent: classifyExit(255, tail).retriable === false }).toEqual({
                tail,
                permanent: isPermanentSshStderr(tail),
            });
        }
    });
});

describe("describeRsyncStderr", () => {
    // The failure most likely to be seen and least self-explanatory: the jail
    // refuses, rsync reports a protocol error, and the operator was told to
    // look for "a backupkit bug" while the server was turning the command away.
    it("names a jail refusal and what to do about it", () => {
        const explained = describeRsyncStderr("backupkit-remote: rejected\nrsync error: error in rsync protocol data stream (code 12) at io.c(228)");
        expect(explained).toContain("jail REFUSED this command");
        expect(explained).toContain("backupkit jail");
        expect(explained).toContain("[rsync said: backupkit-remote: rejected]");
    });

    it.each([
        ["rsync: write failed on \"/archive/x\": No space left on device (28)", "destination filesystem is FULL"],
        ['rsync: change_dir "/srv/data" failed: No such file or directory (2)', "SOURCE directory could not be entered"],
        ["rsync: --link-dest arg does not exist: /archive/2026-08-10T120000Z", "hard-link against is gone"],
        ["@ERROR: auth failed on module archive", "rsync DAEMON on the far side refused"],
        ["rsync: connection unexpectedly closed (0 bytes received so far)", "far side went away before finishing"],
        ["rsync: mkdir \"/archive/new\" failed: Read-only file system (30)", "mounted read-only"],
        ["rsync: [receiver] failed to set times on \"/archive/x\": Operation not permitted (1)", "cannot store the metadata"],
    ])("reads %s", (tail, expected) => {
        expect(describeRsyncStderr(tail)).toContain(expected);
    });

    // The generic `at io.c(228)` summary line is rsync telling you where in ITS
    // source it gave up. Quoting that instead of the real failure is how the
    // useful line got lost in the first place.
    it("quotes the specific failure line, never rsync's own source-location summary", () => {
        const said = describeRsyncStderr(
            'rsync: change_dir "/srv/data" failed: No such file or directory (2)\nrsync error: some files could not be transferred (code 23) at main.c(1338) [sender=3.2.7]',
        );
        expect(said).toContain("[rsync said: rsync: change_dir");
        expect(said).not.toContain("main.c");
    });

    it("is null when the tail says nothing recognisable", () => {
        expect(describeRsyncStderr("")).toBeNull();
        expect(describeRsyncStderr("some unrelated chatter on stderr")).toBeNull();
    });

    // The failure that reaches the log is the exit row PLUS the reading: the
    // exit code is what decided retry vs fail, and the reader needs both.
    it("reaches the classification message so the log line carries the cause", () => {
        const cls = classifyExit(2, "rsync: --link-dest arg does not exist: /archive/x");
        expect(cls.message).toContain("rsync hard failure (exit 2)");
        expect(cls.message).toContain("hard-link against is gone");
    });

    // Regression, found by the line above disagreeing with itself: the jail
    // prints `rejected` and dies, so rsync sees its peer vanish and returns a
    // TRANSPORT code (12). That put the failure on the transient row, which
    // told the reader "a network drop, not your data" about a server that had
    // just refused the command in writing - and then retried the identical
    // command for the target's whole attempt budget. A written refusal is not
    // the ambiguous stderr the retry bias exists for.
    it("a jail refusal is permanent however rsync exits, and never called a network drop", () => {
        for (const exitCode of [12, 13, 30, 2]) {
            const cls = classifyExit(exitCode, "backupkit-remote: rejected");
            expect(cls.retriable).toBe(false);
            expect(cls.promote).toBe(false);
            expect(cls.message).toContain("the backup server refused the command");
            expect(cls.message).toContain("jail REFUSED this command");
            expect(cls.message).not.toContain("network drop");
        }
    });

    // Exit 23 is a WARNING that still promotes a snapshot - and the one case
    // where rsync silently disables deletion, which the reader must be told.
    it("explains the exit-23 case where rsync disabled deletion", () => {
        const cls = classifyExit(23, "rsync: [sender] IO error encountered -- skipping file deletion");
        expect(cls.promote).toBe(true);
        expect(cls.message).toContain("disabled deletion for this run");
    });

    // Exit 255 belongs to ssh. rsync's own `Permission denied (13)` for an
    // unreadable source file must never be read as an ssh auth failure - that
    // exact confusion turned a network drop into "permanent, not retried".
    it("leaves exit 255 to the ssh classifier", () => {
        const cls = classifyExit(255, 'send_files failed to open "/srv/x": Permission denied (13)');
        expect(cls.retriable).toBe(true);
        expect(cls.message).not.toContain("authentication failed");
    });
});
