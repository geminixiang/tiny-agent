import assert from "node:assert/strict";
import test from "node:test";
import { loadMcpTools } from "../src/mcp.js";

const token = process.env.TINY_GITHUB_MCP_TOKEN;

test(
    "GitHub hosted MCP lists and calls get_file_contents",
    { skip: token ? false : "TINY_GITHUB_MCP_TOKEN is not set" },
    async () => {
        const loaded = await loadMcpTools({
            alias: "github",
            url: "https://api.githubcopilot.com/mcp/",
            headers: { Authorization: `Bearer ${token}` },
            allowedTools: ["get_file_contents"],
            callTimeoutMs: 30_000,
        });
        try {
            assert.equal(loaded.protocolVersion, "2026-07-28");
            assert.equal(loaded.tools.length, 1);
            const result = await loaded.tools[0].execute({
                owner: "geminixiang",
                repo: "tiny-agent",
                path: "README.md",
            });
            assert.match(result, /tiny-agent/);
        } finally {
            await loaded.close();
        }
    },
);
