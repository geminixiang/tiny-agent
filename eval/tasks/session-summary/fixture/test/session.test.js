import test from "node:test";
import assert from "node:assert/strict";
import { summarizeEvents } from "../src/session.js";

test("counts events by type", () => {
    const summary = summarizeEvents([
        { type: "started", at: 10 },
        { type: "tool", at: 15 },
        { type: "tool", at: 20 },
    ]);

    assert.deepEqual(summary.byType, { started: 1, tool: 2 });
    assert.equal(summary.total, 3);
});

test("computes duration from first to last timestamp", () => {
    const summary = summarizeEvents([
        { type: "started", at: 100 },
        { type: "completed", at: 175 },
    ]);

    assert.equal(summary.durationMs, 75);
});
