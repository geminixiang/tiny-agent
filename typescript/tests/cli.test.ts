import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { access, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { startTestMcpServer } from "./support/mcp-server.js";

const cli = resolve("src/cli.ts"),
    loader = resolve("node_modules/tsx/dist/loader.mjs");
const jsonLifecycleContract = JSON.parse(
    await readFile(new URL("../../schemas/monitoring/execution-lifecycle-contract.json", import.meta.url), "utf8"),
);

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
    assert.deepEqual(
        events.map((event) => event.type),
        [
            "startup.started",
            "session.attached",
            "startup.completed",
            "operation.started",
            "model.started",
            "model.completed",
            "operation.completed",
        ],
    );
    assert.deepEqual(events[0].plugins, ["bash", "read", "write", "edit", "bg"]);
    assert.equal(events[5].outcome, "failed");
    assert.equal(events[5].errorType, "model_error");
    assert.equal(events[6].outcome, "failed");
    assert.equal(events[6].errorType, "model_error");
    assert.equal(events[6].errorMessage, "Set OPENROUTER_API_KEY");
    assert.doesNotMatch(result.stdout, /tiny-agent|Resume:|\\u001b/);
});

test("exports one-shot lifecycle spans through the official OTLP HTTP exporter", async (t) => {
    const workspace = await mkdtemp(join(tmpdir(), "tiny-agent-cli-"));
    let requestPath = "";
    let contentType = "";
    let bodyBytes = 0;
    let resolveReceived: () => void = () => {};
    const received = new Promise<void>((resolve) => (resolveReceived = resolve));
    const server = createServer((request, response) => {
        requestPath = request.url ?? "";
        contentType = String(request.headers["content-type"] ?? "");
        request.on("data", (chunk) => (bodyBytes += chunk.length));
        request.on("end", () => {
            response.writeHead(200).end();
            resolveReceived();
        });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    t.after(() => server.close());
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("OTLP fixture did not bind TCP");

    const result = await spawnCli(["--json", "hello"], workspace, {
        ...envWithoutKey(),
        OTEL_EXPORTER_OTLP_ENDPOINT: `http://127.0.0.1:${address.port}`,
    });
    await received;

    assert.equal(result.status, 1);
    assert.equal(result.stderr, "");
    assert.equal(requestPath, "/v1/traces");
    assert.match(contentType, /^application\/x-protobuf/);
    assert.ok(bodyBytes > 0);
});

test("--json matches the TypeScript reference lifecycle contract", async (t) => {
    const workspace = await mkdtemp(join(tmpdir(), "tiny-agent-cli-"));
    await writeFile(join(workspace, "contract-read.txt"), "fixture");
    const responses = [...jsonLifecycleContract.responses];
    const server = createServer((_request, response) => {
        response.setHeader("Content-Type", "application/json");
        response.end(JSON.stringify(responses.shift()));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    t.after(() => server.close());
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("mock server did not bind TCP");
    const result = await spawnCli(["--json", "--plugin", "read", jsonLifecycleContract.prompt], workspace, {
        ...process.env,
        OPENROUTER_API_KEY: "test",
        TINY_MODEL: jsonLifecycleContract.model,
        TINY_ENDPOINT: `http://127.0.0.1:${address.port}`,
    });
    assert.equal(result.status, 0);
    assert.equal(result.stderr, "");
    const events = result.stdout
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
    assertJsonLifecycle(events);
});

test("--cwd uses the selected workspace for sessions", async () => {
    const launcher = await mkdtemp(join(tmpdir(), "tiny-agent-launcher-"));
    const workspace = await mkdtemp(join(tmpdir(), "tiny-agent-workspace-"));
    const result = spawnSync(process.execPath, ["--import", loader, cli, "--cwd", workspace, "--json", "hello"], {
        cwd: launcher,
        env: envWithoutKey(),
        encoding: "utf8",
    });
    assert.equal(result.status, 1);
    assert.equal((await readdir(join(workspace, ".tiny-agent/sessions"))).length, 1);
    await assert.rejects(readdir(join(launcher, ".tiny-agent/sessions")));
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
        [
            "startup.started",
            "session.attached",
            "mcp.started",
            "mcp.completed",
            "startup.completed",
            "operation.started",
            "model.started",
            "model.completed",
            "operation.completed",
        ],
    );
    assert.deepEqual(events[0].plugins, ["read"]);
    assert.deepEqual(events[0].mcp, ["fixture"]);
    assert.equal(events[3].server, "fixture");
    assert.equal(events[3].toolCount, 1);
    assert.equal(events[3].outcome, "succeeded");
    assert.equal(events[8].outcome, "failed");
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

test("--json emits a startup terminal when trusted MCP configuration is invalid", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "tiny-agent-cli-"));
    const catalog = join(workspace, "mcp.json");
    await writeFile(catalog, JSON.stringify({ servers: {} }));
    const result = await spawnCli(["--json", "--mcp", "missing", "hello"], workspace, {
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
        ["startup.started", "startup.completed"],
    );
    assert.equal(events[1].outcome, "failed");
    assert.equal(events[1].errorType, "startup_setup_error");
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
        ["startup.started", "session.attached", "mcp.started", "mcp.completed", "startup.completed"],
    );
    assert.equal(events[3].outcome, "failed");
    assert.equal(events[3].errorType, "connection_failed");
    assert.equal(events[4].outcome, "failed");
    assert.equal(events[4].errorType, "mcp_setup_error");
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

function assertJsonLifecycle(events: Record<string, unknown>[]) {
    assert.deepEqual(
        events.map((event) => event.type),
        jsonLifecycleContract.events.map((event: { type: string }) => event.type),
    );
    for (const [index, expected] of jsonLifecycleContract.events.entries()) {
        const actual = events[index];
        for (const key of expected.required) assert.ok(Object.hasOwn(actual, key), `${expected.type}.${key}`);
        for (const [key, value] of Object.entries(expected)) {
            if (key === "type" || key === "required") continue;
            assert.deepEqual(actual[key], value, `${expected.type}.${key}`);
        }
        if ("durationMs" in actual) assert.ok(typeof actual.durationMs === "number" && actual.durationMs >= 0);
        assert.match(String(actual.timestamp), /^\d{4}-\d{2}-\d{2}T/);
    }
    assert.equal(events[0].model, jsonLifecycleContract.model);
    assert.deepEqual(events[0].plugins, jsonLifecycleContract.plugins);
    assert.deepEqual(events[0].mcp, []);
}

function escapeRegex(value: string) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
