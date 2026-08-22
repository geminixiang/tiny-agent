from __future__ import annotations

import json
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


class McpFixture:
    def __init__(self, *, sse: bool = False, token: str | None = None, tools: list[dict] | None = None):
        self.sse = sse
        self.token = token
        self.calls: list[dict] = []
        self.deleted_sessions: list[str] = []
        self.tools = tools or [
            {"name": "echo", "description": "Return the supplied message.", "inputSchema": {"type": "object", "properties": {"message": {"type": "string"}}, "required": ["message"]}},
            {"name": "structured", "inputSchema": {"type": "object"}},
            {"name": "fail", "inputSchema": {"type": "object"}},
            {"name": "image", "inputSchema": {"type": "object"}},
            {"name": "slow", "inputSchema": {"type": "object"}},
        ]
        fixture = self

        class Handler(BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            def do_POST(self):
                length = int(self.headers.get("Content-Length", "0"))
                request = json.loads(self.rfile.read(length))
                fixture.calls.append({"request": request, "authorization": self.headers.get("Authorization")})
                if fixture.token and self.headers.get("Authorization") != f"Bearer {fixture.token}":
                    self.send_response(401); self.send_header("Content-Length", "0"); self.end_headers(); return
                if "id" not in request:
                    self.send_response(202); self.send_header("Content-Length", "0"); self.end_headers(); return
                method = request["method"]
                if method == "initialize": result = {"protocolVersion": "2025-06-18", "capabilities": {"tools": {}}, "serverInfo": {"name": "fixture", "version": "1"}}
                elif method == "tools/list": result = {"tools": fixture.tools}
                else:
                    name = request["params"]["name"]; args = request["params"].get("arguments", {})
                    if name == "echo": result = {"content": [{"type": "text", "text": args["message"]}]}
                    elif name == "structured": result = {"content": [{"type": "text", "text": "count: 2"}], "structuredContent": {"count": 2}}
                    elif name == "fail": result = {"content": [{"type": "text", "text": "not found"}], "isError": True}
                    elif name == "image": result = {"content": [{"type": "image", "data": "AA=="}]}
                    elif name == "slow":
                        time.sleep(args.get("delay", 1)); result = {"content": [{"type": "text", "text": "done"}]}
                response = {"jsonrpc": "2.0", "id": request["id"], "result": result}
                raw = json.dumps(response, separators=(",", ":")).encode()
                self.send_response(200)
                if fixture.sse:
                    raw = b"event: message\ndata: " + raw + b"\n\n"
                    self.send_header("Content-Type", "text/event-stream")
                else: self.send_header("Content-Type", "application/json")
                self.send_header("Mcp-Session-Id", "fixture-session")
                self.send_header("Content-Length", str(len(raw))); self.end_headers()
                try: self.wfile.write(raw)
                except BrokenPipeError: pass

            def do_DELETE(self):
                session_id = self.headers.get("Mcp-Session-Id")
                if session_id: fixture.deleted_sessions.append(session_id)
                self.send_response(200); self.send_header("Content-Length", "0"); self.end_headers()

            def log_message(self, *_): pass

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True); self.thread.start()
        self.url = f"http://127.0.0.1:{self.server.server_port}/mcp"

    def close(self):
        self.server.shutdown(); self.server.server_close(); self.thread.join()
