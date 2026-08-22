from __future__ import annotations

import hashlib
import http.client
import json
import os
import re
import select
import signal
import subprocess
import threading
import time
from pathlib import Path
from typing import Callable
from urllib.parse import urlsplit

from .session import Session, environment_identity, uuid7
from .session_reducer import configuration_digest

DEFAULT_MODEL = "deepseek/deepseek-v4-flash-0731"
OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions"
MAX_BASH_OUTPUT = 10 * 1024 * 1024
MAX_TOOL_OUTPUT = 50 * 1024
ROOT = Path.cwd().resolve()
MODEL = os.getenv("TINY_MODEL") or DEFAULT_MODEL


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
    try: return (ROOT / "AGENTS.md").read_text(encoding="utf-8")
    except FileNotFoundError: return ""


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


def path_in_root(path: str) -> Path:
    full = Path(path)
    full = (full if full.is_absolute() else ROOT / full).resolve()
    if full != ROOT and ROOT not in full.parents: raise ValueError("path must stay inside cwd")
    return full



def execute_bash(command: str, cancelled: threading.Event) -> str:
    process = subprocess.Popen(command, cwd=ROOT, shell=True, executable="/bin/sh", stdout=subprocess.PIPE, stderr=subprocess.STDOUT, start_new_session=True)
    output = bytearray(); deadline = time.monotonic() + 120
    assert process.stdout
    os.set_blocking(process.stdout.fileno(), False)
    try:
        while process.poll() is None:
            if cancelled.is_set(): raise InterruptedError("Operation aborted")
            if time.monotonic() >= deadline: raise TimeoutError("bash timed out after 120 seconds")
            ready, _, _ = select.select([process.stdout], [], [], 0.05)
            if ready:
                chunk = os.read(process.stdout.fileno(), 65_536); remaining = MAX_BASH_OUTPUT - len(output); output.extend(chunk[:remaining])
                if len(chunk) > remaining: raise RuntimeError("bash output exceeded 10MB limit")
        while chunk := os.read(process.stdout.fileno(), 65_536):
            remaining = MAX_BASH_OUTPUT - len(output); output.extend(chunk[:remaining])
            if len(chunk) > remaining: raise RuntimeError("bash output exceeded 10MB limit")
    except BaseException:
        if process.poll() is None:
            try: os.killpg(process.pid, signal.SIGKILL)
            except (ProcessLookupError, PermissionError): pass
        process.wait(); process.stdout.close()
        raise
    process.stdout.close()
    text = output.decode(errors="replace") or "(no output)"
    if process.returncode and text == "(no output)": raise RuntimeError(f"command exited with status {process.returncode}")
    if len(output) <= MAX_TOOL_OUTPUT: return text if not process.returncode else f"{text}\nError: command exited with status {process.returncode}"
    directory = ROOT / ".tiny-agent/tool-output"; directory.mkdir(parents=True, exist_ok=True)
    path = directory / f"{uuid7()}.log"; path.write_bytes(output)
    tail = output[-MAX_TOOL_OUTPUT:]
    while tail and tail[0] & 0xC0 == 0x80: tail = tail[1:]
    result = f"{tail.decode(errors='replace')}\n\n[Output truncated. Full output: {path}]"
    return result if not process.returncode else f"{result}\nError: command exited with status {process.returncode}"


def execute_tool(name: str, args: dict[str, str], cancelled: threading.Event | None = None) -> str:
    cancelled = cancelled or threading.Event()
    if cancelled.is_set(): raise InterruptedError("Operation aborted")
    if name == "bash": return execute_bash(args["command"], cancelled)
    path = path_in_root(args["path"])
    if name == "read":
        text = path.read_text(encoding="utf-8")
        if cancelled.is_set(): raise InterruptedError("Operation aborted")
        return text[:100_000]
    if name == "write":
        path.parent.mkdir(parents=True, exist_ok=True)
        if cancelled.is_set(): raise InterruptedError("Operation aborted")
        path.write_text(args["content"], encoding="utf-8"); return "ok"
    if name == "edit":
        text, old = path.read_text(encoding="utf-8"), args["oldText"]
        count = text.count(old)
        if count != 1: raise ValueError(f"oldText must occur exactly once (found {count})")
        if cancelled.is_set(): raise InterruptedError("Operation aborted")
        path.write_text(text.replace(old, args["newText"], 1), encoding="utf-8"); return "ok"
    raise ValueError(f"unknown tool: {name}")



class Agent:
    def __init__(self, skills: list[dict] | None = None, session: Session | None = None, instructions: str = "", requester: Callable | None = None, on_tool: Callable = lambda event: None, tools: list[dict] | None = None):
        self.skills, self.session, self.requester, self.on_tool = skills or [], session, requester, on_tool
        self.tools = tools if tools is not None else TOOL_DEFINITIONS
        self.usage = {"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0}
        self.cancelled: threading.Event | None = None; self.connection: http.client.HTTPConnection | None = None
        self.active: dict | None = None
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
        model = os.getenv("TINY_MODEL") or DEFAULT_MODEL
        return {
            "model": model, "systemPromptDigest": digest(prompt), "tools": declarations,
            "adapterIdentity": "openrouter:chat-completions:v1", "routingIdentity": f"openrouter:{model}",
            "outputOptionsDigest": digest("{}"),
        }

    @property
    def busy(self) -> bool: return self.cancelled is not None

    def abort(self) -> None:
        if self.cancelled and self.active and self.session and not self.active.get("abortRequested"):
            record = {
                "type": "abortRequested", "operationId": self.active["operationId"],
                "operationKind": "run", "phase": self.active["phase"], "reason": "escape",
            }
            if self.active.get("toolCallId"): record["toolCallId"] = self.active["toolCallId"]
            self.session.append({"kind": "record", "record": record})
            self.active["abortRequested"] = True
        if self.cancelled: self.cancelled.set()
        if self.connection:
            try: self.connection.close()
            except OSError: pass

    def begin(self, operation_id: str, phase: str, tool_call_id: str | None = None) -> threading.Event:
        self.cancelled = threading.Event()
        self.active = {"operationId": operation_id, "phase": phase, "toolCallId": tool_call_id, "abortRequested": False}
        return self.cancelled

    def end(self) -> None: self.cancelled = None; self.connection = None; self.active = None

    def add_usage(self, usage: dict, cache_rate: bool = True) -> None:
        for key in ("input", "output", "cacheRead", "cacheWrite"): self.usage[key] += usage.get(key, 0)
        prompt = self.usage["input"] + self.usage["cacheRead"] + self.usage["cacheWrite"]
        if cache_rate and prompt: self.usage["cacheHitRate"] = self.usage["cacheRead"] / prompt * 100

    def resume_session(self) -> None:
        if not self.session: return
        state = self.session.load()
        if state["operation"]["kind"] != "idle": raise RuntimeError("Session recovery required before resume")
        self.messages = [self.messages[0], *state["activeContext"]]
        self.usage.update(state["usage"])
        prompt = sum(state["usage"][key] for key in ("input", "cacheRead", "cacheWrite"))
        if prompt: self.usage["cacheHitRate"] = state["usage"]["cacheRead"] / prompt * 100

    def call_model(self, messages: list[dict], tools: list | None, cancelled: threading.Event) -> tuple[dict, dict, str]:
        key = os.getenv("OPENROUTER_API_KEY")
        if not key: raise RuntimeError("Set OPENROUTER_API_KEY")
        body = {"model": os.getenv("TINY_MODEL") or DEFAULT_MODEL, "messages": messages, **({"tools": tools} if tools else {})}
        if self.requester: data = self.requester(body, cancelled)
        else:
            url = urlsplit(OPENROUTER_URL); connection = http.client.HTTPSConnection(url.hostname, timeout=120); self.connection = connection
            try:
                connection.request("POST", url.path, json.dumps(body), {"Authorization": f"Bearer {key}", "Content-Type": "application/json", "HTTP-Referer": "https://github.com/geminixiang/tiny-agent"})
                response = connection.getresponse(); raw = response.read().decode()
            finally:
                connection.close()
                if self.connection is connection: self.connection = None
            if response.status < 200 or response.status >= 300: raise RuntimeError(f"OpenRouter {response.status}: {raw}")
            data = json.loads(raw)
        raw_usage = data.get("usage", {}); details = raw_usage.get("prompt_tokens_details", {})
        cache_read = details.get("cached_tokens", raw_usage.get("prompt_cache_hit_tokens", 0)); cache_write = details.get("cache_write_tokens", 0)
        usage = {"input": max(0, raw_usage.get("prompt_tokens", 0) - cache_read - cache_write), "output": raw_usage.get("completion_tokens", 0), "cacheRead": cache_read, "cacheWrite": cache_write}
        answer = data["choices"][0]["message"]
        finish = data["choices"][0].get("finish_reason")
        stop_reason = "length" if finish == "length" else "toolUse" if answer.get("tool_calls") else "stop"
        self.add_usage(usage)
        return answer, usage, stop_reason

    def _attempt(self, operation_id: str, context_id: str, kind: str = "assistant") -> tuple[str, str]:
        step_id, attempt_id = uuid7(), uuid7()
        self.session.append({"kind": "record", "record": {
            "type": "stepAttempt", "operationId": operation_id, "stepId": step_id, "attemptId": attempt_id,
            "stepKind": kind, "attempt": 1, "contextThroughEntryId": context_id,
            "configurationSnapshot": self.configuration, "configurationDigest": self.configuration_digest,
        }})
        return step_id, attempt_id

    def _finish(self, operation_id: str, outcome: str, final_id: str | None = None, completion: str | None = None, error: Exception | None = None) -> None:
        record = {"type": "operationFinished", "operationId": operation_id, "operationKind": "run", "outcome": outcome}
        if final_id: record["finalEntryId"] = final_id
        if completion: record["completion"] = completion
        if error: record["error"] = {"code": "agent_error", "message": str(error)}
        self.session.append({"kind": "record", "record": record})

    def run_agent_loop(self, text: str) -> str:
        if not self.session: raise RuntimeError("Session is required")
        user = {"role": "user", "content": text}; user_id, operation_id = uuid7(), uuid7()
        self.session.append(
            {"kind": "entry", "id": user_id, "entry": {"type": "message", "message": user}},
            {"kind": "record", "record": {"type": "runStarted", "operationId": operation_id, "operationKind": "run", "inputEntryId": user_id}},
        )
        self.messages.append(user); context_id = user_id
        model_tools = [{"type": tool["type"], "function": tool["function"]} for tool in self.tools]
        while True:
            step_id, attempt_id = self._attempt(operation_id, context_id)
            cancelled = self.begin(operation_id, "model")
            try: answer, usage, stop_reason = self.call_model(self.messages, model_tools, cancelled)
            except BaseException as error:
                aborted = cancelled.is_set(); self.end()
                self.session.append({"kind": "record", "record": {"type": "stepFailed", "operationId": operation_id, "stepId": step_id, "attemptId": attempt_id, "error": {"code": "aborted" if aborted else "model_error", "message": "Operation aborted" if aborted else str(error)}}})
                self._finish(operation_id, "aborted" if aborted else "failed", error=None if aborted else error)
                if aborted: return "Operation aborted."
                raise
            self.end(); answer_id = uuid7()
            self.session.append(
                {"kind": "entry", "id": answer_id, "entry": {"type": "message", "stepId": step_id, "attemptId": attempt_id, "stopReason": stop_reason, "message": answer}},
                {"kind": "usage", "operationId": operation_id, "attemptId": attempt_id, "usage": usage},
            )
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
                    self.session.append({"kind": "entry", "id": result_id, "entry": {"type": "message", "stepId": step_id, "assistantEntryId": answer_id, "toolIndex": index, "message": result, "toolName": call["function"]["name"], "result": {"type": "synthetic", "reason": "truncated"}}})
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
                try: args = json.loads(call["function"]["arguments"])
                except (json.JSONDecodeError, TypeError): args = None
                tool = next((item for item in self.tools if item["function"]["name"] == name), None)
                if not isinstance(args, dict) or not tool:
                    reason = "invalidArguments" if not isinstance(args, dict) else "unknownTool"
                    content = "Error: Tool arguments were invalid; the tool was not executed." if reason == "invalidArguments" else "Error: Unknown tool; the tool was not executed."
                    result = {"role": "tool", "content": content, "tool_call_id": call["id"]}; result_id = uuid7()
                    self.session.append({"kind": "entry", "id": result_id, "entry": {"type": "message", "stepId": step_id, "assistantEntryId": answer_id, "toolIndex": index, "message": result, "toolName": name, "result": {"type": "synthetic", "reason": reason}}})
                else:
                    started_id, result_id = uuid7(), uuid7()
                    replay = "safe" if name == "read" else "never"
                    self.session.append({"kind": "record", "id": started_id, "record": {"type": "toolStarted", "operationId": operation_id, "stepId": step_id, "assistantEntryId": answer_id, "toolIndex": index, "toolCallId": call["id"], "toolName": name, "arguments": args, "replay": replay, "replayKey": "builtin:read:v1" if replay == "safe" else f"tool:{name}:v1", "environmentIdentity": environment_identity(ROOT), "resultEntryId": result_id}})
                    cancelled = self.begin(operation_id, "tool", call["id"]); aborted = False
                    try:
                        self.on_tool({"phase": "start", "name": name, "args": args})
                        content = tool["execute"](args, cancelled) if "execute" in tool else execute_tool(name, args, cancelled)
                        result_type = "success"
                    except BaseException as error:
                        aborted = cancelled.is_set(); content = "Operation interrupted after execution status became unknown; the tool was not replayed." if aborted else f"Error: {error}"
                        result_type = "synthetic" if aborted else "error"
                    self.end(); self.on_tool({"phase": "end", "name": name, "args": args, "result": content})
                    result = {"role": "tool", "content": content, "tool_call_id": call["id"]}
                    result_meta = {"type": result_type, **({"reason": "interrupted"} if aborted else {})}
                    self.session.append({"kind": "entry", "id": result_id, "entry": {"type": "message", "stepId": step_id, "message": result, "toolName": name, "toolStartedId": started_id, "result": result_meta}})
                self.messages.append(result); context_id = result_id
                if not aborted: continue
                for pending_index, pending in enumerate(calls[index + 1:], index + 1):
                    skipped = {"role": "tool", "content": "Operation aborted before execution.", "tool_call_id": pending["id"]}; skipped_id = uuid7()
                    self.session.append({"kind": "entry", "id": skipped_id, "entry": {"type": "message", "stepId": step_id, "assistantEntryId": answer_id, "toolIndex": pending_index, "message": skipped, "toolName": pending["function"]["name"], "result": {"type": "synthetic", "reason": "aborted"}}})
                    self.messages.append(skipped); context_id = skipped_id
                self._finish(operation_id, "aborted"); return "Operation aborted."

    def compact(self) -> str:
        return "Compaction is temporarily unavailable during durable session migration."
