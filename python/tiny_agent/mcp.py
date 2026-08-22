from __future__ import annotations

import base64
import http.client
import json
import math
import os
import re
import socket
import threading
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Callable
from urllib.parse import urlsplit

MAX_RESULT_BYTES = 50 * 1024
MAX_SCHEMA_BYTES = 50 * 1024
MAX_DESCRIPTION_BYTES = 8 * 1024
MAX_SCHEMA_DEPTH = 20
MAX_TOOLS = 64
_PROTOCOL_VERSION = "2025-06-18"


@dataclass(frozen=True)
class McpConfig:
    alias: str
    url: str
    headers: dict[str, str] | None = None
    allowed_tools: list[str] | None = None
    call_timeout_ms: float = 30_000


@dataclass
class LoadedMcpTools:
    tools: list[dict]
    protocol_era: str
    protocol_version: str
    close: Callable[[], None]


def split_mcp_aliases(values: list[str] | None) -> list[str]:
    aliases: list[str] = []
    for value in values or []:
        for item in value.split(","):
            alias = item.strip()
            if alias and alias not in aliases: aliases.append(alias)
    return aliases


def load_mcp_configs(aliases: list[str], env: dict[str, str] | os._Environ[str] | None = None, home: Path | None = None) -> list[McpConfig]:
    if not aliases: return []
    env = os.environ if env is None else env
    home = Path.home() if home is None else home
    path = Path(env["TINY_MCP_CONFIG"]).resolve() if env.get("TINY_MCP_CONFIG") else (home / ".tiny-agent/mcp.json").resolve()
    try: value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError): raise ValueError("Failed to load MCP catalog: file is missing, unreadable, or invalid JSON") from None
    catalog = _validate_catalog(value)
    for alias in aliases:
        if alias not in catalog: raise ValueError(f"Unknown MCP server: {alias}")
    configs = []
    for alias in aliases:
        server = catalog[alias]
        token_env = server.get("tokenEnv")
        token = env.get(token_env) if token_env else None
        if token_env and not token: raise ValueError(f"MCP token environment variable is not set: {token_env}")
        configs.append(McpConfig(
            alias=alias,
            url=server["url"],
            headers={"Authorization": f"Bearer {token}"} if token else None,
            allowed_tools=server.get("allowedTools"),
            call_timeout_ms=server.get("callTimeoutMs", 30_000),
        ))
    return configs


def _validate_catalog(value: object) -> dict[str, dict]:
    root = _object(value, "MCP catalog")
    _unknown_field(root, {"servers"}, "MCP catalog")
    servers = _object(root.get("servers"), "MCP catalog servers")
    validated: dict[str, dict] = {}
    for alias, raw in servers.items():
        if not isinstance(alias, str) or not alias.strip(): raise ValueError("MCP server alias must not be empty")
        server = _object(raw, f"MCP server {alias}")
        _unknown_field(server, {"url", "tokenEnv", "allowedTools", "callTimeoutMs"}, f"MCP server {alias}")
        if not isinstance(server.get("url"), str) or not server["url"]: raise ValueError(f"MCP server {alias} url must be a string")
        token_env = server.get("tokenEnv")
        if token_env is not None and (not isinstance(token_env, str) or not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", token_env)):
            raise ValueError(f"MCP server {alias} tokenEnv must be an environment variable name")
        allowed = server.get("allowedTools")
        if allowed is not None:
            if not isinstance(allowed, list) or any(not isinstance(tool, str) or not tool for tool in allowed):
                raise ValueError(f"MCP server {alias} allowedTools must contain nonempty strings")
            if len(set(allowed)) != len(allowed): raise ValueError(f"MCP server {alias} allowedTools must not contain duplicates")
        timeout = server.get("callTimeoutMs")
        if timeout is not None and (isinstance(timeout, bool) or not isinstance(timeout, (int, float)) or not math.isfinite(timeout) or timeout <= 0):
            raise ValueError(f"MCP server {alias} callTimeoutMs must be a positive number")
        validated[alias] = dict(server)
    return validated


def _object(value: object, name: str) -> dict:
    if not isinstance(value, dict): raise ValueError(f"{name} must be an object")
    return value


def _unknown_field(value: dict, allowed: set[str], name: str) -> None:
    unknown = next((key for key in value if key not in allowed), None)
    if unknown is not None: raise ValueError(f"Unknown {name} field: {unknown}")


class _McpClient:
    def __init__(self, config: McpConfig):
        self.config = _validate_config(config)
        self.session_id: str | None = None
        self.protocol_version: str | None = None
        self.closed = False
        self.next_id = 1
        self.lock = threading.Lock()
        self.connections: set[http.client.HTTPConnection] = set()

    def connect(self, cancelled: threading.Event | None = None, deadline: float | None = None) -> None:
        deadline = deadline or time.monotonic() + 10
        result = self.request("initialize", {
            "protocolVersion": _PROTOCOL_VERSION,
            "capabilities": {},
            "clientInfo": {"name": "tiny-agent", "version": "0.1.0"},
        }, cancelled, _remaining_timeout_ms(deadline))
        if not isinstance(result, dict) or not isinstance(result.get("protocolVersion"), str):
            raise RuntimeError("MCP server did not negotiate a protocol version")
        self.protocol_version = result["protocolVersion"]
        self.notify("notifications/initialized", {}, _remaining_timeout_ms(deadline))

    def request(self, method: str, params: dict, cancelled: threading.Event | None, timeout_ms: float) -> object:
        with self.lock:
            request_id = self.next_id
            self.next_id += 1
        response = self._post({"jsonrpc": "2.0", "id": request_id, "method": method, "params": params}, cancelled, timeout_ms)
        if not isinstance(response, dict) or response.get("jsonrpc") != "2.0" or response.get("id") != request_id:
            raise RuntimeError("Invalid MCP JSON-RPC response")
        if "error" in response:
            error = response["error"]
            message = error.get("message") if isinstance(error, dict) else str(error)
            raise RuntimeError(f"MCP request failed: {message}")
        if "result" not in response: raise RuntimeError("Invalid MCP JSON-RPC response")
        return response["result"]

    def notify(self, method: str, params: dict, timeout_ms: float) -> None:
        self._post({"jsonrpc": "2.0", "method": method, "params": params}, None, timeout_ms, notification=True)

    def _post(self, payload: dict, cancelled: threading.Event | None, timeout_ms: float, notification: bool = False) -> object:
        if self.closed: raise RuntimeError("MCP connection is closed")
        if cancelled and cancelled.is_set(): raise InterruptedError("Operation aborted")
        parsed = urlsplit(self.config.url)
        connection_type = http.client.HTTPSConnection if parsed.scheme == "https" else http.client.HTTPConnection
        connection = connection_type(parsed.hostname, parsed.port, timeout=timeout_ms / 1000)
        with self.lock: self.connections.add(connection)
        done = threading.Event()
        timed_out = threading.Event()

        def stop_connection() -> None:
            deadline = time.monotonic() + timeout_ms / 1000
            while not done.wait(0.01):
                if cancelled and cancelled.is_set():
                    _interrupt_connection(connection)
                    return
                if time.monotonic() >= deadline:
                    timed_out.set(); _interrupt_connection(connection)
                    return

        watcher = threading.Thread(target=stop_connection, daemon=True)
        watcher.start()
        headers = {"Content-Type": "application/json", "Accept": "application/json, text/event-stream", **(self.config.headers or {})}
        if self.session_id: headers["Mcp-Session-Id"] = self.session_id
        if self.protocol_version: headers["MCP-Protocol-Version"] = self.protocol_version
        path = parsed.path or "/"
        if parsed.query: path += f"?{parsed.query}"
        body = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode()
        try:
            connection.request("POST", path, body, headers)
            response = connection.getresponse()
            session_id = response.getheader("Mcp-Session-Id")
            if session_id: self.session_id = session_id
            if notification and response.status in (202, 204): return {}
            if response.status < 200 or response.status >= 300:
                raw = response.read(64 * 1024).decode(errors="replace")
                raise RuntimeError(f"MCP HTTP {response.status}: {raw}")
            content_type = response.getheader("Content-Type", "").split(";", 1)[0].strip().lower()
            if content_type == "text/event-stream": return _read_sse(response, payload.get("id"))
            raw = response.read(10 * 1024 * 1024 + 1)
            if len(raw) > 10 * 1024 * 1024: raise RuntimeError("MCP response exceeded 10MB")
            if notification and not raw: return {}
            return json.loads(raw)
        except (OSError, socket.timeout, http.client.HTTPException, json.JSONDecodeError) as error:
            if cancelled and cancelled.is_set(): raise InterruptedError("Operation aborted") from error
            if timed_out.is_set() or isinstance(error, socket.timeout): raise TimeoutError("MCP request timed out") from error
            raise RuntimeError(f"MCP connection failed: {error}") from error
        finally:
            done.set(); connection.close()
            with self.lock: self.connections.discard(connection)

    def close(self) -> None:
        with self.lock:
            if self.closed: return
            self.closed = True
            connections = list(self.connections)
        for connection in connections: connection.close()
        if not self.session_id: return
        try: self._delete_session()
        except Exception: pass

    def _delete_session(self) -> None:
        parsed = urlsplit(self.config.url)
        connection_type = http.client.HTTPSConnection if parsed.scheme == "https" else http.client.HTTPConnection
        connection = connection_type(parsed.hostname, parsed.port, timeout=1)
        path = parsed.path or "/"
        if parsed.query: path += f"?{parsed.query}"
        headers = {**(self.config.headers or {}), "Mcp-Session-Id": self.session_id or ""}
        if self.protocol_version: headers["MCP-Protocol-Version"] = self.protocol_version
        try:
            connection.request("DELETE", path, headers=headers)
            response = connection.getresponse()
            response.read(64 * 1024)
        finally: connection.close()


def _remaining_timeout_ms(deadline: float) -> float:
    remaining = (deadline - time.monotonic()) * 1000
    if remaining <= 0: raise TimeoutError("MCP request timed out")
    return remaining


def _interrupt_connection(connection: http.client.HTTPConnection) -> None:
    sock = connection.sock
    if sock:
        try: sock.shutdown(socket.SHUT_RDWR)
        except OSError: pass
    connection.close()


def _read_sse(response: http.client.HTTPResponse, request_id: int | None) -> object:
    data: list[str] = []
    total = 0
    while True:
        line = response.readline()
        if not line: break
        total += len(line)
        if total > 10 * 1024 * 1024: raise RuntimeError("MCP response exceeded 10MB")
        decoded = line.decode("utf-8").rstrip("\r\n")
        if decoded.startswith("data:"): data.append(decoded[5:].lstrip())
        if decoded or not data: continue
        value = json.loads("\n".join(data)); data.clear()
        if request_id is None or isinstance(value, dict) and value.get("id") == request_id: return value
    if data:
        value = json.loads("\n".join(data))
        if request_id is None or isinstance(value, dict) and value.get("id") == request_id: return value
    raise RuntimeError("MCP SSE response ended without a matching result")


def load_mcp_tools(config: McpConfig, cancelled: threading.Event | None = None, startup_timeout_ms: float = 10_000) -> LoadedMcpTools:
    client = _McpClient(config)
    deadline = time.monotonic() + startup_timeout_ms / 1000
    try:
        client.connect(cancelled, deadline)
        listed = client.request("tools/list", {}, cancelled, _remaining_timeout_ms(deadline))
        if not isinstance(listed, dict) or not isinstance(listed.get("tools"), list): raise RuntimeError("Invalid MCP tools/list response")
        remote_tools = listed["tools"]
        if len(remote_tools) > MAX_TOOLS: raise RuntimeError(f"MCP server returned more than {MAX_TOOLS} tools")
        remote_names: set[str] = set(); mapped_names: set[str] = set(); tools = []
        allowed = set(client.config.allowed_tools) if client.config.allowed_tools is not None else None
        for remote in remote_tools:
            if not isinstance(remote, dict) or not isinstance(remote.get("name"), str): raise RuntimeError("Invalid MCP tool definition")
            remote_name = remote["name"]
            if remote_name in remote_names: raise RuntimeError(f"duplicate MCP tool name: {remote_name}")
            remote_names.add(remote_name)
            if allowed is not None and remote_name not in allowed: continue
            schema = remote.get("inputSchema")
            if not isinstance(schema, dict): raise RuntimeError(f"Invalid MCP tool schema: {remote_name}")
            _validate_schema(schema, remote_name)
            description = remote.get("description")
            if description is not None and not isinstance(description, str): raise RuntimeError(f"Invalid MCP tool description: {remote_name}")
            if description and len(description.encode()) > MAX_DESCRIPTION_BYTES: raise RuntimeError(f"MCP tool description exceeds 8KB: {remote_name}")
            name = _map_tool_name(client.config.alias, remote_name)
            if name in mapped_names: raise RuntimeError(f"duplicate mapped MCP tool name: {name}")
            mapped_names.add(name)

            def execute(args: dict, call_cancelled: threading.Event | None = None, remote_name: str = remote_name) -> str:
                if client.closed: raise RuntimeError("MCP connection is closed")
                if not isinstance(args, dict): raise ValueError("MCP tool arguments must be a JSON object")
                result = client.request("tools/call", {"name": remote_name, "arguments": args}, call_cancelled, client.config.call_timeout_ms)
                if not isinstance(result, dict): raise RuntimeError("Invalid MCP tools/call response")
                if result.get("resultType") == "input_required": raise RuntimeError("MCP tool requires additional user input; input_required is not supported")
                normalized = _normalize_result(result)
                if result.get("isError"): raise RuntimeError(f"MCP tool error: {normalized}")
                return normalized

            tools.append({"type": "function", "function": {
                "name": name,
                "description": description or f"MCP tool {remote_name} from {client.config.alias}.",
                "parameters": schema,
            }, "execute": execute})
        if allowed is not None:
            missing = [name for name in client.config.allowed_tools or [] if name not in remote_names]
            if missing: raise RuntimeError(f"MCP allowed tools were not found: {', '.join(missing)}")
        return LoadedMcpTools(tools, "modern", client.protocol_version or "", client.close)
    except BaseException:
        client.close()
        raise


def _validate_config(config: McpConfig) -> McpConfig:
    if not isinstance(config, McpConfig): raise ValueError("MCP config must be an object")
    alias = config.alias.strip() if isinstance(config.alias, str) else ""
    if not alias: raise ValueError("MCP alias must be a nonempty string")
    if not isinstance(config.url, str): raise ValueError("MCP URL must be a valid URL")
    parsed = urlsplit(config.url)
    if not parsed.scheme or not parsed.hostname: raise ValueError("MCP URL must be a valid URL")
    try: port = parsed.port
    except ValueError: raise ValueError("MCP URL must be a valid URL") from None
    if parsed.scheme != "https" and not (parsed.scheme == "http" and parsed.hostname in ("127.0.0.1", "localhost", "::1")):
        raise ValueError("MCP URL must use HTTPS unless it targets loopback")
    if parsed.username or parsed.password: raise ValueError("MCP URL must not contain credentials")
    timeout = config.call_timeout_ms
    if isinstance(timeout, bool) or not isinstance(timeout, (int, float)) or not math.isfinite(timeout) or timeout <= 0: raise ValueError("MCP callTimeoutMs must be a positive number")
    if config.headers is not None and (not isinstance(config.headers, dict) or any(
        not isinstance(key, str) or not re.fullmatch(r"[!#$%&'*+.^_`|~0-9A-Za-z-]+", key) or
        not isinstance(value, str) or any(ord(char) < 32 and char != "\t" or ord(char) == 127 for char in value)
        for key, value in config.headers.items()
    )):
        raise ValueError("MCP headers contain an invalid name or value")
    allowed = config.allowed_tools
    if allowed is not None:
        if not isinstance(allowed, list) or any(not isinstance(name, str) or not name for name in allowed): raise ValueError("MCP allowedTools must contain nonempty strings")
        if len(set(allowed)) != len(allowed): raise ValueError("MCP allowedTools must not contain duplicates")
    return McpConfig(alias, config.url, config.headers, list(allowed) if allowed is not None else None, timeout)


def _validate_schema(schema: object, tool_name: str) -> None:
    try: encoded = json.dumps(schema, ensure_ascii=False, separators=(",", ":")).encode()
    except (TypeError, ValueError): raise RuntimeError(f"MCP tool schema is not JSON-serializable: {tool_name}") from None
    if len(encoded) > MAX_SCHEMA_BYTES: raise RuntimeError(f"MCP tool schema exceeds 50KB: {tool_name}")
    if _json_depth(schema) > MAX_SCHEMA_DEPTH: raise RuntimeError(f"MCP tool schema exceeds depth {MAX_SCHEMA_DEPTH}: {tool_name}")


def _json_depth(value: object) -> int:
    if isinstance(value, dict): children = value.values()
    elif isinstance(value, list): children = value
    else: return 0
    return 1 + max((_json_depth(child) for child in children), default=0)


def _encode_name(value: str) -> str: return base64.urlsafe_b64encode(value.encode()).decode().rstrip("=")


def _map_tool_name(alias: str, remote_name: str) -> str:
    if not remote_name: raise RuntimeError("MCP tool name must not be empty")
    name = f"mcp__{_encode_name(alias)}__{_encode_name(remote_name)}"
    if len(name) > 64: raise RuntimeError(f"mapped MCP tool name exceeds 64 characters: {remote_name}")
    return name


def display_tool_name(name: str) -> str:
    match = re.fullmatch(r"mcp__([A-Za-z0-9_-]+)__([A-Za-z0-9_-]+)", name)
    if not match: return name
    try:
        decode = lambda value: base64.urlsafe_b64decode(value + "=" * (-len(value) % 4)).decode()
        return f"mcp:{decode(match.group(1))}/{decode(match.group(2))}"
    except (ValueError, UnicodeDecodeError): return name


def _normalize_result(result: dict) -> str:
    content = result.get("content", [])
    if not isinstance(content, list): raise RuntimeError("Invalid MCP tool content")
    unsupported = [item.get("type") if isinstance(item, dict) else "unknown" for item in content if not isinstance(item, dict) or item.get("type") != "text"]
    if unsupported: raise RuntimeError(f"Unsupported MCP content type: {', '.join(str(item) for item in unsupported)}")
    parts = [item["text"] for item in content if isinstance(item.get("text"), str)]
    if "structuredContent" in result:
        try: structured = json.dumps(result["structuredContent"], ensure_ascii=False, separators=(",", ":"))
        except (TypeError, ValueError): raise RuntimeError("MCP structured content is not JSON-serializable") from None
        parts.append(f"Structured content:\n{structured}")
    return _truncate_utf8("\n\n".join(parts) or "(no output)")


def _truncate_utf8(text: str) -> str:
    encoded = text.encode()
    if len(encoded) <= MAX_RESULT_BYTES: return text
    suffix = "\n\n[MCP result truncated to 50KB]"
    prefix = encoded[:MAX_RESULT_BYTES - len(suffix.encode())]
    return prefix.decode(errors="ignore") + suffix
