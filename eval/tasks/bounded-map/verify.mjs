import assert from "node:assert/strict";
import { lstat, readFile, readdir } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const taskDir = dirname(fileURLToPath(import.meta.url));
const fixtureDir = resolve(taskDir, "fixture");
const workspace = process.cwd();
const allowedFiles = new Set(["package.json", "src/bounded-map.js", "test/bounded-map.test.js"]);

function deferred() {
    let resolvePromise;
    let rejectPromise;
    const promise = new Promise((resolve, reject) => {
        resolvePromise = resolve;
        rejectPromise = reject;
    });
    return { promise, resolve: resolvePromise, reject: rejectPromise };
}

async function flushUntil(predicate, message) {
    for (let attempt = 0; attempt < 50; attempt += 1) {
        if (predicate()) return;
        await Promise.resolve();
    }
    assert.fail(message);
}

async function workspaceFiles(directory = workspace) {
    const files = [];
    for (const entry of await readdir(directory, { withFileTypes: true })) {
        if (directory === workspace && (entry.name === ".git" || entry.name === ".tiny-agent"))
            continue;
        const path = resolve(directory, entry.name);
        const name = relative(workspace, path);
        if (entry.isDirectory()) files.push(...(await workspaceFiles(path)));
        else files.push({ name, path });
    }
    return files;
}

async function verifyWorkspacePolicy() {
    const files = await workspaceFiles();
    assert.deepEqual(
        files.map(({ name }) => name).sort(),
        [...allowedFiles].sort(),
        "only src/bounded-map.js may differ from the fixture",
    );
    for (const { name, path } of files) {
        const stats = await lstat(path);
        assert.equal(stats.isFile(), true, `${name} must be a regular file`);
    }
    for (const name of ["package.json", "test/bounded-map.test.js"]) {
        assert.deepEqual(
            await readFile(resolve(workspace, name)),
            await readFile(resolve(fixtureDir, name)),
            `${name} must not change`,
        );
    }
}

await verifyWorkspacePolicy();
const moduleUrl = `${pathToFileURL(resolve(workspace, "src/bounded-map.js")).href}?verify=${Date.now()}`;
const { mapConcurrent } = await import(moduleUrl);
assert.equal(typeof mapConcurrent, "function");

let validationCalls = 0;
const validationWorker = () => {
    validationCalls += 1;
};
for (const [items, limit, worker] of [
    [null, 1, validationWorker],
    [{}, 1, validationWorker],
    [[], 0, validationWorker],
    [[], -1, validationWorker],
    [[], 1.5, validationWorker],
    [[], Number.NaN, validationWorker],
    [[], Number.POSITIVE_INFINITY, validationWorker],
    [[], 1, null],
]) {
    await assert.rejects(() => mapConcurrent(items, limit, worker));
}
assert.equal(validationCalls, 0);

for (const [length, limit] of [
    [1, 1],
    [2, 1],
    [7, 2],
    [17, 5],
    [31, 3],
]) {
    const items = Object.freeze(Array.from({ length }, (_, index) => Object.freeze({ index })));
    const gates = Array.from({ length }, deferred);
    const calls = Array(length).fill(0);
    const started = [];
    let active = 0;
    let maxActive = 0;
    const result = mapConcurrent(items, limit, async (item, index, signal) => {
        assert.equal(signal, undefined);
        assert.equal(item, items[index]);
        calls[index] += 1;
        started.push(index);
        active += 1;
        maxActive = Math.max(maxActive, active);
        try {
            await gates[index].promise;
            return `result:${index}`;
        } finally {
            active -= 1;
        }
    });

    await flushUntil(
        () => started.length === Math.min(length, limit),
        "the initial worker batch did not start",
    );
    assert.deepEqual(started, Array.from({ length: Math.min(length, limit) }, (_, index) => index));
    for (let index = 0; index < length; index += 1) {
        gates[index].resolve();
        const expectedStarts = Math.min(length, Math.max(Math.min(length, limit), index + limit + 1));
        await flushUntil(
            () => started.length >= expectedStarts || index === length - 1,
            "the next queued worker did not start",
        );
    }
    assert.deepEqual(
        await result,
        Array.from({ length }, (_, index) => `result:${index}`),
    );
    assert.equal(maxActive <= limit, true);
    assert.deepEqual(calls, Array(length).fill(1));
    assert.equal(active, 0);
}

const failure = new Error("hidden worker failure");
const failureGates = [deferred(), deferred()];
const failureStarted = [];
let failureSettled = false;
const failedRun = mapConcurrent([0, 1, 2, 3, 4], 2, async (_item, index) => {
    failureStarted.push(index);
    if (index === 1) throw failure;
    await failureGates[index].promise;
    return index;
});
failedRun.then(
    () => {
        failureSettled = true;
    },
    () => {
        failureSettled = true;
    },
);
await flushUntil(() => failureStarted.length === 2, "failure workers did not start");
await Promise.resolve();
assert.deepEqual(failureStarted, [0, 1]);
assert.equal(failureSettled, false, "failure must wait for already-started workers");
failureGates[0].resolve();
await assert.rejects(failedRun, (error) => error === failure);
assert.deepEqual(failureStarted, [0, 1]);

const synchronousFailure = new Error("synchronous failure");
await assert.rejects(
    () =>
        mapConcurrent([0, 1], 1, () => {
            throw synchronousFailure;
        }),
    (error) => error === synchronousFailure,
);

const preController = new AbortController();
const preReason = new Error("pre-aborted");
preController.abort(preReason);
let preAbortCalls = 0;
await assert.rejects(
    () =>
        mapConcurrent(
            [1, 2],
            1,
            () => {
                preAbortCalls += 1;
            },
            { signal: preController.signal },
        ),
    (error) => error === preReason,
);
assert.equal(preAbortCalls, 0);

const abortController = new AbortController();
const abortReason = Object.freeze({ code: "cancelled" });
const abortGates = [deferred(), deferred()];
const abortStarted = [];
let abortSettled = false;
const abortedRun = mapConcurrent(
    [0, 1, 2, 3],
    2,
    async (_item, index, signal) => {
        assert.equal(signal, abortController.signal);
        abortStarted.push(index);
        await abortGates[index].promise;
        return index;
    },
    { signal: abortController.signal },
);
abortedRun.then(
    () => {
        abortSettled = true;
    },
    () => {
        abortSettled = true;
    },
);
await flushUntil(() => abortStarted.length === 2, "abort workers did not start");
abortController.abort(abortReason);
await Promise.resolve();
assert.deepEqual(abortStarted, [0, 1]);
assert.equal(abortSettled, false, "abort must wait for already-started workers");
abortGates[0].resolve();
abortGates[1].resolve();
await assert.rejects(abortedRun, (error) => error === abortReason);
assert.deepEqual(abortStarted, [0, 1]);

const listeners = new Set();
let addedListeners = 0;
let removedListeners = 0;
const trackedSignal = {
    aborted: false,
    reason: undefined,
    addEventListener(type, listener) {
        assert.equal(type, "abort");
        addedListeners += 1;
        listeners.add(listener);
    },
    removeEventListener(type, listener) {
        assert.equal(type, "abort");
        removedListeners += 1;
        listeners.delete(listener);
    },
};
assert.deepEqual(
    await mapConcurrent(Object.freeze([1, 2, 3]), 2, async (value, _index, signal) => {
        assert.equal(signal, trackedSignal);
        return value * 2;
    }, { signal: trackedSignal }),
    [2, 4, 6],
);
assert.equal(addedListeners > 0, true);
assert.equal(removedListeners, addedListeners);
assert.equal(listeners.size, 0);
