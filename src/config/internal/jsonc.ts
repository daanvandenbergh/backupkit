/**
 * The single JSONC reader (security invariant 13): a hand-rolled
 * recursive-descent parser for RFC 8259 JSON plus exactly three tolerances -
 * `//` line comments, `/* *\/` block comments (non-nesting), and one optional
 * trailing comma before `}`/`]`. Two strictness upgrades over JSON.parse:
 * duplicate keys are fatal (naming both lines) and nesting depth caps at 64.
 * Objects are insertion-ordered Maps; every node carries its 1-based line.
 * Pure - no fs. Parse errors are ConfigErrors shaped
 * `<file>:<line>:<col>: <problem>`.
 */

import { ConfigError } from "../../shared/errors.js";

/** An object node: insertion-ordered entries. */
export interface JsoncObjectNode {
    /** Node discriminator. */
    kind: "object";
    /** 1-based line of the opening brace. */
    line: number;
    /** Entries in document order (Map preserves insertion order for any key). */
    entries: Map<string, JsoncNode>;
}

/** An array node. */
export interface JsoncArrayNode {
    /** Node discriminator. */
    kind: "array";
    /** 1-based line of the opening bracket. */
    line: number;
    /** Element nodes in document order. */
    items: JsoncNode[];
}

/** A string literal node. */
export interface JsoncStringNode {
    /** Node discriminator. */
    kind: "string";
    /** 1-based line of the opening quote. */
    line: number;
    /** Decoded string value. */
    value: string;
}

/** A number literal node. */
export interface JsoncNumberNode {
    /** Node discriminator. */
    kind: "number";
    /** 1-based line of the literal. */
    line: number;
    /** Numeric value. */
    value: number;
}

/** A boolean literal node. */
export interface JsoncBooleanNode {
    /** Node discriminator. */
    kind: "boolean";
    /** 1-based line of the literal. */
    line: number;
    /** Boolean value. */
    value: boolean;
}

/** A null literal node. */
export interface JsoncNullNode {
    /** Node discriminator. */
    kind: "null";
    /** 1-based line of the literal. */
    line: number;
}

/** Any parsed JSONC node. */
export type JsoncNode =
    | JsoncObjectNode
    | JsoncArrayNode
    | JsoncStringNode
    | JsoncNumberNode
    | JsoncBooleanNode
    | JsoncNullNode;

/** Maximum object/array nesting depth. */
const MAX_DEPTH = 64;

/** Recursive-descent JSONC parser over one source text. */
class Parser {
    /** Current scan position (index into text). */
    private pos = 0;

    /** Current 1-based line number. */
    private line = 1;

    /** Position where the current line starts (for column computation). */
    private lineStart = 0;

    /** Bind the parser to its source text and reporting filename. */
    constructor(
        private readonly text: string,
        private readonly file: string,
    ) {}

    /** Current 1-based column. */
    private col(): number {
        return this.pos - this.lineStart + 1;
    }

    /** Throw a ConfigError at the given (default: current) position. */
    private fail(problem: string, line?: number, col?: number): never {
        const atLine = line ?? this.line;
        const atCol = col ?? this.col();
        throw new ConfigError(`${this.file}:${atLine}:${atCol}: ${problem}`, { file: this.file, line: atLine });
    }

    /** The character at the current position (undefined at EOF). */
    private peek(offset = 0): string | undefined {
        return this.text[this.pos + offset];
    }

    /** Consume one character, tracking line breaks, and return it. */
    private next(): string | undefined {
        const ch = this.text[this.pos];
        this.pos += 1;
        if (ch === "\n") {
            this.line += 1;
            this.lineStart = this.pos;
        }
        return ch;
    }

    /** Skip whitespace and both comment forms; comments never nest. */
    private skipTrivia(): void {
        for (;;) {
            const ch = this.peek();
            if (ch === " " || ch === "\t" || ch === "\r" || ch === "\n") {
                this.next();
                continue;
            }
            if (ch === "/") {
                const following = this.peek(1);
                if (following === "/") {
                    while (this.peek() !== undefined && this.peek() !== "\n") {
                        this.next();
                    }
                    continue;
                }
                if (following === "*") {
                    const openLine = this.line;
                    const openCol = this.col();
                    this.next();
                    this.next();
                    for (;;) {
                        if (this.peek() === undefined) {
                            this.fail("unterminated block comment", openLine, openCol);
                        }
                        if (this.peek() === "*" && this.peek(1) === "/") {
                            this.next();
                            this.next();
                            break;
                        }
                        this.next();
                    }
                    continue;
                }
                this.fail('unexpected character "/"');
            }
            return;
        }
    }

    /** Parse the single top-level value and require EOF after it. */
    parseDocument(): JsoncNode {
        this.skipTrivia();
        if (this.peek() === undefined) {
            this.fail("unexpected end of input - expected a value");
        }
        const value = this.parseValue(1);
        this.skipTrivia();
        if (this.peek() !== undefined) {
            this.fail("unexpected trailing content after the top-level value");
        }
        return value;
    }

    /** Parse any value at the given nesting depth. */
    private parseValue(depth: number): JsoncNode {
        this.skipTrivia();
        const ch = this.peek();
        if (ch === undefined) {
            this.fail("unexpected end of input - expected a value");
        }
        if (ch === "{") {
            return this.parseObject(depth);
        }
        if (ch === "[") {
            return this.parseArray(depth);
        }
        if (ch === '"') {
            return this.parseString();
        }
        if (ch === "'") {
            this.fail("single quotes are not valid JSON - use double quotes");
        }
        if (ch === "+") {
            this.fail('numbers may not have a leading "+"');
        }
        if (ch === "-" || (ch >= "0" && ch <= "9")) {
            return this.parseNumber();
        }
        if (/[A-Za-z]/.test(ch)) {
            return this.parseKeyword();
        }
        this.fail(`unexpected character ${JSON.stringify(ch)}`);
    }

    /** Parse an object, enforcing the depth cap, unique keys, and one trailing comma. */
    private parseObject(depth: number): JsoncObjectNode {
        if (depth > MAX_DEPTH) {
            this.fail(`nesting depth exceeds ${MAX_DEPTH}`);
        }
        const node: JsoncObjectNode = { kind: "object", line: this.line, entries: new Map() };
        const keyLines = new Map<string, number>();
        this.next();
        this.skipTrivia();
        if (this.peek() === "}") {
            this.next();
            return node;
        }
        for (;;) {
            this.skipTrivia();
            const ch = this.peek();
            if (ch === undefined) {
                this.fail('unexpected end of input - expected a key or "}"');
            }
            if (ch === "'") {
                this.fail("single quotes are not valid JSON - use double quotes");
            }
            if (ch !== '"') {
                this.fail("object keys must be double-quoted strings");
            }
            const keyLine = this.line;
            const keyCol = this.col();
            const key = this.parseString().value;
            const firstLine = keyLines.get(key);
            if (firstLine !== undefined) {
                this.fail(`duplicate key "${key}" - first defined at line ${firstLine}`, keyLine, keyCol);
            }
            this.skipTrivia();
            if (this.peek() !== ":") {
                this.fail(`expected ":" after key "${key}"`);
            }
            this.next();
            const value = this.parseValue(depth + 1);
            node.entries.set(key, value);
            keyLines.set(key, keyLine);
            this.skipTrivia();
            const sep = this.peek();
            if (sep === ",") {
                this.next();
                this.skipTrivia();
                if (this.peek() === "}") {
                    this.next();
                    return node;
                }
                continue;
            }
            if (sep === "}") {
                this.next();
                return node;
            }
            if (sep === undefined) {
                this.fail('unexpected end of input - expected "," or "}"');
            }
            this.fail(`expected "," or "}" but found ${JSON.stringify(sep)}`);
        }
    }

    /** Parse an array, enforcing the depth cap and one trailing comma. */
    private parseArray(depth: number): JsoncArrayNode {
        if (depth > MAX_DEPTH) {
            this.fail(`nesting depth exceeds ${MAX_DEPTH}`);
        }
        const node: JsoncArrayNode = { kind: "array", line: this.line, items: [] };
        this.next();
        this.skipTrivia();
        if (this.peek() === "]") {
            this.next();
            return node;
        }
        for (;;) {
            node.items.push(this.parseValue(depth + 1));
            this.skipTrivia();
            const sep = this.peek();
            if (sep === ",") {
                this.next();
                this.skipTrivia();
                if (this.peek() === "]") {
                    this.next();
                    return node;
                }
                continue;
            }
            if (sep === "]") {
                this.next();
                return node;
            }
            if (sep === undefined) {
                this.fail('unexpected end of input - expected "," or "]"');
            }
            this.fail(`expected "," or "]" but found ${JSON.stringify(sep)}`);
        }
    }

    /** Parse a double-quoted string with full JSON escape handling. */
    private parseString(): JsoncStringNode {
        const openLine = this.line;
        const openCol = this.col();
        this.next();
        let value = "";
        for (;;) {
            const ch = this.peek();
            if (ch === undefined) {
                this.fail("unterminated string", openLine, openCol);
            }
            if (ch === '"') {
                this.next();
                return { kind: "string", line: openLine, value };
            }
            if (ch === "\n") {
                this.fail("multiline strings are not allowed - strings may not contain raw newlines");
            }
            if (ch < " ") {
                this.fail("control character in string - use \\u escapes");
            }
            if (ch === "\\") {
                this.next();
                const esc = this.peek();
                if (esc === undefined) {
                    this.fail("unterminated string", openLine, openCol);
                }
                this.next();
                switch (esc) {
                    case '"':
                        value += '"';
                        break;
                    case "\\":
                        value += "\\";
                        break;
                    case "/":
                        value += "/";
                        break;
                    case "b":
                        value += "\b";
                        break;
                    case "f":
                        value += "\f";
                        break;
                    case "n":
                        value += "\n";
                        break;
                    case "r":
                        value += "\r";
                        break;
                    case "t":
                        value += "\t";
                        break;
                    case "u": {
                        let hex = "";
                        for (let i = 0; i < 4; i += 1) {
                            const digit = this.peek();
                            if (digit === undefined || !/[0-9a-fA-F]/.test(digit)) {
                                this.fail("invalid \\u escape - expected four hex digits");
                            }
                            hex += digit;
                            this.next();
                        }
                        value += String.fromCharCode(Number.parseInt(hex, 16));
                        break;
                    }
                    default:
                        this.fail(`invalid escape sequence "\\${esc}"`);
                }
                continue;
            }
            value += ch;
            this.next();
        }
    }

    /** Parse an RFC 8259 number, rejecting hex, leading zeros, and a lone "-". */
    private parseNumber(): JsoncNumberNode {
        const startLine = this.line;
        let literal = "";
        if (this.peek() === "-") {
            literal += this.next();
        }
        const first = this.peek();
        if (first === "I") {
            this.fail("NaN and Infinity are not valid JSON");
        }
        if (first === undefined || first < "0" || first > "9") {
            this.fail("invalid number - expected a digit");
        }
        if (first === "0") {
            literal += this.next();
            const after = this.peek();
            if (after === "x" || after === "X") {
                this.fail("hex numbers are not allowed");
            }
            if (after !== undefined && after >= "0" && after <= "9") {
                this.fail("numbers may not have leading zeros");
            }
        } else {
            while (this.peek() !== undefined && this.peek()! >= "0" && this.peek()! <= "9") {
                literal += this.next();
            }
        }
        if (this.peek() === ".") {
            literal += this.next();
            if (this.peek() === undefined || this.peek()! < "0" || this.peek()! > "9") {
                this.fail('invalid number - expected digits after "."');
            }
            while (this.peek() !== undefined && this.peek()! >= "0" && this.peek()! <= "9") {
                literal += this.next();
            }
        }
        if (this.peek() === "e" || this.peek() === "E") {
            literal += this.next();
            if (this.peek() === "+" || this.peek() === "-") {
                literal += this.next();
            }
            if (this.peek() === undefined || this.peek()! < "0" || this.peek()! > "9") {
                this.fail("invalid number - expected digits in the exponent");
            }
            while (this.peek() !== undefined && this.peek()! >= "0" && this.peek()! <= "9") {
                literal += this.next();
            }
        }
        return { kind: "number", line: startLine, value: Number(literal) };
    }

    /** Parse true/false/null; reject NaN/Infinity and any other bare word. */
    private parseKeyword(): JsoncNode {
        const startLine = this.line;
        const startCol = this.col();
        let word = "";
        while (this.peek() !== undefined && /[A-Za-z]/.test(this.peek()!)) {
            word += this.next();
        }
        if (word === "true" || word === "false") {
            return { kind: "boolean", line: startLine, value: word === "true" };
        }
        if (word === "null") {
            return { kind: "null", line: startLine };
        }
        if (word === "NaN" || word === "Infinity") {
            this.fail("NaN and Infinity are not valid JSON", startLine, startCol);
        }
        this.fail(`unexpected token "${word}" - object keys and strings must be double-quoted`, startLine, startCol);
    }
}

/**
 * Parse JSONC source text into its node tree. `file` is used in error
 * messages only (`<file>:<line>:<col>: <problem>`). Throws ConfigError on any
 * grammar violation, duplicate key, or depth-cap breach.
 */
export function parseJsonc(text: string, file: string): JsoncNode {
    return new Parser(text, file).parseDocument();
}
