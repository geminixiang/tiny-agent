import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { reduceSession, SessionCorruption } from "../src/session-reducer.js";
import { planRecovery, SYNTHETIC_CONTENT, type SyntheticResult } from "../src/session-recovery.js";

const fixtures = resolve(dirname(fileURLToPath(import.meta.url)), "../../schemas/session/fixtures");
const manifestSchema = JSON.parse(await readFile(resolve(fixtures, "manifest.schema.json"), "utf8"));
const expectedSchema = JSON.parse(await readFile(resolve(fixtures, "../expected-state.schema.json"), "utf8"));
const sessionSchema = JSON.parse(await readFile(resolve(fixtures, "../../session.schema.json"), "utf8"));
const manifest = JSON.parse(await readFile(resolve(fixtures, "manifest.json"), "utf8")) as {
    fixtures: { name: string; file: string; expected: string; schemaValid: boolean }[];
};

const plannerFixtures = resolve(fixtures, "../planner-fixtures");
const plannerManifest = JSON.parse(await readFile(resolve(plannerFixtures, "manifest.json"), "utf8")) as {
    fixtures: { name: string; input: string; expected: string }[];
};
const currentConfigurationSchema = JSON.parse(
    await readFile(resolve(plannerFixtures, "../current-configuration.schema.json"), "utf8"),
);
const recoveryPlanSchema = JSON.parse(await readFile(resolve(plannerFixtures, "../recovery-plan.schema.json"), "utf8"));

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

test("session fixture metadata matches its JSON schemas", async () => {
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
    test(`session fixture: ${fixture.name}`, async () => {
        const bytes = await readFile(resolve(fixtures, fixture.file));
        const expected = JSON.parse(await readFile(resolve(fixtures, fixture.expected), "utf8"));
        if (expected.ok) {
            assert.deepEqual(reduceSession(bytes), expected.state);
            return;
        }
        assert.throws(
            () => reduceSession(bytes),
            (error: unknown) => {
                assert.ok(error instanceof SessionCorruption);
                assert.deepEqual(
                    { code: error.code, line: error.line, ...(error.seq === undefined ? {} : { seq: error.seq }) },
                    expected.error,
                );
                return true;
            },
        );
    });
}

for (const fixture of plannerManifest.fixtures) {
    test(`session recovery plan: ${fixture.name}`, async () => {
        const input = JSON.parse(await readFile(resolve(plannerFixtures, fixture.input), "utf8"));
        const expected = JSON.parse(await readFile(resolve(plannerFixtures, fixture.expected), "utf8"));
        assertSchema(input.current, currentConfigurationSchema);
        assertSchema(expected, recoveryPlanSchema);
        const state = reduceSession(await readFile(resolve(fixtures, input.fixture)));
        if (
            ["abort-close-attempt", "abort-pending-tool", "abort-mixed-tools"].includes(fixture.name) &&
            state.operation.kind !== "idle"
        )
            state.operation.abortRequested = true;
        if (fixture.name === "attempts-exhausted" && state.operation.kind !== "idle") state.operation.step!.attempt = 2;
        assert.deepEqual(planRecovery(state, input.current), expected);
    });
}
function materializeSynthetic(result: SyntheticResult, stepId: string, seq: number, index: number) {
    const id = result.resultEntryId ?? `018f0000-0000-7000-8000-${(0xf0 + index).toString(16).padStart(12, "0")}`;
    return {
        kind: "entry",
        seq,
        id,
        timestamp: 1710000001000 + index,
        entry: {
            type: "message",
            stepId,
            ...(result.toolStartedId
                ? { toolStartedId: result.toolStartedId }
                : { assistantEntryId: result.assistantEntryId, toolIndex: result.toolIndex }),
            message: { role: "tool", tool_call_id: result.toolCallId, content: result.content },
            toolName: result.toolName,
            result: { type: "synthetic", reason: result.reason },
        },
    };
}

function nextSequence(bytes: Buffer) {
    return (
        committedValues(bytes)
            .slice(1)
            .flatMap((value) => (Array.isArray(value) ? value : [value])).length + 1
    );
}

test("every synthetic recovery action materializes as a schema-valid reducible entry", async () => {
    for (const fixture of plannerManifest.fixtures) {
        const input = JSON.parse(await readFile(resolve(plannerFixtures, fixture.input), "utf8"));
        const bytes = await readFile(resolve(fixtures, input.fixture));
        const state = reduceSession(bytes);
        if (
            ["abort-close-attempt", "abort-pending-tool", "abort-mixed-tools"].includes(fixture.name) &&
            state.operation.kind !== "idle"
        )
            state.operation.abortRequested = true;
        const plan = planRecovery(state, input.current);
        if (plan.type !== "appendSynthetic") continue;
        assert.ok(state.operation.kind === "run" && state.operation.step);
        const seq = nextSequence(bytes);
        const facts = plan.results.map((result, index) =>
            materializeSynthetic(
                result,
                state.operation.kind === "run" ? state.operation.step!.stepId : "",
                seq + index,
                index,
            ),
        );
        for (const fact of facts) assertSchema(fact, sessionSchema);
        const appended = Buffer.concat([
            bytes.subarray(0, state.repairedLength),
            Buffer.from(`${JSON.stringify(facts)}\n`),
        ]);
        assert.doesNotThrow(() => reduceSession(appended), fixture.name);
        for (const result of plan.results) assert.equal(result.content, SYNTHETIC_CONTENT[result.reason]);
    }
});

test("session rejects a transaction without partially applying it", async () => {
    const bytes = await readFile(resolve(fixtures, "skipped-seq-transaction.jsonl"));
    assert.throws(() => reduceSession(bytes), { code: "SEQ_MISMATCH" });
    const repaired = Buffer.from(bytes.toString("utf8").replace('"seq":3', '"seq":2'));
    assert.deepEqual(reduceSession(repaired).operation, {
        kind: "run",
        operationId: "018f0000-0000-7000-8000-000000000004",
        inputEntryId: "018f0000-0000-7000-8000-000000000002",
        toolCalls: [],
        abortRequested: false,
    });
});

test("session reduction is effect-free and deterministic", async () => {
    const bytes = await readFile(resolve(fixtures, "completed-tool-run.jsonl"));
    const before = Buffer.from(bytes);
    const first = reduceSession(bytes);
    const second = reduceSession(bytes);
    assert.deepEqual(bytes, before);
    assert.deepEqual(first, second);
});
