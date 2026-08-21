import assert from "node:assert/strict";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const { completeTask } = await import(pathToFileURL(resolve("src/tasks.js")).href);

const tasks = [
    { id: "a", title: "Alpha", completed: false },
    { id: "b", title: "Beta", completed: false },
];
const result = completeTask(tasks, "b");

assert.notStrictEqual(result, tasks);
assert.deepEqual(result, [
    tasks[0],
    { id: "b", title: "Beta", completed: true },
]);
assert.strictEqual(result[0], tasks[0]);
assert.notStrictEqual(result[1], tasks[1]);
assert.deepEqual(tasks, [
    { id: "a", title: "Alpha", completed: false },
    { id: "b", title: "Beta", completed: false },
]);
assert.throws(() => completeTask(tasks, "missing"), {
    name: "Error",
    message: "Unknown task: missing",
});
