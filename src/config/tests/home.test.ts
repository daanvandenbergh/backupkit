import { describe, expect, it } from "vitest";
import { expandHome } from "../internal/home.js";

describe("expandHome", () => {
    it("returns a path without a leading ~ unchanged", () => {
        for (const value of ["/srv/backups", "/srv/~backups", "relative/path", "", "/home/dan/~"]) {
            expect(expandHome(value, "/home/dan")).toEqual({ path: value });
        }
    });

    it("expands a bare ~ to the home itself", () => {
        expect(expandHome("~", "/home/dan")).toEqual({ path: "/home/dan" });
    });

    it("expands the ~/ prefix and keeps the remainder verbatim", () => {
        expect(expandHome("~/keys/id", "/home/dan")).toEqual({ path: "/home/dan/keys/id" });
        expect(expandHome("~/", "/home/dan")).toEqual({ path: "/home/dan/" });
        expect(expandHome("~/a b/'c'", "/home/dan")).toEqual({ path: "/home/dan/a b/'c'" });
    });

    it("expands against a root home without inventing a path", () => {
        // "//keys" - the caller's normalization collapses the duplicate slash.
        expect(expandHome("~/keys", "/")).toEqual({ path: "//keys" });
    });

    it("refuses ~user, which would depend on the machine that parsed the config", () => {
        for (const value of ["~backup/state", "~root", "~-/x", "~~"]) {
            expect(expandHome(value, "/home/dan")).toEqual({ error: expect.stringContaining('"~user" is not supported') });
        }
    });

    it("refuses an empty home", () => {
        expect(expandHome("~/state", "")).toEqual({ error: expect.stringContaining("no home directory is known") });
    });

    it("refuses a relative home rather than producing a relative path", () => {
        expect(expandHome("~/state", "home/dan")).toEqual({ error: expect.stringContaining("is not absolute") });
    });
});
