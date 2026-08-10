/**
 * Tiny fake-binary helper for the ssh test suites (local to src/ssh/tests/ -
 * src/testing/ does not exist yet). Installs node-shebang recorder scripts
 * into a mkdtemp directory: each invocation appends one JSON line (bin name,
 * argv, the ssh-relevant env vars) to a shared log file and behaves per the
 * FAKE_<NAME>_CALLS env var - a JSON array of per-call behaviors (exit,
 * stdout, stderr, sleepMs) indexed by an on-disk call counter, last entry
 * repeating. PATH and the FAKE_* vars are passed per-call via the exec
 * options env; process.env is never mutated and the real SSH_AUTH_SOCK is
 * never inherited.
 */

import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

/** Behavior of one fake-binary invocation. */
export interface FakeCallBehavior {
    /** Exit code. Default 0. */
    exit?: number;
    /** Text written to stdout. */
    stdout?: string;
    /** Text written to stderr. */
    stderr?: string;
    /** Milliseconds to sleep before exiting (for hang-prevention tests). */
    sleepMs?: number;
}

/** One recorded invocation of a fake binary. */
export interface RecordedCall {
    /** The fake binary's name. */
    bin: string;
    /** argv after the binary name. */
    argv: string[];
    /** The ssh-relevant env vars the invocation saw. */
    env: Record<string, string>;
}

/** Env vars every fake binary records when present. */
const RECORDED_ENV_KEYS = ["SSH_AUTH_SOCK", "SSH_ASKPASS", "SSH_ASKPASS_REQUIRE", "BACKUPKIT_PASSPHRASE_FILE"];

/** JS source of one fake binary, parameterized by its name. */
function scriptSource(name: string): string {
    const envKey = `FAKE_${name.toUpperCase().replaceAll("-", "_")}_CALLS`;
    return [
        "#!/usr/bin/env node",
        `// backupkit test fake binary "${name}".`,
        'const fs = require("node:fs");',
        `const recordedKeys = ${JSON.stringify(RECORDED_ENV_KEYS)};`,
        "const env = {};",
        "for (const key of recordedKeys) if (process.env[key] !== undefined) env[key] = process.env[key];",
        "const log = process.env.FAKE_BIN_LOG;",
        `if (log) fs.appendFileSync(log, JSON.stringify({ bin: ${JSON.stringify(name)}, argv: process.argv.slice(2), env }) + "\\n");`,
        `const counterFile = log + ".count-" + ${JSON.stringify(name)};`,
        "let count = 0;",
        'try { count = parseInt(fs.readFileSync(counterFile, "utf8"), 10) || 0; } catch {}',
        "fs.writeFileSync(counterFile, String(count + 1));",
        `const calls = process.env[${JSON.stringify(envKey)}] ? JSON.parse(process.env[${JSON.stringify(envKey)}]) : [];`,
        "const call = calls.length === 0 ? {} : calls[Math.min(count, calls.length - 1)];",
        "if (call.stdout) process.stdout.write(call.stdout);",
        "if (call.stderr) process.stderr.write(call.stderr);",
        "const finish = () => process.exit(call.exit || 0);",
        "if (call.sleepMs) setTimeout(finish, call.sleepMs); else finish();",
        "",
    ].join("\n");
}

/** A mkdtemp directory of fake binaries plus their shared invocation log. */
export class FakeBinDir {
    /** Directory holding the fake binaries and the log. */
    readonly dir: string;

    /** Path of the shared JSON-lines invocation log. */
    readonly logPath: string;

    /** Use `FakeBinDir.create()` - constructors cannot be async. */
    private constructor(dir: string) {
        this.dir = dir;
        this.logPath = join(dir, "calls.log");
    }

    /** Create a fresh fake-bin directory under the OS tmpdir. */
    static async create(): Promise<FakeBinDir> {
        return new FakeBinDir(await mkdtemp(join(tmpdir(), "backupkit-fakebin-")));
    }

    /** Install one fake binary by name and return its absolute path. */
    async install(name: string): Promise<string> {
        const path = join(this.dir, name);
        await writeFile(path, scriptSource(name));
        await chmod(path, 0o755);
        return path;
    }

    /**
     * Build the complete child environment for one test scenario: a PATH of
     * the fake dir + the node binary's dir + system dirs, the shared log
     * path, and one FAKE_<NAME>_CALLS behavior script per named binary.
     * Never contains SSH_AUTH_SOCK.
     */
    env(behaviors: Record<string, FakeCallBehavior[]> = {}): Record<string, string> {
        const env: Record<string, string> = {
            PATH: `${this.dir}:${dirname(process.execPath)}:/usr/bin:/bin`,
            LC_ALL: "C",
            FAKE_BIN_LOG: this.logPath,
        };
        for (const [name, calls] of Object.entries(behaviors)) {
            env[`FAKE_${name.toUpperCase().replaceAll("-", "_")}_CALLS`] = JSON.stringify(calls);
        }
        return env;
    }

    /** Every recorded invocation, in call order. */
    async calls(): Promise<RecordedCall[]> {
        let text: string;
        try {
            text = await readFile(this.logPath, "utf8");
        } catch {
            return [];
        }
        return text
            .split("\n")
            .filter((line) => line !== "")
            .map((line) => JSON.parse(line) as RecordedCall);
    }

    /** Remove the directory and everything in it. */
    async dispose(): Promise<void> {
        await rm(this.dir, { recursive: true, force: true });
    }
}
