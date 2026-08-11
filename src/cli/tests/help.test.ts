/**
 * Help-system tests: the rendered layout (Usage / description / Arguments /
 * Options / Commands, aligned and wrapped), that -h is the alias of --help
 * everywhere, and that `backupkit help <command>` prints exactly the page
 * `backupkit <command> --help` prints - including through the `ls` alias.
 */

import { describe, expect, it } from "vitest";

import { COMMAND_HELP, ROOT_HELP } from "../internal/help.js";
import { main } from "../main.js";
import { fakeDeps } from "./fakes.js";

/** Every dispatchable command name, aliases included. */
const COMMANDS = [
    "run",
    "start",
    "daemon",
    "service",
    "logs",
    "list",
    "ls",
    "status",
    "restore",
    "prune",
    "unlock",
    "check",
    "init",
    "jail",
];

/** Print one help page through the CLI and return its text. */
async function helpFor(argv: string[]): Promise<{ code: number; text: string }> {
    const h = fakeDeps();
    const code = await main(argv, h.deps);
    expect(h.engine.calls).toEqual([]);
    return { code, text: h.out.join("\n") };
}

describe("rendered help pages", () => {
    const pages = [["root", ROOT_HELP], ...Object.entries(COMMAND_HELP)];

    it.each(pages)("%s opens with its usage line", (_name, text) => {
        expect(text.split("\n")[0]).toMatch(/^Usage: backupkit( |$)/);
        // A blank line, then the description - never a list glued to the usage.
        expect(text.split("\n")[1]).toBe("");
    });

    it.each(pages)("%s documents -h/--help in its Options section", (_name, text) => {
        expect(text).toContain("Options:");
        expect(text).toMatch(/^ {2}-h, --help {2,}Display help for command$/m);
    });

    // Wrapping is what keeps the page readable in an 80-100 column terminal;
    // an unwrapped long description silently produced 200-char lines before.
    it.each(pages)("%s wraps every line", (_name, text) => {
        for (const line of text.split("\n")) {
            expect(line.length).toBeLessThanOrEqual(100);
        }
    });

    // Arguments, Options and Commands share ONE description column per page:
    // that is what makes the page scan as a grid rather than three ragged
    // lists, and a padEnd off-by-one is invisible without this check.
    it.each(pages)("%s aligns every list row on one description column", (_name, text) => {
        const columns = new Set<number>();
        let inList = false;
        for (const line of text.split("\n")) {
            if (/^(Arguments|Options|Commands):$/.test(line)) {
                inList = true;
                continue;
            }
            if (line === "") {
                inList = false;
                continue;
            }
            const row = inList ? / {2,}\S/.exec(line.slice(2)) : null;
            if (row !== null) {
                columns.add(2 + row.index + row[0].length - 1);
            }
        }
        expect(columns.size).toBe(1);
    });

    it("lists every command, its alias, and the help command on the root page", () => {
        for (const name of ["run [options]", "list|ls [options]", "help [command]"]) {
            expect(ROOT_HELP).toContain(`  ${name}`);
        }
        // The setup steps survive as a COLUMN block: re-flowed as prose they
        // read "1. backupkit init write a commented starter config".
        expect(ROOT_HELP).toContain("  1. backupkit init             write a commented starter config");
    });

    it("has one page per dispatchable command", () => {
        for (const name of COMMANDS) {
            expect(Object.hasOwn(COMMAND_HELP, name === "ls" ? "list" : name)).toBe(true);
        }
    });
});

describe("-h is --help everywhere", () => {
    it.each(COMMANDS)("%s -h prints the same page as --help, exit 0", async (command) => {
        const short = await helpFor([command, "-h"]);
        const long = await helpFor([command, "--help"]);
        expect(short.code).toBe(0);
        expect(short.text).toBe(long.text);
        expect(short.text).toMatch(/^Usage: backupkit /);
    });

    it("prints the root page for bare -h and --help", async () => {
        for (const flag of ["-h", "--help"]) {
            expect(await helpFor([flag])).toEqual({ code: 0, text: ROOT_HELP });
        }
    });
});

describe("backupkit help <command>", () => {
    it.each(COMMANDS)("help %s prints that command's page", async (command) => {
        const viaHelp = await helpFor(["help", command]);
        const viaFlag = await helpFor([command, "--help"]);
        expect(viaHelp.code).toBe(0);
        expect(viaHelp.text).toBe(viaFlag.text);
    });

    it("resolves the ls alias to the list page", async () => {
        expect((await helpFor(["help", "ls"])).text).toBe(COMMAND_HELP.list);
    });

    it("prints the root page for bare help", async () => {
        expect(await helpFor(["help"])).toEqual({ code: 0, text: ROOT_HELP });
    });

    it("rejects an unknown help topic with exit 64 instead of printing nothing", async () => {
        const h = fakeDeps();
        expect(await main(["help", "frobnicate"], h.deps)).toBe(64);
        expect(h.out).toEqual([]);
        expect(h.err[0]).toContain('unknown command "frobnicate"');
        expect(h.err[0]).toContain("backupkit --help");
    });

    // `help toString` must not print Object.prototype.toString's page.
    it.each([["toString"], ["constructor"], ["__proto__"]])(
        "treats the inherited member %s as an unknown help topic",
        async (name) => {
            const h = fakeDeps();
            expect(await main(["help", name], h.deps)).toBe(64);
            expect(h.out).toEqual([]);
        },
    );
});

describe("--version", () => {
    it.each([["--version"], ["-v"]])("%s prints the package version", async (flag) => {
        const h = fakeDeps();
        expect(await main([flag], h.deps)).toBe(0);
        expect(h.out).toEqual(["0.1.0-test"]);
    });
});
