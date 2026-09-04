import asyncio
import base64
import json
import math
import re
import time
from collections.abc import Mapping
from contextlib import AsyncExitStack
from dataclasses import dataclass
from pathlib import Path
from typing import Awaitable, Callable
from urllib.parse import urlsplit

import httpx2
from mcp import types as mcp_types
from mcp.client import Client
from mcp.client.streamable_http import streamable_http_client

from .settings import Settings

MAX_RESULT_BYTES = 50 * 1024
MAX_SCHEMA_BYTES = 50 * 1024
MAX_DESCRIPTION_BYTES = 8 * 1024
MAX_SCHEMA_DEPTH = 20
MAX_TOOLS = 64


@dataclass(frozen=True)
class _McpConfig:
    alias: str
    url: str
    headers: dict[str, str] | None = None
    allowed_tools: list[str] | None = None
    call_timeout_ms: float = 30_000


@dataclass
class LoadedMcpTools:
    tools: list[dict]
    protocol_version: str
    close: Callable[[], Awaitable[None]]


def split_names(values: list[str] | None) -> list[str]:
    aliases: list[str] = []
    for value in values or []:
        for item in value.split(","):
            alias = item.strip()
            if alias and alias not in aliases:
                aliases.append(alias)
    return aliases


def load_mcp_configs(aliases: list[str], env: Mapping[str, str] | None = None) -> list[_McpConfig]:
    if not aliases:
        return []
    settings = Settings()
    env = settings.environment if env is None else env
    configured_path = settings.tiny_mcp_config if env is settings.environment else env.get("TINY_MCP_CONFIG")
    if not configured_path:
        raise ValueError("TINY_MCP_CONFIG must be set to use --mcp")
    path = Path(configured_path).resolve()
    if not path.is_file():
        raise ValueError("Failed to load MCP catalog: file is missing, unreadable, or invalid JSON")
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except OSError, json.JSONDecodeError:
        raise ValueError("Failed to load MCP catalog: file is missing, unreadable, or invalid JSON") from None
    catalog = _validate_catalog(value)
    for alias in aliases:
        if alias not in catalog:
            raise ValueError(f"Unknown MCP server: {alias}")
    configs = []
    for alias in aliases:
        server = catalog[alias]
        auth = server.get("auth")
        token_env = auth["tokenEnv"] if auth else server.get("tokenEnv")
        token = env.get(token_env) if token_env else None
        if token_env and not token:
            raise ValueError(f"MCP token environment variable is not set: {token_env}")
        if token is not None and any(ord(char) < 32 or ord(char) == 127 for char in token):
            raise ValueError(f"MCP token environment variable contains invalid HTTP header characters: {token_env}")
        headers = None
        if token:
            headers = {"X-API-Key": token} if auth else {"Authorization": f"Bearer {token}"}
        configs.append(
            _McpConfig(
                alias=alias,
                url=server["url"],
                headers=headers,
                allowed_tools=server.get("allowedTools"),
                call_timeout_ms=server.get("callTimeoutMs", 30_000),
            )
        )
    return configs


def _validate_catalog(value: object) -> dict[str, dict]:
    root = _object(value, "MCP catalog")
    _unknown_field(root, {"servers"}, "MCP catalog")
    servers = _object(root.get("servers"), "MCP catalog servers")
    validated: dict[str, dict] = {}
    for alias, raw in servers.items():
        if not isinstance(alias, str) or not alias.strip():
            raise ValueError("MCP server alias must not be empty")
        server = _object(raw, f"MCP server {alias}")
        _unknown_field(server, {"url", "tokenEnv", "auth", "allowedTools", "callTimeoutMs"}, f"MCP server {alias}")
        if not isinstance(server.get("url"), str) or not server["url"]:
            raise ValueError(f"MCP server {alias} url must be a string")
        _validate_url(server["url"])
        token_env = server.get("tokenEnv")
        if token_env is not None and (not isinstance(token_env, str) or not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", token_env)):
            raise ValueError(f"MCP server {alias} tokenEnv must be an environment variable name")
        auth = server.get("auth")
        if token_env is not None and auth is not None:
            raise ValueError(f"MCP server {alias} must not set both tokenEnv and auth")
        if auth is not None:
            auth = _object(auth, f"MCP server {alias} auth")
            _unknown_field(auth, {"type", "tokenEnv"}, f"MCP server {alias} auth")
            if auth.get("type") != "metabaseApiKey":
                raise ValueError(f"MCP server {alias} auth type must be metabaseApiKey")
            auth_token_env = auth.get("tokenEnv")
            if not isinstance(auth_token_env, str) or not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", auth_token_env):
                raise ValueError(f"MCP server {alias} auth tokenEnv must be an environment variable name")
        allowed = server.get("allowedTools")
        if allowed is not None:
            if not isinstance(allowed, list) or any(not isinstance(tool, str) or not tool for tool in allowed):
                raise ValueError(f"MCP server {alias} allowedTools must contain nonempty strings")
            if len(set(allowed)) != len(allowed):
                raise ValueError(f"MCP server {alias} allowedTools must not contain duplicates")
        timeout = server.get("callTimeoutMs")
        if timeout is not None and (isinstance(timeout, bool) or not isinstance(timeout, (int, float)) or not math.isfinite(timeout) or timeout <= 0):
            raise ValueError(f"MCP server {alias} callTimeoutMs must be a positive number")
        validated[alias] = dict(server)
    return validated


def _validate_url(value: str) -> None:
    parsed = urlsplit(value)
    if not parsed.scheme or not parsed.hostname:
        raise ValueError("MCP URL must be a valid URL")
    try:
        parsed.port
    except ValueError:
        raise ValueError("MCP URL must be a valid URL") from None
    if parsed.scheme != "https" and not (parsed.scheme == "http" and parsed.hostname in ("127.0.0.1", "localhost", "::1")):
        raise ValueError("MCP URL must use HTTPS unless it targets loopback")
    if parsed.username or parsed.password:
        raise ValueError("MCP URL must not contain credentials")


def _object(value: object, name: str) -> dict:
    if not isinstance(value, dict):
        raise ValueError(f"{name} must be an object")
    return value


def _unknown_field(value: dict, allowed: set[str], name: str) -> None:
    unknown = next((key for key in value if key not in allowed), None)
    if unknown is not None:
        raise ValueError(f"Unknown {name} field: {unknown}")


def _remaining_timeout_ms(deadline: float) -> float:
    remaining = (deadline - time.monotonic()) * 1000
    if remaining <= 0:
        raise TimeoutError("MCP request timed out")
    return remaining


async def _await_sdk(awaitable, cancelled: asyncio.Event | None, timeout_ms: float):
    current = asyncio.current_task()

    async def cancel_when_requested() -> None:
        await cancelled.wait()
        if current is not None:
            current.cancel()

    abort = asyncio.create_task(cancel_when_requested()) if cancelled is not None else None
    try:
        async with asyncio.timeout(timeout_ms / 1000):
            return await awaitable
    except TimeoutError:
        raise TimeoutError("MCP request timed out") from None
    except asyncio.CancelledError:
        if cancelled is not None and cancelled.is_set():
            raise InterruptedError("Operation aborted") from None
        raise
    except Exception as error:
        raise RuntimeError("MCP request failed") from error
    finally:
        if abort is not None:
            abort.cancel()
            await asyncio.gather(abort, return_exceptions=True)


async def load_mcp_tools(config: _McpConfig, cancelled: asyncio.Event | None = None, startup_timeout_ms: float = 10_000) -> LoadedMcpTools:
    ready = asyncio.get_running_loop().create_future()
    stop = asyncio.Event()
    closed = False

    async def own_client() -> None:
        try:
            async with AsyncExitStack() as stack:
                http_client = await stack.enter_async_context(httpx2.AsyncClient(headers=config.headers or {}))
                transport = streamable_http_client(config.url, http_client=http_client)
                client = Client(
                    transport,
                    mode="auto",
                    read_timeout_seconds=startup_timeout_ms / 1000,
                    client_info=mcp_types.Implementation(name="tiny-agent", version="0.1.0"),
                )
                await stack.enter_async_context(client)
                ready.set_result(client)
                await stop.wait()
        except BaseException as error:
            if not ready.done():
                ready.set_exception(error)
            else:
                raise

    owner = asyncio.create_task(own_client())

    async def close() -> None:
        nonlocal closed
        if closed:
            return
        closed = True
        starting = not ready.done()
        if starting:
            owner.cancel()
        stop.set()
        await asyncio.gather(owner, return_exceptions=True)
        if starting and ready.done():
            try:
                ready.exception()
            except asyncio.CancelledError:
                pass

    try:
        client = await _await_sdk(asyncio.shield(ready), cancelled, startup_timeout_ms)
        deadline = time.monotonic() + startup_timeout_ms / 1000
        remote_tools: list[dict] = []
        cursor: str | None = None
        seen_cursors: set[str] = set()
        while True:
            listed = await _await_sdk(client.list_tools(cursor=cursor, cache_mode="reload"), cancelled, _remaining_timeout_ms(deadline))
            remote_tools.extend(tool.model_dump(by_alias=True, exclude_none=True) for tool in listed.tools)
            if len(remote_tools) > MAX_TOOLS:
                raise RuntimeError(f"MCP server returned more than {MAX_TOOLS} tools")
            cursor = listed.next_cursor
            if cursor is None:
                break
            if not cursor or cursor in seen_cursors:
                raise RuntimeError("Invalid MCP tools/list pagination cursor")
            seen_cursors.add(cursor)
        remote_names: set[str] = set()
        mapped_names: set[str] = set()
        tools = []
        allowed = set(config.allowed_tools) if config.allowed_tools is not None else None
        for remote in remote_tools:
            remote_name = remote.get("name")
            if not isinstance(remote_name, str):
                raise RuntimeError("Invalid MCP tool definition")
            if remote_name in remote_names:
                raise RuntimeError(f"duplicate MCP tool name: {remote_name}")
            remote_names.add(remote_name)
            if allowed is not None and remote_name not in allowed:
                continue
            schema = remote.get("inputSchema")
            if not isinstance(schema, dict):
                raise RuntimeError(f"Invalid MCP tool schema: {remote_name}")
            _validate_schema(schema, remote_name)
            description = remote.get("description")
            if description is not None and not isinstance(description, str):
                raise RuntimeError(f"Invalid MCP tool description: {remote_name}")
            if description and len(description.encode()) > MAX_DESCRIPTION_BYTES:
                raise RuntimeError(f"MCP tool description exceeds 8KB: {remote_name}")
            if _scan_mcp_header_declarations(schema) is None:
                continue
            name = _map_tool_name(config.alias, remote_name)
            if name in mapped_names:
                raise RuntimeError(f"duplicate mapped MCP tool name: {name}")
            mapped_names.add(name)

            async def execute(args: dict, call_cancelled: asyncio.Event | None = None, remote_name: str = remote_name) -> str:
                if closed:
                    raise RuntimeError("MCP connection is closed")
                if not isinstance(args, dict):
                    raise ValueError("MCP tool arguments must be a JSON object")
                result = await _await_sdk(
                    client.call_tool(remote_name, args, read_timeout_seconds=config.call_timeout_ms / 1000),
                    call_cancelled,
                    config.call_timeout_ms,
                )
                value = result.model_dump(by_alias=True, exclude_none=True)
                if value.get("resultType") == "input_required":
                    raise RuntimeError("MCP tool requires additional user input; input_required is not supported")
                normalized = _normalize_result(value)
                if value.get("isError"):
                    raise RuntimeError(f"MCP tool error: {normalized}")
                return normalized

            tools.append(
                {
                    "type": "function",
                    "function": {
                        "name": name,
                        "description": description or f"MCP tool {remote_name} from {config.alias}.",
                        "parameters": schema,
                    },
                    "execute": execute,
                }
            )
        if allowed is not None:
            missing = [name for name in config.allowed_tools or [] if name not in remote_names]
            if missing:
                raise RuntimeError(f"MCP allowed tools were not found: {', '.join(missing)}")

        return LoadedMcpTools(tools, client.protocol_version, close)
    except BaseException:
        await close()
        raise


def _validate_schema(schema: object, tool_name: str) -> None:
    try:
        encoded = json.dumps(schema, ensure_ascii=False, separators=(",", ":")).encode()
    except TypeError, ValueError:
        raise RuntimeError(f"MCP tool schema is not JSON-serializable: {tool_name}") from None
    if len(encoded) > MAX_SCHEMA_BYTES:
        raise RuntimeError(f"MCP tool schema exceeds 50KB: {tool_name}")
    if _json_depth(schema) > MAX_SCHEMA_DEPTH:
        raise RuntimeError(f"MCP tool schema exceeds depth {MAX_SCHEMA_DEPTH}: {tool_name}")


def _json_depth(value: object) -> int:
    if isinstance(value, dict):
        children = value.values()
    elif isinstance(value, list):
        children = value
    else:
        return 0
    return 1 + max((_json_depth(child) for child in children), default=0)


def _encode_name(value: str) -> str:
    return base64.urlsafe_b64encode(value.encode()).decode().rstrip("=")


_NON_REACHABLE_SCHEMA_KEYS = (
    "items",
    "prefixItems",
    "contains",
    "additionalProperties",
    "unevaluatedProperties",
    "unevaluatedItems",
    "propertyNames",
    "patternProperties",
    "dependentSchemas",
    "oneOf",
    "anyOf",
    "allOf",
    "not",
    "if",
    "then",
    "else",
    "$defs",
    "definitions",
)
_OBJECT_SCHEMA_KEYS = {"patternProperties", "dependentSchemas", "$defs", "definitions"}
_MCP_HEADER_TYPES = {"string", "integer", "boolean", "number"}
_HEADER_TOKEN = re.compile(r"[!#$%&'*+\-.^_`|~0-9A-Za-z]+")


def _scan_mcp_header_declarations(schema: dict) -> list[tuple[tuple[str, ...], str, str]] | None:
    declarations: list[tuple[tuple[str, ...], str, str]] = []
    names: set[str] = set()

    def visit(node: object, path: tuple[str, ...], reachable: bool) -> bool:
        if not isinstance(node, dict):
            return True
        if "x-mcp-header" in node:
            name = node["x-mcp-header"]
            value_type = node.get("type")
            if not reachable or not path or not isinstance(name, str) or not name or not _HEADER_TOKEN.fullmatch(name) or value_type not in _MCP_HEADER_TYPES or name.lower() in names:
                return False
            names.add(name.lower())
            declarations.append((path, name, value_type))
        properties = node.get("properties")
        if isinstance(properties, dict):
            for key, child in properties.items():
                if not visit(child, (*path, key), reachable):
                    return False
        for key in _NON_REACHABLE_SCHEMA_KEYS:
            child = node.get(key)
            if child is None:
                continue
            if isinstance(child, list):
                branches = child
            elif key in _OBJECT_SCHEMA_KEYS and isinstance(child, dict):
                branches = list(child.values())
            else:
                branches = [child]
            if any(not visit(branch, (*path, f"<{key}>"), False) for branch in branches):
                return False
        return True

    return declarations if visit(schema, (), True) else None


def _map_tool_name(alias: str, remote_name: str) -> str:
    if not remote_name:
        raise RuntimeError("MCP tool name must not be empty")
    name = f"mcp__{_encode_name(alias)}__{_encode_name(remote_name)}"
    if len(name) > 64:
        raise RuntimeError(f"mapped MCP tool name exceeds 64 characters: {remote_name}")
    return name


def display_tool_name(name: str) -> str:
    match = re.fullmatch(r"mcp__([A-Za-z0-9_-]+)__([A-Za-z0-9_-]+)", name)
    if not match:
        return name
    decode = lambda value: base64.urlsafe_b64decode(value + "=" * (-len(value) % 4)).decode(errors="replace")
    return f"mcp:{decode(match.group(1))}/{decode(match.group(2))}"


def _normalize_result(result: dict) -> str:
    content = result.get("content", [])
    if not isinstance(content, list):
        raise RuntimeError("Invalid MCP tool content")
    parts: list[str] = []
    unsupported: list[object] = []
    for item in content:
        if isinstance(item, dict) and item.get("type") == "text" and isinstance(item.get("text"), str):
            parts.append(item["text"])
            continue
        resource = item.get("resource") if isinstance(item, dict) and item.get("type") == "resource" else None
        if isinstance(resource, dict) and isinstance(resource.get("text"), str) and "blob" not in resource:
            uri = resource.get("uri")
            if uri is None:
                parts.append(resource["text"])
                continue
            if isinstance(uri, str):
                parts.append(f"Resource: {uri}\n{resource['text']}")
                continue
        unsupported.append(item.get("type") if isinstance(item, dict) else "unknown")
    if unsupported:
        raise RuntimeError(f"Unsupported MCP content type: {', '.join(str(item) for item in unsupported)}")
    if "structuredContent" in result:
        try:
            structured = json.dumps(result["structuredContent"], ensure_ascii=False, separators=(",", ":"))
        except TypeError, ValueError:
            raise RuntimeError("MCP structured content is not JSON-serializable") from None
        parts.append(f"Structured content:\n{structured}")
    return _truncate_utf8("\n\n".join(parts) or "(no output)")


def _truncate_utf8(text: str) -> str:
    encoded = text.encode()
    if len(encoded) <= MAX_RESULT_BYTES:
        return text
    suffix = "\n\n[MCP result truncated to 50KB]"
    prefix = encoded[: MAX_RESULT_BYTES - len(suffix.encode())]
    return prefix.decode(errors="ignore") + suffix
