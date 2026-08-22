import json
import os
import threading
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch

from mcp_fixture import McpFixture
from tiny_agent.mcp import McpConfig, display_tool_name, load_mcp_configs, load_mcp_tools, split_mcp_aliases


class McpTest(unittest.TestCase):
    def test_alias_splitting_and_catalog_validation(self):
        self.assertEqual(split_mcp_aliases([" sentry, public ", "sentry", ""]), ["sentry", "public"])
        with TemporaryDirectory() as root:
            path = Path(root) / "catalog.json"
            path.write_text(json.dumps({"servers": {"fixture": {"url": "https://example.com/mcp", "tokenEnv": "JOB_TOKEN", "allowedTools": ["echo"], "callTimeoutMs": 1234}}}), encoding="utf-8")
            configs = load_mcp_configs(["fixture"], {"TINY_MCP_CONFIG": str(path), "JOB_TOKEN": "secret"})
            self.assertEqual(configs, [McpConfig("fixture", "https://example.com/mcp", {"Authorization": "Bearer secret"}, ["echo"], 1234)])
            path.write_text(json.dumps({"servers": {"fixture": {"url": "https://example.com", "extra": True}}}), encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "Unknown MCP server fixture field: extra"): load_mcp_configs(["fixture"], {"TINY_MCP_CONFIG": str(path)})
            path.write_text(json.dumps({"servers": {"fixture": {"url": "https://example.com", "tokenEnv": "TOKEN"}}}), encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "environment variable is not set"): load_mcp_configs(["fixture"], {"TINY_MCP_CONFIG": str(path)})

    def test_json_and_sse_list_call_auth_normalization_and_errors(self):
        for sse in (False, True):
            with self.subTest(sse=sse):
                fixture = McpFixture(sse=sse, token="secret")
                try:
                    loaded = load_mcp_tools(McpConfig("fixture", fixture.url, {"Authorization": "Bearer secret"}))
                    self.addCleanup(loaded.close)
                    self.assertEqual(loaded.protocol_version, "2025-06-18")
                    self.assertEqual(display_tool_name(loaded.tools[0]["function"]["name"]), "mcp:fixture/echo")
                    self.assertEqual(loaded.tools[0]["execute"]({"message": "hello"}), "hello")
                    self.assertEqual(loaded.tools[1]["execute"]({}), 'count: 2\n\nStructured content:\n{"count":2}')
                    with self.assertRaisesRegex(RuntimeError, "MCP tool error: not found"): loaded.tools[2]["execute"]({})
                    with self.assertRaisesRegex(RuntimeError, "Unsupported MCP content type: image"): loaded.tools[3]["execute"]({})
                    self.assertTrue(all(call["authorization"] == "Bearer secret" for call in fixture.calls))
                    loaded.close(); loaded.close()
                    self.assertEqual(fixture.deleted_sessions, ["fixture-session"])
                    with self.assertRaisesRegex(RuntimeError, "connection is closed"): loaded.tools[0]["execute"]({"message": "x"})
                finally: fixture.close()

    def test_allowlist_bounds_mapping_timeout_and_cancellation(self):
        fixture = McpFixture()
        try:
            loaded = load_mcp_tools(McpConfig("fixture", fixture.url, allowed_tools=["slow"], call_timeout_ms=30))
            self.assertEqual(len(loaded.tools), 1)
            with self.assertRaisesRegex(TimeoutError, "timed out"): loaded.tools[0]["execute"]({"delay": 1})
            loaded.close()
            with self.assertRaisesRegex(RuntimeError, "allowed tools were not found"):
                load_mcp_tools(McpConfig("fixture", fixture.url, allowed_tools=["missing"]))
            cancelled = threading.Event(); loaded = load_mcp_tools(McpConfig("fixture", fixture.url, allowed_tools=["slow"]))
            cancelled.set()
            with self.assertRaisesRegex(InterruptedError, "aborted"): loaded.tools[0]["execute"]({"delay": 1}, cancelled)
            loaded.close()
        finally: fixture.close()
        too_many = McpFixture(tools=[{"name": f"tool{i}", "inputSchema": {}} for i in range(65)])
        try:
            with self.assertRaisesRegex(RuntimeError, "more than 64 tools"): load_mcp_tools(McpConfig("fixture", too_many.url))
        finally: too_many.close()
        malformed = McpFixture(tools=[{"name": "bad", "inputSchema": None}])
        try:
            with self.assertRaisesRegex(RuntimeError, "Invalid MCP tool schema"): load_mcp_tools(McpConfig("fixture", malformed.url))
        finally: malformed.close()
        long_name = McpFixture(tools=[{"name": "x" * 60, "inputSchema": {}}])
        try:
            with self.assertRaisesRegex(RuntimeError, "exceeds 64 characters"): load_mcp_tools(McpConfig("fixture", long_name.url))
        finally: long_name.close()

    def test_config_rejects_untrusted_urls_and_duplicate_allowlist(self):
        with self.assertRaisesRegex(ValueError, "use HTTPS"): load_mcp_tools(McpConfig("x", "http://example.com/mcp"))
        with self.assertRaisesRegex(ValueError, "credentials"): load_mcp_tools(McpConfig("x", "https://user:pass@example.com/mcp"))
        with self.assertRaisesRegex(ValueError, "duplicates"): load_mcp_tools(McpConfig("x", "https://example.com/mcp", allowed_tools=["a", "a"]))


if __name__ == "__main__": unittest.main()
