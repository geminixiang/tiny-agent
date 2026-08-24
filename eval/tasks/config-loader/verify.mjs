import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const { loadConfig } = await import(pathToFileURL(resolve("src/config.js")).href);

async function writeJson(value) {
    const dir = await mkdtemp(join(tmpdir(), "config-verify-"));
    const path = join(dir, "app.json");
    await writeFile(path, JSON.stringify(value), "utf8");
    return path;
}

const merged = await loadConfig(await writeJson({ features: ["file"] }), {
    APP_PORT: "4321",
    APP_HOST: "example.local",
    APP_FEATURES: " alpha, beta ,,gamma ",
});
assert.deepEqual(merged, {
    port: 4321,
    host: "example.local",
    features: ["alpha", "beta", "gamma"],
});

assert.deepEqual(await loadConfig(await writeJson({}), {}), {
    port: 3000,
    host: "127.0.0.1",
    features: [],
});

await assert.rejects(async () => loadConfig(await writeJson({ port: 0 }), {}), /port/i);
await assert.rejects(async () => loadConfig(await writeJson({ host: "" }), {}), /host/i);
await assert.rejects(async () => loadConfig(await writeJson({ features: ["ok", 3] }), {}), /features/i);
await assert.rejects(async () => loadConfig(await writeJson({}), { APP_PORT: "abc" }), /port/i);
