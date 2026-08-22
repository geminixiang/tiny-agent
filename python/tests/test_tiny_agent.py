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
from tiny_agent.session_reducer import configuration_digest, reduce_session

FIXTURES = Path(__file__).resolve().parents[2] / "schemas/session/fixtures"


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

    def test_session_shape_and_idle_resume(self):
        now = datetime(2026, 8, 3, 3, 55, 50, 62000, timezone.utc)
        session = tiny.Session.create(tiny.ROOT, now)
        self.assertRegex(session.id, r"^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$")
        replies = iter([{"choices": [{"message": {"role": "assistant", "content": "done"}, "finish_reason": "stop"}], "usage": {"prompt_tokens": 10, "completion_tokens": 2}}])
        agent = tiny.Agent(session=session, requester=lambda *_: next(replies))
        self.assertEqual(agent.run_agent_loop("work"), "done")
        session_id = session.id; session.close()
        reopened = tiny.Session.open(session_id, tiny.ROOT)
        restored = tiny.Agent(session=reopened); restored.resume_session()
        self.assertEqual(restored.messages[1:], [{"role": "user", "content": "work"}, {"role": "assistant", "content": "done"}])
        self.assertEqual(restored.usage["input"], 10)
        reopened.close()

    def test_non_idle_resume_starts_recovery(self):
        session = tiny.Session.create(tiny.ROOT)
        user_id, operation_id = tiny.uuid7(), tiny.uuid7()
        session.append(
            {"kind": "entry", "id": user_id, "entry": {"type": "message", "message": {"role": "user", "content": "work"}}},
            {"kind": "record", "record": {"type": "runStarted", "operationId": operation_id, "operationKind": "run", "inputEntryId": user_id}},
        )
        reply = {"choices": [{"message": {"role": "assistant", "content": "recovered"}, "finish_reason": "stop"}], "usage": {}}
        self.assertEqual(tiny.Agent(session=session, requester=lambda *_: reply).resume_session(), "recovered")
        self.assertEqual(session.load()["operation"]["kind"], "idle")
        session.close()

    def recovery_agent(self, fixture: str, replies=()):
        data = (FIXTURES / fixture).read_bytes(); state = reduce_session(data); session_id = state["header"]["id"]
        directory = tiny.ROOT / ".tiny-agent/sessions"; directory.mkdir(parents=True, exist_ok=True)
        (directory / f"fixture_{session_id}.jsonl").write_bytes(data)
        session = tiny.Session.open(session_id, tiny.ROOT)
        snapshot = state["operation"].get("step", {}).get("configurationSnapshot")
        read_tool = tiny.TOOL_DEFINITIONS[1]
        agent = tiny.Agent(session=session, requester=lambda *_: next(replies), tools=[read_tool])
        if snapshot:
            agent.configuration = snapshot
            agent.configuration_digest = configuration_digest(snapshot)
        return agent, session

    def test_recovers_open_attempt_and_is_idempotent(self):
        replies = iter([{"choices": [{"message": {"role": "assistant", "content": "recovered"}, "finish_reason": "stop"}], "usage": {}}])
        with patch.dict(os.environ, {"TINY_AGENT_ENVIRONMENT_IDENTITY": "fixture"}):
            agent, session = self.recovery_agent("open-attempt.jsonl", replies)
            self.assertEqual(agent.resume_session(), "recovered")
            before = session.path.read_bytes(); self.assertIsNone(agent.resume_session())
            self.assertEqual(session.path.read_bytes(), before); self.assertEqual(session.load()["operation"]["kind"], "idle")
            session.close()

    def test_recovers_pending_safe_and_never_tools(self):
        (tiny.ROOT / "README.md").write_text("evidence", encoding="utf-8")
        reply = lambda text: iter([{"choices": [{"message": {"role": "assistant", "content": text}, "finish_reason": "stop"}], "usage": {}}])
        with patch.dict(os.environ, {"TINY_AGENT_ENVIRONMENT_IDENTITY": "fixture"}):
            safe, safe_session = self.recovery_agent("pending-safe-tool.jsonl", reply("safe done"))
            self.assertEqual(safe.resume_session(), "safe done")
            self.assertIn({"role": "tool", "content": "evidence", "tool_call_id": "call_1"}, safe.messages)
            safe_session.close()

            never, never_session = self.recovery_agent("pending-never-tool.jsonl", reply("never done"))
            self.assertEqual(never.resume_session(), "never done")
            self.assertIn("not replayed", next(message["content"] for message in never.messages if message["role"] == "tool"))
            never_session.close()

    def test_recovers_abort_and_blocks_without_writes(self):
        with patch.dict(os.environ, {"TINY_AGENT_ENVIRONMENT_IDENTITY": "fixture"}):
            aborted, aborted_session = self.recovery_agent("abort-open-attempt.jsonl")
            self.assertIsNone(aborted.resume_session()); self.assertEqual(aborted_session.load()["operation"]["kind"], "idle")
            aborted_session.close()

            exhausted, exhausted_session = self.recovery_agent("attempts-exhausted.jsonl")
            before = exhausted_session.path.read_bytes()
            with self.assertRaisesRegex(RuntimeError, "attempts_exhausted"): exhausted.resume_session()
            self.assertEqual(exhausted_session.path.read_bytes(), before); exhausted_session.close()

            mismatch, mismatch_session = self.recovery_agent("open-attempt.jsonl")
            mismatch.configuration_digest = "sha256:" + "f" * 64; before = mismatch_session.path.read_bytes()
            with self.assertRaisesRegex(RuntimeError, "configuration_changed"): mismatch.resume_session()
            self.assertEqual(mismatch_session.path.read_bytes(), before); mismatch_session.close()

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
        self.assertAlmostEqual(agent.usage["cacheHitRate"], 85 / 220 * 100)
        self.assertEqual({key: agent.usage[key] for key in ("input", "output", "cacheRead", "cacheWrite")}, {"input": 135, "output": 15, "cacheRead": 85, "cacheWrite": 0})
        self.assertEqual((tiny.ROOT / "made.txt").read_text(encoding="utf-8"), "yes")
        self.assertEqual([event["phase"] for event in events], ["start", "end"])
        self.assertFalse(any(fact.get("kind") == "tool_log" for line in session.path.read_text().splitlines()[1:] for fact in (json.loads(line) if isinstance(json.loads(line), list) else [json.loads(line)])))
        self.assertEqual(requests[0]["model"], os.getenv("TINY_MODEL") or tiny.DEFAULT_MODEL)
        session.close()

    def test_model_failure_and_length_are_terminal(self):
        session = tiny.Session.create(tiny.ROOT)
        agent = tiny.Agent(session=session, requester=lambda *_: (_ for _ in ()).throw(RuntimeError("provider failed")))
        with self.assertRaisesRegex(RuntimeError, "provider failed"):
            agent.run_agent_loop("fail")
        self.assertEqual(session.load()["operation"]["kind"], "idle")
        session.close()

        session = tiny.Session.create(tiny.ROOT)
        response = {
            "choices": [{
                "finish_reason": "length",
                "message": {"role": "assistant", "content": None, "tool_calls": [{"id": "cut", "type": "function", "function": {"name": "read", "arguments": '{"path":"README.md"}'}}]},
            }],
            "usage": {},
        }
        agent = tiny.Agent(session=session, requester=lambda *_: response)
        self.assertEqual(agent.run_agent_loop("truncate"), "Model response was truncated.")
        self.assertEqual(agent.messages[-1]["content"], "Error: Tool call arguments were truncated by the model token limit; the tool was not executed.")
        self.assertEqual(session.load()["operation"]["kind"], "idle")
        session.close()

    def test_model_and_tool_abort_keep_legal_transcript(self):
        started = threading.Event()

        def hanging(_, cancelled): started.set(); cancelled.wait(); raise InterruptedError

        session = tiny.Session.create(tiny.ROOT); agent = tiny.Agent(session=session, requester=hanging); result = []
        thread = threading.Thread(target=lambda: result.append(agent.run_agent_loop("wait")))
        thread.start(); started.wait(); agent.abort(); thread.join()
        self.assertEqual(result, ["Operation aborted."]); self.assertEqual(session.load()["operation"]["kind"], "idle")
        session.close()

        replies = iter([{"choices": [{"message": {"role": "assistant", "content": None, "tool_calls": [
            {"id": "slow", "type": "function", "function": {"name": "bash", "arguments": '{"command":"sleep 30"}'}},
            {"id": "later", "type": "function", "function": {"name": "write", "arguments": '{"path":"never","content":"no"}'}},
        ]}}], "usage": {}}])
        tool_session = tiny.Session.create(tiny.ROOT)
        agent = tiny.Agent(session=tool_session, requester=lambda *_: next(replies)); result = []
        thread = threading.Thread(target=lambda: result.append(agent.run_agent_loop("run"))); thread.start()
        while not agent.busy: time.sleep(0.01)
        time.sleep(0.05); agent.abort(); thread.join(2)
        tools = [message for message in agent.messages if message["role"] == "tool"]
        self.assertEqual([(m["tool_call_id"], m["content"]) for m in tools], [
            ("slow", "Operation interrupted after execution status became unknown; the tool was not replayed."),
            ("later", "Operation aborted before execution."),
        ])
        tool_session.close()

    def test_plugin_selection_deduplicates_assembles_mcp_and_rejects_unknown_early(self):
        remote = {"type": "function", "function": {"name": "mcp_remote", "description": "remote", "parameters": {}}}
        loaded = SimpleNamespace(tools=[remote], protocol_version="test", close=lambda: None)
        session = SimpleNamespace(id="session-id", path=Path("session.jsonl"), close=lambda: None)
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
