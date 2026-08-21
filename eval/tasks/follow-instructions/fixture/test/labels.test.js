import test from "node:test";
import assert from "node:assert/strict";
import { normalizeLabel } from "../src/labels.js";

test("normalizes a label", () => {
    assert.equal(normalizeLabel("  hello   tiny agent  "), "tiny:HELLO TINY AGENT");
});
