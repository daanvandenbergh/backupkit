import { describe, expect, it } from "vitest";
import { isPermanentSshStderr } from "../../ssh/classify.js";
import { classifyExit, type ExitClass } from "../internal/classify.js";

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
