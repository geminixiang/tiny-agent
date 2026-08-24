import test from "node:test";
import assert from "node:assert/strict";
import { memoizeAsync } from "../src/cache.js";

test("caches a resolved value inside the ttl", async () => {
    let calls = 0;
    const cached = memoizeAsync(async (key) => `${key}:${++calls}`, { ttlMs: 1_000 });

    assert.equal(await cached("a"), "a:1");
    assert.equal(await cached("a"), "a:1");
    assert.equal(calls, 1);
});

test("keeps different keys independent", async () => {
    let calls = 0;
    const cached = memoizeAsync(async (key) => `${key}:${++calls}`, { ttlMs: 1_000 });

    assert.equal(await cached("a"), "a:1");
    assert.equal(await cached("b"), "b:2");
});

test("shares one pending load for concurrent calls", async () => {
    let calls = 0;
    let release;
    const gate = new Promise((resolve) => {
        release = resolve;
    });
    const cached = memoizeAsync(async (key) => {
        calls += 1;
        await gate;
        return `value:${key}`;
    });

    const first = cached("same");
    const second = cached("same");
    await Promise.resolve();
    assert.equal(calls, 1);
    release();
    assert.equal(await first, "value:same");
    assert.equal(await second, "value:same");
});
