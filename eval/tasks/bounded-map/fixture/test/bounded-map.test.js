import assert from "node:assert/strict";
import test from "node:test";
import { mapConcurrent } from "../src/bounded-map.js";

function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((resolvePromise, rejectPromise) => {
        resolve = resolvePromise;
        reject = rejectPromise;
    });
    return { promise, resolve, reject };
}

async function waitUntil(predicate) {
    for (let attempt = 0; attempt < 20; attempt += 1) {
        if (predicate()) return;
        await Promise.resolve();
    }
    assert.fail("expected scheduling progress");
}

test("never starts more workers than the limit", async () => {
    const gates = Array.from({ length: 4 }, deferred);
    const started = [];
    const result = mapConcurrent(["a", "b", "c", "d"], 2, async (item, index) => {
        started.push(index);
        await gates[index].promise;
        return item.toUpperCase();
    });

    await Promise.resolve();
    assert.deepEqual(started, [0, 1]);
    gates[1].resolve();
    await waitUntil(() => started.length === 3);
    assert.deepEqual(started, [0, 1, 2]);
    gates[0].resolve();
    gates[2].resolve();
    await waitUntil(() => started.length === 4);
    gates[3].resolve();
    assert.deepEqual(await result, ["A", "B", "C", "D"]);
});

test("preserves input order when workers finish out of order", async () => {
    const gates = Array.from({ length: 3 }, deferred);
    const result = mapConcurrent([10, 20, 30], 3, async (item, index) => {
        await gates[index].promise;
        return item + index;
    });

    gates[2].resolve();
    gates[0].resolve();
    gates[1].resolve();
    assert.deepEqual(await result, [10, 21, 32]);
});

test("handles empty input without calling the worker", async () => {
    let calls = 0;
    assert.deepEqual(
        await mapConcurrent([], 2, () => {
            calls += 1;
        }),
        [],
    );
    assert.equal(calls, 0);
});

test("validates arguments before starting workers", async () => {
    let calls = 0;
    const worker = () => {
        calls += 1;
    };

    await assert.rejects(() => mapConcurrent("not an array", 1, worker), /items|array/i);
    await assert.rejects(() => mapConcurrent([], 0, worker), /limit|positive|integer/i);
    await assert.rejects(() => mapConcurrent([], 1.5, worker), /limit|positive|integer/i);
    await assert.rejects(() => mapConcurrent([], 1, null), /worker|function/i);
    assert.equal(calls, 0);
});

test("propagates a worker rejection", async () => {
    const failure = new Error("broken worker");
    await assert.rejects(
        () => mapConcurrent([1, 2, 3], 1, async (item) => {
            if (item === 2) throw failure;
            return item;
        }),
        (error) => error === failure,
    );
});
