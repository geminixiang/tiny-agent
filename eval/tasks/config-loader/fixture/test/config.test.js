import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadConfig } from "../src/config.js";

async function writeJson(value) {
    const dir = await mkdtemp(join(tmpdir(), "config-test-"));
    const path = join(dir, "app.json");
    await writeFile(path, JSON.stringify(value), "utf8");
    return path;
}

test("merges file values with defaults", async () => {
    const path = await writeJson({ port: 8080 });
    assert.deepEqual(await loadConfig(path, {}), {
        port: 8080,
        host: "127.0.0.1",
        features: [],
    });
});

test("environment values override and parse file values", async () => {
    const path = await writeJson({ port: 8080, host: "0.0.0.0", features: ["file"] });
    const config = await loadConfig(path, {
        APP_PORT: "4321",
        APP_HOST: "localhost",
        APP_FEATURES: " alpha, beta ,, gamma ",
    });
    assert.deepEqual(config, {
        port: 4321,
        host: "localhost",
        features: ["alpha", "beta", "gamma"],
    });
});

test("rejects non-string feature entries", async () => {
    const path = await writeJson({ features: ["ok", 3] });
    await assert.rejects(() => loadConfig(path, {}), /features/i);
});
