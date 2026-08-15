/**
 * All CLI help text, rendered from one declarative table into the layout every
 * mainstream CLI uses (Usage / description / Arguments / Options / Commands,
 * two-column aligned, wrapped).
 *
 * The table is the single source: a command's one-line summary in the root
 * `Commands:` list and the heading of its own `<command> --help` page come from
 * the same entry, so the two can never disagree. `-h` is the alias of `--help`
 * everywhere (added by `parseFlags`), and `backupkit help <command>` prints the
 * same page as `backupkit <command> --help`.
 */

/** One `term  description` row of an Arguments/Options/Commands list. */
interface HelpItem {
    /** The left column: an argument name, a flag spelling, or a subcommand. */
    term: string;
    /** The right column: what it does. */
    text: string;
}

/** One help page: a command's, or the root's. */
interface HelpPage {
    /** The usage line, without the leading "Usage: ". */
    usage: string;
    /** The one-line summary used in the root `Commands:` list. */
    summary: string;
    /** The paragraph(s) under the usage line; blank lines separate paragraphs. */
    description: string;
    /** Positional arguments, in order. */
    args?: HelpItem[];
    /** Flags, excluding `-h, --help` which every page gets automatically. */
    options?: HelpItem[];
    /** Subcommand verbs (`service`, `jail`). */
    commands?: HelpItem[];
    /** Free text printed after the lists. */
    footer?: string;
}

/** Wrap column for descriptions and list text. */
const WIDTH = 90;

/** Left indent of every list row. */
const INDENT = "  ";

/** Terms longer than this get their description on the next line instead. */
const MAX_TERM = 38;

/** `-h, --help`, appended to every page's options list. */
const HELP_OPTION: HelpItem = { term: "-h, --help", text: "Display help for command" };

/** `--config <path>`, taken by every command that loads a config. */
const CONFIG_OPTION: HelpItem = {
    term: "--config <path>",
    text: "Config file to use (default: $BACKUPKIT_CONFIG, else /etc/backupkit/config.jsonc for root, else ~/.backupkit/config.jsonc)",
};

/** Greedy word-wrap of one paragraph to `width`, each line prefixed by `indent`. */
function wrapLine(text: string, width: number, indent: string): string[] {
    const lines: string[] = [];
    let current = "";
    for (const word of text.split(/\s+/).filter((part) => part !== "")) {
        if (current === "") {
            current = word;
        } else if (indent.length + current.length + 1 + word.length <= width) {
            current += ` ${word}`;
        } else {
            lines.push(indent + current);
            current = word;
        }
    }
    if (current !== "") {
        lines.push(indent + current);
    }
    return lines;
}

/**
 * Wrap a multi-paragraph block, preserving its blank lines and hard breaks. An
 * INDENTED line is taken verbatim: it is a pre-formatted line (a setup step, a
 * command to copy), and re-wrapping it would flatten the layout that makes it
 * readable.
 */
function wrapBlock(text: string): string[] {
    return text
        .split("\n")
        .flatMap((line) =>
            line.trim() === "" ? [""] : /^\s/.test(line) ? [line.trimEnd()] : wrapLine(line, WIDTH, ""),
        );
}

/**
 * Render one `title:` section. `column` is the shared description column, so
 * Arguments, Options and Commands line up as one grid on a page. A term wider
 * than the column keeps its own line and its description is indented under it -
 * the same fallback commander-style CLIs use, rather than shoving the column
 * right for every other row.
 */
function renderList(title: string, items: HelpItem[], column: number): string[] {
    const lines = [`${title}:`];
    for (const item of items) {
        if (INDENT.length + item.term.length > column - 2) {
            lines.push(INDENT + item.term, ...wrapLine(item.text, WIDTH, "      "));
            continue;
        }
        const [first, ...rest] = wrapLine(item.text, WIDTH, " ".repeat(column));
        lines.push((INDENT + item.term).padEnd(column) + first.trimStart(), ...rest);
    }
    return lines;
}

/** Render a page to its final text (no trailing newline). */
function renderPage(page: HelpPage): string {
    const options = [...(page.options ?? []), HELP_OPTION];
    const all = [...(page.args ?? []), ...options, ...(page.commands ?? [])];
    const widest = Math.max(...all.map((item) => Math.min(item.term.length, MAX_TERM)));
    const column = INDENT.length + widest + 2;
    const sections: string[][] = [[`Usage: ${page.usage}`], [""], wrapBlock(page.description)];
    if (page.args !== undefined) {
        sections.push([""], renderList("Arguments", page.args, column));
    }
    sections.push([""], renderList("Options", options, column));
    if (page.commands !== undefined) {
        sections.push([""], renderList("Commands", page.commands, column));
    }
    if (page.footer !== undefined) {
        sections.push([""], wrapBlock(page.footer));
    }
    return sections.flat().join("\n");
}

/** The `[TARGET...]` positional, shared by every command that takes target names. */
function targetsArg(text: string): HelpItem {
    return { term: "TARGET...", text };
}

/**
 * Every command, in the order the root help lists them. `usage` doubles as the
 * root `Commands:` term (minus the leading "backupkit ").
 */
const PAGES: Record<string, HelpPage> = {
    run: {
        usage: "backupkit run [options] [TARGET...]",
        summary: "Back up due targets now, once",
        description:
            "Back up every target that is due (or only the ones named), then exit. This is one pass, not a scheduler - use `backupkit start` or the service for that.\nExits 1 if any target failed.",
        args: [targetsArg("Targets to back up (default: every due target)")],
        options: [
            { term: "--force", text: "Back up regardless of due-ness, failure backoff, and bucket dedup" },
            { term: "--dry-run", text: "Write nothing: show what a transfer would do, and take no destination lock" },
            CONFIG_OPTION,
        ],
    },
    start: {
        usage: "backupkit start [options]",
        summary: "Foreground scheduler in YOUR session (the home for encrypted keys)",
        description:
            "Run the scheduler in this terminal for as long as the process lives; Ctrl-C stops it.\n\nThis is the supported home for passphrase-protected keys: it starts backupkit's own ssh-agent and adds every explicit remote's key, prompting here for each passphrase, then schedules exactly as the service does. A service has no terminal to prompt on, which is why `backupkit daemon` refuses such a key.",
        options: [
            { term: "--force", text: "Back up every target once immediately, then schedule" },
            CONFIG_OPTION,
        ],
    },
    daemon: {
        usage: "backupkit daemon [options]",
        summary: "Foreground scheduler - what the installed service runs",
        description:
            "The scheduler loop the service unit's ExecStart runs. It never self-daemonizes; the OS supervises it.\n\nRefuses to start when any configured key is passphrase-protected - use an unencrypted key, or `backupkit start`.",
        options: [CONFIG_OPTION],
    },
    service: {
        usage: "backupkit service [options] <verb>",
        summary: "Manage the OS service unit (systemd / launchd)",
        description:
            "Install and control the backupkit service: a systemd unit on Linux, a launchd daemon on macOS. Every verb except `status` requires root.",
        commands: [
            { term: "install", text: "Write the unit for this install and enable it (root)" },
            { term: "uninstall", text: "Stop and remove the unit (root)" },
            { term: "start", text: "Start the service now (root)" },
            { term: "stop", text: "Stop the service (root)" },
            { term: "restart", text: "Restart the service, e.g. after a config change (root)" },
            { term: "status", text: "Report whether the unit is installed and running" },
        ],
        options: [CONFIG_OPTION],
    },
    logs: {
        usage: "backupkit logs [options]",
        summary: "Tail the daemon logs",
        description:
            "Show the service's log output - `journalctl -u backupkit` on Linux, the log file on macOS.",
        options: [
            { term: "-f, --follow", text: "Stream new lines until Ctrl-C" },
            { term: "-n, --lines <n>", text: "How many lines to show (default: 100)" },
            CONFIG_OPTION,
        ],
    },
    list: {
        usage: "backupkit list|ls [options] [TARGET...]",
        summary: "List complete snapshots (alias: ls)",
        description:
            'List the complete snapshots of every target (or only the ones named), oldest first. Mirror targets hold one live copy and no snapshots, so they are not listed.',
        args: [targetsArg("Targets to list (default: all of them)")],
        options: [
            { term: "--json", text: "Print one JSON document on stdout instead of a table" },
            CONFIG_OPTION,
        ],
    },
    status: {
        usage: "backupkit status [options] [TARGET...]",
        summary: "One row per target: last run, next due, lock state",
        description:
            "One row per target: its last snapshot, when it is next due, its last result, consecutive failures, and whether a destination lock is held. A mirror target has no snapshot to name and takes no lock, so both columns stay empty.",
        args: [targetsArg("Targets to report on (default: all of them)")],
        options: [
            { term: "--json", text: "Print one JSON document on stdout instead of a table" },
            CONFIG_OPTION,
        ],
    },
    target: {
        usage: "backupkit target [options] <TARGET>",
        summary: "Show one target's settings, as backupkit resolved them",
        description:
            "Print every setting of one target the way backupkit resolved it - each default filled in with the value actually used, not left blank as it is in the config file. This is the config the next run of that target will obey.\n\nThe transfer endpoints and the full remote are left out of the table (they are derived from direction, source, destination, and the named remote); `--json` includes them.",
        args: [{ term: "TARGET", text: "The target to show" }],
        options: [
            { term: "--json", text: "Print one JSON document on stdout instead of a table" },
            CONFIG_OPTION,
        ],
    },
    remote: {
        usage: "backupkit remote [options] <REMOTE>",
        summary: "Show one remote's settings, as backupkit resolved them",
        description:
            "Print every setting of one remote the way backupkit resolved it - for an explicit remote its host, user, port, key, passphrase source and known_hosts file; for an ssh_config remote the alias, which is all backupkit knows (ssh resolves the rest). The closing line names the targets using it.",
        args: [{ term: "REMOTE", text: "The remote to show" }],
        options: [
            { term: "--json", text: "Print one JSON document on stdout instead of a table" },
            CONFIG_OPTION,
        ],
    },
    restore: {
        usage: "backupkit restore [options] <TARGET> <SNAPSHOT>",
        summary: "Copy a snapshot to a fresh path",
        description:
            "Copy one snapshot out of the archive into a path that does not exist yet. Restoring never writes over an existing directory, and never touches the archive. Only for a snapshot target: a mirror keeps one live copy and no history, so copy from its destination directly.",
        args: [
            { term: "TARGET", text: "The target the snapshot belongs to" },
            { term: "SNAPSHOT", text: "A snapshot name from `backupkit list`, or `latest`" },
        ],
        options: [
            { term: "--output <path>", text: "Path to restore into - must not exist (required)" },
            {
                term: "--dry-run",
                text: "Write nothing: run every check and report what the copy would write (cannot be combined with --verify)",
            },
            { term: "--verify", text: "Re-read the copy and verify checksums afterwards" },
            CONFIG_OPTION,
        ],
    },
    prune: {
        usage: "backupkit prune [options] [TARGET...]",
        summary: "Apply the retention policy now",
        description:
            "Apply each snapshot target's retention policy immediately, instead of waiting for the next run to do it. Mirror targets keep no history and are skipped.",
        args: [targetsArg("Targets to prune (default: all of them)")],
        options: [
            { term: "--dry-run", text: "Print the plan (what is kept, and why) and delete nothing" },
            { term: "--force", text: "Prune even when snapshots appeared that no run created" },
            CONFIG_OPTION,
        ],
    },
    unlock: {
        usage: "backupkit unlock [options] [TARGET...]",
        summary: "Clear a destination lock left behind by a killed run",
        description:
            "Clear the destination lock of a target whose run was killed before it could release it.",
        args: [targetsArg("Targets to unlock (default: all of them)")],
        options: [
            { term: "--force", text: "Clear the lock even while a LIVE backupkit holds it" },
            CONFIG_OPTION,
        ],
        footer: "Without --force a live lock is reported, never removed: two backupkits in one archive root is exactly what the lock exists to prevent. A stale lock (its holder dead, or past the 24h TTL) is cleared either way.",
    },
    check: {
        usage: "backupkit check [options]",
        summary: "Readiness gate: config, binaries, keys, hosts",
        description:
            "Validate the config, verify the rsync/ssh binaries and their versions, load the keys, probe every remote, pin host keys (on a TTY), and print the push-jail lines for the archive server. Run this before scheduling anything.",
        options: [CONFIG_OPTION],
    },
    init: {
        usage: "backupkit init [options]",
        summary: "Write the commented starter config",
        description:
            "Write a fully commented `config.jsonc` to where backupkit will look for it: /etc/backupkit for root, ~/.backupkit otherwise.",
        options: [
            { term: "--force", text: "Overwrite an existing config" },
            { term: "--config <path>", text: "Write the config at this exact path instead" },
        ],
    },
    jail: {
        usage: "backupkit jail [options] <verb>",
        summary: "(On an archive server) install/verify the push jail script",
        description:
            "Run this ON the archive server, where backupkit is installed but needs no config. It manages the `backupkit-remote` forced-command script that confines a pushing source host to rsync inside its own archive root.",
        commands: [
            { term: "install", text: "Copy this package's script into place - atomic, idempotent, rerun after every npm update (root)" },
            { term: "status", text: "Report whether the installed copy matches the package; exits 1 when missing or outdated" },
        ],
        options: [{ term: "--path <path>", text: "Script location (default: /usr/local/bin/backupkit-remote)" }],
    },
};

/** The root page, whose `Commands:` list is derived from PAGES. */
const ROOT_PAGE: HelpPage = {
    usage: "backupkit [options] [command]",
    summary: "versioned rsync-over-SSH backups",
    description:
        "backupkit - automated, versioned backups over SSH with rsync, in both directions: push (the source sends) and pull (the archive server fetches, so a compromised source cannot touch the archive).",
    options: [{ term: "-v, --version", text: "Output the version number" }],
    commands: [
        ...Object.values(PAGES).map((page) => ({
            term: page.usage.replace("backupkit ", ""),
            text: page.summary,
        })),
        { term: "help [command]", text: "Display help for a command" },
    ],
    footer: `Setup:
  1. backupkit init             write a commented starter config
  2. backupkit check            verify keys, hosts, and versions
  3. schedule it, either way:
       backupkit start            in this session (the only way for encrypted keys)
       backupkit service install  as a root service (then: backupkit service start)

Run \`backupkit help <command>\` or \`backupkit <command> --help\` for a command's own options.`,
};

/** The root help printed by bare `backupkit`, `--help`, `-h`, and `help`. */
export const ROOT_HELP: string = renderPage(ROOT_PAGE);

/** Per-command help text, printed by `backupkit <command> --help` and `backupkit help <command>`. */
export const COMMAND_HELP: Record<string, string> = Object.fromEntries(
    Object.entries(PAGES).map(([name, page]) => [name, renderPage(page)]),
);
