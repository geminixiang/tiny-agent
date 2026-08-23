import { createHash } from "node:crypto";

// The RFC 8785 JCS subset documented in docs/session-design.md ("Canonicalization"): recursively
// sorted object keys, preserved array order, and JSON string escaping with lone UTF-16 surrogates
// rejected. Every digest that must agree across a durable-log producer and its later verifier --
// or across this repo's four language ports -- has to run through this exact function, never a
// second hand-rolled copy of it: two independently-written serializers can silently drift on some
// input neither author thought to test, corrupting a contract that is supposed to be exact.
export function canonicalJson(value: unknown): string {
    if (value === null || typeof value === "boolean" || typeof value === "number") return JSON.stringify(value);
    if (typeof value === "string") return canonicalString(value);
    if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
    if (typeof value !== "object") throw new Error("unsupported canonical value");
    const item = value as Record<string, unknown>;
    return `{${Object.keys(item)
        .sort()
        .map((key) => `${canonicalString(key)}:${canonicalJson(item[key])}`)
        .join(",")}}`;
}

function canonicalString(value: string) {
    for (let index = 0; index < value.length; index++) {
        const code = value.charCodeAt(index);
        if (code >= 0xd800 && code <= 0xdbff) {
            // A high surrogate as the very last code unit has no next character at all:
            // charCodeAt() past the end returns NaN, and every comparison against NaN is false,
            // so a naive `next < 0xdc00 || next > 0xdfff` silently passes it as if paired.
            if (index + 1 >= value.length) throw new Error("invalid Unicode scalar string");
            const next = value.charCodeAt(++index);
            if (next < 0xdc00 || next > 0xdfff) throw new Error("invalid Unicode scalar string");
        } else if (code >= 0xdc00 && code <= 0xdfff) throw new Error("invalid Unicode scalar string");
    }
    return `"${[...value]
        .map((character) => {
            if (character === "\\") return "\\\\";
            if (character === '"') return '\\"';
            const escapes: Record<string, string> = { "\b": "\\b", "\t": "\\t", "\n": "\\n", "\f": "\\f", "\r": "\\r" };
            const code = character.codePointAt(0)!;
            return code < 0x20 ? (escapes[character] ?? `\\u${code.toString(16).padStart(4, "0")}`) : character;
        })
        .join("")}"`;
}

export function canonicalDigest(value: unknown) {
    return `sha256:${createHash("sha256").update(canonicalJson(value)).digest("hex")}`;
}
