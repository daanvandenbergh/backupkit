import { posix } from "node:path";
import { describe, expect, it } from "vitest";
import { ConfigError } from "../../shared/errors.js";
import { parseJsonc } from "../internal/jsonc.js";
import { validateConfig, type ValidatedConfig } from "../internal/validate.js";

/** A minimal valid explicit remote object. */
const REMOTE = { host: "10.0.0.11", user: "backup-reader", identityFile: "/etc/backupkit/keys/id" };

/** A minimal valid pull target referencing remote "r1". */
const TARGET = { mode: "snapshot", direction: "pull", remote: "r1", source: "/var/www", destination: "/srv/backups" };

/** Serialize a plain object as JSON (a strict subset of JSONC) and validate it. */
function validate(config: unknown): ValidatedConfig {
    return validateConfig(parseJsonc(JSON.stringify(config, null, 2), "test.jsonc"), "test.jsonc");
}

/** Build a config from the minimal base with deep-ish overrides applied per section. */
function base(overrides?: {
    remotes?: Record<string, unknown>;
    targets?: Record<string, unknown>;
    top?: Record<string, unknown>;
}): unknown {
    return {
        remotes: overrides?.remotes ?? { r1: REMOTE },
        targets: overrides?.targets ?? { t1: TARGET },
        ...overrides?.top,
    };
}

/** Assert validation fails with a ConfigError containing every fragment. */
function expectFail(config: unknown, ...fragments: string[]): ConfigError {
    try {
        validate(config);
    } catch (error) {
        expect(error).toBeInstanceOf(ConfigError);
        for (const fragment of fragments) {
            expect((error as ConfigError).message).toContain(fragment);
        }
        return error as ConfigError;
    }
    expect.unreachable("expected a validation failure");
}

describe("minimal valid config", () => {
    it("passes and preserves document order", () => {
        const result = validate(base());
        expect(result.remotes.map((entry) => entry.name)).toEqual(["r1"]);
        expect(result.targets.map((entry) => entry.name)).toEqual(["t1"]);
        expect(result.warnings).toEqual([]);
    });

    it("keeps integer-like target names in document order", () => {
        // Raw text: a JS object literal would already reorder integer-like keys.
        const target = (destination: string) =>
            `{ "mode": "snapshot", "direction": "pull", "remote": "r1", "source": "/var/www", "destination": "${destination}" }`;
        const text = `{
            "remotes": { "r1": ${JSON.stringify(REMOTE)} },
            "targets": { "2024": ${target("/srv/a")}, "zeta": ${target("/srv/b")}, "10": ${target("/srv/c")} }
        }`;
        const result = validateConfig(parseJsonc(text, "test.jsonc"), "test.jsonc");
        expect(result.targets.map((entry) => entry.name)).toEqual(["2024", "zeta", "10"]);
    });
});

describe("root level", () => {
    it("rejects a non-object root", () => {
        expect(() => validateConfig(parseJsonc("[1]", "test.jsonc"), "test.jsonc")).toThrow("expected an object");
    });

    it("rejects an unknown root key", () => {
        expectFail(base({ top: { verbose: true } }), 'unknown key "verbose"', "verbose");
    });

    it.each([["remotes"], ["targets"]])("requires %s", (key) => {
        const config = base() as Record<string, unknown>;
        delete (config as Record<string, unknown>)[key];
        expectFail(config, `${key}: required field missing`);
    });

    it("rejects an empty remotes record", () => {
        expectFail(base({ remotes: {} }), "remotes: at least one remote is required");
    });

    it("rejects an empty targets record", () => {
        expectFail(base({ targets: {} }), "targets: at least one target is required");
    });

    it.each([
        ["an empty name", ""],
        ["a newline in name", "a\nb"],
    ] as const)("rejects %s", (_label, name) => {
        expectFail(base({ top: { name } }), "name: must be a non-empty single-line string");
    });

    it("accepts a plain instance name", () => {
        expect(validate(base({ top: { name: "prod backups" } })).name).toBe("prod backups");
    });
});

describe("record-key charset", () => {
    it.each([["Web"], ["-x"], [".x"], ["_x"], ["a b"], ["a/b"], ["a".repeat(65)]])(
        "rejects remote key %s",
        (key) => {
            expectFail(base({ remotes: { [key]: REMOTE }, targets: { t1: { ...TARGET, remote: key } } }), "invalid name");
        },
    );

    it.each([["Web"], ["a b"], ["a".repeat(65)]])("rejects target key %s", (key) => {
        expectFail(base({ targets: { [key]: TARGET } }), "invalid name");
    });

    it.each([["@x"]])("rejects a key starting with @: %s", (key) => {
        expectFail(base({ targets: { [key]: TARGET } }), "invalid name");
    });

    it.each([["web1"], ["2024"], ["a.b-c_d"], ["mail@srv1"], ["a".repeat(64)]])("accepts key %s", (key) => {
        expect(() => validate(base({ targets: { [key]: TARGET } }))).not.toThrow();
    });
});

describe("explicit remotes", () => {
    it.each([["host"], ["user"], ["identityFile"]])("names a missing required field: %s", (field) => {
        const remote: Record<string, unknown> = { ...REMOTE };
        delete remote[field];
        expectFail(base({ remotes: { r1: remote } }), `remotes.r1.${field}: required field missing`);
    });

    it("rejects an unknown remote key", () => {
        expectFail(base({ remotes: { r1: { ...REMOTE, hostname: "x" } } }), 'unknown key "hostname"');
    });

    it.each([
        ["a host with whitespace", "bad host"],
        ["a host with @", "user@host"],
        ["a quoted host", 'h"x'],
        ["an empty host", ""],
    ] as const)("rejects %s", (_label, host) => {
        expectFail(base({ remotes: { r1: { ...REMOTE, host } } }), "remotes.r1.host", "invalid host");
    });

    // `host` mirrors ALIAS_REGEX, which excludes ':', '/', and a leading '-'
    // because they "confuse host:path splitting, option parsing, or quoting" -
    // and host has the same three problems. formatEndpoint emits
    // `user@host:path`, and rsync reads an argument whose first '/' precedes the
    // first ':' as a LOCAL path, so "10.0.0.5/x" silently turned a push target's
    // destination into a local relative directory. A leading '-' is an ssh
    // option, a NUL makes spawn throw a raw ERR_INVALID_ARG_VALUE instead of a
    // config error, and an ESC reaches the operator's terminal through
    // SshError messages.
    it.each([
        ["a host that is an ssh option", "-oProxyCommand=x"],
        ["a leading dash", "-h"],
        ["a slash", "10.0.0.5/x"],
        ["a trailing path", "host/../x"],
        ["a NUL", "\u0000evil"],
        ["an escape sequence", "h\u001b[2Jost"],
        ["a DEL character", "host\u007f"],
        ["a colon in a hostname", "host:2222"],
        ["a bracketed IPv6 literal (formatEndpoint adds the brackets)", "[::1]"],
        ["a 254-character host", `${"a".repeat(250)}.com`],
    ] as const)("rejects %s", (_label, host) => {
        expectFail(base({ remotes: { r1: { ...REMOTE, host } } }), "remotes.r1.host", "invalid host");
    });

    it.each([["fe80::1"], ["::1"], ["fe80::1%eth0"], ["backup.example.com"], ["_svc-1"], ["10.0.0.11"], ["Host."]])(
        "accepts host %s",
        (host) => {
            expect(() => validate(base({ remotes: { r1: { ...REMOTE, host } } }))).not.toThrow();
        },
    );

    it.each([["1user"], ["-user"], ["us er"], ["a".repeat(33)]])("rejects user %s", (user) => {
        expectFail(base({ remotes: { r1: { ...REMOTE, user } } }), "remotes.r1.user", "invalid ssh user");
    });

    it.each([["backup-reader"], ["_svc"], ["Root"], ["a".repeat(32)]])("accepts user %s", (user) => {
        expect(() => validate(base({ remotes: { r1: { ...REMOTE, user } } }))).not.toThrow();
    });

    it.each([[0], [65536], [22.5], ["22"]])("rejects port %s", (port) => {
        expectFail(base({ remotes: { r1: { ...REMOTE, port } } }), "remotes.r1.port");
    });

    it.each([[1], [22], [65535]])("accepts port %d", (port) => {
        expect(() => validate(base({ remotes: { r1: { ...REMOTE, port } } }))).not.toThrow();
    });

    it.each([
        ["a relative path", "keys/id", "must be an absolute path"],
        ["a tilde path", "~/keys/id", "use an absolute path"],
        ["whitespace in the path", "/etc/backup kit/id", "whitespace or quote"],
        ["a quote in the path", "/etc/backupkit/'id'", "whitespace or quote"],
    ] as const)("rejects identityFile with %s", (_label, identityFile, fragment) => {
        expectFail(base({ remotes: { r1: { ...REMOTE, identityFile } } }), "remotes.r1.identityFile", fragment);
    });

    it.each([
        ["a raw passphrase", "hunter2"],
        ["an env form", "env:BACKUP_PASS"],
        ["a relative file form", "file:relative/path"],
        ["a bare file:", "file:"],
    ] as const)("rejects %s", (_label, passphrase) => {
        expectFail(
            base({ remotes: { r1: { ...REMOTE, passphrase } } }),
            "remotes.r1.passphrase",
            'passphrase must be "file:/path" or "prompt" - never the passphrase itself',
        );
    });

    it.each([["file:/etc/backupkit/keys/pass"], ["prompt"]])("accepts passphrase %s", (passphrase) => {
        expect(() => validate(base({ remotes: { r1: { ...REMOTE, passphrase } } }))).not.toThrow();
    });

    // defaults.ts publishes the part after "file:" as an absolute passphrase-file
    // path, so it must get the same treatment identityFile gets. The prefix test
    // alone (/^file:\/.+/, unanchored, and `.` never matches \n) accepted ".."
    // escapes, duplicate slashes, spaces, quotes, and embedded newlines - a
    // ResolvedConfig path outside the one normal form.
    it.each([
        ["a .. escape", "file:/etc/keys/../../home/attacker/pass", '"." or ".." component'],
        ["a . component", "file:/etc/./keys/pass", '"." or ".." component'],
        ["whitespace", "file:/etc/my keys/pass", "whitespace or quote"],
        ["a quote", "file:/etc/'keys'/pass", "whitespace or quote"],
        ["an embedded newline", "file:/etc/keys/pass\nExecStartPre=/bin/sh", "NUL or newline"],
    ] as const)("rejects a file: passphrase with %s", (_label, passphrase, fragment) => {
        expectFail(base({ remotes: { r1: { ...REMOTE, passphrase } } }), "remotes.r1.passphrase", fragment);
    });

    it("normalizes duplicate slashes in a file: passphrase path", () => {
        const result = validate(base({ remotes: { r1: { ...REMOTE, passphrase: "file://etc//keys//pass" } } }));
        const remote = result.remotes[0].remote;
        expect("passphrase" in remote && remote.passphrase).toBe("file:/etc/keys/pass");
    });

    it("rejects a knownHostsFile with whitespace", () => {
        expectFail(
            base({ remotes: { r1: { ...REMOTE, knownHostsFile: "/e t c/kh" } } }),
            "remotes.r1.knownHostsFile",
        );
    });

    // The explicit branch used to accept `restrictedShell` into the allow-list
    // and then never read it, so it resolved to false and every remote command
    // went out quoted - the exact failure the flag exists to avoid, silently.
    it("carries restrictedShell through on an explicit remote", () => {
        const result = validate(base({ remotes: { r1: { ...REMOTE, restrictedShell: true } } }));
        const remote = result.remotes[0].remote;
        expect("restrictedShell" in remote && remote.restrictedShell).toBe(true);
    });

    it("rejects a non-boolean restrictedShell on an explicit remote", () => {
        expectFail(
            base({ remotes: { r1: { ...REMOTE, restrictedShell: "yes" } } }),
            "remotes.r1.restrictedShell",
        );
    });
});

describe("alias remotes (alias XOR explicit)", () => {
    it("accepts a lone alias", () => {
        const result = validate(
            base({
                remotes: { r1: REMOTE, myserver: { alias: "myserver" } },
                targets: { t1: TARGET, t2: { ...TARGET, remote: "myserver", destination: "/srv/other" } },
            }),
        );
        expect(result.remotes[1].remote).toEqual({ alias: "myserver" });
    });

    it.each([
        ["host", "10.0.0.1"],
        ["user", "u"],
        ["identityFile", "/k/id"],
        ["port", 22],
        ["passphrase", "prompt"],
        ["knownHostsFile", "/k/kh"],
        ["unknownField", "x"],
    ] as const)("rejects alias + sibling %s with the targeted message", (key, value) => {
        expectFail(
            base({
                remotes: { m: { alias: "m", [key]: value } },
                targets: { t1: { ...TARGET, remote: "m" } },
            }),
            `remotes.m.${key}`,
            "alias remotes take no other fields - host, user, key, and port come from ssh_config; use an explicit remote for per-field control",
        );
    });

    // The one legal companion: it describes the remote's SHELL (a Storage Box
    // parses no quoting), which ssh_config has no way to express.
    it("accepts alias + restrictedShell", () => {
        const result = validate(
            base({
                remotes: { m: { alias: "m", restrictedShell: true } },
                targets: { t1: { ...TARGET, remote: "m" } },
            }),
        );
        expect(result.remotes[0].remote).toEqual({ alias: "m", restrictedShell: true });
    });

    it("rejects a non-boolean restrictedShell", () => {
        expectFail(
            base({
                remotes: { m: { alias: "m", restrictedShell: "yes" } },
                targets: { t1: { ...TARGET, remote: "m" } },
            }),
            "remotes.m.restrictedShell",
            "expected a boolean",
        );
    });

    it.each([
        ["whitespace", "my server"],
        ["a colon", "my:server"],
        ["an at sign", "my@server"],
        ["a slash", "my/server"],
        ["a quote", 'my"server'],
        ["a leading dash", "-myserver"],
        ["an empty string", ""],
        ["65 characters", "a".repeat(65)],
    ] as const)("rejects an alias containing %s", (_label, alias) => {
        expectFail(
            base({ remotes: { m: { alias } }, targets: { t1: { ...TARGET, remote: "m" } } }),
            "remotes.m.alias",
            "invalid alias",
        );
    });

    it.each([["myserver"], ["My_Server.01"], ["_x"], ["a".repeat(64)]])("accepts alias %s", (alias) => {
        expect(() =>
            validate(base({ remotes: { m: { alias } }, targets: { t1: { ...TARGET, remote: "m" } } })),
        ).not.toThrow();
    });

    it("accepts mixed alias and explicit remotes in one config", () => {
        const result = validate(
            base({
                remotes: { r1: REMOTE, m: { alias: "myserver" } },
                targets: {
                    t1: TARGET,
                    t2: { ...TARGET, remote: "m", destination: "/srv/other" },
                },
            }),
        );
        expect(result.remotes).toHaveLength(2);
    });
});

describe("targets", () => {
    it.each([["mode"], ["direction"], ["remote"], ["source"], ["destination"]])(
        "names a missing required field: %s",
        (field) => {
            const target: Record<string, unknown> = { ...TARGET };
            delete target[field];
            expectFail(base({ targets: { t1: target } }), `targets.t1.${field}: required field missing`);
        },
    );

    it("rejects an unknown target key", () => {
        expectFail(base({ targets: { t1: { ...TARGET, bwlimit: "10M" } } }), 'unknown key "bwlimit"');
    });

    it("rejects a bad direction", () => {
        expectFail(base({ targets: { t1: { ...TARGET, direction: "sideways" } } }), 'expected one of "pull", "push"');
    });

    it("rejects a bad mode", () => {
        expectFail(base({ targets: { t1: { ...TARGET, mode: "copy" } } }), 'expected one of "snapshot", "mirror"');
    });

    it("accepts a mirror target", () => {
        const parsed = validate(base({ targets: { t1: { ...TARGET, mode: "mirror" } } }));
        expect(parsed.targets[0].target.mode).toBe("mirror");
    });

    // Rejected rather than ignored: a mirror keeps one live copy and no
    // history, so both keys describe behaviour it will never have - and a
    // silently dropped retention block reads as "my versions are kept".
    it("rejects retention on a mirror target", () => {
        expectFail(
            base({ targets: { t1: { ...TARGET, mode: "mirror", retention: { keepLast: 5 } } } }),
            "targets.t1.retention",
            'only valid on a "snapshot" target',
        );
    });

    it("rejects retention: false on a mirror target too", () => {
        expectFail(base({ targets: { t1: { ...TARGET, mode: "mirror", retention: false } } }), "targets.t1.retention");
    });

    it("rejects minFree on a mirror target", () => {
        expectFail(
            base({ targets: { t1: { ...TARGET, mode: "mirror", minFree: "5%" } } }),
            "targets.t1.minFree",
            'only valid on a "snapshot" target',
        );
    });

    // The jail pins every rsync destination to <root>/<target>/<snap>.partial,
    // which is what confines the --delete it also permits. A mirror writes the
    // root itself, so a jailed push mirror would be rejected by the archive
    // host on every single transfer - a mystery failure unless it is refused here.
    it("rejects a jailed push mirror (the jail's default) with a fix for each way out", () => {
        expectFail(
            base({ targets: { t1: { ...TARGET, mode: "mirror", direction: "push" } } }),
            "targets.t1.jail",
            'a "mirror" push cannot be jailed',
            '"jail": false',
        );
    });

    it("rejects an explicitly jailed push mirror too", () => {
        expectFail(
            base({ targets: { t1: { ...TARGET, mode: "mirror", direction: "push", jail: true } } }),
            "targets.t1.jail",
        );
    });

    it("accepts a push mirror that writes down jail: false", () => {
        const parsed = validate(
            base({ targets: { t1: { ...TARGET, mode: "mirror", direction: "push", jail: false } } }),
        );
        expect(parsed.targets[0].target.jail).toBe(false);
    });

    it("a PULL mirror needs no such declaration - there is no jail on that side", () => {
        expect(() => validate(base({ targets: { t1: { ...TARGET, mode: "mirror" } } }))).not.toThrow();
    });

    it("keeps every other knob available on a mirror", () => {
        const parsed = validate(
            base({
                targets: {
                    t1: {
                        ...TARGET,
                        mode: "mirror",
                        exclude: ["*.tmp"],
                        schedule: { interval: "hour" },
                        retry: { attempts: 3 },
                        rsync: { bwlimit: "10M", verify: true },
                        enabled: false,
                    },
                },
            }),
        );
        expect(parsed.targets[0].target.rsync).toEqual({ bwlimit: "10M", verify: true });
        expect(parsed.targets[0].target.retry).toEqual({ attempts: 3 });
    });

    it("rejects an unknown remote reference listing the configured names", () => {
        expectFail(
            base({ targets: { t1: { ...TARGET, remote: "nope" } } }),
            "targets.t1.remote",
            'unknown remote "nope"',
            "configured remotes: r1",
        );
    });

    it.each([
        ["a relative source", { source: "var/www" }, "must be an absolute path"],
        ["a tilde destination", { destination: "~/backups" }, "use an absolute path"],
        ["a newline in destination", { destination: "/srv/back\nups" }, "NUL or newline"],
    ] as const)("rejects %s", (_label, patch, fragment) => {
        expectFail(base({ targets: { t1: { ...TARGET, ...patch } } }), fragment);
    });

    it("rejects a non-array exclude", () => {
        expectFail(base({ targets: { t1: { ...TARGET, exclude: "cache/" } } }), "expected an array of strings");
    });

    it("rejects a non-string exclude element", () => {
        expectFail(base({ targets: { t1: { ...TARGET, exclude: [1] } } }), "targets.t1.exclude[0]");
    });

    it("rejects a newline in an exclude pattern", () => {
        expectFail(base({ targets: { t1: { ...TARGET, exclude: ["a\nb"] } } }), "NUL or newline");
    });

    it("accepts hostile-but-legal exclude patterns", () => {
        const exclude = ["cache/", "*.tmp", "a b", "$(rm -rf /)", "'quoted'"];
        expect(validate(base({ targets: { t1: { ...TARGET, exclude } } })).targets[0].target.exclude).toEqual(exclude);
    });

    it("rejects a non-boolean enabled", () => {
        expectFail(base({ targets: { t1: { ...TARGET, enabled: "yes" } } }), "expected a boolean");
    });

    it.each([[true], [false]])("accepts jail: %s on a push target", (jail) => {
        const parsed = validate(base({ targets: { t1: { ...TARGET, direction: "push", jail } } }));
        expect(parsed.targets[0].target.jail).toBe(jail);
    });

    it("rejects jail on a pull target", () => {
        expectFail(base({ targets: { t1: { ...TARGET, jail: false } } }), "only valid on a push target");
    });

    it("rejects a non-boolean jail", () => {
        expectFail(base({ targets: { t1: { ...TARGET, direction: "push", jail: "no" } } }), "expected a boolean");
    });
});

describe("schedule matrix", () => {
    it.each([
        [{ interval: "minute" }],
        [{ interval: "minute", intervalCount: 5 }],
        [{ interval: "hour", intervalCount: 6 }],
        [{ interval: "day" }],
        [{ interval: "day", at: "03:00" }],
        [{ interval: "day", intervalCount: 3, at: "12:00" }],
        [{ interval: "week", on: "sun" }],
        [{ interval: "week", on: "mon", at: "01:00" }],
        [{ interval: "week", intervalCount: 2 }],
        [{ interval: "month" }],
        [{ interval: "month", dayOfMonth: 15 }],
        [{ interval: "month", dayOfMonth: 28, at: "23:59" }],
        [{ interval: "month", intervalCount: 2, dayOfMonth: 1, at: "00:00" }],
        [{ interval: "day", intervalCount: 1 }],
    ])("accepts %j", (schedule) => {
        expect(() => validate(base({ targets: { t1: { ...TARGET, schedule } } }))).not.toThrow();
    });

    it("requires interval", () => {
        expectFail(
            base({ targets: { t1: { ...TARGET, schedule: { at: "03:00" } } } }),
            "targets.t1.schedule.interval: required field missing",
        );
    });

    it("rejects a bad interval", () => {
        expectFail(
            base({ targets: { t1: { ...TARGET, schedule: { interval: "fortnight" } } } }),
            'expected one of "minute", "hour", "day", "week", "month"',
        );
    });

    it.each([
        ["minute"],
        ["hour"],
    ] as const)('rejects "at" on interval %s with the targeted message', (interval) => {
        expectFail(
            base({ targets: { t1: { ...TARGET, schedule: { interval, at: "03:00" } } } }),
            "targets.t1.schedule.at",
            '"at" is only valid for intervals "day", "week", and "month"',
        );
    });

    it.each([["minute"], ["hour"], ["day"], ["month"]] as const)(
        'rejects "on" on interval %s with the targeted message',
        (interval) => {
            expectFail(
                base({ targets: { t1: { ...TARGET, schedule: { interval, on: "sun" } } } }),
                "targets.t1.schedule.on",
                '"on" is only valid for interval "week"',
            );
        },
    );

    it.each([["minute"], ["hour"], ["day"], ["week"]] as const)(
        'rejects "dayOfMonth" on interval %s with the targeted message',
        (interval) => {
            expectFail(
                base({ targets: { t1: { ...TARGET, schedule: { interval, dayOfMonth: 5 } } } }),
                "targets.t1.schedule.dayOfMonth",
                '"dayOfMonth" is only valid for interval "month"',
            );
        },
    );

    it.each([[0], [-1], [1.5], ["2"]])("rejects intervalCount %s", (intervalCount) => {
        expectFail(
            base({ targets: { t1: { ...TARGET, schedule: { interval: "day", intervalCount } } } }),
            "expected a positive integer",
        );
    });

    it.each([[0], [29], [2.5]])("rejects dayOfMonth %s", (dayOfMonth) => {
        expectFail(
            base({ targets: { t1: { ...TARGET, schedule: { interval: "month", dayOfMonth } } } }),
            "expected an integer between 1 and 28",
        );
    });

    it.each([["24:00"], ["3:00"], ["03:60"], ["0300"], ["aa:bb"], ["03:00:00"]])("rejects at %s", (at) => {
        expectFail(
            base({ targets: { t1: { ...TARGET, schedule: { interval: "day", at } } } }),
            '"at" must be "HH:MM"',
        );
    });

    it("rejects a bad weekday", () => {
        expectFail(
            base({ targets: { t1: { ...TARGET, schedule: { interval: "week", on: "monday" } } } }),
            'expected one of "mon", "tue", "wed", "thu", "fri", "sat", "sun"',
        );
    });

    it("rejects an unknown schedule key", () => {
        expectFail(
            base({ targets: { t1: { ...TARGET, schedule: { interval: "day", cron: "* * *" } } } }),
            'unknown key "cron"',
        );
    });

    it('accepts "at" with intervalCount > 1 (legal and unambiguous)', () => {
        expect(() =>
            validate(base({ targets: { t1: { ...TARGET, schedule: { interval: "week", intervalCount: 2, at: "04:30" } } } })),
        ).not.toThrow();
    });
});

describe("retention", () => {
    it("rejects an empty retention object at top level", () => {
        expectFail(base({ top: { retention: {} } }), "retention", "empty retention {}");
    });

    it("rejects an empty retention object on a target", () => {
        expectFail(base({ targets: { t1: { ...TARGET, retention: {} } } }), "targets.t1.retention", "empty retention {}");
    });

    it("accepts retention: false on a target", () => {
        expect(validate(base({ targets: { t1: { ...TARGET, retention: false } } })).targets[0].target.retention).toBe(
            false,
        );
    });

    it("rejects retention: true", () => {
        expectFail(
            base({ targets: { t1: { ...TARGET, retention: true } } }),
            "expected a retention object or false",
        );
    });

    it("rejects false at top level (targets-only spelling)", () => {
        expectFail(base({ top: { retention: false } }), "retention: expected an object");
    });

    it.each([[-1], [1.5], ["3"]])("rejects a count of %s", (count) => {
        expectFail(base({ top: { retention: { keepLast: count } } }), "expected a non-negative integer");
    });

    it("accepts zero counts (non-empty object)", () => {
        expect(validate(base({ top: { retention: { keepLast: 0 } } })).retention).toEqual({ keepLast: 0 });
    });

    it("rejects an unknown retention key", () => {
        expectFail(base({ top: { retention: { keepFortnightly: 2 } } }), 'unknown key "keepFortnightly"');
    });

    it("accepts the full rule set", () => {
        const rules = { keepLast: 7, keepHourly: 24, keepDaily: 14, keepWeekly: 8, keepMonthly: 12, keepYearly: 3 };
        expect(validate(base({ top: { retention: rules } })).retention).toEqual(rules);
    });
});

describe("retry", () => {
    it.each([[0], [11], [2.5], ["5"]])("rejects attempts %s", (attempts) => {
        expectFail(
            base({ targets: { t1: { ...TARGET, retry: { attempts } } } }),
            "targets.t1.retry.attempts",
            "expected an integer between 1 and 10",
        );
    });

    it.each([[1], [5], [10]])("accepts attempts %d", (attempts) => {
        expect(
            validate(base({ targets: { t1: { ...TARGET, retry: { attempts } } } })).targets[0].target.retry,
        ).toEqual({ attempts });
    });

    it("rejects an unknown key inside retry", () => {
        expectFail(base({ targets: { t1: { ...TARGET, retry: { delays: [1] } } } }), 'unknown key "delays"');
    });
});

describe("minFree", () => {
    it.each([["5%"], ["0%"], ["50%"], ["2.5%"], ["10G"], ["500M"], ["1T"], ["3K"]])("accepts %s", (minFree) => {
        expect(() => validate(base({ targets: { t1: { ...TARGET, minFree } } }))).not.toThrow();
    });

    it("accepts false", () => {
        expect(validate(base({ targets: { t1: { ...TARGET, minFree: false } } })).targets[0].target.minFree).toBe(
            false,
        );
    });

    it.each([["51%"], ["10"], ["10GB"], ["abc"], ["%"], ["-5%"], [""]])("rejects %s", (minFree) => {
        expectFail(
            base({ targets: { t1: { ...TARGET, minFree } } }),
            'minFree must be "N%" (0-50) or an absolute size like "10G"/"500M", or false',
        );
    });

    it("rejects true", () => {
        expectFail(base({ targets: { t1: { ...TARGET, minFree: true } } }), "expected a string");
    });
});

describe("rsync options", () => {
    it("accepts the full option set", () => {
        const rsync = {
            compress: false,
            bwlimit: "10M",
            ioTimeoutSec: 300,
            xattrs: true,
            preserveOwnership: false,
            preserveDevices: true,
            remoteRsyncBin: "/opt/homebrew/bin/rsync",
            verify: true,
        };
        expect(validate(base({ targets: { t1: { ...TARGET, rsync } } })).targets[0].target.rsync).toEqual(rsync);
    });

    it.each([["10Kbps"], ["10T"], ["K"], ["1 M"], [""]])("rejects bwlimit %s", (bwlimit) => {
        expectFail(
            base({ targets: { t1: { ...TARGET, rsync: { bwlimit } } } }),
            "bwlimit must be a number with an optional K/M/G suffix",
        );
    });

    it.each([["500K"], ["10M"], ["2G"], ["1"], ["1.5"]])("accepts bwlimit %s", (bwlimit) => {
        expect(() => validate(base({ targets: { t1: { ...TARGET, rsync: { bwlimit } } } }))).not.toThrow();
    });

    it.each([[0], [-1], [1.5]])("rejects ioTimeoutSec %s", (ioTimeoutSec) => {
        expectFail(base({ targets: { t1: { ...TARGET, rsync: { ioTimeoutSec } } } }), "expected a positive integer");
    });

    it("rejects a relative remoteRsyncBin", () => {
        expectFail(base({ targets: { t1: { ...TARGET, rsync: { remoteRsyncBin: "rsync" } } } }), "absolute path");
    });

    it("rejects remoteRsyncBin on a push target (the jail forces the remote binary)", () => {
        expectFail(
            base({
                targets: {
                    t1: { ...TARGET, direction: "push", rsync: { remoteRsyncBin: "/opt/homebrew/bin/rsync" } },
                },
            }),
            "not allowed on a push target",
        );
    });

    it("rejects an unknown rsync key", () => {
        expectFail(base({ targets: { t1: { ...TARGET, rsync: { inplace: true } } } }), 'unknown key "inplace"');
    });

    it("rejects a non-boolean flag", () => {
        expectFail(base({ targets: { t1: { ...TARGET, rsync: { compress: "yes" } } } }), "expected a boolean");
    });
});

describe("top-level settings", () => {
    it("rejects a relative stateDir", () => {
        expectFail(base({ top: { stateDir: "state" } }), "stateDir: must be an absolute path");
    });

    it("rejects a bad logging level", () => {
        expectFail(base({ top: { logging: { level: "verbose" } } }), 'expected one of "error", "warn", "info", "debug"');
    });

    it("rejects an unknown logging key", () => {
        expectFail(base({ top: { logging: { rotate: true } } }), 'unknown key "rotate"');
    });

    it("rejects a relative logging file", () => {
        expectFail(base({ top: { logging: { file: "log.txt" } } }), "must be an absolute path");
    });

    it.each([["rsyncBin"], ["sshBin"]])("rejects a %s with whitespace", (key) => {
        expectFail(base({ top: { [key]: "/usr/local/bin/my rsync" } }), "whitespace or quote");
    });

    it("accepts valid binary overrides", () => {
        const result = validate(base({ top: { rsyncBin: "/opt/homebrew/bin/rsync", sshBin: "/usr/bin/ssh" } }));
        expect(result.rsyncBin).toBe("/opt/homebrew/bin/rsync");
        expect(result.sshBin).toBe("/usr/bin/ssh");
    });
});

describe("cross-field rules", () => {
    // restrictedShell sends every remote argv element as a BARE word, while the
    // jail script's case arms match only the single-quoted forms. Since `jail`
    // defaults to true on push, the pair used to validate happily and then have
    // every mkdir/mv/rm answered with a bare `backupkit-remote: rejected` while
    // rsync itself kept working - a mystery failure, at run time, on a live
    // archive. It has to be refused here or nowhere.
    it("rejects a restrictedShell remote serving a jailed push target", () => {
        expectFail(
            base({
                remotes: { box: { alias: "box", restrictedShell: true } },
                targets: { nas: { ...TARGET, direction: "push", remote: "box", destination: "/home/backups" } },
            }),
            "targets.nas.jail",
            'set "jail": false on this target, or drop restrictedShell',
        );
    });

    it("accepts a restrictedShell remote on an UNJAILED push target", () => {
        const result = validate(
            base({
                remotes: { box: { alias: "box", restrictedShell: true } },
                targets: {
                    nas: { ...TARGET, direction: "push", remote: "box", destination: "/home/backups", jail: false },
                },
            }),
        );
        expect(result.targets[0].target.jail).toBe(false);
    });

    it("accepts a restrictedShell remote on a pull target, which has no jail", () => {
        const result = validate(
            base({
                remotes: { box: { alias: "box", restrictedShell: true } },
                targets: { t1: { ...TARGET, remote: "box" } },
            }),
        );
        expect(result.targets[0].target.direction).toBe("pull");
    });

    it("rejects a snapshot root nested inside another target's snapshot root", () => {
        expectFail(
            base({
                targets: {
                    web: { ...TARGET, destination: "/srv/backups" },
                    db: { ...TARGET, destination: "/srv/backups/web" },
                },
            }),
            "targets.db.destination",
            "write root /srv/backups/web/db collides with targets.web's write root /srv/backups/web",
        );
    });

    // A mirror's write root is its destination itself, and it transfers with
    // `--delete --force` - so a mirror pointed at a directory that CONTAINS
    // another target's archive would delete that archive on its first run.
    // This is the one config mistake in this file that destroys data instead
    // of failing, which is what makes the check load-bearing rather than tidy.
    it("rejects a snapshot archive sitting inside a mirror's destination", () => {
        expectFail(
            base({
                targets: {
                    clone: { ...TARGET, mode: "mirror", destination: "/srv/backups" },
                    db: { ...TARGET, destination: "/srv/backups/nested" },
                },
            }),
            "targets.db.destination",
            "collides with targets.clone's write root /srv/backups",
        );
    });

    it("rejects a mirror nested inside another target's snapshot root", () => {
        expectFail(
            base({
                targets: {
                    web: { ...TARGET, destination: "/srv/backups" },
                    clone: { ...TARGET, mode: "mirror", destination: "/srv/backups/web/inside" },
                },
            }),
            "targets.clone.destination",
            "collides with targets.web's write root /srv/backups/web",
        );
    });

    it("rejects two mirrors sharing one destination", () => {
        expectFail(
            base({
                targets: {
                    a: { ...TARGET, mode: "mirror", destination: "/srv/clone" },
                    b: { ...TARGET, mode: "mirror", source: "/other", destination: "/srv/clone" },
                },
            }),
            "targets.b.destination",
            "write root /srv/clone collides",
        );
    });

    it("allows a mirror beside a snapshot archive in the same parent", () => {
        expect(() =>
            validate(
                base({
                    targets: {
                        web: { ...TARGET, destination: "/srv/backups" },
                        clone: { ...TARGET, mode: "mirror", destination: "/srv/clone" },
                    },
                }),
            ),
        ).not.toThrow();
    });

    // The push jail bakes the LITERAL destination into the authorized_keys
    // forced command as $ROOT, while every operand sent to that jail is built
    // with posix.join (which normalizes) - and the jail compares them as string
    // prefixes. A non-normal destination therefore validates, prints a
    // plausible jail line, and then has every remote command rejected. Paths
    // must leave validation in exactly the form the operands are built in.
    it("returns every path in one normal form, so the jail root and the store operands cannot diverge", () => {
        const validated = validate(
            base({
                targets: { web: { ...TARGET, source: "/var//www/", destination: "/srv/backups//archive/" } },
                top: { stateDir: "/var//lib/backupkit/" },
            }),
        );
        expect(validated.targets[0].target.destination).toBe("/srv/backups/archive");
        expect(validated.targets[0].target.source).toBe("/var/www");
        expect(validated.stateDir).toBe("/var/lib/backupkit");
        // The jail's own prefix rule, applied to the resolved pair.
        const root = validated.targets[0].target.destination;
        expect(posix.join(root, "web").startsWith(`${root}/`)).toBe(true);
    });

    // Same seam, the other half: a space in a PUSH destination is the jail root
    // real rsync backslash-escapes and the jail's `set -- $CMD` then
    // word-splits, so every rsync through the jail is rejected while the
    // lifecycle commands still succeed - config validates, `check` reports OK,
    // and no backup ever completes. A PULL destination is purely local.
    it.each([
        ["a space", "/srv/My Backups"],
        ["a tab", "/srv/My\tBackups"],
        ["a single quote", "/srv/'backups'"],
        ["a double quote", '/srv/"backups"'],
    ] as const)("rejects a push destination with %s", (_label, destination) => {
        expectFail(
            base({ targets: { web: { mode: "snapshot", direction: "push", remote: "r1", source: "/var/www", destination } } }),
            "targets.web.destination",
            "a push destination may not contain whitespace or quote characters",
        );
    });

    it("accepts the same whitespace destination for a pull target", () => {
        const validated = validate(
            base({ targets: { web: { ...TARGET, destination: "/Volumes/My Backups" } } }),
        );
        expect(validated.targets[0].target.destination).toBe("/Volumes/My Backups");
    });

    it("still accepts a clean push destination", () => {
        expect(() =>
            validate(
                base({ targets: { web: { mode: "snapshot", direction: "push", remote: "r1", source: "/var/www", destination: "/srv/backups" } } }),
            ),
        ).not.toThrow();
    });

    it.each([
        ["/srv/./backups", "."],
        ["/srv/x/../backups", ".."],
    ])("rejects %s: a %s component makes the push jail reject every command", (destination) => {
        expectFail(
            base({ targets: { web: { ...TARGET, destination } } }),
            "targets.web.destination",
            'may not contain a "." or ".." component',
        );
    });

    it("normalizes duplicate and trailing slashes before comparing", () => {
        expectFail(
            base({
                targets: {
                    web: { ...TARGET, destination: "/srv//backups/" },
                    db: { ...TARGET, destination: "/srv/backups/web" },
                },
            }),
            "write root",
        );
    });

    it("allows two targets sharing a destination root (sibling snapshot roots)", () => {
        expect(() =>
            validate(
                base({
                    targets: {
                        web: { ...TARGET, destination: "/srv/backups" },
                        db: { ...TARGET, destination: "/srv/backups" },
                    },
                }),
            ),
        ).not.toThrow();
    });

    it("scopes the collision check per remote for push targets", () => {
        expect(() =>
            validate(
                base({
                    remotes: { r1: REMOTE, r2: { ...REMOTE, host: "10.0.0.12" } },
                    targets: {
                        web: { mode: "snapshot", direction: "push", remote: "r1", source: "/var/www", destination: "/srv/backups" },
                        db: {
                            mode: "snapshot",
                            direction: "push",
                            remote: "r2",
                            source: "/var/db",
                            destination: "/srv/backups/web",
                        },
                    },
                }),
            ),
        ).not.toThrow();
    });

    it("catches the collision on the SAME push remote", () => {
        expectFail(
            base({
                targets: {
                    web: { mode: "snapshot", direction: "push", remote: "r1", source: "/var/www", destination: "/srv/backups" },
                    db: { mode: "snapshot", direction: "push", remote: "r1", source: "/var/db", destination: "/srv/backups/web" },
                },
            }),
            "write root",
        );
    });

    it("does not conflate a local pull root with a remote push root", () => {
        expect(() =>
            validate(
                base({
                    targets: {
                        web: { ...TARGET, destination: "/srv/backups" },
                        db: {
                            mode: "snapshot",
                            direction: "push",
                            remote: "r1",
                            source: "/var/db",
                            destination: "/srv/backups/web",
                        },
                    },
                }),
            ),
        ).not.toThrow();
    });

    it("warns about unreferenced remotes without failing", () => {
        const result = validate(base({ remotes: { r1: REMOTE, spare: { ...REMOTE, host: "10.0.0.99" } } }));
        expect(result.warnings).toEqual(['remote "spare" is not referenced by any target']);
    });
});

describe("error message shape", () => {
    it("carries file:line and the dotted path for a nested error", () => {
        const text = [
            "{",
            '    "remotes": { "r1": { "host": "10.0.0.11", "user": "u", "identityFile": "/k/id" } },',
            '    "targets": {',
            '        "web": {',
            '            "mode": "snapshot",',
            '            "direction": "pull",',
            '            "remote": "r1",',
            '            "source": "/var/www",',
            '            "destination": "/srv/backups",',
            '            "schedule": { "interval": "day", "on": "sun" }',
            "        }",
            "    }",
            "}",
        ].join("\n");
        try {
            validateConfig(parseJsonc(text, "test.jsonc"), "test.jsonc");
            expect.unreachable("must throw");
        } catch (error) {
            const configError = error as ConfigError;
            expect(configError.message).toBe(
                'test.jsonc:10: targets.web.schedule.on: "on" is only valid for interval "week"',
            );
            expect(configError.file).toBe("test.jsonc");
            expect(configError.line).toBe(10);
            expect(configError.path).toBe("targets.web.schedule.on");
        }
    });
});
