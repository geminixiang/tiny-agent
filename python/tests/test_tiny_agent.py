import io
import json
import os
import re
import threading
import time
import unittest
from contextlib import redirect_stdout
from datetime import datetime, timezone
from pathlib import Path
from tempfile import TemporaryDirectory
from types import SimpleNamespace
from unittest.mock import patch

from tiny_agent import agent as tiny
from tiny_agent import cli
from tiny_agent.cli import Terminal


class TinyAgentTest(unittest.TestCase):
    def setUp(self):
        self.temp = TemporaryDirectory(); self.old_root = tiny.ROOT
        tiny.ROOT = Path(self.temp.name).resolve()
        self.addCleanup(self.temp.cleanup); self.addCleanup(setattr, tiny, "ROOT", self.old_root)
        self.env = patch.dict(os.environ, {"OPENROUTER_API_KEY": "test"})
        self.env.start(); self.addCleanup(self.env.stop)

    def test_tools_paths_and_large_bash_output(self):
        self.assertEqual(tiny.execute_tool("write", {"path": "a.txt", "content": "hello"}), "ok")
        self.assertEqual(tiny.execute_tool("read", {"path": str(tiny.ROOT / "a.txt")}), "hello")
        self.assertEqual(tiny.execute_tool("edit", {"path": "a.txt", "oldText": "hello", "newText": "hi"}), "ok")
        with self.assertRaisesRegex(ValueError, "inside cwd"): tiny.execute_tool("read", {"path": "../secret"})
        result = tiny.execute_tool(
            "bash", {"command": "printf begin; yes x | head -n 30000; printf end"}
        )
        path = Path(re.search(r"Full output: (.*\.log)\]", result).group(1))
        self.assertTrue(path.read_text(encoding="utf-8").startswith("begin")); self.assertTrue(path.read_text(encoding="utf-8").endswith("end"))
        self.assertLess(len(result), path.stat().st_size)

    def test_bash_error_preserves_output_and_cancel_kills_children(self):
        self.assertIn("captured", tiny.execute_tool("bash", {"command": "printf captured; exit 7"}))
        old_limit = tiny.MAX_BASH_OUTPUT; tiny.MAX_BASH_OUTPUT = 1024
        try:
            with self.assertRaisesRegex(RuntimeError, "10MB limit"): tiny.execute_bash("yes x | head -n 10000", threading.Event())
        finally: tiny.MAX_BASH_OUTPUT = old_limit
        cancelled = threading.Event(); done = []
        thread = threading.Thread(target=lambda: self._capture_error(done, lambda: tiny.execute_bash("sleep 30 & wait", cancelled)))
        thread.start(); time.sleep(0.1); cancelled.set(); thread.join(2)
        self.assertFalse(thread.is_alive()); self.assertIsInstance(done[0], InterruptedError)

    @staticmethod
    def _capture_error(out, call):
        try: call()
        except BaseException as error: out.append(error)

    def test_skills_project_instructions_and_prompt(self):
        (tiny.ROOT / "AGENTS.md").write_text("Always be brief.", encoding="utf-8")
        path = tiny.ROOT / ".tiny-agent/skills/hello/SKILL.md"; path.parent.mkdir(parents=True)
        path.write_text(
            "---\nname: hello\ndescription: Greets users.\n---\nSECRET", encoding="utf-8"
        )
        skills = tiny.load_skills([str(path)])
        self.assertEqual([(s["name"], s["description"]) for s in skills], [("hello", "Greets users.")])
        system = tiny.Agent(skills, instructions=tiny.load_project_instructions()).messages[0]["content"]
        self.assertIn("Always be brief.", system); self.assertIn(str(path), system); self.assertNotIn("SECRET", system)

    def test_session_schema_shape_resume_and_compaction(self):
        now = datetime(2026, 8, 3, 3, 55, 50, 62000, timezone.utc); session = tiny.Session.create(tiny.ROOT, now)
        self.assertRegex(session.id, r"^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$")
        self.assertTrue(session.path.name.startswith("2026-08-03T03-55-50-062Z_"))
        agent = tiny.Agent(
            session=session,
            requester=lambda body, _: {"choices": [{"message": {"role": "assistant", "content": "summary"}}], "usage": {}},
        )
        messages = [
            {"role": "user", "content": "old"}, {"role": "assistant", "content": "old answer"},
            {"role": "user", "content": "run"},
            {"role": "assistant", "content": None, "tool_calls": [{"id": "1", "type": "function", "function": {"name": "read", "arguments": '{"path":"a"}'}}]},
            {"role": "tool", "content": "data", "tool_call_id": "1"}, {"role": "assistant", "content": "done"},
            {"role": "user", "content": "next"}, {"role": "assistant", "content": "answer"},
        ]
        for message in messages: agent.messages.append(message); session.append({"type": "message", "message": message})
        self.assertEqual(agent.compact(), "Compacted 2 messages (kept last 6).")
        restored = tiny.Agent(session=session); restored.resume_session(); self.assertEqual(restored.messages, agent.messages)
        records = session.records(); compact = records[-1]
        self.assertEqual((compact["compactedMessages"], compact["keptMessages"]), (2, 6))
        allowed = {"session", "message", "compaction", "interruption"}
        self.assertTrue(all(record["type"] in allowed and "timestamp" in record for record in records))

    def test_model_tool_loop_cache_and_no_tui_log_in_session(self):
        replies = iter([
            {"choices": [{"message": {"role": "assistant", "content": None, "tool_calls": [{"id": "1", "type": "function", "function": {"name": "write", "arguments": '{"path":"made.txt","content":"yes"}'}}]}}],
             "usage": {"prompt_tokens": 100, "completion_tokens": 10, "prompt_tokens_details": {"cached_tokens": 25}}},
            {"choices": [{"message": {"role": "assistant", "content": "done"}}],
             "usage": {"prompt_tokens": 120, "completion_tokens": 5, "prompt_cache_hit_tokens": 60}},
        ])
        requests, events = [], []

        def request(body, _): requests.append(body); return next(replies)

        session = tiny.Session.create(tiny.ROOT); agent = tiny.Agent(session=session, requester=request, on_tool=events.append)
        self.assertEqual(agent.run_agent_loop("make it"), "done")
        self.assertEqual(agent.usage, {"input": 135, "output": 15, "cacheRead": 85, "cacheWrite": 0, "cacheHitRate": 50})
        self.assertEqual((tiny.ROOT / "made.txt").read_text(encoding="utf-8"), "yes")
        self.assertEqual([event["phase"] for event in events], ["start", "end"])
        self.assertFalse(any(record["type"] == "tool_log" or record.get("phase") in ("start", "end") for record in session.records()))
        self.assertEqual(requests[0]["model"], os.getenv("TINY_MODEL") or tiny.DEFAULT_MODEL)

    def test_model_and_tool_abort_keep_legal_transcript(self):
        started = threading.Event()

        def hanging(_, cancelled): started.set(); cancelled.wait(); raise InterruptedError

        session = tiny.Session.create(tiny.ROOT); agent = tiny.Agent(session=session, requester=hanging); result = []
        thread = threading.Thread(target=lambda: result.append(agent.run_agent_loop("wait")))
        thread.start(); started.wait(); agent.abort(); thread.join()
        self.assertEqual(result, ["Operation aborted."]); self.assertEqual(session.records()[-1]["phase"], "model")

        replies = iter([{"choices": [{"message": {"role": "assistant", "content": None, "tool_calls": [
            {"id": "slow", "type": "function", "function": {"name": "bash", "arguments": '{"command":"sleep 30"}'}},
            {"id": "later", "type": "function", "function": {"name": "write", "arguments": '{"path":"never","content":"no"}'}},
        ]}}], "usage": {}}])
        agent = tiny.Agent(session=tiny.Session.create(tiny.ROOT), requester=lambda *_: next(replies)); result = []
        thread = threading.Thread(target=lambda: result.append(agent.run_agent_loop("run"))); thread.start()
        while not agent.busy: time.sleep(0.01)
        time.sleep(0.05); agent.abort(); thread.join(2)
        tools = [message for message in agent.messages if message["role"] == "tool"]
        self.assertEqual([(m["tool_call_id"], m["content"]) for m in tools], [
            ("slow", "Operation aborted"), ("later", "Operation aborted before execution"),
        ])

    def test_plugin_selection_deduplicates_assembles_mcp_and_rejects_unknown_early(self):
        remote = {"type": "function", "function": {"name": "mcp_remote", "description": "remote", "parameters": {}}}
        loaded = SimpleNamespace(tools=[remote], protocol_version="test", close=lambda: None)
        session = SimpleNamespace(id="session-id", path=Path("session.jsonl"))
        captured = {}

        class FakeAgent:
            def __init__(self, _skills, _session, _instructions, tools):
                captured["tools"] = tools; self.usage = {"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0}; self.on_tool = None
            def run_agent_loop(self, _text): return "done"

        class FakeTerminal:
            def __enter__(self): return self
            def __exit__(self, *_): return None
            def run(self, _agent, operation): return operation()

        output = io.StringIO()
        with patch.object(cli, "load_mcp_configs", return_value=[SimpleNamespace(alias="fixture")]), \
             patch.object(cli, "load_mcp_tools", return_value=loaded), \
             patch.object(cli, "load_skills", return_value=[]), \
             patch.object(cli, "load_project_instructions", return_value=""), \
             patch.object(cli.Session, "create", return_value=session), \
             patch.object(cli, "Agent", FakeAgent), patch.object(cli, "Terminal", FakeTerminal), \
             redirect_stdout(output):
            self.assertEqual(cli.run_cli(["--plugin", " read, edit ", "--plugin", "read", "--mcp", "fixture", "hello"]), 0)

        self.assertEqual([tool["function"]["name"] for tool in captured["tools"]], ["read", "edit", "mcp_remote"])
        self.assertIn("tools: read, edit, mcp_remote\nmcp: fixture", output.getvalue())

        with patch.object(cli.Session, "create") as create:
            with self.assertRaisesRegex(ValueError, r"Unknown plugin: missing\. Available plugins: bash, read, write, edit"):
                cli.run_cli(["--plugin", "missing", "hello"])
            create.assert_not_called()

    def test_terminal_display_position(self):
        self.assertEqual(Terminal.display_position("你a", 80), (0, 3))
        self.assertEqual(Terminal.display_position("abcdefg你", 8), (1, 2))
        self.assertEqual(Terminal.display_position("e\u0301你", 8), (0, 3))

    def test_terminal_edits_at_cursor_and_distinguishes_escape(self):
        read_fd, write_fd = os.pipe(); terminal = Terminal.__new__(Terminal); terminal.fd = read_fd; terminal.tty = True
        try:
            os.write(write_fd, "你a\x1b[Db\x1b[C\x7f\r".encode()); self.assertEqual(terminal.readline(""), "你b")
            os.write(write_fd, b"[D"); self.assertEqual(terminal.escape_sequence(), b"D")
            self.assertEqual(terminal.escape_sequence(), b"")
        finally: os.close(read_fd); os.close(write_fd)

    def test_formatting(self):
        self.assertEqual(tiny.format_usage({"input": 1200, "output": 30, "cacheRead": 500, "cacheWrite": 100, "cacheHitRate": 27.777}), "↑1.2k ↓30 R500 W100 CH27.8%")
        self.assertEqual(tiny.format_tool_event({"phase": "start", "name": "read", "args": {"path": "README.md"}}), "◆ read README.md")


if __name__ == "__main__":
    unittest.main()
