import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const { memoizeAsync } = await import(pathToFileURL(resolve("src/cache.js")).href);

let calls = 0;
let release;
const gate = new Promise((resolveGate) => {
    release = resolveGate;
});
const cachedConcurrent = memoizeAsync(async (key) => {
    calls += 1;
    await gate;
    return `value:${key}:${calls}`;
}, { ttlMs: 1_000 });

const first = cachedConcurrent("same");
const second = cachedConcurrent("same");
await delay(10);
assert.equal(calls, 1);
release();
assert.equal(await first, "value:same:1");
assert.equal(await second, "value:same:1");

let ttlCalls = 0;
const cachedTtl = memoizeAsync(async () => ++ttlCalls, { ttlMs: 20 });
assert.equal(await cachedTtl("x"), 1);
assert.equal(await cachedTtl("x"), 1);
await delay(30);
assert.equal(await cachedTtl("x"), 2);

let failures = 0;
const cachedFailure = memoizeAsync(async () => {
    failures += 1;
    if (failures === 1) throw new Error("temporary");
    return "ok";
}, { ttlMs: 1_000 });
await assert.rejects(() => cachedFailure("k"), /temporary/);
assert.equal(await cachedFailure("k"), "ok");
assert.equal(failures, 2);
