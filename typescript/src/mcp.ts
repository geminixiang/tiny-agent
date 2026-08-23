import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import type { Tool } from "./tools.js";

const MAX_RESULT_BYTES = 50 * 1024,
    MAX_SCHEMA_BYTES = 50 * 1024,
    MAX_DESCRIPTION_BYTES = 8 * 1024,
    MAX_SCHEMA_DEPTH = 20,
    MAX_TOOLS = 64,
    CONFIG_KEYS = new Set(["alias", "url", "headers", "callTimeoutMs", "allowedTools"]);

export type McpConfig = {
    alias: string;
    url: string | URL;
    headers?: Record<string, string>;
    callTimeoutMs?: number;
    allowedTools?: string[];
};

export type LoadedMcpTools = {
    tools: Tool[];
    protocolVersion: string;
    close(): Promise<void>;
};

export async function loadMcpTools(config: McpConfig, signal?: AbortSignal): Promise<LoadedMcpTools> {
    const validated = validateConfig(config);
    const client = new Client(
        { name: "tiny-agent", version: "0.1.0" },
        { versionNegotiation: { mode: { pin: "2026-07-28" } } },
    );
    let closed = false;
    const close = async () => {
        if (closed) return;
        closed = true;
        await client.close();
    };

    try {
        const transport = new StreamableHTTPClientTransport(validated.url, {
            requestInit: validated.headers ? { headers: validated.headers } : undefined,
        });
        await client.connect(transport, { signal });
        const listed = await client.listTools(undefined, { signal });
        if (listed.tools.length > MAX_TOOLS) throw Error(`MCP server returned more than ${MAX_TOOLS} tools`);
        const remoteNames = new Set<string>();
        const mappedNames = new Set<string>();
        const allowed = validated.allowedTools && new Set(validated.allowedTools);
        const tools: Tool[] = [];

        for (const remote of listed.tools) {
            if (remoteNames.has(remote.name)) throw Error(`duplicate MCP tool name: ${remote.name}`);
            remoteNames.add(remote.name);
            if (allowed && !allowed.has(remote.name)) continue;
            validateSchema(remote.inputSchema, remote.name);
            if (remote.description && Buffer.byteLength(remote.description) > MAX_DESCRIPTION_BYTES) {
                throw Error(`MCP tool description exceeds 8KB: ${remote.name}`);
            }
            const name = mapToolName(validated.alias, remote.name);
            if (mappedNames.has(name)) throw Error(`duplicate mapped MCP tool name: ${name}`);
            mappedNames.add(name);
            tools.push({
                name,
                description: remote.description ?? `MCP tool ${remote.name} from ${validated.alias}.`,
                parameters: remote.inputSchema as Record<string, unknown>,
                async execute(args, callSignal) {
                    if (closed) throw Error("MCP connection is closed");
                    if (args === null || typeof args !== "object" || Array.isArray(args)) {
                        throw Error("MCP tool arguments must be a JSON object");
                    }
                    const result = await client.callTool(
                        { name: remote.name, arguments: args },
                        {
                            signal: callSignal,
                            timeout: validated.callTimeoutMs,
                            maxTotalTimeout: validated.callTimeoutMs,
                            allowInputRequired: true,
                        },
                    );
                    if (isInputRequired(result)) {
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
        const protocolEra = client.getProtocolEra();
        const protocolVersion = client.getNegotiatedProtocolVersion();
        if (protocolEra !== "modern" || !protocolVersion) {
            throw Error("MCP server did not negotiate the modern protocol");
        }
        return { tools, protocolVersion, close };
    } catch (error) {
        await close();
        throw error;
    }
}

function validateConfig(config: McpConfig) {
    if (!config || typeof config !== "object" || Array.isArray(config)) throw Error("MCP config must be an object");
    const unknown = Object.keys(config).find((key) => !CONFIG_KEYS.has(key));
    if (unknown) throw Error(`Unknown MCP config field: ${unknown}`);
    if (typeof config.alias !== "string" || !config.alias.trim()) throw Error("MCP alias must be a nonempty string");
    let url: URL;
    try {
        url = new URL(config.url);
    } catch {
        throw Error("MCP URL must be a valid URL");
    }
    if (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopback(url.hostname))) {
        throw Error("MCP URL must use HTTPS unless it targets loopback");
    }
    if (url.username || url.password) throw Error("MCP URL must not contain credentials");
    if (config.callTimeoutMs !== undefined && (!Number.isFinite(config.callTimeoutMs) || config.callTimeoutMs <= 0)) {
        throw Error("MCP callTimeoutMs must be a positive number");
    }
    if (config.headers !== undefined) {
        if (config.headers === null || typeof config.headers !== "object" || Array.isArray(config.headers)) {
            throw Error("MCP headers must be an object");
        }
        try {
            new Headers(config.headers);
        } catch {
            throw Error("MCP headers contain an invalid name or value");
        }
        for (const [name, value] of Object.entries(config.headers)) {
            if (!name || typeof value !== "string") throw Error("MCP headers must contain string values");
        }
    }
    if (config.allowedTools !== undefined) {
        if (
            !Array.isArray(config.allowedTools) ||
            config.allowedTools.some((name) => typeof name !== "string" || !name)
        ) {
            throw Error("MCP allowedTools must contain nonempty strings");
        }
        if (new Set(config.allowedTools).size !== config.allowedTools.length) {
            throw Error("MCP allowedTools must not contain duplicates");
        }
    }
    return {
        alias: config.alias.trim(),
        url,
        headers: config.headers,
        callTimeoutMs: config.callTimeoutMs ?? 30_000,
        allowedTools: config.allowedTools,
    };
}

function isLoopback(hostname: string) {
    return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "[::1]";
}

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

function isInputRequired(result: unknown) {
    return (
        result !== null &&
        typeof result === "object" &&
        "resultType" in result &&
        result.resultType === "input_required"
    );
}

function normalizeResult(result: {
    content?: Array<{ type: string; text?: string }>;
    structuredContent?: unknown;
    isError?: boolean;
}) {
    const unsupported = (result.content ?? []).filter((item) => item.type !== "text");
    if (unsupported.length) {
        throw Error(`Unsupported MCP content type: ${unsupported.map((item) => item.type).join(", ")}`);
    }
    const parts = (result.content ?? [])
        .filter((item) => typeof item.text === "string")
        .map((item) => item.text as string);
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
