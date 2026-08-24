import assert from "node:assert/strict";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const { summarizeEvents } = await import(pathToFileURL(resolve("src/session.js")).href);

assert.deepEqual(summarizeEvents([]), {
    total: 0,
    byType: {},
    durationMs: 0,
    toolFailures: 0,
    lastError: null,
});

const events = [
    null,
    { type: "started", at: 100 },
    { type: "tool", at: 140, ok: false, error: "first failure" },
    { type: "message", at: "bad" },
    { type: "tool", at: 90, ok: true },
    { type: "tool", at: 250, ok: false, error: "second failure" },
    { at: 300 },
];

assert.deepEqual(summarizeEvents(events), {
    total: 5,
    byType: { started: 1, tool: 3, message: 1 },
    durationMs: 160,
    toolFailures: 2,
    lastError: "second failure",
});
