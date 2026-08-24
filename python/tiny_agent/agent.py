import asyncio
import hashlib
import importlib.util
import json
import os
import re
import signal
import ssl
import time
from contextlib import suppress
from pathlib import Path
from typing import Awaitable, Callable
from urllib.parse import urlsplit

from .http import close_writer, read_http_response, remaining, wait_owned
from .session import Session, environment_identity, uuid7
from .session_recovery import plan_recovery
from .session_reducer import configuration_digest, source_digest
from .settings import DEFAULT_MODEL, Settings

OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions"
MAX_BASH_OUTPUT = 10 * 1024 * 1024
BASH_TIMEOUT_SECONDS = 120
MAX_HTTP_RESPONSE = 10 * 1024 * 1024
MAX_TOOL_OUTPUT = 50 * 1024
ROOT = Path.cwd().resolve()


def format_tokens(n: int) -> str: return str(n) if n < 1_000 else f"{n / 1_000:.1f}k" if n < 10_000 else f"{n // 1_000}k" if n < 1_000_000 else f"{n / 1_000_000:.1f}M" if n < 10_000_000 else f"{n // 1_000_000}M"

def format_usage(usage: dict) -> str:
    parts = [f"↑{format_tokens(usage['input'])}", f"↓{format_tokens(usage['output'])}"]
    if usage["cacheRead"]: parts.append(f"R{format_tokens(usage['cacheRead'])}")
    if usage["cacheWrite"]: parts.append(f"W{format_tokens(usage['cacheWrite'])}")
    if (usage["cacheRead"] or usage["cacheWrite"]) and "cacheHitRate" in usage: parts.append(f"CH{usage['cacheHitRate']:.1f}%")
    return " ".join(parts)


def format_tool_event(event: dict) -> str:
    if event["phase"] == "end":
        result = event.get("result", "")
        return f"  └ {result}" if result in ("ok", "(no output)") else f"  └ {len(result)} chars"
    name, args = event["name"], event["args"]
    target = args.get("command" if name == "bash" else "path", "")
    target = target if len(target) <= 80 else target[:77] + "..."
    suffix = f" ({len(args.get('content', ''))} chars)" if name == "write" else f" ({len(args.get('oldText', ''))}→{len(args.get('newText', ''))} chars)" if name == "edit" else ""
    return f"◆ {name}{f' {target}' if target else ''}{suffix}"


def load_project_instructions() -> str:
    path = ROOT / "AGENTS.md"
    return path.read_text(encoding="utf-8") if path.is_file() else ""


def load_skills(extra: list[str] | None = None) -> list[dict]:
    files = sorted((ROOT / ".tiny-agent/skills").glob("**/SKILL.md")) + [Path(path).resolve() for path in extra or []]
    skills, seen = [], set()
    for path in files:
        path = path.resolve()
        if path in seen: continue
        seen.add(path)
        text = path.read_text(encoding="utf-8")
        head = re.match(r"^---\n(.*?)\n---", text, re.S)
        metadata = head.group(1) if head else ""
        field = lambda key: (re.search(rf"^{key}:\s*[\"']?(.*?)[\"']?$", metadata, re.M) or [None, ""])[1]
        skills.append({"name": field("name") or path.parent.name, "description": field("description"), "path": str(path)})
    return skills


TOOL_DEFINITIONS = []
for name, description, properties in [
    ("bash", "Run a shell command in the working directory", {"command": {"type": "string"}}),
    ("read", "Read a UTF-8 text file", {"path": {"type": "string"}}),
    ("write", "Create or overwrite a UTF-8 text file", {"path": {"type": "string"}, "content": {"type": "string"}}),
    ("edit", "Replace one unique exact string in a UTF-8 text file", {"path": {"type": "string"}, "oldText": {"type": "string"}, "newText": {"type": "string"}}),
]:
    TOOL_DEFINITIONS.append({"type": "function", "function": {"name": name, "description": description, "parameters": {"type": "object", "properties": properties, "required": list(properties)}}})


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
            if parsed.query: path += f"?{parsed.query}"
            request_headers = {"Host": parsed.hostname or "", "Content-Length": str(len(body)), "Connection": "close", **headers}
            raw_headers = "".join(f"{name}: {value}\r\n" for name, value in request_headers.items())
            writer.write(f"POST {path} HTTP/1.1\r\n{raw_headers}\r\n".encode() + body)
            await asyncio.wait_for(writer.drain(), remaining(deadline))
            status, _, raw = await read_http_response(
                reader, deadline, MAX_HTTP_RESPONSE,
                "OpenRouter returned an invalid HTTP response", "OpenRouter response exceeded 10MB",
            )
            text = raw.decode()
            if status < 200 or status >= 300: raise RuntimeError(f"OpenRouter {status}: {text}")
            return json.loads(text)
        finally:
            if writer: await close_writer(writer, deadline)

    return await wait_owned(request(), cancelled)


def normalize_assistant_message(value: object) -> dict:
    if not isinstance(value, dict) or value.get("role") != "assistant": raise RuntimeError("invalid assistant message")
    content = value.get("content")
    if content is not None and not isinstance(content, str): raise RuntimeError("invalid assistant content")
    normalized = {"role": "assistant", "content": content}
    raw_calls = value.get("tool_calls")
    if raw_calls is None: return normalized
    if not isinstance(raw_calls, list) or not raw_calls: raise RuntimeError("invalid assistant tool_calls")
    calls = []
    for value_call in raw_calls:
        if not isinstance(value_call, dict) or value_call.get("type") != "function": raise RuntimeError("invalid assistant tool call")
        function = value_call.get("function")
        if (
            not isinstance(value_call.get("id"), str) or not value_call["id"] or
            not isinstance(function, dict) or not isinstance(function.get("name"), str) or
            not function["name"] or not isinstance(function.get("arguments"), str)
        ):
            raise RuntimeError("invalid assistant tool call")
        calls.append({
            "id": value_call["id"],
            "type": "function",
            "function": {"name": function["name"], "arguments": function["arguments"]},
        })
    normalized["tool_calls"] = calls
    return normalized


def provider_stop_reason(finish: object, answer: dict) -> str:
    if finish == "length": return "length"
    if finish in ("tool_calls", "function_call"):
        if not answer.get("tool_calls"):
            raise RuntimeError(f"Provider finish_reason {finish} requires tool calls")
        return "toolUse"
    if finish in ("content_filter", "network_error"): raise RuntimeError(f"Provider finish_reason: {finish}")
    if finish not in (None, "stop"): raise RuntimeError(f"Unknown provider finish_reason: {finish}")
    return "toolUse" if answer.get("tool_calls") else "stop"


def entry_fact(fact_id: str, entry: dict) -> dict:
    return {"kind": "entry", "id": fact_id, "entry": entry}


def record_fact(record: dict, fact_id: str | None = None) -> dict:
    fact = {"kind": "record", "record": record}
    if fact_id: fact["id"] = fact_id
    return fact


def usage_fact(operation_id: str, attempt_id: str, usage: dict) -> dict:
    return {"kind": "usage", "operationId": operation_id, "attemptId": attempt_id, "usage": usage}


def step_failed_record(operation_id: str, step_id: str, attempt_id: str, code: str, message: str) -> dict:
    return {
        "type": "stepFailed", "operationId": operation_id, "stepId": step_id, "attemptId": attempt_id,
        "error": {"code": code, "message": message},
    }


def json_object(text: object) -> dict | None:
    if not isinstance(text, str) or not text.strip().startswith("{"):
        return None
    try:
        value = json.loads(text)
    except json.JSONDecodeError:
        return None
    return value if isinstance(value, dict) else None


async def execute_bash(command: str, cancelled: asyncio.Event) -> str:
    deadline = time.monotonic() + BASH_TIMEOUT_SECONDS
    creation = asyncio.create_task(asyncio.create_subprocess_shell(
        command, cwd=ROOT, executable="/bin/sh", stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.STDOUT, start_new_session=True,
    ))
    abort = asyncio.create_task(cancelled.wait())
    timer = asyncio.create_task(asyncio.sleep(max(0, deadline - time.monotonic())))
    process: asyncio.subprocess.Process | None = None
    read: asyncio.Task[bytes] | None = None
    waited: asyncio.Task[int] | None = None

    async def cancel_tasks(*tasks: asyncio.Task | None) -> None:
        active = [task for task in tasks if task is not None]
        for task in active: task.cancel()
        if active: await asyncio.gather(*active, return_exceptions=True)

    async def kill_process_group() -> None:
        assert process is not None
        with suppress(ProcessLookupError, PermissionError):
            os.killpg(process.pid, signal.SIGKILL)

    async def kill_and_reap() -> None:
        assert process is not None
        await kill_process_group()
        if process.stdout:
            transport = getattr(process.stdout, "_transport", None)
            if transport: transport.close()
        await cancel_tasks(read)
        if waited is not None:
            await asyncio.gather(waited, return_exceptions=True)
        else:
            await asyncio.gather(process.wait(), return_exceptions=True)

    try:
        done, _ = await asyncio.wait((creation, abort, timer), return_when=asyncio.FIRST_COMPLETED)
        if creation in done: process = await creation
        if abort in done:
            await cancel_tasks(creation)
            raise InterruptedError("Operation aborted")
        if timer in done:
            await cancel_tasks(creation)
            raise TimeoutError(f"bash timed out after {BASH_TIMEOUT_SECONDS:g} seconds")
        assert process is not None
        assert process.stdout

        output = bytearray()
        stdout_eof = False
        leader_exited = False
        read = asyncio.create_task(process.stdout.read(65_536))
        waited = asyncio.create_task(process.wait())
        while not (stdout_eof and leader_exited):
            monitored = [abort, timer, waited]
            if read is not None: monitored.append(read)
            done, _ = await asyncio.wait(monitored, return_when=asyncio.FIRST_COMPLETED)
            if abort in done: raise InterruptedError("Operation aborted")
            if timer in done: raise TimeoutError(f"bash timed out after {BASH_TIMEOUT_SECONDS:g} seconds")
            if read is not None and read in done:
                chunk = await read
                read = None
                if chunk:
                    remaining_bytes = MAX_BASH_OUTPUT - len(output)
                    output.extend(chunk[:remaining_bytes])
                    if len(chunk) > remaining_bytes:
                        raise RuntimeError("bash output exceeded 10MB limit")
                    read = asyncio.create_task(process.stdout.read(65_536))
                else:
                    stdout_eof = True
            if waited in done and not leader_exited:
                await waited
                leader_exited = True
                await kill_process_group()

        # The shell may have exited after starting redirected descendants which no
        # longer hold stdout open. Its isolated process group must not outlive the tool.
        await kill_process_group()
    except asyncio.CancelledError:
        if process is not None: await kill_and_reap()
        if cancelled.is_set(): raise InterruptedError("Operation aborted") from None
        raise
    except BaseException:
        if process is not None: await kill_and_reap()
        raise
    finally:
        await cancel_tasks(read, abort, timer)
        if process is None: await cancel_tasks(creation)

    text = output.decode(errors="replace") or "(no output)"
    if process.returncode and text == "(no output)": raise RuntimeError(f"command exited with status {process.returncode}")
    if len(output) <= MAX_TOOL_OUTPUT: return text if not process.returncode else f"{text}\nError: command exited with status {process.returncode}"

    def store_output() -> Path:
        directory = ROOT / ".tiny-agent/tool-output"
        directory.mkdir(parents=True, exist_ok=True)
        path = directory / f"{uuid7()}.log"
        path.write_bytes(output)
        return path

    if cancelled.is_set(): raise InterruptedError("Operation aborted")
    path = await asyncio.to_thread(store_output)
    if cancelled.is_set(): raise InterruptedError("Operation aborted")
    tail = output[-MAX_TOOL_OUTPUT:]
    while tail and tail[0] & 0xC0 == 0x80: tail = tail[1:]
    result = f"{tail.decode(errors='replace')}\n\n[Output truncated. Full output: {path}]"
    return result if not process.returncode else f"{result}\nError: command exited with status {process.returncode}"


async def execute_tool(name: str, args: dict[str, str], cancelled: asyncio.Event | None = None) -> str:
    cancelled = cancelled or asyncio.Event()
    if cancelled.is_set(): raise InterruptedError("Operation aborted")
    if name == "bash": return await execute_bash(args["command"], cancelled)

    def execute_file_tool() -> str:
        path = Path(args["path"])
        path = path if path.is_absolute() else ROOT / path
        if name == "read": return path.read_text(encoding="utf-8")[:100_000]
        if name == "write":
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(args["content"], encoding="utf-8")
            return "ok"
        if name == "edit":
            text, old = path.read_text(encoding="utf-8"), args["oldText"]
            count = text.count(old)
            if count != 1: raise ValueError(f"oldText must occur exactly once (found {count})")
            path.write_text(text.replace(old, args["newText"], 1), encoding="utf-8")
            return "ok"
        raise ValueError(f"unknown tool: {name}")

    result = await asyncio.to_thread(execute_file_tool)
    if cancelled.is_set(): raise InterruptedError("Operation aborted")
    return result



class Agent:
    def __init__(self, skills: list[dict] | None = None, session: Session | None = None, instructions: str = "", requester: Callable | None = None, on_tool: Callable = lambda event: None, tools: list[dict] | None = None):
        self.skills, self.session, self.requester, self.on_tool = skills or [], session, requester, on_tool
        self.tools = tools if tools is not None else TOOL_DEFINITIONS
        self.usage = {"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0}
        self.cancelled: asyncio.Event | None = None
        self.active: dict | None = None; self.activity_generation = 0
        listing = "\n".join(f"<skill>\n<name>{s['name']}</name>\n<description>{s['description']}</description>\n<location>{s['path']}</location>\n</skill>" for s in self.skills) or "(none)"
        project = f'\n\n<project_context>\n\nProject-specific instructions and guidelines:\n\n<project_instructions path="{ROOT / "AGENTS.md"}">\n{instructions}\n</project_instructions>\n\n</project_context>' if instructions else ""
        prompt = f"You are tiny-agent, a concise coding agent in {ROOT}. Use tools to inspect and change files. Follow the project instructions below. When a task matches an available skill, use read on its location before following it.{project}\n\n<available_skills>\n{listing}\n</available_skills>"
        self.messages = [{"role": "system", "content": prompt}]
        self.configuration = self._configuration(prompt)
        self.configuration_digest = configuration_digest(self.configuration)

    def _configuration(self, prompt: str) -> dict:
        digest = lambda value: "sha256:" + hashlib.sha256(value.encode()).hexdigest()
        declarations = []
        for tool in self.tools:
            function = tool["function"]
            definition = json.dumps({key: function[key] for key in ("name", "description", "parameters")}, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
            declarations.append({"name": function["name"], "definitionDigest": digest(definition)})
        model = Settings().tiny_model
        return {
            "model": model, "systemPromptDigest": digest(prompt), "tools": declarations,
            "adapterIdentity": "openrouter:chat-completions:v1", "routingIdentity": f"openrouter:{model}",
            "outputOptionsDigest": digest("{}"),
        }

    @property
    def busy(self) -> bool: return self.cancelled is not None

    def abort(self) -> None:
        active, cancelled = self.active, self.cancelled
        if cancelled and active and self.session and not active.get("abortRequested"):
            record = {
                "type": "abortRequested", "operationId": active["operationId"],
                "operationKind": active["operationKind"], "phase": active["phase"], "reason": "escape",
            }
            if active.get("toolCallId"): record["toolCallId"] = active["toolCallId"]
            active["abortRequested"] = self.session.request_abort(
                active["operationId"], cancelled, record_fact(record),
            )
        elif cancelled:
            cancelled.set()
        if cancelled and cancelled.is_set() and active:
            task = active.get("task")
            if task and task is not asyncio.current_task(): task.cancel()

    def begin(self, operation_id: str, phase: str, tool_call_id: str | None = None, operation_kind: str = "run") -> asyncio.Event:
        self.activity_generation += 1
        self.cancelled = asyncio.Event()
        self.active = {"generation": self.activity_generation, "operationId": operation_id, "operationKind": operation_kind, "phase": phase, "toolCallId": tool_call_id, "abortRequested": False, "task": asyncio.current_task()}
        return self.cancelled

    def end(self) -> None:
        self.cancelled = None; self.active = None

    def _is_aborted(self, operation_id: str, cancelled: asyncio.Event) -> bool:
        operation = self.session.load()["operation"]
        return cancelled.is_set() or (operation.get("operationId") == operation_id and operation.get("abortRequested", False))

    def _fail_aborted_attempt(self, operation_id: str, step_id: str, attempt_id: str, cancelled: asyncio.Event, usage: dict | None = None, cache_rate: bool = True) -> None:
        failure = record_fact(step_failed_record(operation_id, step_id, attempt_id, "aborted", "Operation aborted"))
        if usage is None:
            self.session.append(failure)
            return
        self.session.append_aborted_attempt(
            operation_id, cancelled, failure,
            usage_fact(operation_id, attempt_id, usage),
        )
        self.add_usage(usage, cache_rate)

    def add_usage(self, usage: dict, cache_rate: bool = True) -> None:
        for key in ("input", "output", "cacheRead", "cacheWrite"): self.usage[key] += usage.get(key, 0)
        prompt = sum(usage.get(key, 0) for key in ("input", "cacheRead", "cacheWrite"))
        if cache_rate and prompt: self.usage["cacheHitRate"] = usage.get("cacheRead", 0) / prompt * 100

    def _replay_declaration(self, tool: dict) -> tuple[str, str]:
        if tool is TOOL_DEFINITIONS[1]:
            return "safe", "builtin:read:v1"
        return "never", f"tool:{tool['function']['name']}:v1"

    def _current_recovery_configuration(self) -> dict:
        declarations = []
        for configured in self.configuration["tools"]:
            tool = next((item for item in self.tools if item["function"]["name"] == configured["name"]), None)
            replay, replay_key = self._replay_declaration(tool) if tool else ("never", f"tool:{configured['name']}:v1")
            declarations.append({**configured, "replay": replay, "replayKey": replay_key})
        return {
            "configurationDigest": self.configuration_digest,
            "environmentIdentity": environment_identity(ROOT),
            "tools": declarations,
        }

    def _restore_projection(self) -> None:
        state = self.session.load()
        self.messages = [self.messages[0], *state["activeContext"]]
        self.usage = {**state["usage"]}
        usage_by_attempt = {
            fact["attemptId"]: fact["usage"] for fact in self._facts()
            if fact.get("kind") == "usage" and "attemptId" in fact
        }
        for fact in reversed(self._facts()):
            entry = fact.get("entry", {})
            if fact.get("kind") != "entry" or entry.get("type") != "message" or entry.get("message", {}).get("role") != "assistant": continue
            request_usage = usage_by_attempt.get(entry.get("attemptId"))
            if not request_usage: continue
            prompt = sum(request_usage.get(key, 0) for key in ("input", "cacheRead", "cacheWrite"))
            if prompt: self.usage["cacheHitRate"] = request_usage.get("cacheRead", 0) / prompt * 100
            break

    async def resume_session(self) -> str | None:
        if not self.session: return None
        self._restore_projection()
        while self.session.load()["operation"]["kind"] != "idle":
            state = self.session.load()
            operation_id = state["operation"]["operationId"]
            action = plan_recovery(state, self._current_recovery_configuration())
            if action["type"] == "blocked":
                raise RuntimeError(f"Session recovery blocked: {action['reason']}")
            if action["type"] == "closeAttempt":
                step = state["operation"]["step"]
                record = {
                    "type": "stepFailed", "operationId": operation_id, "stepId": step["stepId"],
                    "attemptId": step["attemptId"], "error": action["error"],
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
                    if key in action: record[key] = action[key]
                self.session.append(record_fact(record))
                self._restore_projection()
                continue
            raise RuntimeError(f"Unknown recovery action: {action['type']}")

    def _append_synthetic_results(self, results: list[dict]) -> None:
        facts = []
        for item in results:
            message = {"role": "tool", "content": item["content"], "tool_call_id": item["toolCallId"]}
            entry = {
                "type": "message", "stepId": self.session.load()["operation"]["step"]["stepId"],
                "message": message, "toolName": item["toolName"],
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
        state = self.session.load(); step_id = state["operation"]["step"]["stepId"]
        tool = next((item for item in self.tools if item["function"]["name"] == action["toolName"]), None)
        if not tool: raise RuntimeError(f"Recovery tool unavailable: {action['toolName']}")
        if action["mode"] == "start":
            call = next(message for message in reversed(state["activeContext"]) if message["role"] == "assistant")["tool_calls"][action["toolIndex"]]
            started_id, result_id = uuid7(), uuid7()
            replay, replay_key = self._replay_declaration(tool)
            record = {
                "type": "toolStarted", "operationId": operation_id, "stepId": step_id,
                "assistantEntryId": action["assistantEntryId"], "toolIndex": action["toolIndex"],
                "toolCallId": call["id"], "toolName": action["toolName"], "arguments": action["arguments"],
                "replay": replay, "replayKey": replay_key,
                "environmentIdentity": environment_identity(ROOT), "resultEntryId": result_id,
            }
            self.session.append(record_fact(record, started_id))
        else:
            started_id = action["toolStartedId"]
            pending = next(item for item in state["operation"]["toolCalls"] if item["toolStartedId"] == started_id)
            result_id, call = pending["resultEntryId"], {"id": pending["toolCallId"]}
        cancelled = self.begin(operation_id, "tool", call["id"])
        aborted = False
        try:
            self.on_tool({"phase": "start", "name": action["toolName"], "args": action["arguments"]})
            content = await tool["execute"](action["arguments"], cancelled) if "execute" in tool else await execute_tool(action["toolName"], action["arguments"], cancelled)
            result = {"type": "success"}
        except BaseException as error:
            aborted = self._is_aborted(operation_id, cancelled)
            content = "Operation interrupted after execution status became unknown; the tool was not replayed." if aborted else f"Error: {error}"
            result = {"type": "synthetic", "reason": "interrupted"} if aborted else {"type": "error"}
        entry = lambda value, meta: entry_fact(result_id, {
            "type": "message", "stepId": step_id,
            "message": {"role": "tool", "content": value, "tool_call_id": call["id"]},
            "toolName": action["toolName"], "toolStartedId": started_id, "result": meta,
        })
        if not aborted and self.session.append_if_active(operation_id, cancelled, entry(content, result)) is None:
            aborted = True
        if aborted:
            content = "Operation interrupted after execution status became unknown; the tool was not replayed."
            self.session.append(entry(content, {"type": "synthetic", "reason": "interrupted"}))
        self.end(); self.on_tool({"phase": "end", "name": action["toolName"], "args": action["arguments"], "result": content})

    async def _continue_operation(self, operation_id: str, action: dict) -> str:
        return await self._run_operation(operation_id, action["contextThroughEntryId"], action)

    async def call_model(self, messages: list[dict], tools: list | None, cancelled: asyncio.Event) -> tuple[dict, dict, str]:
        settings = Settings(); key = settings.openrouter_api_key
        if not key: raise RuntimeError("Set OPENROUTER_API_KEY")
        body = {"model": settings.tiny_model, "messages": messages, **({"tools": tools} if tools else {})}
        if self.requester:
            data = await self.requester(body, cancelled)
        else:
            data = await _post_json(OPENROUTER_URL, body, {
                "Authorization": f"Bearer {key.get_secret_value()}", "Content-Type": "application/json",
                "HTTP-Referer": "https://github.com/geminixiang/tiny-agent",
            }, 120, cancelled)
        raw_usage = data.get("usage", {}); details = raw_usage.get("prompt_tokens_details", {})
        cache_read = details.get("cached_tokens", raw_usage.get("prompt_cache_hit_tokens", 0)); cache_write = details.get("cache_write_tokens", 0)
        usage = {"input": max(0, raw_usage.get("prompt_tokens", 0) - cache_read - cache_write), "output": raw_usage.get("completion_tokens", 0), "cacheRead": cache_read, "cacheWrite": cache_write}
        answer = normalize_assistant_message(data["choices"][0]["message"])
        finish = data["choices"][0].get("finish_reason")
        return answer, usage, provider_stop_reason(finish, answer)

    def _attempt(self, operation_id: str, context_id: str, kind: str = "assistant", attempt: int = 1, step_id: str | None = None) -> tuple[str, str]:
        step_id, attempt_id = step_id or uuid7(), uuid7()
        record = {
            "type": "stepAttempt", "operationId": operation_id, "stepId": step_id, "attemptId": attempt_id,
            "stepKind": kind, "attempt": attempt, "contextThroughEntryId": context_id,
            "configurationSnapshot": self.configuration, "configurationDigest": self.configuration_digest,
        }
        self.session.append(record_fact(record))
        return step_id, attempt_id

    def _finish(self, operation_id: str, outcome: str, final_id: str | None = None, completion: str | None = None, error: Exception | None = None, operation_kind: str = "run") -> None:
        record = {"type": "operationFinished", "operationId": operation_id, "operationKind": operation_kind, "outcome": outcome}
        if final_id: record["finalEntryId"] = final_id
        if completion: record["completion"] = completion
        if error: record["error"] = {"code": "agent_error", "message": str(error)}
        self.session.append(record_fact(record))

    async def run_agent_loop(self, text: str) -> str:
        if not self.session: raise RuntimeError("Session is required")
        user = {"role": "user", "content": text}; user_id, operation_id = uuid7(), uuid7()
        self.session.append(
            entry_fact(user_id, {"type": "message", "message": user}),
            record_fact({"type": "runStarted", "operationId": operation_id, "operationKind": "run", "inputEntryId": user_id}),
        )
        self.messages.append(user); context_id = user_id
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
            try: answer, usage, stop_reason = await self.call_model(self.messages, model_tools, cancelled)
            except BaseException as error:
                aborted = self._is_aborted(operation_id, cancelled); self.end()
                code = "aborted" if aborted else "model_error"
                message = "Operation aborted" if aborted else str(error)
                self.session.append(record_fact(step_failed_record(operation_id, step_id, attempt_id, code, message)))
                self._finish(operation_id, "aborted" if aborted else "failed", error=None if aborted else error)
                if aborted: return "Operation aborted."
                raise
            answer_id = uuid7()
            committed = self.session.append_if_active(
                operation_id, cancelled,
                entry_fact(answer_id, {"type": "message", "stepId": step_id, "attemptId": attempt_id, "stopReason": stop_reason, "message": answer}),
                usage_fact(operation_id, attempt_id, usage),
            )
            self.end()
            if committed is None:
                self._fail_aborted_attempt(operation_id, step_id, attempt_id, cancelled, usage)
                self._finish(operation_id, "aborted")
                return "Operation aborted."
            self.add_usage(usage)
            self.messages.append(answer); context_id = answer_id
            calls = answer.get("tool_calls", [])
            if stop_reason == "length":
                if not calls:
                    error = RuntimeError("Model response was truncated")
                    self._finish(operation_id, "failed", error=error)
                    return "Model response was truncated."
                for index, call in enumerate(calls):
                    result = {"role": "tool", "content": "Error: Tool call arguments were truncated by the model token limit; the tool was not executed.", "tool_call_id": call["id"]}
                    result_id = uuid7()
                    entry = {"type": "message", "stepId": step_id, "assistantEntryId": answer_id, "toolIndex": index, "message": result, "toolName": call["function"]["name"], "result": {"type": "synthetic", "reason": "truncated"}}
                    self.session.append(entry_fact(result_id, entry))
                    self.messages.append(result); context_id = result_id
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
                    result = {"role": "tool", "content": content, "tool_call_id": call["id"]}; result_id = uuid7()
                    entry = {"type": "message", "stepId": step_id, "assistantEntryId": answer_id, "toolIndex": index, "message": result, "toolName": name, "result": {"type": "synthetic", "reason": reason}}
                    self.session.append(entry_fact(result_id, entry))
                else:
                    started_id, result_id = uuid7(), uuid7()
                    replay, replay_key = self._replay_declaration(tool)
                    record = {"type": "toolStarted", "operationId": operation_id, "stepId": step_id, "assistantEntryId": answer_id, "toolIndex": index, "toolCallId": call["id"], "toolName": name, "arguments": args, "replay": replay, "replayKey": replay_key, "environmentIdentity": environment_identity(ROOT), "resultEntryId": result_id}
                    self.session.append(record_fact(record, started_id))
                    cancelled = self.begin(operation_id, "tool", call["id"]); aborted = False
                    try:
                        self.on_tool({"phase": "start", "name": name, "args": args})
                        content = await tool["execute"](args, cancelled) if "execute" in tool else await execute_tool(name, args, cancelled)
                        result_type = "success"
                    except BaseException as error:
                        aborted = self._is_aborted(operation_id, cancelled); content = "Operation interrupted after execution status became unknown; the tool was not replayed." if aborted else f"Error: {error}"
                        result_type = "synthetic" if aborted else "error"
                    if not aborted:
                        success = {"role": "tool", "content": content, "tool_call_id": call["id"]}
                        entry = {"type": "message", "stepId": step_id, "message": success, "toolName": name, "toolStartedId": started_id, "result": {"type": result_type}}
                        committed = self.session.append_if_active(operation_id, cancelled, entry_fact(result_id, entry))
                        aborted = committed is None
                    if aborted:
                        content = "Operation interrupted after execution status became unknown; the tool was not replayed."
                        result = {"role": "tool", "content": content, "tool_call_id": call["id"]}
                        entry = {"type": "message", "stepId": step_id, "message": result, "toolName": name, "toolStartedId": started_id, "result": {"type": "synthetic", "reason": "interrupted"}}
                        self.session.append(entry_fact(result_id, entry))
                    else:
                        result = success
                    self.end(); self.on_tool({"phase": "end", "name": name, "args": args, "result": content})
                self.messages.append(result); context_id = result_id
                if not aborted: continue
                for pending_index, pending in enumerate(calls[index + 1:], index + 1):
                    skipped = {"role": "tool", "content": "Operation aborted before execution.", "tool_call_id": pending["id"]}; skipped_id = uuid7()
                    entry = {"type": "message", "stepId": step_id, "assistantEntryId": answer_id, "toolIndex": pending_index, "message": skipped, "toolName": pending["function"]["name"], "result": {"type": "synthetic", "reason": "aborted"}}
                    self.session.append(entry_fact(skipped_id, entry))
                    self.messages.append(skipped); context_id = skipped_id
                self._finish(operation_id, "aborted"); return "Operation aborted."

    async def compact(self) -> str:
        if not self.session: raise RuntimeError("Session is required")
        state = self.session.load()
        messages = state["activeContext"]
        if not messages: return "Nothing to compact."
        cut = max(len(messages) - 6, 0)
        while cut > 0 and messages[cut]["role"] != "user": cut -= 1
        if not cut: return "Nothing to compact."

        durable_source = self._message_facts()
        input_through_id = durable_source[-1]["id"]
        retained_count = len(messages) - cut
        retained = durable_source[-retained_count:] if retained_count else []
        compacted = durable_source[:-retained_count] if retained_count else durable_source
        if not compacted: return "Nothing to compact."

        operation_id, result_id = uuid7(), uuid7()
        record = {
            "type": "compactionStarted", "operationId": operation_id, "operationKind": "compaction",
            "inputThroughEntryId": input_through_id, "resultEntryId": result_id,
            "compactedEntryIds": [item["id"] for item in compacted],
            "retainedEntryIds": [item["id"] for item in retained],
            "sourceDigest": source_digest(self._full_state(), input_through_id),
        }
        self.session.append(record_fact(record))
        result = await self._continue_compaction(operation_id, {
            "attempt": 1, "contextThroughEntryId": input_through_id,
        })
        self._restore_projection()
        return result

    async def _continue_compaction(self, operation_id: str, action: dict) -> str:
        state = self.session.load(); operation = state["operation"]
        step_id, attempt_id = self._attempt(
            operation_id, action["contextThroughEntryId"], "compaction",
            action.get("attempt", 1), action.get("stepId"),
        )
        source = self._message_facts(operation["inputThroughEntryId"])
        messages = state["activeContext"]
        retained_count = len(self._compaction_record(operation_id)["retainedEntryIds"])
        old = messages[:-retained_count] if retained_count else messages
        cancelled = self.begin(operation_id, "compact", operation_kind="compaction")
        try:
            summary, usage, stop_reason = await self.call_model([
                {"role": "system", "content": "Summarize this coding session compactly. Preserve decisions, changed files, errors, and next steps."},
                {"role": "user", "content": json.dumps(old, ensure_ascii=False, separators=(",", ":"))},
            ], None, cancelled)
            text = summary.get("content") or ""
            if stop_reason != "stop" or not text.strip(): raise RuntimeError("Model returned an invalid compaction summary")
        except BaseException as error:
            aborted = self._is_aborted(operation_id, cancelled); self.end()
            code = "aborted" if aborted else "model_error"
            message = "Operation aborted" if aborted else str(error)
            self.session.append(record_fact(step_failed_record(operation_id, step_id, attempt_id, code, message)))
            self._finish(operation_id, "aborted" if aborted else "failed", error=None if aborted else error, operation_kind="compaction")
            if aborted: return "Compaction aborted."
            raise
        retained_ids = set(self._compaction_record(operation_id)["retainedEntryIds"])
        retained = [{"sourceEntryId": item["id"], "message": item["message"]} for item in source if item["id"] in retained_ids]
        result_id = operation["resultEntryId"]
        committed = self.session.append_if_active(
            operation_id, cancelled,
            entry_fact(result_id, {
                "type": "compaction", "operationId": operation_id, "summary": text,
                "compactedThroughEntryId": self._compaction_record(operation_id)["compactedEntryIds"][-1],
                "retainedTail": retained,
            }),
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
            value = json.loads(raw); facts.extend(value if isinstance(value, list) else [value])
        return facts

    def _full_state(self) -> dict:
        # source_digest needs the reducer's entry index, which is intentionally private in the public projection.
        state = {"entries": {}}
        for fact in self._facts():
            if fact.get("kind") == "entry": state["entries"][fact["id"]] = {"entry": fact["entry"]}
        return state

    def _message_facts(self, through_id: str | None = None) -> list[dict]:
        result = []
        for fact in self._facts():
            if fact.get("kind") == "entry" and fact["entry"].get("type") == "message":
                result.append({"id": fact["id"], "message": fact["entry"]["message"]})
            if through_id and fact.get("id") == through_id: break
        return result

    def _compaction_record(self, operation_id: str) -> dict:
        return next(fact["record"] for fact in reversed(self._facts()) if fact.get("kind") == "record" and fact["record"].get("type") == "compactionStarted" and fact["record"]["operationId"] == operation_id)
