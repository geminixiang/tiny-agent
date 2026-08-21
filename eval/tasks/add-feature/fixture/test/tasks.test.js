import test from "node:test";
import assert from "node:assert/strict";
import { activeTasks } from "../src/tasks.js";

test("returns only active tasks", () => {
    const tasks = [
        { id: "a", title: "Alpha", completed: false },
        { id: "b", title: "Beta", completed: true },
    ];
    assert.deepEqual(activeTasks(tasks), [tasks[0]]);
});
