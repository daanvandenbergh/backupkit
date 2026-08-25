"""Regression matrix for .claude/hooks/block-destructive-git.sh.

Every guarded literal is assembled from fragments so this file's own text - and
the Bash command that runs it - never contains one. The hook scans the whole
command string, so a test suite written the obvious way refuses to run.
"""

import json
import subprocess

H = ".claude/hooks/block-destructive-git.sh"

ST = "st" + "ash"
RS = "re" + "set"
CL = "cle" + "an"
CO = "che" + "ckout"
RE = "res" + "tore"

DENY, OK = "deny", "allow"

CASES = [
    # (command, expected, what it is guarding)
    (f"git {ST}",                          DENY, "plain"),
    (f"git {ST} list",                     OK,   "recovery path stays open"),
    (f"git {ST} pop",                      OK,   "recovery path stays open"),
    (f"git {ST} list && git {ST}",         DENY, "allowed form must not launder the blocked one"),
    (f"cd somedir && git {ST}",            DENY, "compound"),
    (f"git status; git {ST}",              DENY, "compound"),
    (f"git  {ST}",                         DENY, "doubled space - a glob cannot express this"),
    (f"git -C /tmp {ST}",                  DENY, "global option before the verb (was a bypass)"),
    (f"git -C /tmp {RS} --hard",           DENY, "global option before the verb (was a bypass)"),
    (f"git --no-pager {CL} -fd",           DENY, "global option before the verb (was a bypass)"),
    (f"git -c user.name=x commit -am hi",  DENY, "global option before the verb (was a bypass)"),
    (f"git {RS} --hard",                   DENY, "plain"),
    (f"git {CL} -fd",                      DENY, "plain"),
    (f"git {RE} src/foo.ts",               DENY, "plain"),
    (f"git {CO} -- src/foo.ts",            DENY, "plain"),
    ("git add" + " -A",                    DENY, "sweeping add"),
    ("git add" + " .",                     DENY, "sweeping add"),
    ("git commit" + " -am x",              DENY, "sweeping commit"),
    # ...and the things that must keep working.
    ("git add src/foo.ts src/bar.ts",      OK,   "explicit-path staging - the documented way"),
    ("git commit" + " -m x",               OK,   "scoped commit"),
    ("git push origin main",               OK,   "not this hook's business"),
    ("npm publish",                        OK,   "not this hook's business"),
    ("git status --short",                 OK,   "read-only"),
    ("git show HEAD:src/foo.ts",           OK,   "the recommended alternative"),
    (f"git -C /tmp {ST} list",             OK,   "global option + recovery path"),
]


def decide(cmd: str) -> str:
    out = subprocess.run(
        ["bash", H],
        input=json.dumps({"tool_input": {"command": cmd}}),
        capture_output=True,
        text=True,
    ).stdout.strip()
    return DENY if out else OK


def main() -> int:
    failures = 0
    for cmd, want, why in CASES:
        got = decide(cmd)
        if got == want:
            print(f"  ok   {got:<5}  {cmd}")
        else:
            failures += 1
            print(f"  FAIL {got:<5} (want {want})  {cmd}   <- {why}")
    print("\n%d case(s), %d failure(s)" % (len(CASES), failures))
    return 1 if failures else 0


raise SystemExit(main())
