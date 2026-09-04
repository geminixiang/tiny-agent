import json
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit


class McpFixture:
    def __init__(
        self,
        *,
        sse: bool = False,
        chunked: bool = False,
        token: str | None = None,
        tools: list[dict] | None = None,
        http_error: int | None = None,
        error_body: str = "",
        rpc_errors: dict[str, dict] | None = None,
        pages: list[list[dict]] | None = None,
        sse_terminal_delay: float = 0,
        legacy: bool = False,
        list_delay: float = 0,
    ):
        self.sse = sse
        self.chunked = chunked
        self.sse_terminal_delay = sse_terminal_delay
        self.legacy = legacy
        self.list_delay = list_delay
        self.token = token
        self.http_error = http_error
        self.error_body = error_body
        self.rpc_errors = rpc_errors or {}
        self.pages = pages
        self.method_counts: dict[str, int] = {}
        self.calls: list[dict] = []
        self.tools = tools or [
            {"name": "echo", "description": "Return the supplied message.", "inputSchema": {"type": "object", "properties": {"message": {"type": "string"}}, "required": ["message"]}},
            {"name": "structured", "inputSchema": {"type": "object"}},
            {"name": "fail", "inputSchema": {"type": "object"}},
            {"name": "image", "inputSchema": {"type": "object"}},
            {"name": "slow", "inputSchema": {"type": "object"}},
            {"name": "text_resource", "inputSchema": {"type": "object"}},
            {"name": "binary_resource", "inputSchema": {"type": "object"}},
        ]
        fixture = self

        class Handler(BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            def do_POST(self):
                length = int(self.headers.get("Content-Length", "0"))
                request = json.loads(self.rfile.read(length))
                headers = {name.lower(): value for name, value in self.headers.items()}
                fixture.calls.append({"request": request, "authorization": self.headers.get("Authorization"), "headers": headers})
                if fixture.token and self.headers.get("Authorization") != f"Bearer {fixture.token}":
                    self._raw_error(401, b"unauthorized secret")
                    return
                if fixture.http_error is not None:
                    self._raw_error(fixture.http_error, fixture.error_body.encode())
                    return
                method = request.get("method")
                fixture.method_counts[method] = fixture.method_counts.get(method, 0) + 1
                configured_error = fixture.rpc_errors.get(method)
                if configured_error:
                    errors = configured_error if isinstance(configured_error, list) else [configured_error]
                    index = min(fixture.method_counts[method] - 1, len(errors) - 1)
                    error = errors[index]
                    if error is not None:
                        self._rpc_error(request, error.get("code", -32603), error.get("message", "canary"), error.get("data"))
                        return
                if fixture.legacy:
                    self._handle_legacy(request)
                    return
                self._handle_modern(request)

            def do_DELETE(self):
                self.send_response(200)
                self.send_header("Content-Length", "0")
                self.end_headers()

            def _handle_legacy(self, request):
                method = request.get("method")
                params = request.get("params", {})
                if method == "server/discover":
                    self._rpc_error(request, -32601, "method not found")
                    return
                if method == "initialize":
                    self._rpc_result(
                        request,
                        {
                            "protocolVersion": "2025-03-26",
                            "capabilities": {"tools": {}},
                            "serverInfo": {"name": "fixture", "version": "1"},
                        },
                        "fixture-session",
                    )
                    return
                if method == "notifications/initialized":
                    self.send_response(202)
                    self.send_header("Content-Length", "0")
                    self.end_headers()
                    return
                if self.headers.get("Mcp-Session-Id") != "fixture-session":
                    self._rpc_error(request, -32000, "missing session")
                    return
                if method == "tools/list":
                    self._rpc_result(request, {"tools": fixture.tools})
                    return
                if method == "tools/call":
                    self._rpc_result(request, self._tool_result(params))
                    return
                self._rpc_error(request, -32601, "method not found")

            def _handle_modern(self, request):
                method = request.get("method")
                params = request.get("params", {})
                meta = params.get("_meta") if isinstance(params, dict) else None
                expected_meta = {
                    "io.modelcontextprotocol/protocolVersion": "2026-07-28",
                    "io.modelcontextprotocol/clientInfo": {"name": "tiny-agent", "version": "0.1.0"},
                    "io.modelcontextprotocol/clientCapabilities": {},
                }
                if (
                    method == "initialize"
                    or self.headers.get("Mcp-Session-Id")
                    or self.headers.get("MCP-Protocol-Version") != "2026-07-28"
                    or self.headers.get("Mcp-Method") != method
                    or meta != expected_meta
                ):
                    self._rpc_error(request, -32022, "invalid modern metadata")
                    return
                if method == "tools/call" and self.headers.get("Mcp-Name") != _encode_mcp_param_value(params.get("name", "")):
                    self._rpc_error(request, -32022, "invalid tool metadata")
                    return
                if method == "server/discover":
                    result = {
                        "resultType": "complete",
                        "supportedVersions": ["2026-07-28"],
                        "capabilities": {"tools": {}},
                        "_meta": {"io.modelcontextprotocol/serverInfo": {"name": "fixture", "version": "1"}},
                    }
                elif method == "tools/list":
                    if fixture.list_delay:
                        time.sleep(fixture.list_delay)
                    if fixture.pages is None:
                        result = {"resultType": "complete", "tools": fixture.tools, "ttlMs": 0, "cacheScope": "private"}
                    else:
                        page = int(params.get("cursor", "0"))
                        result = {"resultType": "complete", "tools": fixture.pages[page], "ttlMs": 0, "cacheScope": "private"}
                        if page + 1 < len(fixture.pages):
                            result["nextCursor"] = str(page + 1)
                elif method == "tools/call":
                    result = {"resultType": "complete", **self._tool_result(params)}
                else:
                    self._rpc_error(request, -32601, "method not found")
                    return
                self._rpc_result(request, result)

            def _tool_result(self, params):
                name = params["name"]
                args = params.get("arguments", {})
                if name == "echo":
                    return {"content": [{"type": "text", "text": args["message"]}]}
                if name == "structured":
                    return {"content": [{"type": "text", "text": "count: 2"}], "structuredContent": {"count": 2}}
                if name == "fail":
                    return {"content": [{"type": "text", "text": "not found"}], "isError": True}
                if name == "image":
                    return {"content": [{"type": "image", "data": "AA==", "mimeType": "image/png"}]}
                if name == "slow":
                    time.sleep(args.get("delay", 1))
                    return {"content": [{"type": "text", "text": "done"}]}
                if name == "text_resource":
                    return {"content": [{"type": "resource", "resource": {"uri": "file:///README.md", "mimeType": "text/markdown", "text": args.get("text", "resource body")}}]}
                if name == "binary_resource":
                    return {"content": [{"type": "resource", "resource": {"uri": "file:///image.png", "mimeType": "image/png", "blob": "AA=="}}]}
                raise AssertionError(f"unknown tool {name}")

            def _rpc_result(self, request, result, session_id=None):
                response = {"jsonrpc": "2.0", "id": request["id"], "result": result}
                self._send_json(response, session_id)

            def _rpc_error(self, request, code, message, data=None):
                error = {"code": code, "message": message}
                if data is not None:
                    error["data"] = data
                response = {"jsonrpc": "2.0", "id": request.get("id"), "error": error}
                self._send_json(response)

            def _send_json(self, response, session_id=None):
                raw = json.dumps(response, separators=(",", ":")).encode()
                self.send_response(200)
                if session_id is not None:
                    self.send_header("Mcp-Session-Id", session_id)
                if fixture.sse:
                    raw = b"event: message\ndata: " + raw + b"\n\n"
                    self.send_header("Content-Type", "text/event-stream")
                else:
                    self.send_header("Content-Type", "application/json")
                if fixture.chunked:
                    self.send_header("Transfer-Encoding", "chunked")
                    self.end_headers()
                    midpoint = max(1, len(raw) // 2)
                    chunks = [raw[index : index + 3] for index in range(0, len(raw), 3)] if fixture.sse_terminal_delay else (raw[:midpoint], raw[midpoint:])
                    try:
                        for chunk in chunks:
                            self.wfile.write(f"{len(chunk):x};fixture=yes\r\n".encode() + chunk + b"\r\n")
                        self.wfile.flush()
                        if fixture.sse_terminal_delay:
                            time.sleep(fixture.sse_terminal_delay)
                        self.wfile.write(b"0\r\nX-Fixture: done\r\n\r\n")
                    except BrokenPipeError, ConnectionResetError:
                        pass
                    return
                self.send_header("Content-Length", str(len(raw)))
                self.end_headers()
                try:
                    self.wfile.write(raw)
                except BrokenPipeError:
                    pass

            def _raw_error(self, status, body):
                self.send_response(status)
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                try:
                    self.wfile.write(body)
                except BrokenPipeError:
                    pass

            def log_message(self, *_):
                pass

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.url = f"http://127.0.0.1:{self.server.server_port}/mcp"

    def close(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()


def _encode_mcp_param_value(value: str) -> str:
    import base64

    if value and value == value.strip() and not (value.startswith("=?base64?") and value.endswith("?=")) and all(character == "\t" or 32 <= ord(character) <= 126 for character in value):
        return value
    return f"=?base64?{base64.b64encode(value.encode()).decode()}?="
