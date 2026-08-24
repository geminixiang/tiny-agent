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

test("environment host overrides the file host", async () => {
    const path = await writeJson({ host: "0.0.0.0" });
    const config = await loadConfig(path, { APP_HOST: "localhost" });
    assert.equal(config.host, "localhost");
});
