import test from "node:test";
import assert from "node:assert/strict";
import { activeTasks, completeTask } from "../src/tasks.js";

test("returns only active tasks", () => {
    const tasks = [
        { id: "a", title: "Alpha", completed: false },
        { id: "b", title: "Beta", completed: true },
    ];
    assert.deepEqual(activeTasks(tasks), [tasks[0]]);
});

test("completes only the matching task without mutation", () => {
    const tasks = [
        { id: "a", title: "Alpha", completed: false },
        { id: "b", title: "Beta", completed: false },
    ];
    const result = completeTask(tasks, "b");

    assert.notStrictEqual(result, tasks);
    assert.strictEqual(result[0], tasks[0]);
    assert.notStrictEqual(result[1], tasks[1]);
    assert.equal(result[1].completed, true);
    assert.equal(tasks[1].completed, false);
});
