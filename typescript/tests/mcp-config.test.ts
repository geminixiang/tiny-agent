import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadMcpConfigs } from "../src/mcp-config.js";

const fixture = {
    servers: {
        sentry: {
            url: "https://mcp.example.com/sentry",
            tokenEnv: "SENTRY_JOB_TOKEN",
            allowedTools: ["search", "get_issue"],
            callTimeoutMs: 12_000,
        },
        metabase: {
            url: "https://mcp.example.com/metabase",
            auth: { type: "metabaseApiKey", tokenEnv: "METABASE_JOB_KEY" },
            allowedTools: ["execute_question"],
        },
        public: { url: "https://mcp.example.com/public" },
    },
};

test("loads the trusted MCP catalog from an explicit TINY_MCP_CONFIG path and resolves its token environment", async () => {
    const root = await mkdtemp(join(tmpdir(), "tiny-agent-mcp-config-"));
    const path = join(root, "trusted.json");
    await writeFile(path, JSON.stringify(fixture));
    assert.deepEqual(
        await loadMcpConfigs(["sentry", "metabase", "public"], {
            TINY_MCP_CONFIG: path,
            SENTRY_JOB_TOKEN: "secret",
            METABASE_JOB_KEY: "metabase-secret",
        }),
        [
            {
                alias: "sentry",
                url: new URL("https://mcp.example.com/sentry"),
                headers: { Authorization: "Bearer secret" },
                allowedTools: ["search", "get_issue"],
                callTimeoutMs: 12_000,
            },
            {
                alias: "metabase",
                url: new URL("https://mcp.example.com/metabase"),
                headers: { "X-API-Key": "metabase-secret" },
                allowedTools: ["execute_question"],
                callTimeoutMs: 30_000,
            },
            { alias: "public", url: new URL("https://mcp.example.com/public"), callTimeoutMs: 30_000 },
        ],
    );
});

test("requires TINY_MCP_CONFIG to be set when aliases are requested", async () => {
    await assert.rejects(() => loadMcpConfigs(["sentry"], {}), /TINY_MCP_CONFIG must be set to use --mcp/);
});

test("rejects invalid catalogs, aliases, and missing tokens without leaking secrets", async () => {
    const root = await mkdtemp(join(tmpdir(), "tiny-agent-mcp-config-"));
    const path = join(root, "catalog.json");
    const load = async (value: unknown, aliases = ["sentry"], env: NodeJS.ProcessEnv = {}) => {
        await writeFile(path, JSON.stringify(value));
        return loadMcpConfigs(aliases, { ...env, TINY_MCP_CONFIG: path });
    };

    await assert.rejects(() => load({ ...fixture, extra: true }), /Unknown MCP catalog field: extra/);
    await assert.rejects(() => load({ servers: { sentry: { url: 42 } } }), /MCP server sentry url must be a string/);
    await assert.rejects(() => load({ servers: { sentry: { url: "not a URL" } } }), /valid URL/);
    await assert.rejects(() => load({ servers: { sentry: { url: "http://example.com/mcp" } } }), /use HTTPS/);
    await assert.rejects(
        () => load({ servers: { sentry: { url: "https://user:pass@example.com/mcp" } } }),
        /must not contain credentials/,
    );
    await assert.rejects(
        () => load({ servers: { sentry: { url: "https://example.com", tokenEnv: 42 } } }),
        /tokenEnv must be an environment variable name/,
    );
    await assert.rejects(
        () => load({ servers: { sentry: { url: "https://example.com", tokenEnv: "BAD-NAME" } } }),
        /tokenEnv must be an environment variable name/,
    );
    await assert.rejects(
        () => load({ servers: { sentry: { url: "https://example.com", tokenEnv: "toString" } } }),
        /environment variable is not set: toString/,
    );
    await assert.rejects(
        () =>
            load(
                {
                    servers: {
                        sentry: {
                            url: "https://example.com",
                            tokenEnv: "TOKEN",
                            auth: { type: "metabaseApiKey", tokenEnv: "OTHER_TOKEN" },
                        },
                    },
                },
                ["sentry"],
                { TOKEN: "secret", OTHER_TOKEN: "other-secret" },
            ),
        /must not set both tokenEnv and auth/,
    );
    await assert.rejects(
        () =>
            load({
                servers: {
                    sentry: { url: "https://example.com", auth: { type: "custom", tokenEnv: "TOKEN" } },
                },
            }),
        /auth type must be metabaseApiKey/,
    );
    await assert.rejects(
        () =>
            load({
                servers: {
                    sentry: {
                        url: "https://example.com",
                        auth: { type: "metabaseApiKey", tokenEnv: "BAD-NAME" },
                    },
                },
            }),
        /auth tokenEnv must be an environment variable name/,
    );
    await assert.rejects(
        () =>
            load({
                servers: {
                    sentry: {
                        url: "https://example.com",
                        auth: { type: "metabaseApiKey", tokenEnv: "TOKEN", header: "X-Other" },
                    },
                },
            }),
        /Unknown MCP server sentry auth field: header/,
    );
    await assert.rejects(
        () => load(fixture, ["metabase"], { METABASE_JOB_KEY: "" }),
        /environment variable is not set: METABASE_JOB_KEY/,
    );
    await assert.rejects(
        () => load({ servers: { sentry: { url: "https://example.com", allowedTools: ["x", "x"] } } }),
        /allowedTools must not contain duplicates/,
    );
    await assert.rejects(() => load(fixture, ["missing"]), /Unknown MCP server: missing/);
    await assert.rejects(() => load(fixture, ["toString"]), /Unknown MCP server: toString/);
    await assert.rejects(() => load(fixture, ["constructor"]), /Unknown MCP server: constructor/);
    await assert.rejects(() => load(fixture, ["__proto__"]), /Unknown MCP server: __proto__/);
    const secret = "do-not-leak-this-token";
    await assert.rejects(
        () => load(fixture, ["sentry"], { SENTRY_JOB_TOKEN: "" }),
        (error: Error) => !error.message.includes(secret) && /environment variable is not set/.test(error.message),
    );
});
