import assert from "node:assert/strict";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const { normalizeLabel } = await import(pathToFileURL(resolve("src/labels.js")).href);

assert.equal(normalizeLabel(" one\ttwo\nthree "), "tiny:ONE TWO THREE");
assert.equal(normalizeLabel("already"), "tiny:ALREADY");
assert.equal(normalizeLabel("  \t "), "tiny:");
assert.throws(() => normalizeLabel(42), {
    name: "TypeError",
    message: "Label must be a string",
});
