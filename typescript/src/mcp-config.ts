import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { validateNonemptyStringArray, type McpConfig } from "./mcp.js";

const ROOT_KEYS = new Set(["servers"]),
    SERVER_KEYS = new Set(["url", "tokenEnv", "auth", "allowedTools", "callTimeoutMs"]),
    AUTH_KEYS = new Set(["type", "tokenEnv"]);

export type McpServerCatalog = {
    servers: Record<
        string,
        {
            url: string;
            tokenEnv?: string;
            auth?: { type: "metabaseApiKey"; tokenEnv: string };
            allowedTools?: string[];
            callTimeoutMs?: number;
        }
    >;
};

export async function loadMcpConfigs(aliases: string[], env: NodeJS.ProcessEnv = process.env): Promise<McpConfig[]> {
    if (!aliases.length) return [];
    if (!env.TINY_MCP_CONFIG) throw Error("TINY_MCP_CONFIG must be set to use --mcp");
    const path = resolve(env.TINY_MCP_CONFIG);
    let value: unknown;
    try {
        value = JSON.parse(await readFile(path, "utf8"));
    } catch {
        throw Error("Failed to load MCP catalog: file is missing, unreadable, or invalid JSON");
    }
    const catalog = validateCatalog(value);
    const missing = aliases.find((alias) => !Object.hasOwn(catalog.servers, alias));
    if (missing) throw Error(`Unknown MCP server: ${missing}`);
    const configs: McpConfig[] = [];
    for (const alias of aliases) {
        const server = catalog.servers[alias];
        const token = credential(server, env);
        configs.push({
            alias,
            url: server.url,
            ...(token
                ? {
                      headers:
                          server.auth?.type === "metabaseApiKey"
                              ? { "X-API-Key": token }
                              : { Authorization: `Bearer ${token}` },
                  }
                : {}),
            ...(server.allowedTools ? { allowedTools: server.allowedTools } : {}),
            ...(server.callTimeoutMs ? { callTimeoutMs: server.callTimeoutMs } : {}),
        });
    }
    return configs;
}

function validateCatalog(value: unknown): McpServerCatalog {
    const root = object(value, "MCP catalog");
    unknownField(root, ROOT_KEYS, "MCP catalog");
    const servers = object(root.servers, "MCP catalog servers");
    const validated = Object.create(null) as McpServerCatalog["servers"];
    for (const [alias, value] of Object.entries(servers)) {
        if (!alias.trim()) throw Error("MCP server alias must not be empty");
        const server = object(value, `MCP server ${alias}`);
        unknownField(server, SERVER_KEYS, `MCP server ${alias}`);
        if (typeof server.url !== "string" || !server.url) throw Error(`MCP server ${alias} url must be a string`);
        if (server.tokenEnv !== undefined) validateTokenEnv(server.tokenEnv, `MCP server ${alias} tokenEnv`);
        if (server.tokenEnv !== undefined && server.auth !== undefined) {
            throw Error(`MCP server ${alias} must not set both tokenEnv and auth`);
        }
        let auth: McpServerCatalog["servers"][string]["auth"];
        if (server.auth !== undefined) {
            const value = object(server.auth, `MCP server ${alias} auth`);
            unknownField(value, AUTH_KEYS, `MCP server ${alias} auth`);
            if (value.type !== "metabaseApiKey") {
                throw Error(`MCP server ${alias} auth type must be metabaseApiKey`);
            }
            validateTokenEnv(value.tokenEnv, `MCP server ${alias} auth tokenEnv`);
            auth = { type: "metabaseApiKey", tokenEnv: value.tokenEnv as string };
        }
        validateNonemptyStringArray(server.allowedTools, `MCP server ${alias} allowedTools`);
        if (
            server.callTimeoutMs !== undefined &&
            (typeof server.callTimeoutMs !== "number" ||
                !Number.isFinite(server.callTimeoutMs) ||
                server.callTimeoutMs <= 0)
        ) {
            throw Error(`MCP server ${alias} callTimeoutMs must be a positive number`);
        }
        validated[alias] = {
            url: server.url,
            ...(server.tokenEnv === undefined ? {} : { tokenEnv: server.tokenEnv }),
            ...(auth === undefined ? {} : { auth }),
            ...(server.allowedTools === undefined ? {} : { allowedTools: [...server.allowedTools] as string[] }),
            ...(server.callTimeoutMs === undefined ? {} : { callTimeoutMs: server.callTimeoutMs }),
        };
    }
    return { servers: validated };
}

function credential(server: McpServerCatalog["servers"][string], env: NodeJS.ProcessEnv): string | undefined {
    const tokenEnv = server.auth?.tokenEnv ?? server.tokenEnv;
    if (!tokenEnv) return undefined;
    const token = Object.hasOwn(env, tokenEnv) ? env[tokenEnv] : undefined;
    if (!token) throw Error(`MCP token environment variable is not set: ${tokenEnv}`);
    return token;
}

function validateTokenEnv(value: unknown, name: string): asserts value is string {
    if (typeof value !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) {
        throw Error(`${name} must be an environment variable name`);
    }
}

function object(value: unknown, name: string): Record<string, unknown> {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw Error(`${name} must be an object`);
    return value as Record<string, unknown>;
}

function unknownField(value: Record<string, unknown>, allowed: Set<string>, name: string) {
    const field = Object.keys(value).find((key) => !allowed.has(key));
    if (field) throw Error(`Unknown ${name} field: ${field}`);
}
