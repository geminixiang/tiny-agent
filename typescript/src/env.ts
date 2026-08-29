// Single point of contact for every environment variable tiny-agent reads. Each named variable's
// default, trim/empty handling, and error message live here once instead of being re-decided at
// every call site.

export const systemEnv: NodeJS.ProcessEnv = process.env;

export const MODEL = systemEnv.TINY_MODEL || "openai/gpt-5.6-luna";
export const ENDPOINT = systemEnv.TINY_ENDPOINT || "https://openrouter.ai/api/v1";

export function chatCompletionsUrl(endpoint = ENDPOINT) {
    const trimmed = endpoint.replace(/\/+$/, "");
    if (trimmed.endsWith("/chat/completions")) return trimmed;
    return `${trimmed}/chat/completions`;
}

export function requireOpenRouterApiKey() {
    const key = systemEnv.OPENROUTER_API_KEY;
    if (!key) throw Error("Set OPENROUTER_API_KEY");
    return key;
}

export function environmentIdentityOverride() {
    return systemEnv.TINY_AGENT_ENVIRONMENT_IDENTITY?.trim();
}

export function requireMcpConfigPath(env: NodeJS.ProcessEnv = systemEnv) {
    if (!env.TINY_MCP_CONFIG) throw Error("TINY_MCP_CONFIG must be set to use --mcp");
    return env.TINY_MCP_CONFIG;
}
