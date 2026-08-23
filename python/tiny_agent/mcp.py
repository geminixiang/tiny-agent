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
_MODERN_PROTOCOL_VERSION = "2026-07-28"
_MAX_HTTP_RESPONSE_BYTES = 10 * 1024 * 1024
_CLIENT_INFO = {"name": "tiny-agent", "version": "0.1.0"}
_CLIENT_CAPABILITIES: dict = {}


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
    protocol_version: str
    close: Callable[[], None]


def split_mcp_aliases(values: list[str] | None) -> list[str]:
    aliases: list[str] = []
    for value in values or []:
        for item in value.split(","):
            alias = item.strip()
            if alias and alias not in aliases: aliases.append(alias)
    return aliases


def load_mcp_configs(aliases: list[str], env: dict[str, str] | os._Environ[str] | None = None) -> list[McpConfig]:
    if not aliases: return []
    env = os.environ if env is None else env
    if not env.get("TINY_MCP_CONFIG"): raise ValueError("TINY_MCP_CONFIG must be set to use --mcp")
    path = Path(env["TINY_MCP_CONFIG"]).resolve()
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


class _HttpStatusError(RuntimeError):
    def __init__(self, status: int):
        self.status = status
        if status in (401, 403): error_class = "authentication error"
        elif 400 <= status < 500: error_class = "client error"
        elif 500 <= status < 600: error_class = "server error"
        else: error_class = "HTTP error"
        super().__init__(f"MCP HTTP {status} ({error_class})")


class _RpcError(RuntimeError):
    def __init__(self, error: object = None):
        self.code: int | None = None
        self.data: object = None
        if isinstance(error, dict):
            code = error.get("code")
            if isinstance(code, int) and not isinstance(code, bool): self.code = code
            self.data = error.get("data")
        super().__init__("MCP request failed (JSON-RPC error)")


class _McpClient:
    def __init__(self, config: McpConfig):
        self.config = _validate_config(config)
        self.protocol_version: str | None = None
        self.closed = False
        self.next_id = 1
        self.lock = threading.Lock()
        self.connections: set[http.client.HTTPConnection] = set()

    def connect(self, cancelled: threading.Event | None = None, deadline: float | None = None) -> None:
        deadline = deadline or time.monotonic() + 10
        corrective_retry = False
        while True:
            try:
                discovered = self.request("server/discover", {}, cancelled, _remaining_timeout_ms(deadline))
                if not _valid_discovery(discovered): raise _RpcError()
            except _RpcError as error:
                if not corrective_retry and _offers_exact_modern_version(error):
                    corrective_retry = True
                    continue
                raise RuntimeError("MCP server does not support the modern protocol version") from None
            self.protocol_version = _MODERN_PROTOCOL_VERSION
            return

    def request(self, method: str, params: dict, cancelled: threading.Event | None, timeout_ms: float) -> object:
        params = {**params, "_meta": {
            "io.modelcontextprotocol/protocolVersion": _MODERN_PROTOCOL_VERSION,
            "io.modelcontextprotocol/clientInfo": _CLIENT_INFO,
            "io.modelcontextprotocol/clientCapabilities": _CLIENT_CAPABILITIES,
        }}
        with self.lock:
            request_id = self.next_id
            self.next_id += 1
        response = self._post(
            {"jsonrpc": "2.0", "id": request_id, "method": method, "params": params},
            cancelled,
            timeout_ms,
        )
        if not isinstance(response, dict) or response.get("jsonrpc") != "2.0" or response.get("id") != request_id:
            raise _RpcError("Invalid MCP JSON-RPC response")
        if "error" in response: raise _RpcError(response["error"])
        if "result" not in response: raise _RpcError("Invalid MCP JSON-RPC response")
        result = response["result"]
        if not isinstance(result, dict) or result.get("resultType") not in ("complete", "input_required"):
            raise _RpcError("Invalid modern MCP result envelope")
        return result

    def _post(self, payload: dict, cancelled: threading.Event | None, timeout_ms: float) -> object:
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
        headers = {
            "Content-Type": "application/json", "Accept": "application/json, text/event-stream",
            "MCP-Protocol-Version": _MODERN_PROTOCOL_VERSION, "Mcp-Method": payload.get("method", ""),
            **(self.config.headers or {}),
        }
        if payload.get("method") == "tools/call":
            name = payload.get("params", {}).get("name")
            if isinstance(name, str): headers["Mcp-Name"] = _encode_mcp_param_value(name)
            headers.update(payload.get("params", {}).pop("_mcp_param_headers", {}))
        path = parsed.path or "/"
        if parsed.query: path += f"?{parsed.query}"
        body = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode()
        try:
            connection.request("POST", path, body, headers)
            response = connection.getresponse()
            if response.status < 200 or response.status >= 300:
                raw = response.read(_MAX_HTTP_RESPONSE_BYTES + 1)
                if len(raw) > _MAX_HTTP_RESPONSE_BYTES: raise RuntimeError("MCP response exceeded 10MB")
                if 400 <= response.status < 500:
                    try: rpc_response = json.loads(raw)
                    except (UnicodeDecodeError, json.JSONDecodeError): rpc_response = None
                    if isinstance(rpc_response, dict) and isinstance(rpc_response.get("error"), dict):
                        raise _RpcError(rpc_response["error"])
                raise _HttpStatusError(response.status)
            content_type = response.getheader("Content-Type", "").split(";", 1)[0].strip().lower()
            if content_type == "text/event-stream": return _read_sse(response, payload.get("id"))
            raw = response.read(_MAX_HTTP_RESPONSE_BYTES + 1)
            if len(raw) > _MAX_HTTP_RESPONSE_BYTES: raise RuntimeError("MCP response exceeded 10MB")
            return json.loads(raw)
        except (OSError, socket.timeout, http.client.HTTPException, UnicodeDecodeError, json.JSONDecodeError) as error:
            if cancelled and cancelled.is_set(): raise InterruptedError("Operation aborted") from error
            if timed_out.is_set() or isinstance(error, socket.timeout): raise TimeoutError("MCP request timed out") from error
            raise RuntimeError(f"MCP connection failed ({type(error).__name__})") from error
        finally:
            done.set(); connection.close()
            with self.lock: self.connections.discard(connection)

    def close(self) -> None:
        with self.lock:
            if self.closed: return
            self.closed = True
            connections = list(self.connections)
        for connection in connections: connection.close()


def _offers_exact_modern_version(error: _RpcError) -> bool:
    if error.code != -32022: return False
    data = error.data
    if not isinstance(data, dict): return False
    supported = data.get("supported")
    return isinstance(supported, list) and _MODERN_PROTOCOL_VERSION in supported


def _valid_discovery(value: object) -> bool:
    if not isinstance(value, dict) or value.get("resultType") != "complete": return False
    versions = value.get("supportedVersions")
    return (
        isinstance(versions, list) and _MODERN_PROTOCOL_VERSION in versions and
        isinstance(value.get("capabilities"), dict)
    )


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
        line = response.readline(_MAX_HTTP_RESPONSE_BYTES - total + 1)
        if not line: break
        total += len(line)
        if total > _MAX_HTTP_RESPONSE_BYTES: raise RuntimeError("MCP response exceeded 10MB")
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
        remote_tools: list[object] = []
        cursor: str | None = None
        seen_cursors: set[str] = set()
        while True:
            params = {"cursor": cursor} if cursor is not None else {}
            listed = client.request("tools/list", params, cancelled, _remaining_timeout_ms(deadline))
            if not isinstance(listed, dict) or not isinstance(listed.get("tools"), list): raise RuntimeError("Invalid MCP tools/list response")
            remote_tools.extend(listed["tools"])
            if len(remote_tools) > MAX_TOOLS: raise RuntimeError(f"MCP server returned more than {MAX_TOOLS} tools")
            next_cursor = listed.get("nextCursor")
            if next_cursor is None: break
            if not isinstance(next_cursor, str) or not next_cursor or next_cursor in seen_cursors: raise RuntimeError("Invalid MCP tools/list pagination cursor")
            seen_cursors.add(next_cursor)
            cursor = next_cursor
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
            declarations = _scan_mcp_header_declarations(schema)
            if declarations is None: continue
            name = _map_tool_name(client.config.alias, remote_name)
            if name in mapped_names: raise RuntimeError(f"duplicate mapped MCP tool name: {name}")
            mapped_names.add(name)

            def execute(args: dict, call_cancelled: threading.Event | None = None, remote_name: str = remote_name, declarations: list[tuple[tuple[str, ...], str, str]] = declarations) -> str:
                if client.closed: raise RuntimeError("MCP connection is closed")
                if not isinstance(args, dict): raise ValueError("MCP tool arguments must be a JSON object")
                request_params = {"name": remote_name, "arguments": args}
                if declarations:
                    request_params["_mcp_param_headers"] = _build_mcp_param_headers(declarations, args)
                result = client.request("tools/call", request_params, call_cancelled, client.config.call_timeout_ms)
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
        return LoadedMcpTools(tools, client.protocol_version or "", client.close)
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


def _encode_mcp_param_value(value: str) -> str:
    needs_base64 = (
        not value or value != value.strip() or
        value.startswith("=?base64?") and value.endswith("?=") or
        any(character != "\t" and not 32 <= ord(character) <= 126 for character in value)
    )
    if not needs_base64: return value
    encoded = base64.b64encode(value.encode()).decode()
    return f"=?base64?{encoded}?="


_NON_REACHABLE_SCHEMA_KEYS = (
    "items", "prefixItems", "contains", "additionalProperties", "unevaluatedProperties",
    "unevaluatedItems", "propertyNames", "patternProperties", "dependentSchemas", "oneOf",
    "anyOf", "allOf", "not", "if", "then", "else", "$defs", "definitions",
)
_OBJECT_SCHEMA_KEYS = {"patternProperties", "dependentSchemas", "$defs", "definitions"}
_MCP_HEADER_TYPES = {"string", "integer", "boolean", "number"}
_HEADER_TOKEN = re.compile(r"[!#$%&'*+\-.^_`|~0-9A-Za-z]+")


def _scan_mcp_header_declarations(schema: dict) -> list[tuple[tuple[str, ...], str, str]] | None:
    declarations: list[tuple[tuple[str, ...], str, str]] = []
    names: set[str] = set()

    def visit(node: object, path: tuple[str, ...], reachable: bool) -> bool:
        if not isinstance(node, dict): return True
        if "x-mcp-header" in node:
            name = node["x-mcp-header"]
            value_type = node.get("type")
            if (
                not reachable or not path or not isinstance(name, str) or not name or
                not _HEADER_TOKEN.fullmatch(name) or value_type not in _MCP_HEADER_TYPES or
                name.lower() in names
            ): return False
            names.add(name.lower())
            declarations.append((path, name, value_type))
        properties = node.get("properties")
        if isinstance(properties, dict):
            for key, child in properties.items():
                if not visit(child, (*path, key), reachable): return False
        for key in _NON_REACHABLE_SCHEMA_KEYS:
            child = node.get(key)
            if child is None: continue
            if isinstance(child, list): branches = child
            elif key in _OBJECT_SCHEMA_KEYS and isinstance(child, dict): branches = list(child.values())
            else: branches = [child]
            if any(not visit(branch, (*path, f"<{key}>"), False) for branch in branches): return False
        return True

    return declarations if visit(schema, (), True) else None


def _build_mcp_param_headers(declarations: list[tuple[tuple[str, ...], str, str]], args: dict) -> dict[str, str]:
    headers: dict[str, str] = {}
    for path, name, value_type in declarations:
        value: object = args
        for key in path:
            if not isinstance(value, dict) or key not in value:
                value = None
                break
            value = value[key]
        if value is None: continue
        if isinstance(value, str): string = value
        elif isinstance(value, bool): string = "true" if value else "false"
        elif isinstance(value, (int, float)) and math.isfinite(value):
            if isinstance(value, int):
                if abs(value) > 9_007_199_254_740_991: continue
                string = str(value)
            elif value.is_integer():
                if abs(value) > 9_007_199_254_740_991: continue
                string = str(int(value))
            else: string = str(value)
        else: continue
        headers[f"Mcp-Param-{name}"] = _encode_mcp_param_value(string)
    return headers


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
    parts: list[str] = []
    unsupported: list[object] = []
    for item in content:
        if isinstance(item, dict) and item.get("type") == "text" and isinstance(item.get("text"), str):
            parts.append(item["text"]); continue
        resource = item.get("resource") if isinstance(item, dict) and item.get("type") == "resource" else None
        if isinstance(resource, dict) and isinstance(resource.get("text"), str) and "blob" not in resource:
            uri = resource.get("uri")
            if uri is None:
                parts.append(resource["text"]); continue
            if isinstance(uri, str):
                parts.append(f"Resource: {uri}\n{resource['text']}"); continue
        unsupported.append(item.get("type") if isinstance(item, dict) else "unknown")
    if unsupported: raise RuntimeError(f"Unsupported MCP content type: {', '.join(str(item) for item in unsupported)}")
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
