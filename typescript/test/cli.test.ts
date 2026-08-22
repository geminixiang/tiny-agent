import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { access, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { startTestMcpServer } from "./support/mcp-server.js";

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

test("prints selected tools and MCP servers at startup", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "tiny-agent-cli-"));
    const result = spawnSync(process.execPath, ["--import", loader, cli, "--plugin", "read", "hello"], {
        cwd: workspace,
        env: envWithoutKey(),
        encoding: "utf8",
    });
    assert.equal(result.status, 1);
    assert.match(result.stdout, /tools: read\nmcp: \(none\)/);
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

test("--mcp connects trusted aliases, deduplicates them, and closes before exit", async (t) => {
    const workspace = await mkdtemp(join(tmpdir(), "tiny-agent-cli-"));
    const server = await startTestMcpServer();
    const catalog = join(workspace, "mcp.json");
    const secret = "mcp-test-secret";
    t.after(() => server.close());
    await writeFile(
        catalog,
        JSON.stringify({
            servers: {
                fixture: {
                    url: server.url,
                    tokenEnv: "MCP_TEST_TOKEN",
                    allowedTools: ["echo"],
                },
            },
        }),
    );
    const result = await spawnCli(
        ["--json", "--plugin", "read", "--mcp", "fixture, fixture", "--mcp", "fixture", "hello"],
        workspace,
        {
            ...envWithoutKey(),
            TINY_MCP_CONFIG: catalog,
            MCP_TEST_TOKEN: secret,
        },
    );
    assert.equal(result.status, 1);
    assert.equal(result.stderr, "");
    const events = result.stdout
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
    assert.deepEqual(
        events.map((event) => event.type),
        ["run.started", "mcp.connected", "run.completed"],
    );
    assert.deepEqual(events[0].plugins, ["read"]);
    assert.deepEqual(events[0].mcp, ["fixture"]);
    assert.equal(events[1].server, "fixture");
    assert.equal(events[1].protocolEra, "modern");
    assert.equal(events[1].toolCount, 1);
    assert.equal(events[2].result.message, "Set OPENROUTER_API_KEY");
    assert.doesNotMatch(result.stdout + result.stderr, new RegExp(`${secret}|${escapeRegex(server.url.href)}`));
});

test("--mcp rejects unknown aliases before creating a session", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "tiny-agent-cli-"));
    const catalog = join(workspace, "mcp.json");
    await writeFile(catalog, JSON.stringify({ servers: {} }));
    const result = await spawnCli(["--mcp", "missing", "hello"], workspace, {
        ...envWithoutKey(),
        TINY_MCP_CONFIG: catalog,
    });
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /^Unknown MCP server: missing/);
    await assert.rejects(() => access(join(workspace, ".tiny-agent")));
});

test("--mcp emits a complete JSON run when connection fails", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "tiny-agent-cli-"));
    const catalog = join(workspace, "mcp.json");
    await writeFile(catalog, JSON.stringify({ servers: { down: { url: "http://127.0.0.1:1/mcp" } } }));
    const result = await spawnCli(["--json", "--mcp", "down", "hello"], workspace, {
        ...envWithoutKey(),
        TINY_MCP_CONFIG: catalog,
    });
    assert.equal(result.status, 1);
    assert.equal(result.stderr, "");
    const events = result.stdout
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
    assert.deepEqual(
        events.map((event) => event.type),
        ["run.started", "mcp.failed", "run.completed"],
    );
    assert.equal(events[2].result.cause, "mcp_setup_error");
    assert.doesNotMatch(result.stdout, /127\.0\.0\.1|ECONNREFUSED/);
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

function spawnCli(args: string[], cwd: string, env: NodeJS.ProcessEnv) {
    return new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve, reject) => {
        const child = spawn(process.execPath, ["--import", loader, cli, ...args], { cwd, env });
        const timer = setTimeout(() => {
            child.kill("SIGKILL");
            reject(new Error("tiny-ts subprocess timed out"));
        }, 5_000);
        let stdout = "",
            stderr = "";
        child.stdout.setEncoding("utf8").on("data", (chunk) => (stdout += chunk));
        child.stderr.setEncoding("utf8").on("data", (chunk) => (stderr += chunk));
        child.on("error", (error) => {
            clearTimeout(timer);
            reject(error);
        });
        child.on("close", (status) => {
            clearTimeout(timer);
            resolve({ status, stdout, stderr });
        });
    });
}

function escapeRegex(value: string) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
