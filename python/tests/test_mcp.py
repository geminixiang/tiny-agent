import json
import os
import threading
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch

from mcp_fixture import McpFixture
from tiny_agent.mcp import McpConfig, _encode_mcp_param_value, display_tool_name, load_mcp_configs, load_mcp_tools, split_mcp_aliases


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

    def test_modern_json_and_sse_list_call_auth_normalization_and_errors(self):
        for sse in (False, True):
            with self.subTest(sse=sse):
                fixture = McpFixture(sse=sse, token="secret")
                try:
                    loaded = load_mcp_tools(McpConfig("fixture", fixture.url, {"Authorization": "Bearer secret"}))
                    self.addCleanup(loaded.close)
                    self.assertEqual(loaded.protocol_version, "2026-07-28")
                    self.assertEqual(display_tool_name(loaded.tools[0]["function"]["name"]), "mcp:fixture/echo")
                    self.assertEqual(loaded.tools[0]["execute"]({"message": "hello"}), "hello")
                    self.assertEqual(loaded.tools[1]["execute"]({}), 'count: 2\n\nStructured content:\n{"count":2}')
                    with self.assertRaisesRegex(RuntimeError, "MCP tool error: not found"): loaded.tools[2]["execute"]({})
                    with self.assertRaisesRegex(RuntimeError, "Unsupported MCP content type: image"): loaded.tools[3]["execute"]({})
                    self.assertTrue(all(call["authorization"] == "Bearer secret" for call in fixture.calls))
                    loaded.close(); loaded.close()
                    with self.assertRaisesRegex(RuntimeError, "connection is closed"): loaded.tools[0]["execute"]({"message": "x"})
                finally: fixture.close()

    def test_http_errors_are_sanitized_and_never_fall_back(self):
        canary = "SECRET-CANARY-DO-NOT-LEAK"
        for status in (401, 404, 503):
            with self.subTest(status=status):
                fixture = McpFixture(http_error=status, error_body=canary)
                try:
                    with self.assertRaises(RuntimeError) as raised:
                        load_mcp_tools(McpConfig("fixture", fixture.url))
                    self.assertIn(f"MCP HTTP {status}", str(raised.exception))
                    self.assertNotIn(canary, str(raised.exception))
                    self.assertEqual([call["request"]["method"] for call in fixture.calls], ["server/discover"])
                finally: fixture.close()

    def test_json_rpc_errors_are_sanitized_for_json_and_sse(self):
        canary = "SECRET-RPC-CANARY"
        error = {"code": -32603, "message": canary, "data": {"secret": canary}}
        for sse in (False, True):
            for method in ("server/discover", "tools/list", "tools/call"):
                with self.subTest(sse=sse, method=method):
                    fixture = McpFixture(sse=sse, rpc_errors={method: error})
                    try:
                        with self.assertRaises(RuntimeError) as raised:
                            loaded = load_mcp_tools(McpConfig("fixture", fixture.url))
                            self.addCleanup(loaded.close)
                            loaded.tools[0]["execute"]({"message": "hello"})
                        self.assertNotIn(canary, str(raised.exception))
                    finally: fixture.close()

    def test_negotiation_corrective_retry_and_loud_rejection(self):
        mutual = {"code": -32022, "message": "retry", "data": {"supported": ["2026-07-28"]}}
        fixture = McpFixture(rpc_errors={"server/discover": [mutual, None]})
        try:
            loaded = load_mcp_tools(McpConfig("fixture", fixture.url)); loaded.close()
            self.assertEqual(fixture.method_counts["server/discover"], 2)
        finally: fixture.close()

        cases = [
            {"code": -32022, "data": {"supported": ["2027-01-01"]}},
            {"code": -32022, "data": {"supported": ["2025-11-25"]}},
            {"code": -32022, "data": {"supported": []}},
            {"code": -32603, "data": {"supported": ["2026-07-28"]}},
        ]
        for error in cases:
            with self.subTest(error=error):
                fixture = McpFixture(rpc_errors={"server/discover": error})
                try:
                    with self.assertRaisesRegex(RuntimeError, "does not support the modern protocol"):
                        load_mcp_tools(McpConfig("fixture", fixture.url))
                    self.assertEqual(fixture.method_counts["server/discover"], 1)
                finally: fixture.close()

    def test_mcp_header_encoding_mirroring_and_invalid_declaration_exclusion(self):
        self.assertEqual(_encode_mcp_param_value("plain ASCII"), "plain ASCII")
        self.assertEqual(_encode_mcp_param_value(""), "=?base64??=")
        self.assertEqual(_encode_mcp_param_value("\tvalue"), "=?base64?CXZhbHVl?=")
        self.assertEqual(_encode_mcp_param_value("=?base64?YWJj?="), "=?base64?PT9iYXNlNjQ/WVdKaj89?=")
        self.assertEqual(_encode_mcp_param_value("工具"), "=?base64?5bel5YW3?=")
        schema = {"type": "object", "properties": {
            "message": {"type": "string", "x-mcp-header": "Message"},
            "nested": {"type": "object", "properties": {"enabled": {"type": "boolean", "x-mcp-header": "Enabled"}}},
        }}
        fixture = McpFixture(tools=[{"name": "echo", "inputSchema": schema}])
        try:
            loaded = load_mcp_tools(McpConfig("fixture", fixture.url))
            loaded.tools[0]["execute"]({"message": " café ", "nested": {"enabled": True}})
            call = fixture.calls[-1]["headers"]
            self.assertEqual(call["mcp-name"], "echo")
            self.assertEqual(call["mcp-param-message"], "=?base64?IGNhZsOpIA==?=")
            self.assertEqual(call["mcp-param-enabled"], "true")
            loaded.close()
        finally: fixture.close()
        invalid = McpFixture(tools=[{"name": "echo", "inputSchema": {"type": "object", "items": {"type": "string", "x-mcp-header": "Bad"}}}])
        try:
            loaded = load_mcp_tools(McpConfig("fixture", invalid.url))
            self.assertEqual(loaded.tools, []); loaded.close()
        finally: invalid.close()

    def test_tools_list_pagination_aggregates_under_bounds(self):
        pages = [
            [{"name": "echo", "inputSchema": {"type": "object"}}],
            [{"name": "structured", "inputSchema": {"type": "object"}}],
        ]
        fixture = McpFixture(pages=pages)
        try:
            loaded = load_mcp_tools(McpConfig("fixture", fixture.url))
            self.assertEqual(len(loaded.tools), 2)
            list_calls = [call["request"]["params"] for call in fixture.calls if call["request"]["method"] == "tools/list"]
            self.assertEqual(list_calls, [{"_meta": list_calls[0]["_meta"]}, {"cursor": "1", "_meta": list_calls[1]["_meta"]}])
            loaded.close()
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
