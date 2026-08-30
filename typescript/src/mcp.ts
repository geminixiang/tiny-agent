import { Client, isInputRequiredResult, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { canonicalDigest } from "./canonical-json.js";
import type { Tool } from "./tools.js";

const MAX_RESULT_BYTES = 50 * 1024;
const MAX_SCHEMA_BYTES = 50 * 1024;
const MAX_DESCRIPTION_BYTES = 8 * 1024;
const MAX_SCHEMA_DEPTH = 20;
const MAX_TOOLS = 64;

export type McpConfig = {
    readonly alias: string;
    readonly url: URL;
    readonly headers?: Readonly<Record<string, string>>;
    readonly callTimeoutMs: number;
    readonly allowedTools?: readonly string[];
};

export type LoadedMcpTools = {
    tools: Tool[];
    protocolVersion: string;
    close(): Promise<void>;
};

export async function loadMcpTools(config: McpConfig, signal?: AbortSignal): Promise<LoadedMcpTools> {
    const client = new Client({ name: "tiny-agent", version: "0.1.0" }, { versionNegotiation: { mode: "auto" } });
    let closed = false;
    let transport: StreamableHTTPClientTransport | undefined;
    const close = async () => {
        if (closed) return;
        closed = true;
        try {
            if (client.getProtocolEra() === "legacy") await transport?.terminateSession();
        } finally {
            await client.close();
        }
    };

    try {
        transport = new StreamableHTTPClientTransport(config.url, {
            requestInit: { redirect: "error", ...(config.headers ? { headers: config.headers } : {}) },
        });
        await client.connect(transport, { signal });
        const listed = await client.listTools(undefined, { signal });
        if (listed.tools.length > MAX_TOOLS) throw Error(`MCP server returned more than ${MAX_TOOLS} tools`);
        const remoteNames = new Set<string>();
        const mappedNames = new Set<string>();
        const allowed = config.allowedTools && new Set(config.allowedTools);
        const tools: Tool[] = [];
        const protocolVersion = client.getNegotiatedProtocolVersion();
        if (!protocolVersion) throw Error("MCP server did not negotiate a protocol version");
        const adapterIdentity = canonicalDigest({
            url: config.url.toString(),
            auth: mcpAuthType(config.headers),
            protocolVersion,
        });

        for (const remote of listed.tools) {
            if (remoteNames.has(remote.name)) throw Error(`duplicate MCP tool name: ${remote.name}`);
            remoteNames.add(remote.name);
            if (allowed && !allowed.has(remote.name)) continue;
            validateSchema(remote.inputSchema, remote.name);
            if (remote.description && Buffer.byteLength(remote.description) > MAX_DESCRIPTION_BYTES) {
                throw Error(`MCP tool description exceeds 8KB: ${remote.name}`);
            }
            const name = mapToolName(config.alias, remote.name);
            if (mappedNames.has(name)) throw Error(`duplicate mapped MCP tool name: ${name}`);
            mappedNames.add(name);
            tools.push({
                name,
                description: remote.description ?? `MCP tool ${remote.name} from ${config.alias}.`,
                parameters: remote.inputSchema as Record<string, unknown>,
                definitionIdentity: `${adapterIdentity}:${remote.name}`,
                async execute(args, callSignal) {
                    if (closed) throw Error("MCP connection is closed");
                    if (args === null || typeof args !== "object" || Array.isArray(args)) {
                        throw Error("MCP tool arguments must be a JSON object");
                    }
                    const result = await client.callTool(
                        { name: remote.name, arguments: args },
                        {
                            signal: callSignal,
                            timeout: config.callTimeoutMs,
                            maxTotalTimeout: config.callTimeoutMs,
                            allowInputRequired: true,
                        },
                    );
                    if (isInputRequiredResult(result)) {
                        throw Error("MCP tool requires additional user input; input_required is not supported");
                    }
                    const normalized = normalizeResult(result);
                    if (result.isError) throw Error(`MCP tool error: ${normalized}`);
                    return normalized;
                },
            });
        }

        if (allowed) {
            const missing = [...allowed].filter((name) => !remoteNames.has(name));
            if (missing.length) throw Error(`MCP allowed tools were not found: ${missing.join(", ")}`);
        }
        return { tools, protocolVersion, close };
    } catch (error) {
        await close();
        throw error;
    }
}

// prettier-ignore
function mcpAuthType(headers?: Readonly<Record<string, string>>) { const h = new Headers(headers); return h.has("x-api-key") ? "metabaseApiKey" : h.has("authorization") ? "bearer" : "none"; }

function validateSchema(schema: unknown, toolName: string) {
    let encoded: string;
    try {
        encoded = JSON.stringify(schema);
    } catch {
        throw Error(`MCP tool schema is not JSON-serializable: ${toolName}`);
    }
    if (Buffer.byteLength(encoded) > MAX_SCHEMA_BYTES) throw Error(`MCP tool schema exceeds 50KB: ${toolName}`);
    if (jsonDepth(schema) > MAX_SCHEMA_DEPTH)
        throw Error(`MCP tool schema exceeds depth ${MAX_SCHEMA_DEPTH}: ${toolName}`);
}

function jsonDepth(value: unknown): number {
    if (value === null || typeof value !== "object") return 0;
    const children = Array.isArray(value) ? value : Object.values(value);
    return 1 + Math.max(0, ...children.map(jsonDepth));
}

export function displayToolName(name: string) {
    const match = name.match(/^mcp__([A-Za-z0-9_-]+)__([A-Za-z0-9_-]+)$/);
    if (!match) return name;
    try {
        return `mcp:${Buffer.from(match[1], "base64url").toString()}/${Buffer.from(match[2], "base64url").toString()}`;
    } catch {
        return name;
    }
}

function mapToolName(alias: string, remoteName: string) {
    if (!remoteName) throw Error("MCP tool name must not be empty");
    const name = `mcp__${Buffer.from(alias).toString("base64url")}__${Buffer.from(remoteName).toString("base64url")}`;
    if (name.length > 64) throw Error(`mapped MCP tool name exceeds 64 characters: ${remoteName}`);
    return name;
}

function normalizeResult(result: {
    content?: Array<{
        type: string;
        text?: string;
        resource?: { uri?: string; mimeType?: string; text?: string; blob?: string };
    }>;
    structuredContent?: unknown;
    isError?: boolean;
}) {
    const unsupported = (result.content ?? []).filter(
        (item) =>
            item.type !== "text" &&
            !(
                item.type === "resource" &&
                typeof item.resource?.text === "string" &&
                typeof item.resource.blob !== "string"
            ),
    );
    if (unsupported.length) {
        throw Error(`Unsupported MCP content type: ${unsupported.map((item) => item.type).join(", ")}`);
    }
    const parts = (result.content ?? []).flatMap((item) => {
        if (item.type === "text" && typeof item.text === "string") return [item.text];
        if (item.type === "resource" && typeof item.resource?.text === "string") {
            const source = item.resource.uri ? `Resource: ${item.resource.uri}\n` : "";
            return [`${source}${item.resource.text}`];
        }
        return [];
    });
    if (result.structuredContent !== undefined) {
        parts.push(`Structured content:\n${JSON.stringify(result.structuredContent)}`);
    }
    const content = `${parts.join("\n\n") || "(no output)"}`;
    return truncateUtf8(content, MAX_RESULT_BYTES);
}

function truncateUtf8(text: string, maxBytes: number) {
    const bytes = Buffer.from(text);
    if (bytes.length <= maxBytes) return text;
    const suffix = "\n\n[MCP result truncated to 50KB]";
    const limit = maxBytes - Buffer.byteLength(suffix);
    let end = limit;
    while (end > 0 && (bytes[end] & 0xc0) === 0x80) end--;
    return bytes.subarray(0, end).toString() + suffix;
}
