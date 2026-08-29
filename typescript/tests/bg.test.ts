import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const cwd = await mkdtemp(join(tmpdir(), "tiny-bg-"));
process.chdir(cwd);
const { closeBackgroundProcesses, executeTool } = await import("../src/index.js");

function resultMeta(result: string) {
    return JSON.parse(result.split("\n", 1)[0]);
}

test("bg manages lifecycle, logs, fast failures, and stale metadata", async () => {
    await writeFile("server.mjs", 'console.log("ready"); setInterval(() => console.log("tick"), 100);\n');
    const started = resultMeta(await executeTool("bg", { action: "start", command: "node server.mjs" }));
    assert.equal(started.id, String(started.pid));
    assert.equal(started.status, "running");
    assert.ok(started.processStartedAt);

    await new Promise((resolve) => setTimeout(resolve, 250));
    assert.match(await executeTool("bg", { action: "logs", id: started.id, tail: 5 }), /tick/);
    assert.ok(JSON.parse(await executeTool("bg", { action: "list" })).some((meta: any) => meta.id === started.id));

    const metaPath = join(cwd, ".tiny-agent/bg", `${started.id}.json`);
    const original = JSON.parse(await readFile(metaPath, "utf8"));
    await writeFile(metaPath, `${JSON.stringify({ ...original, processStartedAt: "different process" }, null, 2)}\n`);
    assert.equal(resultMeta(await executeTool("bg", { action: "stop", id: started.id })).status, "stale");
    process.kill(started.pid, 0);

    await writeFile(metaPath, `${JSON.stringify(original, null, 2)}\n`);
    assert.equal(resultMeta(await executeTool("bg", { action: "stop", id: started.id })).status, "stopped");

    const failed = await executeTool("bg", { action: "start", command: "echo boom >&2; exit 7" });
    const failedMeta = resultMeta(failed);
    assert.equal(failedMeta.status, "exited");
    assert.equal(failedMeta.exitCode, 7);
    assert.match(failed, /boom/);
    await closeBackgroundProcesses();
});
