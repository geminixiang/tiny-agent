import asyncio
import importlib.util
import json
import math
import os
import re
import signal
import ssl
import subprocess
import time
from contextlib import suppress
from datetime import datetime, timezone
from pathlib import Path
from typing import Awaitable, Callable
from urllib.parse import urlsplit

from .http import close_writer, read_http_response, remaining, wait_owned
from .lifecycle import ExecutionLifecycle
from .session import Session, environment_identity, uuid7
from .session.recovery import plan_recovery
from .session.reducer import source_digest
from .session.runtime import current_configuration, entry_fact, project_session, record_fact, replay_declaration, runtime_configuration, step_failed_record, usage_fact
from .settings import DEFAULT_ENDPOINT, DEFAULT_MODEL, Settings


def chat_completions_url(endpoint: str | None = None) -> str:
    trimmed = (endpoint or Settings().tiny_endpoint or DEFAULT_ENDPOINT).rstrip("/")
    return trimmed if trimmed.endswith("/chat/completions") else f"{trimmed}/chat/completions"


MAX_BASH_OUTPUT = 10_000_000
BASH_TIMEOUT_SECONDS = 120
MAX_HTTP_RESPONSE = 10 * 1024 * 1024
MAX_TOOL_OUTPUT = 50 * 1024
ROOT = Path.cwd().resolve()


def set_root(path: Path) -> None:
    global ROOT
    ROOT = path.resolve()


def timestamp() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def format_tokens(n: int) -> str:
    return str(n) if n < 1_000 else f"{n / 1_000:.1f}k" if n < 10_000 else f"{n // 1_000}k" if n < 1_000_000 else f"{n / 1_000_000:.1f}M" if n < 10_000_000 else f"{n // 1_000_000}M"


def format_usage(usage: dict) -> str:
    parts = [f"↑{format_tokens(usage['input'])}", f"↓{format_tokens(usage['output'])}"]
    if usage["cacheRead"]:
        parts.append(f"R{format_tokens(usage['cacheRead'])}")
    if usage["cacheWrite"]:
        parts.append(f"W{format_tokens(usage['cacheWrite'])}")
    if (usage["cacheRead"] or usage["cacheWrite"]) and "cacheHitRate" in usage:
        parts.append(f"CH{usage['cacheHitRate']:.1f}%")
    return " ".join(parts)


def format_tool_event(event: dict) -> str:
    if event["phase"] == "end":
        result = event.get("result", "")
        if result.startswith("Error:") or result in ("Operation aborted", "ok", "(no output)"):
            return f"  └ {result}"
        return f"  └ {len(result)} chars"
    name, args = event["name"], event["args"]
    target = args.get("command" if name in ("bash", "bg") else "path", "") or args.get("id", "")
    target = target if len(target) <= 80 else target[:77] + "..."
    suffix = f" ({len(args.get('content', ''))} chars)" if name == "write" else f" ({len(args.get('edits', []))} blocks)" if name == "edit" else ""
    return f"◆ {name}{f' {target}' if target else ''}{suffix}"


def load_project_instructions() -> str:
    path = ROOT / "AGENTS.md"
    return path.read_text(encoding="utf-8") if path.is_file() else ""


def load_skills(extra: list[str] | None = None) -> list[dict]:
    files = sorted((ROOT / ".tiny-agent/skills").glob("**/SKILL.md")) + [Path(path).resolve() for path in extra or []]
    skills, seen = [], set()
    for path in files:
        path = path.resolve()
        if path in seen:
            continue
        seen.add(path)
        text = path.read_text(encoding="utf-8")
        head = re.match(r"^---\n(.*?)\n---", text, re.S)
        metadata = head.group(1) if head else ""
        field = lambda key: (re.search(rf"^{key}:\s*[\"']?(.*?)[\"']?$", metadata, re.M) or [None, ""])[1]
        skills.append({"name": field("name") or path.parent.name, "description": field("description"), "path": str(path)})
    return skills


TOOL_DEFINITIONS = [
    {
        "type": "function",
        "function": {
            "name": "bash",
            "description": "Run commands, builds, tests, and file discovery in the working directory. Use read, write, or edit for ordinary text file operations. Output is limited to the last 2,000 lines or 50KB; truncated output includes a full-output path.",
            "parameters": {
                "type": "object",
                "properties": {
                    "command": {"type": "string", "description": "Shell command to execute in the working directory."},
                    "timeout": {"type": "number", "exclusiveMinimum": 0, "description": "Optional timeout in seconds. Defaults to 120."},
                },
                "required": ["command"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "read",
            "description": "Read a UTF-8 text file. Prefer this over cat or sed. Returns at most 2,000 complete lines or 50KB and includes an offset hint when more lines remain.",
            "parameters": {
                "type": "object",
                "properties": {
                    "path": {"type": "string", "description": "Path to the UTF-8 text file."},
                    "offset": {"type": "integer", "minimum": 1, "description": "1-indexed line number to start reading from."},
                    "limit": {"type": "integer", "minimum": 1, "description": "Maximum number of lines to return."},
                },
                "required": ["path"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "write",
            "description": "Create a new UTF-8 text file or completely rewrite an existing file. Parent directories are created automatically. Use edit for partial changes.",
            "parameters": {
                "type": "object",
                "properties": {"path": {"type": "string", "description": "Path to create or completely rewrite."}, "content": {"type": "string", "description": "Complete UTF-8 file content."}},
                "required": ["path", "content"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "edit",
            "description": "Make precise replacements in an existing UTF-8 text file. Every oldText must match exactly once in the original file, and edits must not overlap. All edits are validated before writing.",
            "parameters": {
                "type": "object",
                "properties": {
                    "path": {"type": "string", "description": "Path to the existing UTF-8 text file."},
                    "edits": {
                        "type": "array",
                        "minItems": 1,
                        "description": "Atomic replacement blocks validated against the original file.",
                        "items": {
                            "type": "object",
                            "properties": {
                                "oldText": {"type": "string", "minLength": 1, "description": "Exact text that must occur exactly once in the original file."},
                                "newText": {"type": "string", "description": "Replacement text."},
                            },
                            "required": ["oldText", "newText"],
                        },
                    },
                },
                "required": ["path", "edits"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "bg",
            "description": "Manage background processes in the working directory. The id is the process pid; metadata and logs live in .tiny-agent/bg/<pid>.json and .log. Use for servers and other long-running commands. List shows running processes by default; use status=all or a specific status to inspect history in the same cwd.",
            "parameters": {
                "type": "object",
                "properties": {
                    "action": {"type": "string", "enum": ["start", "list", "status", "logs", "stop"]},
                    "command": {"type": "string"},
                    "id": {"type": "string"},
                    "tail": {"type": "integer", "minimum": 1},
                    "status": {"type": "string", "enum": ["running", "exited", "stopped", "stale", "all"], "description": "Filter for action=list. Defaults to running."},
                },
                "required": ["action"],
            },
        },
    },
]


def _tls_context() -> ssl.SSLContext:
    if importlib.util.find_spec("certifi") is None:
        return ssl.create_default_context()
    import certifi

    return ssl.create_default_context(cafile=certifi.where())


async def _post_json(url: str, payload: dict, headers: dict[str, str], timeout: float, cancelled: asyncio.Event | None = None) -> dict:
    async def request() -> dict:
        parsed = urlsplit(url)
        use_tls = parsed.scheme == "https"
        port = parsed.port or (443 if use_tls else 80)
        deadline = time.monotonic() + timeout
        writer: asyncio.StreamWriter | None = None
        try:
            context = _tls_context() if use_tls else None
            reader, writer = await asyncio.wait_for(asyncio.open_connection(parsed.hostname, port, ssl=context), remaining(deadline))
            body = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode()
            path = parsed.path or "/"
            if parsed.query:
                path += f"?{parsed.query}"
            request_headers = {"Host": parsed.hostname or "", "Content-Length": str(len(body)), "Connection": "close", **headers}
            raw_headers = "".join(f"{name}: {value}\r\n" for name, value in request_headers.items())
            writer.write(f"POST {path} HTTP/1.1\r\n{raw_headers}\r\n".encode() + body)
            await asyncio.wait_for(writer.drain(), remaining(deadline))
            status, _, raw = await read_http_response(
                reader,
                deadline,
                MAX_HTTP_RESPONSE,
                "OpenRouter returned an invalid HTTP response",
                "OpenRouter response exceeded 10MB",
            )
            text = raw.decode()
            if status < 200 or status >= 300:
                raise RuntimeError(f"OpenRouter {status}: {text}")
            return json.loads(text)
        finally:
            if writer:
                await close_writer(writer, deadline)

    return await wait_owned(request(), cancelled)


def normalize_assistant_message(value: object) -> dict:
    if not isinstance(value, dict) or value.get("role") != "assistant":
        raise RuntimeError("invalid assistant message")
    content = value.get("content")
    if content is not None and not isinstance(content, str):
        raise RuntimeError("invalid assistant content")
    normalized = {"role": "assistant", "content": content}
    raw_calls = value.get("tool_calls")
    if raw_calls is None:
        return normalized
    if not isinstance(raw_calls, list) or not raw_calls:
        raise RuntimeError("invalid assistant tool_calls")
    calls = []
    for value_call in raw_calls:
        if not isinstance(value_call, dict) or value_call.get("type") != "function":
            raise RuntimeError("invalid assistant tool call")
        function = value_call.get("function")
        if (
            not isinstance(value_call.get("id"), str)
            or not value_call["id"]
            or not isinstance(function, dict)
            or not isinstance(function.get("name"), str)
            or not function["name"]
            or not isinstance(function.get("arguments"), str)
        ):
            raise RuntimeError("invalid assistant tool call")
        calls.append(
            {
                "id": value_call["id"],
                "type": "function",
                "function": {"name": function["name"], "arguments": function["arguments"]},
            }
        )
    normalized["tool_calls"] = calls
    return normalized


def provider_stop_reason(finish: object, answer: dict) -> str:
    if finish == "length":
        return "length"
    if finish in ("tool_calls", "function_call"):
        if not answer.get("tool_calls"):
            raise RuntimeError(f"Provider finish_reason {finish} requires tool calls")
        return "toolUse"
    if finish in ("content_filter", "network_error"):
        raise RuntimeError(f"Provider finish_reason: {finish}")
    if finish not in (None, "stop"):
        raise RuntimeError(f"Unknown provider finish_reason: {finish}")
    return "toolUse" if answer.get("tool_calls") else "stop"


def json_object(text: object) -> dict | None:
    if not isinstance(text, str) or not text.strip().startswith("{"):
        return None
    try:
        value = json.loads(text)
    except json.JSONDecodeError:
        return None
    return value if isinstance(value, dict) else None


async def execute_bash(command: str, cancelled: asyncio.Event, timeout: float | None = None) -> str:
    timeout = BASH_TIMEOUT_SECONDS if timeout is None else timeout
    creation = asyncio.create_task(
        asyncio.create_subprocess_shell(
            command,
            cwd=ROOT,
            executable="/bin/sh",
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            start_new_session=True,
        )
    )
    abort = asyncio.create_task(cancelled.wait())
    timer = asyncio.create_task(asyncio.sleep(timeout))
    process: asyncio.subprocess.Process | None = None
    readers: list[asyncio.Task[tuple[bytes, bool]]] = []
    waited: asyncio.Task[int] | None = None
    capped = asyncio.Event()

    async def cancel_tasks(*tasks: asyncio.Task | None) -> None:
        active = [task for task in tasks if task is not None]
        for task in active:
            task.cancel()
        if active:
            await asyncio.gather(*active, return_exceptions=True)

    async def read_stream(stream: asyncio.StreamReader) -> tuple[bytes, bool]:
        output = bytearray()
        exceeded = False
        while chunk := await stream.read(65_536):
            remaining_bytes = MAX_BASH_OUTPUT - len(output)
            if remaining_bytes > 0:
                output.extend(chunk[:remaining_bytes])
            if len(chunk) > remaining_bytes:
                exceeded = True
                capped.set()
        return bytes(output), exceeded

    async def kill_process_group() -> None:
        assert process is not None
        with suppress(ProcessLookupError, PermissionError):
            os.killpg(process.pid, signal.SIGKILL)

    reason = "exit"
    try:
        done, _ = await asyncio.wait((creation, abort, timer), return_when=asyncio.FIRST_COMPLETED)
        if abort in done:
            await cancel_tasks(creation)
            raise InterruptedError("Operation aborted")
        if timer in done:
            await cancel_tasks(creation)
            return f"Command timed out after {timeout:g} seconds."
        process = await creation
        assert process.stdout and process.stderr
        readers = [asyncio.create_task(read_stream(process.stdout)), asyncio.create_task(read_stream(process.stderr))]
        waited = asyncio.create_task(process.wait())
        cap_wait = asyncio.create_task(capped.wait())
        done, _ = await asyncio.wait((abort, timer, waited, cap_wait), return_when=asyncio.FIRST_COMPLETED)
        if abort in done:
            reason = "cancelled"
        elif timer in done:
            reason = "timeout"
        elif cap_wait in done and capped.is_set():
            reason = "capped"
        await kill_process_group()
        await asyncio.gather(waited, return_exceptions=True)
        await cancel_tasks(cap_wait)
    except asyncio.CancelledError:
        if process is not None:
            await kill_process_group()
            await asyncio.gather(process.wait(), return_exceptions=True)
        if cancelled.is_set():
            raise InterruptedError("Operation aborted") from None
        raise
    finally:
        await cancel_tasks(abort, timer)
        if process is None:
            await cancel_tasks(creation)

    if reason == "cancelled":
        await cancel_tasks(*readers)
        raise InterruptedError("Operation aborted")
    streams = await asyncio.gather(*readers, return_exceptions=True)
    stdout, stderr = (item[0] if isinstance(item, tuple) else b"" for item in streams)
    output = (stdout + stderr).decode(errors="replace")
    if reason == "capped":
        return await limit_bash_output(
            append_bash_note(output, "Bash output exceeded the 10MB safety cap; complete output was not captured."),
            False,
            cancelled,
        )
    if reason == "timeout":
        return await limit_bash_output(append_bash_note(output, f"Command timed out after {timeout:g} seconds."), True, cancelled)
    assert process is not None
    if process.returncode:
        output = append_bash_note(output, f"Command exited with code {process.returncode}")
    elif not output:
        output = "(no output)"
    return await limit_bash_output(output, True, cancelled)


def append_bash_note(output: str, note: str) -> str:
    return f"{output}\n\n{note}" if output else note


async def limit_bash_output(output: str, complete: bool, cancelled: asyncio.Event) -> str:
    lines = output.split("\n")
    if lines and lines[-1] == "":
        lines.pop()
    if len(lines) <= 2_000 and len(output.encode()) <= MAX_TOOL_OUTPUT:
        return output
    encoded = output.encode()
    byte_start = max(0, len(encoded) - MAX_TOOL_OUTPUT)
    while byte_start < len(encoded) and encoded[byte_start] & 0xC0 == 0x80:
        byte_start += 1
    tail_lines = encoded[byte_start:].decode().split("\n")
    if len(tail_lines) > 2_000:
        tail_lines = tail_lines[-2_000:]
    tail = "\n".join(tail_lines)
    start = max(1, len(lines) - len(tail_lines) + 1)

    def store_output() -> Path:
        directory = ROOT / ".tiny-agent/tool-output"
        directory.mkdir(parents=True, exist_ok=True)
        path = directory / f"{uuid7()}.log"
        path.write_text(output, encoding="utf-8")
        return path

    if cancelled.is_set():
        raise InterruptedError("Operation aborted")
    path = await asyncio.to_thread(store_output)
    if cancelled.is_set():
        raise InterruptedError("Operation aborted")
    label = "Full output" if complete else "Captured output; command exceeded the 10MB safety cap"
    return f"{tail}\n\n[Showing lines {start}-{len(lines)} of {len(lines)}. {label}: {path}]"


BG_PROCESSES: dict[str, asyncio.subprocess.Process] = {}


def bg_dir() -> Path:
    return ROOT / ".tiny-agent/bg"


def bg_paths(pid: str) -> tuple[Path, Path]:
    if not pid.isdigit():
        raise ValueError("id must be a pid")
    return bg_dir() / f"{pid}.json", bg_dir() / f"{pid}.log"


def process_running(pid: int) -> bool:
    with suppress(ProcessLookupError, PermissionError):
        os.kill(pid, 0)
        return True
    return False


def process_started_at(pid: int) -> str:
    if not process_running(pid):
        return ""
    result = subprocess.run(
        ["ps", "-p", str(pid), "-o", "lstart="],
        capture_output=True,
        text=True,
        env={**os.environ, "LC_ALL": "C"},
        check=False,
    )
    return result.stdout.strip() if result.returncode == 0 else ""


def read_bg_meta(pid: str) -> dict:
    meta_path, _ = bg_paths(pid)
    meta = json.loads(meta_path.read_text(encoding="utf-8"))
    if meta.get("cwd") != str(ROOT):
        raise ValueError(f"bg {pid} belongs to a different cwd")
    return meta


def write_bg_meta(meta: dict) -> None:
    meta_path, _ = bg_paths(str(meta["id"]))
    meta_path.write_text(json.dumps(meta, indent=2) + "\n", encoding="utf-8")


def current_bg_status(meta: dict) -> str:
    if meta.get("status") != "running":
        return meta.get("status", "exited")
    started = process_started_at(int(meta["pid"]))
    if not started:
        return "exited"
    return "running" if started == meta.get("processStartedAt") else "stale"


def log_tail(path: Path, lines: int = 80) -> str:
    if not path.exists():
        return ""
    return "\n".join(path.read_text(encoding="utf-8", errors="replace").splitlines()[-min(lines, 2_000) :])


async def wait_bg_exit(process: asyncio.subprocess.Process, meta: dict, log) -> None:
    code = await process.wait()
    status = "stopped" if meta["id"] not in BG_PROCESSES else "exited"
    BG_PROCESSES.pop(meta["id"], None)
    log.write(f"\nexited: {time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())}\nexitCode: {code}\nsignal: \n")
    log.close()
    meta.update({"status": status, "exitCode": code, "signal": None, "exitedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())})
    with suppress(Exception):
        write_bg_meta(meta)


async def execute_bg(args: dict[str, str], cancelled: asyncio.Event) -> str:
    action = args.get("action", "")
    if action == "start":
        command = args.get("command", "")
        if not command:
            raise ValueError("command must be a nonempty string")
        bg_dir().mkdir(parents=True, exist_ok=True)
        process = await asyncio.create_subprocess_shell(command, cwd=ROOT, executable="/bin/sh", stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT, start_new_session=True)
        pid = str(process.pid)
        _, log_path = bg_paths(pid)
        log = log_path.open("w", encoding="utf-8")
        started = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        log.write(f"$ {command}\ncwd: {ROOT}\npid: {pid}\nstarted: {started}\n\n")
        log.flush()

        async def pump() -> None:
            assert process.stdout
            while chunk := await process.stdout.readline():
                log.write(chunk.decode(errors="replace"))
                log.flush()

        asyncio.create_task(pump())
        meta = {
            "id": pid,
            "command": command,
            "cwd": str(ROOT),
            "pid": process.pid,
            "pgid": process.pid,
            "ownerPid": os.getpid(),
            "startedAt": started,
            "processStartedAt": process_started_at(process.pid),
            "log": f".tiny-agent/bg/{pid}.log",
            "status": "running",
        }
        BG_PROCESSES[pid] = process
        write_bg_meta(meta)
        asyncio.create_task(wait_bg_exit(process, meta, log))
        await asyncio.sleep(0.5)
        status = current_bg_status(meta)
        if status != "running":
            with suppress(Exception):
                meta = read_bg_meta(pid)
            status = current_bg_status(meta)
        return json.dumps({**meta, "status": status}) + (f"\n{log_tail(log_path)}" if status != "running" else "")
    if action == "list":
        status = args.get("status", "running")
        if status not in {"running", "exited", "stopped", "stale", "all"}:
            raise ValueError(f"unknown bg status filter: {status}")
        metas = []
        for path in bg_dir().glob("*.json"):
            with suppress(Exception):
                meta = read_bg_meta(path.stem)
                current = {**meta, "status": current_bg_status(meta)}
                if status == "all" or current["status"] == status:
                    metas.append(current)
        return json.dumps(metas)
    pid = args.get("id", "")
    meta = read_bg_meta(pid)
    meta_path, log_path = bg_paths(pid)
    if action == "status":
        return json.dumps({**meta, "status": current_bg_status(meta)}) + "\n" + log_tail(log_path, int(args.get("tail", 40)))
    if action == "logs":
        return log_tail(log_path, int(args.get("tail", 80))) or "(no output)"
    if action == "stop":
        if current_bg_status(meta) == "running":
            BG_PROCESSES.pop(pid, None)
            with suppress(ProcessLookupError, PermissionError):
                os.killpg(int(meta.get("pgid") or meta["pid"]), signal.SIGTERM)
            deadline = time.monotonic() + 2
            while time.monotonic() < deadline and process_running(int(meta["pid"])):
                await asyncio.sleep(0.05)
            if process_running(int(meta["pid"])):
                with suppress(ProcessLookupError, PermissionError):
                    os.killpg(int(meta.get("pgid") or meta["pid"]), signal.SIGKILL)
            meta.update({"status": "stopped", "exitedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())})
            write_bg_meta(meta)
        return json.dumps({**meta, "status": current_bg_status(meta)})
    raise ValueError(f"unknown bg action: {action}")


async def close_background_processes() -> None:
    for pid in list(BG_PROCESSES):
        with suppress(Exception):
            await execute_bg({"action": "stop", "id": pid}, asyncio.Event())


def _required_string(value: object, name: str) -> str:
    if not isinstance(value, str) or not value:
        raise ValueError(f"{name} must be a nonempty string")
    return value


def _optional_positive_integer(value: object, name: str) -> int | None:
    if value is None:
        return None
    if not isinstance(value, int) or isinstance(value, bool) or value < 1:
        raise ValueError(f"{name} must be an integer >= 1")
    return value


def _required_edits(value: object) -> list[dict[str, str]]:
    if not isinstance(value, list) or not value:
        raise ValueError("edits must be a nonempty array")
    edits = []
    for index, edit in enumerate(value):
        if not isinstance(edit, dict):
            raise ValueError(f"edits[{index}] must be an object")
        old_text, new_text = edit.get("oldText"), edit.get("newText")
        if not isinstance(old_text, str):
            raise ValueError(f"edits[{index}].oldText must be a string")
        if not old_text:
            raise ValueError(f"edits[{index}].oldText must not be empty")
        if not isinstance(new_text, str):
            raise ValueError(f"edits[{index}].newText must be a string")
        edits.append({"oldText": old_text, "newText": new_text})
    return edits


def _resolve_path(requested_path: str) -> Path:
    path = Path(requested_path)
    return path.resolve() if path.is_absolute() else (ROOT / path).resolve()


def _read_lines(text: str, offset: int = 1, limit: int = 2_000) -> str:
    lines = [] if text == "" else text.replace("\r\n", "\n").split("\n")
    if lines and lines[-1] == "":
        lines.pop()
    if not lines:
        if offset == 1:
            return ""
        raise ValueError(f"Offset {offset} is beyond end of file (0 lines total).")
    if offset > len(lines):
        raise ValueError(f"Offset {offset} is beyond end of file ({len(lines)} lines total).")
    selected = []
    for line in lines[offset - 1 : offset - 1 + min(limit, 2_000)]:
        candidate = "\n".join([*selected, line])
        if len(candidate.encode()) > MAX_TOOL_OUTPUT:
            break
        selected.append(line)
    if not selected:
        return f"Line {offset} exceeds 50KB. Use bash with a byte-oriented command to inspect this line."
    end = offset + len(selected) - 1
    result = "\n".join(selected)
    if end < len(lines):
        result += f"\n\n[Showing lines {offset}-{end} of {len(lines)}. Use offset={end + 1} to continue.]"
    return result


def _execute_file_tool(name: str, args: dict) -> str:
    requested_path = _required_string(args.get("path"), "path")
    path = _resolve_path(requested_path)
    if name == "read":
        offset = _optional_positive_integer(args.get("offset"), "offset") or 1
        limit = _optional_positive_integer(args.get("limit"), "limit") or 2_000
        return _read_lines(path.read_bytes().decode("utf-8"), offset, limit)
    if name == "write":
        content = args.get("content")
        if not isinstance(content, str):
            raise ValueError("content must be a string")
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(content.encode("utf-8"))
        return f"Successfully wrote {len(content.encode('utf-8'))} bytes to {requested_path}."
    if name != "edit":
        raise ValueError(f"unknown tool: {name}")

    edits = _required_edits(args.get("edits"))
    original = path.read_bytes().decode("utf-8")
    bom = original.startswith("\ufeff")
    text = original[1:] if bom else original
    first_newline = text.find("\n")
    newline = "\r\n" if first_newline > 0 and text[first_newline - 1] == "\r" else "\n"
    normalized, positions, source = "", [0], 0
    while source < len(text):
        if text.startswith("\r\n", source):
            normalized += "\n"
            source += 2
        else:
            normalized += text[source]
            source += 1
        positions.append(source)
    ranges = []
    for index, edit in enumerate(edits):
        old_text = edit["oldText"].replace("\r\n", "\n")
        start = normalized.find(old_text)
        second = normalized.find(old_text, start + 1) if start >= 0 else -1
        if start < 0:
            raise ValueError(f"edits[{index}].oldText was not found in {requested_path}.")
        if second >= 0:
            raise ValueError(f"edits[{index}].oldText occurs more than once in {requested_path}; add more context.")
        ranges.append({"index": index, "start": positions[start], "end": positions[start + len(old_text)], "newText": edit["newText"].replace("\r\n", "\n").replace("\n", newline)})
    ordered = sorted(ranges, key=lambda item: item["start"])
    for previous, current in zip(ordered, ordered[1:]):
        if current["start"] < previous["end"]:
            raise ValueError(f"edits[{previous['index']}] and edits[{current['index']}] overlap in {requested_path}.")
    edited = text
    for edit in sorted(ranges, key=lambda item: item["start"], reverse=True):
        edited = edited[: edit["start"]] + edit["newText"] + edited[edit["end"] :]
    path.write_bytes((("\ufeff" if bom else "") + edited).encode("utf-8"))
    return f"Successfully replaced {len(edits)} block(s) in {requested_path}."


async def execute_tool(name: str, args: dict, cancelled: asyncio.Event | None = None) -> str:
    cancelled = cancelled or asyncio.Event()
    if cancelled.is_set():
        raise InterruptedError("Operation aborted")
    if name == "bash":
        timeout = args.get("timeout", BASH_TIMEOUT_SECONDS)
        if isinstance(timeout, bool) or not isinstance(timeout, (int, float)) or not math.isfinite(timeout) or timeout <= 0:
            raise ValueError("timeout must be a positive number of seconds")
        return await execute_bash(_required_string(args.get("command"), "command"), cancelled, float(timeout))
    if name == "bg":
        return await execute_bg(args, cancelled)
    result = await asyncio.to_thread(_execute_file_tool, name, args)
    if cancelled.is_set():
        raise InterruptedError("Operation aborted")
    return result


class Agent:
    def __init__(
        self,
        skills: list[dict] | None = None,
        session: Session | None = None,
        instructions: str = "",
        requester: Callable | None = None,
        on_tool: Callable = lambda event: None,
        on_event: Callable = lambda event: None,
        tools: list[dict] | None = None,
        lifecycle: ExecutionLifecycle | None = None,
    ):
        self.skills, self.session, self.requester, self.on_tool, self.on_event = skills or [], session, requester, on_tool, on_event
        self.lifecycle = lifecycle or ExecutionLifecycle()
        if session:
            session.observe_commits(self.lifecycle.committed)
        self.recovering = False
        self.tools = tools if tools is not None else TOOL_DEFINITIONS
        self.usage = {"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0}
        self.cancelled: asyncio.Event | None = None
        self.active: dict | None = None
        self.activity_generation = 0
        listing = "\n".join(f"<skill>\n<name>{s['name']}</name>\n<description>{s['description']}</description>\n<location>{s['path']}</location>\n</skill>" for s in self.skills) or "(none)"
        project = (
            f'\n\n<project_context>\n\nProject-specific instructions and guidelines:\n\n<project_instructions path="{ROOT / "AGENTS.md"}">\n{instructions}\n</project_instructions>\n\n</project_context>'
            if instructions
            else ""
        )
        prompt = f"You are tiny-agent, a concise coding agent in {ROOT}. Use only the tools provided in this request. If the available tools cannot complete the task, explain the missing capability instead of calling an unavailable tool. Follow the project instructions below. When a task matches an available skill, use its location only when a provided tool can read it.\n\nFor implementation tasks, inspect only what is needed, then make the changes and run focused tests. Do not keep researching the same uncertainty when a mature dependency or direct implementation is available.\nUse the provided tool descriptions to choose the right capability. Not every run enables file access, shell access, or file modification.\nPrefer completing a small working implementation over exhaustively researching every option. If repeated experiments fail, reconsider the approach instead of making another similar attempt.{project}\n\n<available_skills>\n{listing}\n</available_skills>"
        self.messages = [{"role": "system", "content": prompt}]
        self.configuration, self.configuration_digest = runtime_configuration(prompt, self.tools, Settings().tiny_model)

    @property
    def busy(self) -> bool:
        return self.cancelled is not None

    def abort(self) -> None:
        active, cancelled = self.active, self.cancelled
        if cancelled and active and self.session and not active.get("abortRequested"):
            record = {
                "type": "abortRequested",
                "operationId": active["operationId"],
                "operationKind": active["operationKind"],
                "phase": active["phase"],
                "reason": "escape",
            }
            if active.get("toolCallId"):
                record["toolCallId"] = active["toolCallId"]
            active["abortRequested"] = self.session.request_abort(
                active["operationId"],
                cancelled,
                record_fact(record),
            )
        elif cancelled:
            cancelled.set()
        if cancelled and cancelled.is_set() and active:
            task = active.get("task")
            if task and task is not asyncio.current_task():
                task.cancel()

    def begin(self, operation_id: str, phase: str, tool_call_id: str | None = None, operation_kind: str = "run") -> asyncio.Event:
        self.activity_generation += 1
        self.cancelled = asyncio.Event()
        self.active = {
            "generation": self.activity_generation,
            "operationId": operation_id,
            "operationKind": operation_kind,
            "phase": phase,
            "toolCallId": tool_call_id,
            "abortRequested": False,
            "task": asyncio.current_task(),
        }
        return self.cancelled

    def end(self) -> None:
        self.cancelled = None
        self.active = None

    def _is_aborted(self, operation_id: str, cancelled: asyncio.Event) -> bool:
        operation = self.session.load()["operation"]
        return cancelled.is_set() or (operation.get("operationId") == operation_id and operation.get("abortRequested", False))

    def _fail_aborted_attempt(self, operation_id: str, step_id: str, attempt_id: str, cancelled: asyncio.Event, usage: dict | None = None, cache_rate: bool = True) -> None:
        failure = record_fact(step_failed_record(operation_id, step_id, attempt_id, "aborted", "Operation aborted"))
        if usage is None:
            self.session.append(failure)
            return
        self.session.append_aborted_attempt(
            operation_id,
            cancelled,
            failure,
            usage_fact(operation_id, attempt_id, usage),
        )
        self.add_usage(usage, cache_rate)

    def add_usage(self, usage: dict, cache_rate: bool = True) -> None:
        for key in ("input", "output", "cacheRead", "cacheWrite"):
            self.usage[key] += usage.get(key, 0)
        prompt = sum(usage.get(key, 0) for key in ("input", "cacheRead", "cacheWrite"))
        if cache_rate and prompt:
            self.usage["cacheHitRate"] = usage.get("cacheRead", 0) / prompt * 100

    def _current_recovery_configuration(self) -> dict:
        return current_configuration(self.configuration, self.configuration_digest, self.tools, TOOL_DEFINITIONS[1], environment_identity(ROOT))

    def _restore_projection(self) -> None:
        state = self.session.load()
        self.messages, self.usage = project_session(state, self.messages[0])
        usage_by_attempt = {fact["attemptId"]: fact["usage"] for fact in self._facts() if fact.get("kind") == "usage" and "attemptId" in fact}
        for fact in reversed(self._facts()):
            entry = fact.get("entry", {})
            if fact.get("kind") != "entry" or entry.get("type") != "message" or entry.get("message", {}).get("role") != "assistant":
                continue
            request_usage = usage_by_attempt.get(entry.get("attemptId"))
            if not request_usage:
                continue
            prompt = sum(request_usage.get(key, 0) for key in ("input", "cacheRead", "cacheWrite"))
            if prompt:
                self.usage["cacheHitRate"] = request_usage.get("cacheRead", 0) / prompt * 100
            break

    async def resume_session(self) -> str | None:
        if not self.session:
            return None
        if self.session.load()["operation"]["kind"] == "idle":
            self._restore_projection()
            return None
        self.recovering = True
        try:
            return await self._resume_session()
        finally:
            self.recovering = False

    async def _resume_session(self) -> str | None:
        self._restore_projection()
        attached: set[str] = set()
        while self.session.load()["operation"]["kind"] != "idle":
            state = self.session.load()
            operation = state["operation"]
            if operation["operationId"] not in attached:
                attached.add(operation["operationId"])
                self.lifecycle.observe({"type": "recovery.attached", "timestamp": timestamp(), "operationId": operation["operationId"], "operationKind": operation["kind"]})
            operation_id = state["operation"]["operationId"]
            action = plan_recovery(state, self._current_recovery_configuration())
            if action["type"] == "blocked":
                raise RuntimeError(f"Session recovery blocked: {action['reason']}")
            if action["type"] == "closeAttempt":
                step = state["operation"]["step"]
                record = {
                    "type": "stepFailed",
                    "operationId": operation_id,
                    "stepId": step["stepId"],
                    "attemptId": step["attemptId"],
                    "error": action["error"],
                }
                self.session.append(record_fact(record))
                continue
            if action["type"] == "appendSynthetic":
                self._append_synthetic_results(action["results"])
                self._restore_projection()
                continue
            if action["type"] == "startTool":
                await self._execute_recovered_tool(operation_id, action)
                self._restore_projection()
                continue
            if action["type"] == "startStep":
                if state["operation"]["kind"] == "compaction":
                    await self._continue_compaction(operation_id, action)
                    self._restore_projection()
                    continue
                answer = await self._continue_operation(operation_id, action)
                self._restore_projection()
                return answer
            if action["type"] == "finish":
                record = {"type": "operationFinished", "operationId": operation_id, "operationKind": state["operation"]["kind"], "outcome": action["outcome"]}
                for key in ("completion", "finalEntryId", "error"):
                    if key in action:
                        record[key] = action[key]
                self.session.append(record_fact(record))
                self._restore_projection()
                continue
            raise RuntimeError(f"Unknown recovery action: {action['type']}")

    def _append_synthetic_results(self, results: list[dict]) -> None:
        facts = []
        for item in results:
            message = {"role": "tool", "content": item["content"], "tool_call_id": item["toolCallId"]}
            entry = {
                "type": "message",
                "stepId": self.session.load()["operation"]["step"]["stepId"],
                "message": message,
                "toolName": item["toolName"],
                "result": {"type": "synthetic", "reason": item["reason"]},
            }
            if "toolStartedId" in item:
                entry["toolStartedId"] = item["toolStartedId"]
                fact_id = item["resultEntryId"]
            else:
                entry.update(assistantEntryId=item["assistantEntryId"], toolIndex=item["toolIndex"])
                fact_id = uuid7()
            facts.append(entry_fact(fact_id, entry))
        self.session.append(*facts)

    async def _execute_recovered_tool(self, operation_id: str, action: dict) -> None:
        state = self.session.load()
        step_id = state["operation"]["step"]["stepId"]
        tool = next((item for item in self.tools if item["function"]["name"] == action["toolName"]), None)
        if not tool:
            raise RuntimeError(f"Recovery tool unavailable: {action['toolName']}")
        if action["mode"] == "start":
            call = next(message for message in reversed(state["activeContext"]) if message["role"] == "assistant")["tool_calls"][action["toolIndex"]]
            await self._execute_durable_tool(operation_id, step_id, action["assistantEntryId"], action["toolIndex"], call, tool, action["arguments"])
            return
        pending = next(item for item in state["operation"]["toolCalls"] if item["toolStartedId"] == action["toolStartedId"])
        call = {"id": pending["toolCallId"]}
        await self._execute_durable_tool(
            operation_id,
            step_id,
            pending["assistantEntryId"],
            pending["toolIndex"],
            call,
            tool,
            action["arguments"],
            pending["toolStartedId"],
            pending["resultEntryId"],
        )

    async def _execute_durable_tool(
        self,
        operation_id: str,
        step_id: str,
        assistant_entry_id: str,
        tool_index: int,
        call: dict,
        tool: dict,
        args: dict,
        started_id: str | None = None,
        result_id: str | None = None,
    ) -> tuple[dict, str, bool]:
        name = tool["function"]["name"]
        if started_id is None:
            started_id, result_id = uuid7(), uuid7()
            replay, replay_key = replay_declaration(tool, TOOL_DEFINITIONS[1], name)
            record = {
                "type": "toolStarted",
                "operationId": operation_id,
                "stepId": step_id,
                "assistantEntryId": assistant_entry_id,
                "toolIndex": tool_index,
                "toolCallId": call["id"],
                "toolName": name,
                "arguments": args,
                "replay": replay,
                "replayKey": replay_key,
                "environmentIdentity": environment_identity(ROOT),
                "resultEntryId": result_id,
            }
            self.session.append(record_fact(record, started_id))
        assert result_id is not None

        started = time.monotonic()
        physical_attempt_id = uuid7()
        parent_attempt_id = self.session.load()["operation"].get("step", {}).get("attemptId", "")
        self.lifecycle.observe(
            {
                "type": "tool.started",
                "timestamp": timestamp(),
                "operationId": operation_id,
                "stepId": step_id,
                "attemptId": physical_attempt_id,
                "parentAttemptId": parent_attempt_id,
                "toolStartedId": started_id,
                "toolCallId": call["id"],
                "tool": name,
                "recovery": self.recovering,
            }
        )
        self.on_event({"type": "tool.started", "timestamp": timestamp(), "toolCallId": call["id"], "tool": name})
        self.on_tool({"phase": "start", "name": name, "args": args})
        cancelled = self.begin(operation_id, "tool", call["id"])
        aborted, ok = False, False
        try:
            content = await tool["execute"](args, cancelled) if "execute" in tool else await execute_tool(name, args, cancelled)
            ok = True
        except asyncio.CancelledError:
            aborted = self._is_aborted(operation_id, cancelled)
            if not aborted:
                self.end()
                raise
            content = "Operation interrupted after execution status became unknown; the tool was not replayed."
        except Exception as error:
            aborted = self._is_aborted(operation_id, cancelled)
            content = "Operation interrupted after execution status became unknown; the tool was not replayed." if aborted else f"Error: {error}"

        if not aborted:
            message = {"role": "tool", "content": content, "tool_call_id": call["id"]}
            result_type = "success" if ok else "error"
            entry = {"type": "message", "stepId": step_id, "message": message, "toolName": name, "toolStartedId": started_id, "result": {"type": result_type}}
            aborted = self.session.append_if_active(operation_id, cancelled, entry_fact(result_id, entry)) is None
        if aborted:
            content = "Operation interrupted after execution status became unknown; the tool was not replayed."
            message = {"role": "tool", "content": content, "tool_call_id": call["id"]}
            entry = {"type": "message", "stepId": step_id, "message": message, "toolName": name, "toolStartedId": started_id, "result": {"type": "synthetic", "reason": "interrupted"}}
            self.session.append(entry_fact(result_id, entry))
            ok = False

        self.end()
        self.on_tool({"phase": "end", "name": name, "args": args, "result": content})
        self.on_event(
            {
                "type": "tool.completed",
                "timestamp": timestamp(),
                "toolCallId": call["id"],
                "tool": name,
                "durationMs": (time.monotonic() - started) * 1000,
                "ok": ok,
            }
        )
        return message, result_id, aborted

    async def _continue_operation(self, operation_id: str, action: dict) -> str:
        return await self._run_operation(operation_id, action["contextThroughEntryId"], action)

    async def call_model(self, messages: list[dict], tools: list | None, cancelled: asyncio.Event) -> tuple[dict, dict, str]:
        started = time.monotonic()
        settings = Settings()
        key = settings.openrouter_api_key
        if not key:
            raise RuntimeError("Set OPENROUTER_API_KEY")
        body = {"model": settings.tiny_model, "messages": messages, **({"tools": tools} if tools else {})}
        if self.requester:
            data = await self.requester(body, cancelled)
        else:
            data = await _post_json(
                chat_completions_url(settings.tiny_endpoint),
                body,
                {
                    "Authorization": f"Bearer {key.get_secret_value()}",
                    "Content-Type": "application/json",
                    "HTTP-Referer": "https://github.com/geminixiang/tiny-agent",
                },
                120,
                cancelled,
            )
        raw_usage = data.get("usage", {})
        details = raw_usage.get("prompt_tokens_details", {})
        cache_read = details.get("cached_tokens", raw_usage.get("prompt_cache_hit_tokens", 0))
        cache_write = details.get("cache_write_tokens", 0)
        usage = {"input": max(0, raw_usage.get("prompt_tokens", 0) - cache_read - cache_write), "output": raw_usage.get("completion_tokens", 0), "cacheRead": cache_read, "cacheWrite": cache_write}
        answer = normalize_assistant_message(data["choices"][0]["message"])
        finish = data["choices"][0].get("finish_reason")
        event_usage = {**usage}
        prompt_tokens = sum(usage.get(key, 0) for key in ("input", "cacheRead", "cacheWrite"))
        if prompt_tokens:
            event_usage["cacheHitRate"] = usage.get("cacheRead", 0) / prompt_tokens * 100
        self.on_event({"type": "model.completed", "timestamp": timestamp(), "durationMs": (time.monotonic() - started) * 1000, "usage": event_usage})
        return answer, usage, provider_stop_reason(finish, answer)

    def _attempt(self, operation_id: str, context_id: str, kind: str = "assistant", attempt: int = 1, step_id: str | None = None) -> tuple[str, str]:
        step_id, attempt_id = step_id or uuid7(), uuid7()
        record = {
            "type": "stepAttempt",
            "operationId": operation_id,
            "stepId": step_id,
            "attemptId": attempt_id,
            "stepKind": kind,
            "attempt": attempt,
            "contextThroughEntryId": context_id,
            "configurationSnapshot": self.configuration,
            "configurationDigest": self.configuration_digest,
        }
        self.session.append(record_fact(record))
        return step_id, attempt_id

    def _finish(self, operation_id: str, outcome: str, final_id: str | None = None, completion: str | None = None, error: Exception | None = None, operation_kind: str = "run") -> None:
        record = {"type": "operationFinished", "operationId": operation_id, "operationKind": operation_kind, "outcome": outcome}
        if final_id:
            record["finalEntryId"] = final_id
        if completion:
            record["completion"] = completion
        if error:
            record["error"] = {"code": "agent_error", "message": str(error)}
        self.session.append(record_fact(record))

    async def run_agent_loop(self, text: str) -> str:
        if not self.session:
            raise RuntimeError("Session is required")
        user = {"role": "user", "content": text}
        user_id, operation_id = uuid7(), uuid7()
        self.session.append(
            entry_fact(user_id, {"type": "message", "message": user}),
            record_fact({"type": "runStarted", "operationId": operation_id, "operationKind": "run", "inputEntryId": user_id}),
        )
        self.messages.append(user)
        context_id = user_id
        return await self._run_operation(operation_id, context_id)

    async def _run_operation(self, operation_id: str, context_id: str, next_step: dict | None = None) -> str:
        model_tools = [{"type": tool["type"], "function": tool["function"]} for tool in self.tools]
        while True:
            if next_step:
                step_id, attempt_id = self._attempt(operation_id, next_step["contextThroughEntryId"], attempt=next_step["attempt"], step_id=next_step.get("stepId"))
                context_id, next_step = next_step["contextThroughEntryId"], None
            else:
                step_id, attempt_id = self._attempt(operation_id, context_id)
            cancelled = self.begin(operation_id, "model")
            try:
                answer, usage, stop_reason = await self.call_model(self.messages, model_tools, cancelled)
            except asyncio.CancelledError:
                aborted = self._is_aborted(operation_id, cancelled)
                self.end()
                if not aborted:
                    raise
                self.session.append(record_fact(step_failed_record(operation_id, step_id, attempt_id, "aborted", "Operation aborted")))
                self._finish(operation_id, "aborted")
                return "Operation aborted."
            except Exception as error:
                aborted = self._is_aborted(operation_id, cancelled)
                self.end()
                code = "aborted" if aborted else "model_error"
                message = "Operation aborted" if aborted else str(error)
                self.session.append(record_fact(step_failed_record(operation_id, step_id, attempt_id, code, message)))
                self._finish(operation_id, "aborted" if aborted else "failed", error=None if aborted else error)
                if aborted:
                    return "Operation aborted."
                raise
            answer_id = uuid7()
            committed = self.session.append_if_active(
                operation_id,
                cancelled,
                entry_fact(answer_id, {"type": "message", "stepId": step_id, "attemptId": attempt_id, "stopReason": stop_reason, "message": answer}),
                usage_fact(operation_id, attempt_id, usage),
            )
            self.end()
            if committed is None:
                self._fail_aborted_attempt(operation_id, step_id, attempt_id, cancelled, usage)
                self._finish(operation_id, "aborted")
                return "Operation aborted."
            self.add_usage(usage)
            self.messages.append(answer)
            context_id = answer_id
            calls = answer.get("tool_calls", [])
            if stop_reason == "length":
                if not calls:
                    error = RuntimeError("Model response was truncated")
                    self._finish(operation_id, "failed", error=error)
                    return "Model response was truncated."
                for index, call in enumerate(calls):
                    result = {"role": "tool", "content": "Error: Tool call arguments were truncated by the model token limit; the tool was not executed.", "tool_call_id": call["id"]}
                    result_id = uuid7()
                    entry = {
                        "type": "message",
                        "stepId": step_id,
                        "assistantEntryId": answer_id,
                        "toolIndex": index,
                        "message": result,
                        "toolName": call["function"]["name"],
                        "result": {"type": "synthetic", "reason": "truncated"},
                    }
                    self.session.append(entry_fact(result_id, entry))
                    self.messages.append(result)
                    context_id = result_id
                self._finish(operation_id, "completed", answer_id, "truncated")
                return answer.get("content") or "Model response was truncated."
            if not calls:
                content = answer.get("content") or ""
                if not content.strip():
                    error = RuntimeError("Model returned an empty response")
                    self._finish(operation_id, "failed", error=error)
                    raise error
                self._finish(operation_id, "completed", answer_id, "normal")
                return content
            for index, call in enumerate(calls):
                aborted = False
                name = call["function"]["name"]
                args = json_object(call["function"].get("arguments"))
                tool = next((item for item in self.tools if item["function"]["name"] == name), None)
                if args is None or not tool:
                    reason = "invalidArguments" if args is None else "unknownTool"
                    content = "Error: Tool arguments were invalid; the tool was not executed." if reason == "invalidArguments" else "Error: Unknown tool; the tool was not executed."
                    result = {"role": "tool", "content": content, "tool_call_id": call["id"]}
                    result_id = uuid7()
                    entry = {
                        "type": "message",
                        "stepId": step_id,
                        "assistantEntryId": answer_id,
                        "toolIndex": index,
                        "message": result,
                        "toolName": name,
                        "result": {"type": "synthetic", "reason": reason},
                    }
                    self.session.append(entry_fact(result_id, entry))
                else:
                    result, result_id, aborted = await self._execute_durable_tool(
                        operation_id,
                        step_id,
                        answer_id,
                        index,
                        call,
                        tool,
                        args,
                    )
                self.messages.append(result)
                context_id = result_id
                if not aborted:
                    continue
                for pending_index, pending in enumerate(calls[index + 1 :], index + 1):
                    skipped = {"role": "tool", "content": "Operation aborted before execution.", "tool_call_id": pending["id"]}
                    skipped_id = uuid7()
                    entry = {
                        "type": "message",
                        "stepId": step_id,
                        "assistantEntryId": answer_id,
                        "toolIndex": pending_index,
                        "message": skipped,
                        "toolName": pending["function"]["name"],
                        "result": {"type": "synthetic", "reason": "aborted"},
                    }
                    self.session.append(entry_fact(skipped_id, entry))
                    self.messages.append(skipped)
                    context_id = skipped_id
                self._finish(operation_id, "aborted")
                return "Operation aborted."

    async def compact(self) -> str:
        if not self.session:
            raise RuntimeError("Session is required")
        state = self.session.load()
        messages = state["activeContext"]
        if not messages:
            return "Nothing to compact."
        cut = max(len(messages) - 6, 0)
        while cut > 0 and messages[cut]["role"] != "user":
            cut -= 1
        if not cut:
            return "Nothing to compact."

        durable_source = self._message_facts()
        input_through_id = durable_source[-1]["id"]
        retained_count = len(messages) - cut
        retained = durable_source[-retained_count:] if retained_count else []
        compacted = durable_source[:-retained_count] if retained_count else durable_source
        if not compacted:
            return "Nothing to compact."

        operation_id, result_id = uuid7(), uuid7()
        record = {
            "type": "compactionStarted",
            "operationId": operation_id,
            "operationKind": "compaction",
            "inputThroughEntryId": input_through_id,
            "resultEntryId": result_id,
            "compactedEntryIds": [item["id"] for item in compacted],
            "retainedEntryIds": [item["id"] for item in retained],
            "sourceDigest": source_digest(self._full_state(), input_through_id),
        }
        self.session.append(record_fact(record))
        result = await self._continue_compaction(
            operation_id,
            {
                "attempt": 1,
                "contextThroughEntryId": input_through_id,
            },
        )
        self._restore_projection()
        return result

    async def _continue_compaction(self, operation_id: str, action: dict) -> str:
        state = self.session.load()
        operation = state["operation"]
        step_id, attempt_id = self._attempt(
            operation_id,
            action["contextThroughEntryId"],
            "compaction",
            action.get("attempt", 1),
            action.get("stepId"),
        )
        source = self._message_facts(operation["inputThroughEntryId"])
        messages = state["activeContext"]
        retained_count = len(self._compaction_record(operation_id)["retainedEntryIds"])
        old = messages[:-retained_count] if retained_count else messages
        cancelled = self.begin(operation_id, "compact", operation_kind="compaction")
        try:
            summary, usage, stop_reason = await self.call_model(
                [
                    {"role": "system", "content": "Summarize this coding session compactly. Preserve decisions, changed files, errors, and next steps."},
                    {"role": "user", "content": json.dumps(old, ensure_ascii=False, separators=(",", ":"))},
                ],
                None,
                cancelled,
            )
            text = summary.get("content") or ""
            if stop_reason != "stop" or not text.strip():
                raise RuntimeError("Model returned an invalid compaction summary")
        except asyncio.CancelledError:
            aborted = self._is_aborted(operation_id, cancelled)
            self.end()
            if not aborted:
                raise
            self.session.append(record_fact(step_failed_record(operation_id, step_id, attempt_id, "aborted", "Operation aborted")))
            self._finish(operation_id, "aborted", operation_kind="compaction")
            return "Compaction aborted."
        except Exception as error:
            aborted = self._is_aborted(operation_id, cancelled)
            self.end()
            code = "aborted" if aborted else "model_error"
            message = "Operation aborted" if aborted else str(error)
            self.session.append(record_fact(step_failed_record(operation_id, step_id, attempt_id, code, message)))
            self._finish(operation_id, "aborted" if aborted else "failed", error=None if aborted else error, operation_kind="compaction")
            if aborted:
                return "Compaction aborted."
            raise
        retained_ids = set(self._compaction_record(operation_id)["retainedEntryIds"])
        retained = [{"sourceEntryId": item["id"], "message": item["message"]} for item in source if item["id"] in retained_ids]
        result_id = operation["resultEntryId"]
        committed = self.session.append_if_active(
            operation_id,
            cancelled,
            entry_fact(
                result_id,
                {
                    "type": "compaction",
                    "operationId": operation_id,
                    "summary": text,
                    "compactedThroughEntryId": self._compaction_record(operation_id)["compactedEntryIds"][-1],
                    "retainedTail": retained,
                },
            ),
            usage_fact(operation_id, attempt_id, usage),
        )
        self.end()
        if committed is None:
            self._fail_aborted_attempt(operation_id, step_id, attempt_id, cancelled, usage, cache_rate=False)
            self._finish(operation_id, "aborted", operation_kind="compaction")
            return "Compaction aborted."
        self.add_usage(usage, cache_rate=False)
        self._finish(operation_id, "completed", result_id, operation_kind="compaction")
        return f"Compacted {len(source) - len(retained)} messages (kept last {len(retained)})."

    def _facts(self) -> list[dict]:
        facts = []
        for raw in self.session.data.decode().splitlines()[1:]:
            value = json.loads(raw)
            facts.extend(value if isinstance(value, list) else [value])
        return facts

    def _full_state(self) -> dict:
        # source_digest needs the reducer's entry index, which is intentionally private in the public projection.
        state = {"entries": {}}
        for fact in self._facts():
            if fact.get("kind") == "entry":
                state["entries"][fact["id"]] = {"entry": fact["entry"]}
        return state

    def _message_facts(self, through_id: str | None = None) -> list[dict]:
        result = []
        for fact in self._facts():
            if fact.get("kind") == "entry" and fact["entry"].get("type") == "message":
                result.append({"id": fact["id"], "message": fact["entry"]["message"]})
            if through_id and fact.get("id") == through_id:
                break
        return result

    def _compaction_record(self, operation_id: str) -> dict:
        return next(
            fact["record"] for fact in reversed(self._facts()) if fact.get("kind") == "record" and fact["record"].get("type") == "compactionStarted" and fact["record"]["operationId"] == operation_id
        )
