import { createServer, type Server } from "node:http";
import { once } from "node:events";
import { toNodeHandler } from "@modelcontextprotocol/node";
import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

export type TestMcpServer = {
    url: URL;
    slowCalls: {
        started: number;
        aborted: number;
        completed: number;
    };
    close(): Promise<void>;
};

export async function startTestMcpServer(
    options: {
        longToolName?: boolean;
        largeResult?: boolean;
        largeSchema?: boolean;
        tooManyTools?: boolean;
        unsupportedContent?: boolean;
        resourceContent?: boolean;
    } = {},
): Promise<TestMcpServer> {
    const slowCalls = { started: 0, aborted: 0, completed: 0 };
    const handler = createMcpHandler(() => {
        const server = new McpServer({ name: "tiny-agent-test", version: "1.0.0" });

        server.registerTool(
            "echo",
            {
                description: "Return the supplied message.",
                inputSchema: z.object({ message: z.string() }),
            },
            async ({ message }) => ({ content: [{ type: "text", text: message }] }),
        );
        server.registerTool(
            "structured_result",
            {
                description: "Return text and structured content.",
                inputSchema: z.object({ query: z.string() }),
                outputSchema: z.object({ query: z.string(), count: z.number() }),
            },
            async ({ query }) => {
                const output = { query, count: 2 };
                return {
                    content: [{ type: "text", text: `${query}: 2` }],
                    structuredContent: output,
                };
            },
        );
        server.registerTool(
            "fail",
            {
                description: "Return an MCP tool error.",
                inputSchema: z.object({ message: z.string() }),
            },
            async ({ message }) => ({ content: [{ type: "text", text: message }], isError: true }),
        );
        server.registerTool(
            "slow",
            {
                description: "Wait until the delay expires or the request is aborted.",
                inputSchema: z.object({ delayMs: z.number().int().positive() }),
            },
            async ({ delayMs }, context) => {
                slowCalls.started++;
                try {
                    await delay(delayMs, context.mcpReq.signal);
                    slowCalls.completed++;
                    return { content: [{ type: "text", text: "finished" }] };
                } catch (error) {
                    if (context.mcpReq.signal.aborted) slowCalls.aborted++;
                    throw error;
                }
            },
        );
        if (options.longToolName) {
            server.registerTool(
                "tool_" + "x".repeat(60),
                { description: "Tool with a name too long to map.", inputSchema: z.object({}) },
                async () => ({ content: [{ type: "text", text: "unused" }] }),
            );
        }
        if (options.largeResult) {
            server.registerTool(
                "large",
                { description: "Return a large result.", inputSchema: z.object({}) },
                async () => ({ content: [{ type: "text", text: "你".repeat(30_000) }] }),
            );
        }
        if (options.largeSchema) {
            const properties = Object.fromEntries(
                Array.from({ length: 1_000 }, (_, index) => [`field_${index}`, z.string().describe("x".repeat(80))]),
            );
            server.registerTool(
                "large_schema",
                { description: "Expose a large schema.", inputSchema: z.object(properties) },
                async () => ({ content: [{ type: "text", text: "unused" }] }),
            );
        }
        if (options.tooManyTools) {
            for (let index = 0; index < 65; index++) {
                server.registerTool(
                    `extra_${index}`,
                    { description: "Extra tool.", inputSchema: z.object({}) },
                    async () => ({ content: [{ type: "text", text: "unused" }] }),
                );
            }
        }
        if (options.resourceContent) {
            server.registerTool(
                "resource",
                { description: "Return embedded text resource content.", inputSchema: z.object({}) },
                async () =>
                    ({
                        content: [
                            {
                                type: "resource",
                                resource: {
                                    uri: "file:///README.md",
                                    mimeType: "text/markdown",
                                    text: "# tiny-agent",
                                },
                            },
                        ],
                    }) as never,
            );
        }
        if (options.unsupportedContent) {
            server.registerTool(
                "image",
                { description: "Return unsupported image content.", inputSchema: z.object({}) },
                async () => ({ content: [{ type: "image", data: "AA==", mimeType: "image/png" }] }),
            );
        }
        return server;
    });
    const server = createServer(toNodeHandler(handler));
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("MCP test server did not bind a TCP port");

    return {
        url: new URL(`http://127.0.0.1:${address.port}/mcp`),
        slowCalls,
        async close() {
            await handler.close();
            await closeServer(server);
        },
    };
}

function delay(ms: number, signal: AbortSignal) {
    return new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, ms);
        signal.addEventListener(
            "abort",
            () => {
                clearTimeout(timer);
                reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
            },
            { once: true },
        );
    });
}

async function closeServer(server: Server) {
    if (!server.listening) return;
    const closed = once(server, "close");
    server.close();
    server.closeAllConnections();
    await closed;
}
