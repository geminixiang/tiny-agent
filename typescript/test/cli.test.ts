import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { access, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

const cli = resolve("src/cli.ts"),
    loader = resolve("node_modules/tsx/dist/loader.mjs");

function envWithoutKey() {
    const env = { ...process.env };
    delete env.OPENROUTER_API_KEY;
    return env;
}

test("--json emits a structured failed result without TUI output", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "tiny-agent-cli-"));
    const result = spawnSync(process.execPath, ["--import", loader, cli, "--json", "hello"], {
        cwd: workspace,
        env: envWithoutKey(),
        encoding: "utf8",
    });
    assert.equal(result.status, 1);
    assert.equal(result.stderr, "");
    const events = result.stdout
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
    assert.equal(events.length, 2);
    assert.equal(events[0].type, "run.started");
    assert.deepEqual(events[0].plugins, ["bash", "read", "write", "edit"]);
    assert.equal(events[1].type, "run.completed");
    assert.deepEqual(
        {
            status: events[1].result.status,
            cause: events[1].result.cause,
            message: events[1].result.message,
        },
        { status: "failed", cause: "agent_error", message: "Set OPENROUTER_API_KEY" },
    );
    assert.doesNotMatch(result.stdout, /tiny-agent|Resume:|\\u001b/);
});

test("--plugin selects and deduplicates trusted plugins", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "tiny-agent-cli-"));
    const result = spawnSync(
        process.execPath,
        ["--import", loader, cli, "--json", "--plugin", "read, edit", "--plugin", "read", "hello"],
        { cwd: workspace, env: envWithoutKey(), encoding: "utf8" },
    );
    assert.equal(result.status, 1);
    const events = result.stdout
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
    assert.deepEqual(events[0].plugins, ["read", "edit"]);
});

test("--plugin rejects unknown plugins before creating a session", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "tiny-agent-cli-"));
    const result = spawnSync(process.execPath, ["--import", loader, cli, "--plugin", "missing", "hello"], {
        cwd: workspace,
        env: envWithoutKey(),
        encoding: "utf8",
    });
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /^Unknown plugin: missing\. Available plugins: bash, read, write, edit/);
    await assert.rejects(() => access(join(workspace, ".tiny-agent")));
});

test("--json requires a one-shot prompt", () => {
    const result = spawnSync(process.execPath, ["--import", loader, cli, "--json"], {
        env: envWithoutKey(),
        encoding: "utf8",
    });
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /^--json requires a one-shot prompt\./);
});
