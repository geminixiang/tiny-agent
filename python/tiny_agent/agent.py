from __future__ import annotations

import http.client
import json
import os
import re
import secrets
import select
import signal
import subprocess
import threading
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable
from urllib.parse import urlsplit

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


def uuid7(now_ms: int | None = None) -> str:
    value = bytearray(secrets.token_bytes(16)); value[:6] = (now_ms or time.time_ns() // 1_000_000).to_bytes(6, "big")
    value[6] = value[6] & 0x0F | 0x70; value[8] = value[8] & 0x3F | 0x80
    h = value.hex(); return f"{h[:8]}-{h[8:12]}-{h[12:16]}-{h[16:20]}-{h[20:]}"


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


class Session:
    def __init__(self, session_id: str, path: Path): self.id, self.path, self.lock = session_id, path, threading.Lock()

    @classmethod
    def create(cls, cwd: Path = ROOT, now: datetime | None = None) -> Session:
        now = now or datetime.now(timezone.utc); session_id = uuid7(int(now.timestamp() * 1000)); directory = cwd / ".tiny-agent/sessions"; directory.mkdir(parents=True, exist_ok=True)
        stamp = now.isoformat(timespec="milliseconds").replace("+00:00", "Z"); path = directory / f"{stamp.replace(':', '-').replace('.', '-')}_{session_id}.jsonl"
        session = cls(session_id, path); session.append({"type": "session", "version": 1, "id": session_id, "createdAt": stamp, "cwd": str(cwd), "provider": "openrouter", "model": MODEL}); return session

    @classmethod
    def open(cls, session_id: str, cwd: Path = ROOT) -> Session:
        if not re.fullmatch(r"[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}", session_id, re.I): raise ValueError(f"Invalid session ID: {session_id}")
        matches = list((cwd / ".tiny-agent/sessions").glob(f"*_{session_id}.jsonl"))
        if len(matches) != 1: raise ValueError(f"{'Duplicate session ID' if matches else 'Session not found'}: {session_id}")
        return cls(session_id, matches[0])

    def append(self, record: dict) -> None:
        record = {**record, "timestamp": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")}
        with self.lock, self.path.open("a", encoding="utf-8") as file: file.write(json.dumps(record, ensure_ascii=False, separators=(",", ":")) + "\n")

    def records(self) -> list[dict]: return [json.loads(line) for line in self.path.read_text(encoding="utf-8").splitlines() if line]


class Agent:
    def __init__(self, skills: list[dict] | None = None, session: Session | None = None, instructions: str = "", requester: Callable | None = None, on_tool: Callable = lambda event: None, tools: list[dict] | None = None):
        self.skills, self.session, self.requester, self.on_tool = skills or [], session, requester, on_tool
        self.tools = tools if tools is not None else TOOL_DEFINITIONS
        self.usage = {"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0}
        self.cancelled: threading.Event | None = None; self.connection: http.client.HTTPConnection | None = None
        listing = "\n".join(f"<skill>\n<name>{s['name']}</name>\n<description>{s['description']}</description>\n<location>{s['path']}</location>\n</skill>" for s in self.skills) or "(none)"
        project = f'\n\n<project_context>\n\nProject-specific instructions and guidelines:\n\n<project_instructions path="{ROOT / "AGENTS.md"}">\n{instructions}\n</project_instructions>\n\n</project_context>' if instructions else ""
        prompt = f"You are tiny-agent, a concise coding agent in {ROOT}. Use tools to inspect and change files. Follow the project instructions below. When a task matches an available skill, use read on its location before following it.{project}\n\n<available_skills>\n{listing}\n</available_skills>"
        self.messages = [{"role": "system", "content": prompt}]

    @property
    def busy(self) -> bool: return self.cancelled is not None

    def abort(self) -> None:
        if self.cancelled: self.cancelled.set()
        if self.connection:
            try: self.connection.close()
            except OSError: pass

    def begin(self) -> threading.Event: self.cancelled = threading.Event(); return self.cancelled
    def end(self) -> None: self.cancelled = None; self.connection = None
    def interrupt(self, phase: str, tool_call_id: str | None = None) -> None:
        if self.session: self.session.append({"type": "interruption", "phase": phase, "reason": "escape", **({"toolCallId": tool_call_id} if tool_call_id else {})})

    def add_usage(self, usage: dict, cache_rate: bool) -> None:
        for key in ("input", "output", "cacheRead", "cacheWrite"): self.usage[key] += usage.get(key, 0)
        prompt = usage.get("input", 0) + usage.get("cacheRead", 0) + usage.get("cacheWrite", 0)
        if cache_rate and prompt: self.usage["cacheHitRate"] = usage.get("cacheRead", 0) / prompt * 100

    def resume_session(self) -> None:
        if not self.session: return
        for record in self.session.records()[1:]:
            if record["type"] == "message":
                self.messages.append(record["message"])
                if record.get("usage"): self.add_usage(record["usage"], True)
                continue
            if record["type"] != "compaction": continue
            count = record["keptMessages"]; recent = self.messages[-count:] if count else []
            self.messages = [self.messages[0], {"role": "user", "content": f"[Compacted history]\n{record['summary']}"}, *recent]
            self.add_usage(record["usage"], False)

    def call_model(self, messages: list[dict], tools: list | None, update_cache_rate: bool, cancelled: threading.Event) -> tuple[dict, dict]:
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
        self.add_usage(usage, update_cache_rate)
        return data["choices"][0]["message"], usage

    def model_request(self, messages: list[dict], tools: list | None, phase: str, update_cache_rate: bool = True) -> tuple[dict, dict] | None:
        cancelled = self.begin()
        try: return self.call_model(messages, tools, update_cache_rate, cancelled)
        except BaseException:
            if not cancelled.is_set(): raise
            self.interrupt(phase); return None
        finally: self.end()

    def run_agent_loop(self, text: str) -> str:
        user = {"role": "user", "content": text}; self.messages.append(user)
        if self.session: self.session.append({"type": "message", "message": user})
        model_tools = [{"type": tool["type"], "function": tool["function"]} for tool in self.tools]
        while True:
            response = self.model_request(self.messages, model_tools, "model")
            if not response: return "Operation aborted."
            answer, usage = response; self.messages.append(answer)
            if self.session: self.session.append({"type": "message", "message": answer, "usage": usage})
            calls = answer.get("tool_calls", [])
            if not calls: return answer.get("content") or ""
            for index, call in enumerate(calls):
                args, aborted = {}, False; cancelled = self.begin()
                try:
                    args = json.loads(call["function"]["arguments"]); self.on_tool({"phase": "start", "name": call["function"]["name"], "args": args})
                    name = call["function"]["name"]
                    tool = next((item for item in self.tools if item["function"]["name"] == name), None)
                    if not tool: raise ValueError(f"unknown tool: {name}")
                    content = tool["execute"](args, cancelled) if "execute" in tool else execute_tool(name, args, cancelled)
                except BaseException as error:
                    aborted = cancelled.is_set(); content = "Operation aborted" if aborted else f"Error: {error}"
                self.end(); self.on_tool({"phase": "end", "name": call["function"]["name"], "args": args, "result": content})
                result = {"role": "tool", "content": content, "tool_call_id": call["id"]}; self.messages.append(result)
                if self.session: self.session.append({"type": "message", "message": result, "toolName": call["function"]["name"]})
                if not aborted: continue
                for pending in calls[index + 1:]:
                    skipped = {"role": "tool", "content": "Operation aborted before execution", "tool_call_id": pending["id"]}; self.messages.append(skipped)
                    if self.session: self.session.append({"type": "message", "message": skipped, "toolName": pending["function"]["name"]})
                self.interrupt("tool", call["id"]); return "Operation aborted."

    def compact(self) -> str:
        if len(self.messages) <= 1: return "Nothing to compact."
        cut = max(len(self.messages) - 6, 1)
        while cut > 1 and self.messages[cut]["role"] != "user": cut -= 1
        recent, old = self.messages[cut:], self.messages[1:cut]
        if not old: return "Nothing to compact."
        response = self.model_request([{"role": "system", "content": "Summarize this coding session compactly. Preserve decisions, changed files, errors, and next steps."}, {"role": "user", "content": json.dumps(old, ensure_ascii=False, separators=(",", ":"))}], None, "compact", False)
        if not response: return "Compaction aborted."
        summary, usage = response; text = summary.get("content")
        self.messages = [self.messages[0], {"role": "user", "content": f"[Compacted history]\n{text}"}, *recent]
        if self.session: self.session.append({"type": "compaction", "summary": text, "compactedMessages": len(old), "keptMessages": len(recent), "usage": usage})
        return f"Compacted {len(old)} messages (kept last {len(recent)})."
