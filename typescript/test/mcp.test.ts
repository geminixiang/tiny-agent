import assert from "node:assert/strict";
import test from "node:test";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { displayToolName, loadMcpTools } from "../src/mcp.js";
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

test("loadMcpTools maps and calls local MCP tools", async (t) => {
    const server = await startTestMcpServer();
    const loaded = await loadMcpTools({ alias: "fixture", url: server.url });
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
    const loaded = await loadMcpTools({
        alias: "fixture",
        url: server.url,
        allowedTools: ["slow"],
        callTimeoutMs: 1_000,
    });
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

test("loadMcpTools validates trusted config before network access", async () => {
    const unreachable = "http://127.0.0.1:1/mcp";
    await assert.rejects(() => loadMcpTools({ alias: "", url: unreachable }), /alias/);
    await assert.rejects(() => loadMcpTools({ alias: "fixture", url: "file:///tmp/mcp" }), /use HTTPS/);
    await assert.rejects(() => loadMcpTools({ alias: "fixture", url: "http://example.com/mcp" }), /use HTTPS/);
    await assert.rejects(() => loadMcpTools({ alias: "fixture", url: unreachable, callTimeoutMs: 0 }), /callTimeoutMs/);
    await assert.rejects(
        () => loadMcpTools({ alias: "fixture", url: unreachable, allowedTools: ["echo", "echo"] }),
        /must not contain duplicates/,
    );
    await assert.rejects(
        () => loadMcpTools({ alias: "fixture", url: unreachable, unexpected: true } as never),
        /Unknown MCP config field: unexpected/,
    );
    await assert.rejects(
        () => loadMcpTools({ alias: "fixture", url: unreachable, headers: { "bad header": "value" } }),
        /invalid name or value/,
    );
});

test("loadMcpTools rejects missing allowed tools", async () => {
    const server = await startTestMcpServer();
    await assert.rejects(
        () => loadMcpTools({ alias: "fixture", url: server.url, allowedTools: ["missing"] }),
        /allowed tools were not found: missing/,
    );
    await server.close();
});

test("loadMcpTools closes partial startup when discovered names cannot be mapped", async () => {
    const server = await startTestMcpServer({ longToolName: true });
    await assert.rejects(
        () => loadMcpTools({ alias: "fixture", url: server.url }),
        /mapped MCP tool name exceeds 64 characters/,
    );
    await server.close();
});

test("loadMcpTools normalizes embedded text resources and rejects binary content", async () => {
    const resource = await startTestMcpServer({ resourceContent: true });
    const loaded = await loadMcpTools({ alias: "fixture", url: resource.url, allowedTools: ["resource"] });
    assert.equal(await loaded.tools[0].execute({}), "Resource: file:///README.md\n# tiny-agent");
    await loaded.close();
    await resource.close();

    const unsupported = await startTestMcpServer({ unsupportedContent: true });
    const unsupportedLoaded = await loadMcpTools({
        alias: "fixture",
        url: unsupported.url,
        allowedTools: ["image"],
    });
    await assert.rejects(() => unsupportedLoaded.tools[0].execute({}), /Unsupported MCP content type: image/);
    await unsupportedLoaded.close();
    await unsupported.close();
});

test("loadMcpTools rejects oversized discovery", async () => {
    const largeSchema = await startTestMcpServer({ largeSchema: true });
    await assert.rejects(() => loadMcpTools({ alias: "fixture", url: largeSchema.url }), /schema exceeds 50KB/);
    await largeSchema.close();

    const tooMany = await startTestMcpServer({ tooManyTools: true });
    await assert.rejects(() => loadMcpTools({ alias: "fixture", url: tooMany.url }), /more than 64 tools/);
    await tooMany.close();
});

test("loadMcpTools bounds large UTF-8 results", async (t) => {
    const server = await startTestMcpServer({ largeResult: true });
    const loaded = await loadMcpTools({ alias: "fixture", url: server.url, allowedTools: ["large"] });
    t.after(async () => {
        await loaded.close();
        await server.close();
    });
    const result = await loaded.tools[0].execute({});
    assert.ok(Buffer.byteLength(result) <= 50 * 1024);
    assert.match(result, /MCP result truncated to 50KB/);
    assert.doesNotMatch(result, /�/);
});

async function waitFor(predicate: () => boolean) {
    const deadline = Date.now() + 1_000;
    while (!predicate()) {
        if (Date.now() >= deadline) throw new Error("Timed out waiting for MCP server state");
        await new Promise((resolve) => setTimeout(resolve, 5));
    }
}
