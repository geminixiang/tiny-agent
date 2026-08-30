import asyncio
import json
import os
import threading
import time
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch

from mcp_fixture import McpFixture
from tiny_agent.http import read_http_response
from tiny_agent.mcp import McpConfig, _encode_mcp_param_value, _normalize_result, display_tool_name, load_mcp_configs, load_mcp_tools, split_names


class McpTest(unittest.IsolatedAsyncioTestCase):
    async def test_alias_splitting_and_catalog_validation(self):
        self.assertEqual(split_names([" sentry, public ", "sentry", ""]), ["sentry", "public"])
        with TemporaryDirectory() as root:
            path = Path(root) / "catalog.json"
            path.write_text(json.dumps({"servers": {"fixture": {"url": "https://example.com/mcp", "tokenEnv": "JOB_TOKEN", "allowedTools": ["echo"], "callTimeoutMs": 1234}}}), encoding="utf-8")
            configs = load_mcp_configs(["fixture"], {"TINY_MCP_CONFIG": str(path), "JOB_TOKEN": "secret"})
            self.assertEqual(configs, [McpConfig("fixture", "https://example.com/mcp", {"Authorization": "Bearer secret"}, ["echo"], 1234)])
            path.write_text(json.dumps({"servers": {"fixture": {"url": "https://example.com", "extra": True}}}), encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "Unknown MCP server fixture field: extra"): load_mcp_configs(["fixture"], {"TINY_MCP_CONFIG": str(path)})
            path.write_text(json.dumps({"servers": {"fixture": {"url": "https://example.com", "tokenEnv": "TOKEN"}}}), encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "environment variable is not set"): load_mcp_configs(["fixture"], {"TINY_MCP_CONFIG": str(path)})
            for url, error in (("not a URL", "valid URL"), ("http://example.com/mcp", "use HTTPS"), ("https://user:pass@example.com/mcp", "credentials")):
                path.write_text(json.dumps({"servers": {"fixture": {"url": url}}}), encoding="utf-8")
                with self.assertRaisesRegex(ValueError, error): load_mcp_configs(["fixture"], {"TINY_MCP_CONFIG": str(path)})

    async def test_modern_json_and_sse_list_call_auth_normalization_and_errors(self):
        for sse, chunked in ((False, False), (False, True), (True, False), (True, True)):
            with self.subTest(sse=sse, chunked=chunked):
                fixture = McpFixture(sse=sse, chunked=chunked, token="secret")
                try:
                    loaded = await load_mcp_tools(McpConfig("fixture", fixture.url, {"Authorization": "Bearer secret"}))
                    self.addCleanup(loaded.close)
                    self.assertEqual(loaded.protocol_version, "2026-07-28")
                    self.assertEqual(display_tool_name(loaded.tools[0]["function"]["name"]), "mcp:fixture/echo")
                    self.assertEqual(await loaded.tools[0]["execute"]({"message": "hello"}), "hello")
                    self.assertEqual(await loaded.tools[1]["execute"]({}), 'count: 2\n\nStructured content:\n{"count":2}')
                    with self.assertRaisesRegex(RuntimeError, "MCP tool error: not found"): await loaded.tools[2]["execute"]({})
                    with self.assertRaisesRegex(RuntimeError, "Unsupported MCP content type: image"): await loaded.tools[3]["execute"]({})
                    self.assertEqual(await loaded.tools[5]["execute"]({}), "Resource: file:///README.md\nresource body")
                    truncated = await loaded.tools[5]["execute"]({"text": "你" * 20_000})
                    self.assertLessEqual(len(truncated.encode()), 50 * 1024)
                    self.assertTrue(truncated.endswith("[MCP result truncated to 50KB]"))
                    with self.assertRaisesRegex(RuntimeError, "Unsupported MCP content type: resource"): await loaded.tools[6]["execute"]({})
                    self.assertTrue(all(call["authorization"] == "Bearer secret" for call in fixture.calls))
                    await loaded.close(); await loaded.close()
                    with self.assertRaisesRegex(RuntimeError, "connection is closed"): await loaded.tools[0]["execute"]({"message": "x"})
                finally: fixture.close()

    async def test_chunked_sse_returns_before_terminal_chunk_with_fragmented_event(self):
        fixture = McpFixture(sse=True, chunked=True, sse_terminal_delay=0.3)
        try:
            loaded = await asyncio.wait_for(
                load_mcp_tools(McpConfig("fixture", fixture.url, allowed_tools=["echo"], call_timeout_ms=100)),
                0.2,
            )
            self.assertEqual(
                await asyncio.wait_for(loaded.tools[0]["execute"]({"message": "prompt"}), 0.2),
                "prompt",
            )
            await loaded.close()
        finally: fixture.close()

    async def test_truncated_http_framing_is_normalized(self):
        responses = (
            b"HTTP/1.1 200 OK\r\nContent-Length: 4\r\n\r\nab",
            b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n4\r\nab",
            b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n2\r\nab\r",
        )
        for response in responses:
            with self.subTest(response=response):
                reader = asyncio.StreamReader()
                reader.feed_data(response); reader.feed_eof()
                with self.assertRaisesRegex(RuntimeError, "invalid fixture response"):
                    await read_http_response(reader, time.monotonic() + 1, 1024, "invalid fixture response", "too large")

    async def test_resource_normalization_rejects_blob_and_allows_missing_uri(self):
        self.assertEqual(
            _normalize_result({"content": [{"type": "resource", "resource": {"text": "body"}}]}),
            "body",
        )
        with self.assertRaisesRegex(RuntimeError, "Unsupported MCP content type: resource"):
            _normalize_result({
                "content": [{"type": "resource", "resource": {"text": "body", "blob": "AA=="}}]
            })

    async def test_http_errors_are_sanitized_and_never_fall_back(self):
        canary = "SECRET-CANARY-DO-NOT-LEAK"
        for status in (401, 404, 503):
            with self.subTest(status=status):
                fixture = McpFixture(http_error=status, error_body=canary)
                try:
                    with self.assertRaises(RuntimeError) as raised:
                        await load_mcp_tools(McpConfig("fixture", fixture.url))
                    self.assertIn(f"MCP HTTP {status}", str(raised.exception))
                    self.assertNotIn(canary, str(raised.exception))
                    self.assertEqual([call["request"]["method"] for call in fixture.calls], ["server/discover"])
                finally: fixture.close()

    async def test_json_rpc_errors_are_sanitized_for_json_and_sse(self):
        canary = "SECRET-RPC-CANARY"
        error = {"code": -32603, "message": canary, "data": {"secret": canary}}
        for sse in (False, True):
            for method in ("server/discover", "tools/list", "tools/call"):
                with self.subTest(sse=sse, method=method):
                    fixture = McpFixture(sse=sse, rpc_errors={method: error})
                    try:
                        with self.assertRaises(RuntimeError) as raised:
                            loaded = await load_mcp_tools(McpConfig("fixture", fixture.url))
                            self.addCleanup(loaded.close)
                            await loaded.tools[0]["execute"]({"message": "hello"})
                        self.assertNotIn(canary, str(raised.exception))
                    finally: fixture.close()

    async def test_negotiation_corrective_retry_and_loud_rejection(self):
        mutual = {"code": -32022, "message": "retry", "data": {"supported": ["2026-07-28"]}}
        fixture = McpFixture(rpc_errors={"server/discover": [mutual, None]})
        try:
            loaded = await load_mcp_tools(McpConfig("fixture", fixture.url)); await loaded.close()
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
                        await load_mcp_tools(McpConfig("fixture", fixture.url))
                    self.assertEqual(fixture.method_counts["server/discover"], 1)
                finally: fixture.close()

    async def test_mcp_header_encoding_mirroring_and_invalid_declaration_exclusion(self):
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
            loaded = await load_mcp_tools(McpConfig("fixture", fixture.url))
            await loaded.tools[0]["execute"]({"message": " café ", "nested": {"enabled": True}})
            call = fixture.calls[-1]["headers"]
            self.assertEqual(call["mcp-name"], "echo")
            self.assertEqual(call["mcp-param-message"], "=?base64?IGNhZsOpIA==?=")
            self.assertEqual(call["mcp-param-enabled"], "true")
            await loaded.close()
        finally: fixture.close()
        invalid = McpFixture(tools=[{"name": "echo", "inputSchema": {"type": "object", "items": {"type": "string", "x-mcp-header": "Bad"}}}])
        try:
            loaded = await load_mcp_tools(McpConfig("fixture", invalid.url))
            self.assertEqual(loaded.tools, []); await loaded.close()
        finally: invalid.close()

    async def test_tools_list_pagination_aggregates_under_bounds(self):
        pages = [
            [{"name": "echo", "inputSchema": {"type": "object"}}],
            [{"name": "structured", "inputSchema": {"type": "object"}}],
        ]
        fixture = McpFixture(pages=pages)
        try:
            loaded = await load_mcp_tools(McpConfig("fixture", fixture.url))
            self.assertEqual(len(loaded.tools), 2)
            list_calls = [call["request"]["params"] for call in fixture.calls if call["request"]["method"] == "tools/list"]
            self.assertEqual(list_calls, [{"_meta": list_calls[0]["_meta"]}, {"cursor": "1", "_meta": list_calls[1]["_meta"]}])
            await loaded.close()
        finally: fixture.close()

    async def test_allowlist_bounds_mapping_timeout_and_cancellation(self):
        fixture = McpFixture()
        try:
            loaded = await load_mcp_tools(McpConfig("fixture", fixture.url, allowed_tools=["slow"], call_timeout_ms=30))
            self.assertEqual(len(loaded.tools), 1)
            with self.assertRaisesRegex(TimeoutError, "timed out"): await loaded.tools[0]["execute"]({"delay": 1})
            await loaded.close()
            with self.assertRaisesRegex(RuntimeError, "allowed tools were not found"):
                await load_mcp_tools(McpConfig("fixture", fixture.url, allowed_tools=["missing"]))
            cancelled = asyncio.Event(); loaded = await load_mcp_tools(McpConfig("fixture", fixture.url, allowed_tools=["slow"]))
            task = asyncio.create_task(loaded.tools[0]["execute"]({"delay": 1}, cancelled))
            await asyncio.sleep(0.05); cancelled.set()
            with self.assertRaisesRegex(InterruptedError, "aborted"): await asyncio.wait_for(task, 1)
            await loaded.close()
        finally: fixture.close()
        too_many = McpFixture(tools=[{"name": f"tool{i}", "inputSchema": {}} for i in range(65)])
        try:
            with self.assertRaisesRegex(RuntimeError, "more than 64 tools"): await load_mcp_tools(McpConfig("fixture", too_many.url))
        finally: too_many.close()
        malformed = McpFixture(tools=[{"name": "bad", "inputSchema": None}])
        try:
            with self.assertRaisesRegex(RuntimeError, "Invalid MCP tool schema"): await load_mcp_tools(McpConfig("fixture", malformed.url))
        finally: malformed.close()
        long_name = McpFixture(tools=[{"name": "x" * 60, "inputSchema": {}}])
        try:
            with self.assertRaisesRegex(RuntimeError, "exceeds 64 characters"): await load_mcp_tools(McpConfig("fixture", long_name.url))
        finally: long_name.close()

    async def test_close_cancels_only_owned_request(self):
        fixture = McpFixture()
        try:
            loaded = await load_mcp_tools(McpConfig("fixture", fixture.url, allowed_tools=["slow"]))
            continued = asyncio.Event()

            async def caller():
                try: await loaded.tools[0]["execute"]({"delay": 1})
                except asyncio.CancelledError: pass
                continued.set()
                await asyncio.sleep(10)

            caller_task = asyncio.create_task(caller())
            await asyncio.sleep(0.05)
            await asyncio.wait_for(loaded.close(), 1)
            await asyncio.wait_for(continued.wait(), 1)
            self.assertFalse(caller_task.done())
            caller_task.cancel(); await asyncio.gather(caller_task, return_exceptions=True)
        finally: fixture.close()


if __name__ == "__main__": unittest.main()
