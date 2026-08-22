import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SessionStore, environmentIdentity } from "../src/session.js";

const MODEL = "test/model";
const USER_ID = "018f0000-0000-7000-8000-000000000002";
const OPERATION_ID = "018f0000-0000-7000-8000-000000000004";

async function workspace() {
    return mkdtemp(join(tmpdir(), "tiny-session-store-"));
}

function acceptedRun() {
    return [
        {
            kind: "entry",
            id: USER_ID,
            entry: { type: "message", message: { role: "user", content: "inspect" } },
        },
        {
            kind: "record",
            record: {
                type: "runStarted",
                operationId: OPERATION_ID,
                operationKind: "run",
                inputEntryId: USER_ID,
            },
        },
    ];
}

test("session store creates an exclusive 0600 canonical file", async () => {
    const cwd = await workspace();
    const store = await SessionStore.create(cwd, MODEL, new Date("2026-08-22T00:00:00.000Z"));
    const header = JSON.parse((await readFile(store.path, "utf8")).trim());
    assert.deepEqual(
        { kind: header.kind, version: header.version, cwd: header.cwd, provider: header.provider, model: header.model },
        { kind: "header", version: 2, cwd, provider: "openrouter", model: MODEL },
    );
    assert.equal((await stat(store.path)).mode & 0o777, 0o600);
    await assert.rejects(() => SessionStore.open(store.id, cwd), /already open/);
    await store.close();
});

test("environment identity prefers a nonempty override and otherwise resolves cwd", async () => {
    const cwd = await workspace();
    const previous = process.env.TINY_AGENT_ENVIRONMENT_IDENTITY;
    process.env.TINY_AGENT_ENVIRONMENT_IDENTITY = " job-123 ";
    assert.equal(await environmentIdentity(cwd), "job-123");
    delete process.env.TINY_AGENT_ENVIRONMENT_IDENTITY;
    assert.equal(await environmentIdentity(cwd), await (await import("node:fs/promises")).realpath(cwd));
    if (previous === undefined) delete process.env.TINY_AGENT_ENVIRONMENT_IDENTITY;
    else process.env.TINY_AGENT_ENVIRONMENT_IDENTITY = previous;
});

test("session store validates a candidate before append and preserves bytes on rejection", async () => {
    const cwd = await workspace();
    const store = await SessionStore.create(cwd, MODEL);
    const before = await readFile(store.path);
    await assert.rejects(
        () => store.append({ kind: "record", record: { type: "runStarted" } }),
        /INVALID_FACT|INVALID_REFERENCE|INVALID_TRANSITION/,
    );
    assert.deepEqual(await readFile(store.path), before);
    assert.equal((await store.load()).operation.kind, "idle");
    await store.close();
});

test("session store serializes concurrent transactions in FIFO order", async () => {
    const cwd = await workspace();
    const store = await SessionStore.create(cwd, MODEL);
    const [facts] = await Promise.all([
        store.append(acceptedRun()),
        store.append({
            kind: "record",
            record: {
                type: "abortRequested",
                operationId: OPERATION_ID,
                operationKind: "run",
                phase: "model",
                reason: "escape",
            },
        }),
    ]);
    assert.deepEqual(
        facts.map((fact) => fact.seq),
        [1, 2],
    );
    const lines = (await readFile(store.path, "utf8"))
        .trim()
        .split("\n")
        .slice(1)
        .map((line) => JSON.parse(line));
    assert.deepEqual(
        lines.flatMap((value) => (Array.isArray(value) ? value : [value])).map((fact) => fact.seq),
        [1, 2, 3],
    );
    assert.equal((await store.load()).operation.kind, "run");
    await store.close();
});

test("session store repairs a torn tail before admitting appends", async () => {
    const cwd = await workspace();
    const created = await SessionStore.create(cwd, MODEL);
    const id = created.id;
    const path = created.path;
    await created.append(acceptedRun());
    await created.close();
    await writeFile(path, Buffer.concat([await readFile(path), Buffer.from('{"kind":"record"')]));
    const reopened = await SessionStore.open(id, cwd);
    assert.equal((await readFile(path, "utf8")).endsWith("\n"), true);
    await reopened.append({
        kind: "record",
        record: {
            type: "abortRequested",
            operationId: OPERATION_ID,
            operationKind: "run",
            phase: "model",
            reason: "escape",
        },
    });
    assert.equal((await reopened.load()).operation.kind, "run");
    await reopened.close();
});

test("session store opens canonical sessions only, enforces one writer, and closes idempotently", async () => {
    const cwd = await workspace();
    const store = await SessionStore.create(cwd, MODEL);
    await assert.rejects(() => SessionStore.open(store.id, cwd), /already open/);
    await store.close();
    await store.close();
    await assert.rejects(() => store.append(acceptedRun()), /closed/);
    const reopened = await SessionStore.open(store.id, cwd);
    await reopened.close();

    const legacy = await SessionStore.create(cwd, MODEL, new Date("2026-08-23T00:00:00.000Z"));
    const legacyId = legacy.id;
    const legacyPath = legacy.path;
    await legacy.close();
    await writeFile(legacyPath, `${JSON.stringify({ type: "session", version: 1, id: legacyId })}\n`);
    await chmod(legacyPath, 0o600);
    await assert.rejects(() => SessionStore.open(legacyId, cwd), /INVALID_HEADER|UNSUPPORTED_VERSION/);
});
