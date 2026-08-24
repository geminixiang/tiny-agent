import { createServer, type Server } from "node:http";
import { once } from "node:events";

export type LegacyTestMcpServer = {
    url: URL;
    methods: string[];
    authenticated: boolean;
    sessionHeaders: number;
    deleted: boolean;
    close(): Promise<void>;
};

export async function startLegacyTestMcpServer(): Promise<LegacyTestMcpServer> {
    const state: LegacyTestMcpServer = {
        url: new URL("http://127.0.0.1"),
        methods: [],
        authenticated: true,
        sessionHeaders: 0,
        deleted: false,
        async close() {
            await closeServer(server);
        },
    };
    const sessionId = "legacy-session";
    const server = createServer(async (request, response) => {
        if (request.headers["x-api-key"] !== "fixture-secret") state.authenticated = false;
        if (request.method === "DELETE") {
            state.deleted = request.headers["mcp-session-id"] === sessionId;
            response.writeHead(200).end();
            return;
        }
        if (request.method === "GET") {
            response.writeHead(405).end();
            return;
        }
        const body = await readBody(request);
        const message = JSON.parse(body) as { id?: number; method: string; params?: unknown };
        state.methods.push(message.method);
        if (request.headers["mcp-session-id"] === sessionId) state.sessionHeaders++;
        if (message.method === "server/discover") {
            json(response, { jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Method not found" } });
            return;
        }
        if (message.method === "initialize") {
            json(
                response,
                {
                    jsonrpc: "2.0",
                    id: message.id,
                    result: {
                        protocolVersion: "2025-03-26",
                        capabilities: { tools: {} },
                        serverInfo: { name: "legacy-fixture", version: "1.0.0" },
                    },
                },
                { "Mcp-Session-Id": sessionId },
            );
            return;
        }
        if (message.method === "notifications/initialized") {
            response.writeHead(202).end();
            return;
        }
        if (message.method === "tools/list") {
            json(response, {
                jsonrpc: "2.0",
                id: message.id,
                result: {
                    tools: [
                        {
                            name: "echo",
                            description: "Return a message.",
                            inputSchema: {
                                type: "object",
                                properties: { message: { type: "string" } },
                                required: ["message"],
                            },
                        },
                    ],
                },
            });
            return;
        }
        if (message.method === "tools/call") {
            const params = message.params as { arguments?: { message?: string } };
            json(response, {
                jsonrpc: "2.0",
                id: message.id,
                result: { content: [{ type: "text", text: params.arguments?.message ?? "" }] },
            });
            return;
        }
        json(response, { jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Method not found" } });
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw Error("legacy MCP fixture did not bind a TCP port");
    state.url = new URL(`http://127.0.0.1:${address.port}/mcp`);
    return state;
}

function json(response: import("node:http").ServerResponse, value: unknown, headers: Record<string, string> = {}) {
    response.writeHead(200, { "Content-Type": "application/json", ...headers });
    response.end(JSON.stringify(value));
}

async function readBody(request: import("node:http").IncomingMessage) {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    return Buffer.concat(chunks).toString();
}

async function closeServer(server: Server) {
    if (!server.listening) return;
    const closed = once(server, "close");
    server.close();
    server.closeAllConnections();
    await closed;
}
