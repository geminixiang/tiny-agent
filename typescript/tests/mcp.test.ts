import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { displayToolName, loadMcpTools, type McpConfig } from "../src/mcp.js";
import { startLegacyTestMcpServer } from "./support/legacy-mcp-server.js";
import { startTestMcpServer } from "./support/mcp-server.js";

test("displays encoded MCP tool names for humans", () => {
    assert.equal(displayToolName("mcp__Y29tcGxleA__YW5hbHl6ZV9kYXRh"), "mcp:complex/analyze_data");
    assert.equal(displayToolName("read"), "read");
    assert.equal(displayToolName("mcp__invalid"), "mcp__invalid");
});

test("official MCP v2 client lists and calls local Streamable HTTP tools", async (t) => {
    const server = await startTestMcpServer();
    const client = new Client(
        { name: "tiny-agent-test", version: "1.0.0" },
        { versionNegotiation: { mode: { pin: "2026-07-28" } } },
    );
    t.after(async () => {
        await client.close();
        await server.close();
    });
    await client.connect(new StreamableHTTPClientTransport(server.url));
    assert.equal(client.getProtocolEra(), "modern");
    assert.equal(client.getNegotiatedProtocolVersion(), "2026-07-28");

    const listed = await client.listTools();
    assert.deepEqual(
        listed.tools.map((tool) => tool.name),
        ["echo", "structured_result", "fail", "slow"],
    );
    assert.deepEqual(listed.tools[0].inputSchema, {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        type: "object",
        properties: { message: { type: "string" } },
        required: ["message"],
    });

    const echo = await client.callTool({ name: "echo", arguments: { message: "hello" } });
    assert.deepEqual(echo.content, [{ type: "text", text: "hello" }]);

    const structured = await client.callTool({ name: "structured_result", arguments: { query: "revenue" } });
    assert.deepEqual(structured.content, [{ type: "text", text: "revenue: 2" }]);
    assert.deepEqual(structured.structuredContent, { query: "revenue", count: 2 });

    const failed = await client.callTool({ name: "fail", arguments: { message: "not found" } });
    assert.equal(failed.isError, true);
    assert.deepEqual(failed.content, [{ type: "text", text: "not found" }]);
});

test("official MCP v2 client cancels slow calls at the server and remains usable", async (t) => {
    const server = await startTestMcpServer();
    const client = new Client(
        { name: "tiny-agent-test", version: "1.0.0" },
        { versionNegotiation: { mode: { pin: "2026-07-28" } } },
    );
    t.after(async () => {
        await client.close();
        await server.close();
    });
    await client.connect(new StreamableHTTPClientTransport(server.url));

    const controller = new AbortController();
    setTimeout(() => controller.abort(), 20);
    await assert.rejects(
        () => client.callTool({ name: "slow", arguments: { delayMs: 1_000 } }, { signal: controller.signal }),
        /abort/i,
    );
    await assert.rejects(
        () => client.callTool({ name: "slow", arguments: { delayMs: 1_000 } }, { timeout: 20 }),
        /timed out|timeout/i,
    );
    await waitFor(() => server.slowCalls.aborted === 2);
    assert.deepEqual(server.slowCalls, { started: 2, aborted: 2, completed: 0 });

    const recovered = await client.callTool({ name: "echo", arguments: { message: "still alive" } });
    assert.deepEqual(recovered.content, [{ type: "text", text: "still alive" }]);
});

test("loadMcpTools auto-negotiates a stateful legacy server", async (t) => {
    const server = await startLegacyTestMcpServer();
    t.after(async () => server.close());
    const loaded = await loadMcpTools(
        mcpConfig("legacy", server.url, {
            headers: { "X-API-Key": "fixture-secret" },
            allowedTools: ["echo"],
        }),
    );
    t.after(async () => loaded.close());
    assert.equal(loaded.protocolVersion, "2025-03-26");
    assert.equal(await loaded.tools[0].execute({ message: "hello" }), "hello");
    await loaded.close();
    assert.deepEqual(server.methods, [
        "server/discover",
        "initialize",
        "notifications/initialized",
        "tools/list",
        "tools/call",
    ]);
    assert.equal(server.authenticated, true);
    assert.ok(server.sessionHeaders >= 3);
    assert.equal(server.deleted, true);
    assert.ok(loaded.tools[0].definitionIdentity);
    assert.doesNotMatch(loaded.tools[0].definitionIdentity!, /fixture-secret|127\.0\.0\.1/);
});

test("loadMcpTools maps and calls local MCP tools", async (t) => {
    const server = await startTestMcpServer();
    const loaded = await loadMcpTools(mcpConfig("fixture", server.url));
    t.after(async () => {
        await loaded.close();
        await server.close();
    });

    assert.equal(loaded.protocolVersion, "2026-07-28");
    assert.deepEqual(
        loaded.tools.map((tool) => tool.name),
        ["echo", "structured_result", "fail", "slow"].map(
            (name) =>
                `mcp__${Buffer.from("fixture").toString("base64url")}__${Buffer.from(name).toString("base64url")}`,
        ),
    );
    assert.equal(loaded.tools[0].description, "Return the supplied message.");
    assert.deepEqual(loaded.tools[0].parameters, {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        type: "object",
        properties: { message: { type: "string" } },
        required: ["message"],
    });
    assert.equal(await loaded.tools[0].execute({ message: "hello" }), "hello");
    assert.equal(
        await loaded.tools[1].execute({ query: "revenue" }),
        'revenue: 2\n\nStructured content:\n{"query":"revenue","count":2}',
    );
    await assert.rejects(() => loaded.tools[2].execute({ message: "not found" }), /MCP tool error: not found/);
    await assert.rejects(() => loaded.tools[0].execute(null as never), /arguments must be a JSON object/);

    await loaded.close();
    await loaded.close();
    await assert.rejects(() => loaded.tools[0].execute({ message: "hello" }), /MCP connection is closed/);
});

test("loadMcpTools filters tools and propagates cancellation", async (t) => {
    const server = await startTestMcpServer();
    const loaded = await loadMcpTools(
        mcpConfig("fixture", server.url, { allowedTools: ["slow"], callTimeoutMs: 1_000 }),
    );
    t.after(async () => {
        await loaded.close();
        await server.close();
    });
    assert.equal(loaded.tools.length, 1);

    const controller = new AbortController();
    setTimeout(() => controller.abort(), 20);
    await assert.rejects(() => loaded.tools[0].execute({ delayMs: 1_000 }, controller.signal), /abort/i);
    await waitFor(() => server.slowCalls.aborted === 1);
});

test("loadMcpTools rejects redirects before forwarding credentials", async (t) => {
    let leaked = false;
    const target = createServer((request, response) => {
        leaked = request.headers["x-api-key"] !== undefined || request.headers.authorization !== undefined;
        response.writeHead(500).end();
    });
    target.listen(0, "127.0.0.1");
    await once(target, "listening");
    t.after(() => target.close());

    const targetPort = (target.address() as AddressInfo).port;
    const redirector = createServer((_request, response) => {
        response.writeHead(307, { Location: `http://127.0.0.1:${targetPort}/mcp` }).end();
    });
    redirector.listen(0, "127.0.0.1");
    await once(redirector, "listening");
    t.after(() => redirector.close());

    const port = (redirector.address() as AddressInfo).port;
    await assert.rejects(() =>
        loadMcpTools(
            mcpConfig("fixture", `http://127.0.0.1:${port}/mcp`, {
                headers: { "X-API-Key": "secret" },
            }),
        ),
    );
    assert.equal(leaked, false);
});

test("loadMcpTools rejects missing allowed tools", async () => {
    const server = await startTestMcpServer();
    await assert.rejects(
        () => loadMcpTools(mcpConfig("fixture", server.url, { allowedTools: ["missing"] })),
        /allowed tools were not found: missing/,
    );
    await server.close();
});

test("loadMcpTools closes partial startup when discovered names cannot be mapped", async () => {
    const server = await startTestMcpServer({ longToolName: true });
    await assert.rejects(
        () => loadMcpTools(mcpConfig("fixture", server.url)),
        /mapped MCP tool name exceeds 64 characters/,
    );
    await server.close();
});

test("loadMcpTools normalizes embedded text resources and rejects binary content", async () => {
    const resource = await startTestMcpServer({ resourceContent: true });
    const loaded = await loadMcpTools(mcpConfig("fixture", resource.url, { allowedTools: ["resource"] }));
    assert.equal(await loaded.tools[0].execute({}), "Resource: file:///README.md\n# tiny-agent");
    await loaded.close();
    await resource.close();

    const unsupported = await startTestMcpServer({ unsupportedContent: true });
    const unsupportedLoaded = await loadMcpTools(mcpConfig("fixture", unsupported.url, { allowedTools: ["image"] }));
    await assert.rejects(() => unsupportedLoaded.tools[0].execute({}), /Unsupported MCP content type: image/);
    await unsupportedLoaded.close();
    await unsupported.close();
});

test("loadMcpTools rejects oversized discovery", async () => {
    const largeSchema = await startTestMcpServer({ largeSchema: true });
    await assert.rejects(() => loadMcpTools(mcpConfig("fixture", largeSchema.url)), /schema exceeds 50KB/);
    await largeSchema.close();

    const tooMany = await startTestMcpServer({ tooManyTools: true });
    await assert.rejects(() => loadMcpTools(mcpConfig("fixture", tooMany.url)), /more than 64 tools/);
    await tooMany.close();
});

test("loadMcpTools bounds large UTF-8 results", async (t) => {
    const server = await startTestMcpServer({ largeResult: true });
    const loaded = await loadMcpTools(mcpConfig("fixture", server.url, { allowedTools: ["large"] }));
    t.after(async () => {
        await loaded.close();
        await server.close();
    });
    const result = await loaded.tools[0].execute({});
    assert.ok(Buffer.byteLength(result) <= 50 * 1024);
    assert.match(result, /MCP result truncated to 50KB/);
    assert.doesNotMatch(result, /�/);
});

function mcpConfig(alias: string, url: string | URL, overrides: Partial<McpConfig> = {}): McpConfig {
    return { alias, url: new URL(url), callTimeoutMs: 30_000, ...overrides };
}

async function waitFor(predicate: () => boolean) {
    const deadline = Date.now() + 1_000;
    while (!predicate()) {
        if (Date.now() >= deadline) throw new Error("Timed out waiting for MCP server state");
        await new Promise((resolve) => setTimeout(resolve, 5));
    }
}
