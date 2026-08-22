import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { reduceSessionV2, SessionV2Corruption } from "../src/session-v2.js";

const fixtures = resolve(dirname(fileURLToPath(import.meta.url)), "../../schemas/session-v2/fixtures");
const manifestSchema = JSON.parse(await readFile(resolve(fixtures, "manifest.schema.json"), "utf8"));
const expectedSchema = JSON.parse(await readFile(resolve(fixtures, "../expected-state.schema.json"), "utf8"));
const sessionSchema = JSON.parse(await readFile(resolve(fixtures, "../session.schema.json"), "utf8"));
const manifest = JSON.parse(await readFile(resolve(fixtures, "manifest.json"), "utf8")) as {
    fixtures: { name: string; file: string; expected: string; schemaValid: boolean }[];
};

type JsonSchema = Record<string, unknown>;

function validateSchema(value: unknown, schema: JsonSchema, root: JsonSchema, path = "$"): string[] {
    if (schema.$ref) {
        const target = String(schema.$ref)
            .slice(2)
            .split("/")
            .reduce<unknown>((current, key) => (current as Record<string, unknown>)[key], root) as JsonSchema;
        return validateSchema(value, target, root, path);
    }
    if (schema.oneOf) {
        const matches = (schema.oneOf as JsonSchema[]).filter(
            (candidate) => validateSchema(value, candidate, root, path).length === 0,
        );
        return matches.length === 1 ? [] : [`${path}: expected exactly one schema match, got ${matches.length}`];
    }
    const errors: string[] = [];
    if (schema.const !== undefined && value !== schema.const) errors.push(`${path}: expected constant ${schema.const}`);
    if (schema.enum && !(schema.enum as unknown[]).includes(value)) errors.push(`${path}: unexpected enum value`);
    const types = Array.isArray(schema.type) ? schema.type : schema.type ? [schema.type] : [];
    if (types.length) {
        const actual = value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
        const integer = actual === "number" && Number.isInteger(value);
        if (!types.includes(actual) && !(types.includes("integer") && integer))
            errors.push(`${path}: expected ${types}`);
    }
    if (typeof value === "string") {
        if (schema.minLength !== undefined && value.length < Number(schema.minLength))
            errors.push(`${path}: too short`);
        if (schema.pattern && !new RegExp(String(schema.pattern)).test(value)) errors.push(`${path}: pattern mismatch`);
    }
    if (typeof value === "number") {
        if (schema.minimum !== undefined && value < Number(schema.minimum)) errors.push(`${path}: below minimum`);
        if (schema.maximum !== undefined && value > Number(schema.maximum)) errors.push(`${path}: above maximum`);
    }
    if (Array.isArray(value)) {
        if (schema.minItems !== undefined && value.length < Number(schema.minItems))
            errors.push(`${path}: too few items`);
        if (schema.items)
            value.forEach((item, index) =>
                errors.push(...validateSchema(item, schema.items as JsonSchema, root, `${path}[${index}]`)),
            );
    }
    if (value && typeof value === "object" && !Array.isArray(value)) {
        const object = value as Record<string, unknown>;
        for (const key of (schema.required as string[] | undefined) ?? [])
            if (!Object.hasOwn(object, key)) errors.push(`${path}: missing ${key}`);
        const properties = (schema.properties as Record<string, JsonSchema> | undefined) ?? {};
        if (schema.additionalProperties === false)
            for (const key of Object.keys(object))
                if (!Object.hasOwn(properties, key)) errors.push(`${path}: extra ${key}`);
        for (const [key, property] of Object.entries(properties))
            if (Object.hasOwn(object, key))
                errors.push(...validateSchema(object[key], property, root, `${path}.${key}`));
    }
    for (const condition of (schema.allOf as JsonSchema[] | undefined) ?? []) {
        const applies = !condition.if || validateSchema(value, condition.if as JsonSchema, root, path).length === 0;
        if (applies && condition.then) errors.push(...validateSchema(value, condition.then as JsonSchema, root, path));
    }
    return errors;
}

function assertSchema(value: unknown, schema: JsonSchema, root = schema) {
    assert.deepEqual(validateSchema(value, schema, root), []);
}

function committedValues(bytes: Buffer) {
    const lastLf = bytes.lastIndexOf(0x0a);
    if (lastLf < 0) return [];
    return bytes
        .subarray(0, lastLf)
        .toString("utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line));
}

test("session v2 fixture metadata matches its JSON schemas", async () => {
    assertSchema(manifest, manifestSchema);
    for (const fixture of manifest.fixtures) {
        const expected = JSON.parse(await readFile(resolve(fixtures, fixture.expected), "utf8"));
        assertSchema(expected, expectedSchema);
        if (!fixture.schemaValid) continue;
        // Lexically invalid fixtures bypass JSON.parse here so duplicate keys and lone surrogates reach the reducer as bytes.
        for (const value of committedValues(await readFile(resolve(fixtures, fixture.file))))
            assertSchema(value, sessionSchema);
    }
});

for (const fixture of manifest.fixtures) {
    test(`session v2 fixture: ${fixture.name}`, async () => {
        const bytes = await readFile(resolve(fixtures, fixture.file));
        const expected = JSON.parse(await readFile(resolve(fixtures, fixture.expected), "utf8"));
        if (expected.ok) {
            assert.deepEqual(reduceSessionV2(bytes), expected.state);
            return;
        }
        assert.throws(
            () => reduceSessionV2(bytes),
            (error: unknown) => {
                assert.ok(error instanceof SessionV2Corruption);
                assert.deepEqual(
                    { code: error.code, line: error.line, ...(error.seq === undefined ? {} : { seq: error.seq }) },
                    expected.error,
                );
                return true;
            },
        );
    });
}

test("session v2 rejects a transaction without partially applying it", async () => {
    const bytes = await readFile(resolve(fixtures, "skipped-seq-transaction.jsonl"));
    assert.throws(() => reduceSessionV2(bytes), { code: "SEQ_MISMATCH" });
    const repaired = Buffer.from(bytes.toString("utf8").replace('"seq":3', '"seq":2'));
    assert.deepEqual(reduceSessionV2(repaired).operation, {
        kind: "run",
        operationId: "018f0000-0000-7000-8000-000000000004",
        inputEntryId: "018f0000-0000-7000-8000-000000000002",
        toolCalls: [],
        abortRequested: false,
    });
});

test("session v2 reduction is effect-free and deterministic", async () => {
    const bytes = await readFile(resolve(fixtures, "completed-tool-run.jsonl"));
    const before = Buffer.from(bytes);
    const first = reduceSessionV2(bytes);
    const second = reduceSessionV2(bytes);
    assert.deepEqual(bytes, before);
    assert.deepEqual(first, second);
});
