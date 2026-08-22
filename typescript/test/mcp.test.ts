import assert from "node:assert/strict";
import test from "node:test";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { startTestMcpServer } from "./support/mcp-server.js";

test("official MCP v2 client lists and calls local Streamable HTTP tools", async (t) => {
    const server = await startTestMcpServer();
    const client = new Client({ name: "tiny-agent-test", version: "1.0.0" }, { versionNegotiation: { mode: "auto" } });
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
    const client = new Client({ name: "tiny-agent-test", version: "1.0.0" }, { versionNegotiation: { mode: "auto" } });
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

async function waitFor(predicate: () => boolean) {
    const deadline = Date.now() + 1_000;
    while (!predicate()) {
        if (Date.now() >= deadline) throw new Error("Timed out waiting for MCP server state");
        await new Promise((resolve) => setTimeout(resolve, 5));
    }
}
