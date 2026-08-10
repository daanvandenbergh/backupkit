import { describe, expect, it } from "vitest";
import { ConfigError, isBackupkitError } from "../../shared/errors.js";
import { parseJsonc, type JsoncNode, type JsoncObjectNode } from "../internal/jsonc.js";

/** Parse with a fixed filename. */
function parse(text: string): JsoncNode {
    return parseJsonc(text, "test.jsonc");
}

/** Parse and assert the root is an object. */
function parseObject(text: string): JsoncObjectNode {
    const node = parse(text);
    if (node.kind !== "object") {
        throw new Error("expected an object root");
    }
    return node;
}

/** Extract the plain JS value from a node tree (order-preserving for objects). */
function toValue(node: JsoncNode): unknown {
    switch (node.kind) {
        case "object": {
            const out: Record<string, unknown> = {};
            for (const [key, child] of node.entries) {
                out[key] = toValue(child);
            }
            return out;
        }
        case "array":
            return node.items.map(toValue);
        case "string":
        case "number":
        case "boolean":
            return node.value;
        case "null":
            return null;
    }
}

/** Assert parsing fails with a ConfigError whose message contains every fragment. */
function expectFail(text: string, ...fragments: string[]): void {
    try {
        parse(text);
    } catch (error) {
        expect(isBackupkitError(error)).toBe(true);
        expect(error).toBeInstanceOf(ConfigError);
        for (const fragment of fragments) {
            expect((error as ConfigError).message).toContain(fragment);
        }
        return;
    }
    expect.unreachable(`expected a parse failure for: ${text}`);
}

describe("parseJsonc: plain JSON", () => {
    it.each([
        ["an object", '{"a": 1, "b": "x"}', { a: 1, b: "x" }],
        ["an array", "[1, 2, 3]", [1, 2, 3]],
        ["a nested structure", '{"a": {"b": [true, false, null]}}', { a: { b: [true, false, null] } }],
        ["an empty object", "{}", {}],
        ["an empty array", "[]", []],
        ["a bare string", '"hi"', "hi"],
        ["a bare number", "42", 42],
        ["zero", "0", 0],
        ["a negative number", "-7", -7],
        ["a negative zero-point number", "-0.5", -0.5],
        ["a decimal", "3.25", 3.25],
        ["an exponent", "1e3", 1000],
        ["a negative exponent", "2.5e-2", 0.025],
        ["a plus exponent", "2E+2", 200],
        ["true", "true", true],
        ["false", "false", false],
        ["null", "null", null],
        ["a unicode escape", '"\\u0041\\u00e9"', "Aé"],
        ["a surrogate pair escape", '"\\ud83d\\ude00"', "😀"],
        ["all simple escapes", '"\\"\\\\\\/\\b\\f\\n\\r\\t"', '"\\/\b\f\n\r\t'],
    ] as const)("parses %s", (_label, text, expected) => {
        expect(toValue(parse(text))).toEqual(expected);
    });
});

describe("parseJsonc: UTF-8 BOM tolerance", () => {
    /** U+FEFF, the byte-order mark. */
    const BOM = String.fromCharCode(0xfeff);

    it("parses a BOM-prefixed document identically to the same text without one", () => {
        const text = '{"a": 1, "b": "x"}';
        expect(toValue(parse(BOM + text))).toEqual(toValue(parse(text)));
    });

    it("does not treat a BOM elsewhere in the document as trivia", () => {
        expectFail(`{"a": ${BOM}1}`, "unexpected character");
    });
});

describe("parseJsonc: comments", () => {
    it.each([
        ["a line comment", '// hello\n{"a": 1}', { a: 1 }],
        ["a trailing line comment", '{"a": 1} // done', { a: 1 }],
        ["a line comment between entries", '{"a": 1, // first\n"b": 2}', { a: 1, b: 2 }],
        ["a block comment", '/* header */ {"a": 1}', { a: 1 }],
        ["a block comment inside an object", '{"a": /* the value */ 1}', { a: 1 }],
        ["a multi-line block comment", '{\n/* one\ntwo\nthree */\n"a": 1}', { a: 1 }],
        ["a comment before the closing brace", '{"a": 1\n// tail\n}', { a: 1 }],
        ["a comment before the closing bracket", "[1\n/* tail */\n]", [1]],
        ["a block comment with stars", '/* ** * ** */ {"a": 1}', { a: 1 }],
        ["an empty line comment at EOF", '{"a": 1}//', { a: 1 }],
    ] as const)("tolerates %s", (_label, text, expected) => {
        expect(toValue(parse(text))).toEqual(expected);
    });

    it("treats comment markers inside strings as content", () => {
        expect(toValue(parse('{"url": "http://x", "b": "a // b", "c": "a /* b */ c"}'))).toEqual({
            url: "http://x",
            b: "a // b",
            c: "a /* b */ c",
        });
    });

    it("treats */ inside a string as content", () => {
        expect(toValue(parse('{"a": "*/ still string"}'))).toEqual({ a: "*/ still string" });
    });

    it("handles an escaped quote before a comment", () => {
        expect(toValue(parse('{"a": "x\\" // not a comment"} // real comment'))).toEqual({
            a: 'x" // not a comment',
        });
    });

    it("does not nest block comments", () => {
        // /* /* */ closes at the first */; the rest must be valid JSON.
        expect(toValue(parse('/* /* */ {"a": 1}'))).toEqual({ a: 1 });
    });
});

describe("parseJsonc: trailing commas", () => {
    it.each([
        ["object trailing comma", '{"a": 1,}', { a: 1 }],
        ["array trailing comma", "[1, 2,]", [1, 2]],
        ["trailing comma then comment then brace", '{"a": 1, // c\n}', { a: 1 }],
        ["trailing comma then block comment then bracket", "[1, /* c */ ]", [1]],
        ["nested trailing commas", '{"a": [1,], "b": {"c": 2,},}', { a: [1], b: { c: 2 } }],
    ] as const)("tolerates %s", (_label, text, expected) => {
        expect(toValue(parse(text))).toEqual(expected);
    });

    it.each([
        ["a double trailing comma in an array", "[1,,]"],
        ["a double trailing comma in an object", '{"a": 1,,}'],
        ["a leading comma in an array", "[,1]"],
        ["a leading comma in an object", '{,"a": 1}'],
        ["a lone comma object", "{,}"],
        ["a lone comma array", "[,]"],
    ] as const)("rejects %s", (_label, text) => {
        expectFail(text);
    });
});

describe("parseJsonc: duplicate keys", () => {
    it("rejects duplicates naming both lines", () => {
        expectFail('{\n"a": 1,\n"b": 2,\n"a": 3\n}', "test.jsonc:4:1", 'duplicate key "a"', "first defined at line 2");
    });

    it("rejects duplicates on one line with correct columns", () => {
        expectFail('{"a": 1, "a": 2}', "test.jsonc:1:10", 'duplicate key "a"', "first defined at line 1");
    });

    it("allows the same key in different objects", () => {
        expect(toValue(parse('{"a": {"x": 1}, "b": {"x": 2}}'))).toEqual({ a: { x: 1 }, b: { x: 2 } });
    });
});

describe("parseJsonc: depth cap", () => {
    it("accepts nesting of depth 64", () => {
        const text = "[".repeat(64) + "]".repeat(64);
        expect(parse(text)).toBeDefined();
    });

    it("rejects nesting of depth 65", () => {
        const text = "[".repeat(65) + "]".repeat(65);
        expectFail(text, "nesting depth exceeds 64");
    });

    it("counts object nesting toward the cap", () => {
        const open = '{"k":'.repeat(65) + "1" + "}".repeat(65);
        expectFail(open, "nesting depth exceeds 64");
    });
});

describe("parseJsonc: unterminated constructs", () => {
    it("rejects an unterminated string naming the opening position", () => {
        expectFail('{\n"a": "oops', "test.jsonc:2:6", "unterminated string");
    });

    it("rejects an unterminated block comment naming the opening position", () => {
        expectFail('{"a": 1} /* never closed', "test.jsonc:1:10", "unterminated block comment");
    });

    it("rejects /* at EOF", () => {
        expectFail("/*", "unterminated block comment");
    });

    it("rejects an unterminated object", () => {
        expectFail('{"a": 1', 'expected "," or "}"');
    });

    it("rejects an unterminated array", () => {
        expectFail("[1, 2", 'expected "," or "]"');
    });

    it("rejects EOF where a key is expected", () => {
        expectFail('{"a": 1,', "unexpected end of input");
    });

    it("rejects a string ending in a lone backslash", () => {
        expectFail('"abc\\', "unterminated string");
    });

    it("rejects empty input", () => {
        expectFail("", "unexpected end of input");
    });

    it("rejects comment-only input", () => {
        expectFail("// nothing here\n/* still nothing */", "unexpected end of input");
    });
});

describe("parseJsonc: targeted rejections", () => {
    it.each([
        ["single-quoted value", "{'a': 1}", "single quotes"],
        ["single-quoted string value", '{"a": \'x\'}', "single quotes"],
        ["an unquoted key", "{a: 1}", "object keys must be double-quoted strings"],
        ["NaN", '{"a": NaN}', "NaN and Infinity are not valid JSON"],
        ["Infinity", '{"a": Infinity}', "NaN and Infinity are not valid JSON"],
        ["-Infinity", '{"a": -Infinity}', "NaN and Infinity are not valid JSON"],
        ["a leading plus", '{"a": +1}', 'leading "+"'],
        ["a hex number", '{"a": 0x10}', "hex numbers are not allowed"],
        ["a leading zero", '{"a": 01}', "leading zeros"],
        ["a bare dot number", '{"a": 1.}', 'digits after "."'],
        ["a bare exponent", '{"a": 1e}', "digits in the exponent"],
        ["a multiline string", '{"a": "one\ntwo"}', "multiline strings are not allowed"],
        ["a raw tab in a string", '{"a": "one\ttwo"}', "control character in string"],
        ["an invalid escape", '{"a": "\\q"}', 'invalid escape sequence "\\q"'],
        ["a short unicode escape", '{"a": "\\u12"}', "four hex digits"],
        ["a missing colon", '{"a" 1}', 'expected ":" after key "a"'],
        ["trailing garbage", '{"a": 1} 2', "unexpected trailing content"],
        ["two top-level values", "1 2", "unexpected trailing content"],
        ["a bare word", "hello", 'unexpected token "hello"'],
        ["a stray character", "@", "unexpected character"],
        ["a lone slash", "/ {}", 'unexpected character "/"'],
    ] as const)("rejects %s", (_label, text, fragment) => {
        expectFail(text, fragment);
    });
});

describe("parseJsonc: positions and CRLF", () => {
    it("reports line and column of the offending token", () => {
        expectFail('{\n  "a": 1,\n  "b": x\n}', "test.jsonc:3:8", 'unexpected token "x"');
    });

    it("counts CRLF line endings as single line breaks", () => {
        expectFail('{\r\n  "a": 1,\r\n  "b": x\r\n}', "test.jsonc:3:", 'unexpected token "x"');
    });

    it("parses CRLF documents cleanly", () => {
        expect(toValue(parse('{\r\n  "a": 1, // c\r\n  "b": 2,\r\n}'))).toEqual({ a: 1, b: 2 });
    });

    it("records each node's line", () => {
        const root = parseObject('{\n  "a": 1,\n  "b": "x"\n}');
        expect(root.line).toBe(1);
        expect(root.entries.get("a")!.line).toBe(2);
        expect(root.entries.get("b")!.line).toBe(3);
    });

    it("errors carry the file and line payload", () => {
        try {
            parse('{\n"a": oops\n}');
            expect.unreachable("must throw");
        } catch (error) {
            expect((error as ConfigError).file).toBe("test.jsonc");
            expect((error as ConfigError).line).toBe(2);
        }
    });
});

describe("parseJsonc: insertion order", () => {
    it("preserves document order including integer-like keys", () => {
        const root = parseObject('{"2024": 1, "web": 2, "10": 3, "alpha": 4}');
        expect([...root.entries.keys()]).toEqual(["2024", "web", "10", "alpha"]);
    });

    it("preserves order in nested objects", () => {
        const root = parseObject('{"targets": {"z": 1, "a": 2, "m": 3}}');
        const targets = root.entries.get("targets") as JsoncObjectNode;
        expect([...targets.entries.keys()]).toEqual(["z", "a", "m"]);
    });
});
