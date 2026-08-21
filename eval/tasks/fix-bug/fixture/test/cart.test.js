import test from "node:test";
import assert from "node:assert/strict";
import { total } from "../src/cart.js";

test("totals regular items", () => {
    assert.equal(total([{ price: 10, quantity: 2 }]), 20);
});

test("applies each item's percentage discount", () => {
    assert.equal(
        total([
            { price: 100, quantity: 2, discount: 0.1 },
            { price: 25, quantity: 1, discount: 0.2 },
        ]),
        200,
    );
});

test("treats a missing discount as zero", () => {
    assert.equal(
        total([
            { price: 5, quantity: 3 },
            { price: 10, quantity: 1, discount: 0.5 },
        ]),
        20,
    );
});
