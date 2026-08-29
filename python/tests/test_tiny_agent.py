import asyncio
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
from tiny_agent.session_reducer import configuration_digest, reduce_session, source_digest

FIXTURES = Path(__file__).resolve().parents[2] / "schemas/session/fixtures"


async def async_value(value):
    return value


class TinyAgentTest(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.temp = TemporaryDirectory(); self.old_root = tiny.ROOT
        tiny.ROOT = Path(self.temp.name).resolve()
        self.addCleanup(self.temp.cleanup); self.addCleanup(setattr, tiny, "ROOT", self.old_root)
        self.env = patch.dict(os.environ, {"OPENROUTER_API_KEY": "test"})
        self.env.start(); self.addCleanup(self.env.stop)

    async def test_bg_lifecycle_fast_failure_and_stale_metadata(self):
        (tiny.ROOT / "server.py").write_text(
            'import time\nprint("ready", flush=True)\nwhile True:\n print("tick", flush=True); time.sleep(0.1)\n',
            encoding="utf-8",
        )
        started_text = await tiny.execute_tool("bg", {"action": "start", "command": "python3 server.py"})
        started = json.loads(started_text.splitlines()[0])
        self.assertEqual(started["id"], str(started["pid"]))
        self.assertEqual(started["status"], "running")
        self.assertTrue(started["processStartedAt"])
        await asyncio.sleep(0.25)
        self.assertIn("tick", await tiny.execute_tool("bg", {"action": "logs", "id": started["id"], "tail": "5"}))

        meta_path, _ = tiny.bg_paths(started["id"])
        original = json.loads(meta_path.read_text(encoding="utf-8"))
        tiny.write_bg_meta({**original, "processStartedAt": "different process"})
        stale = json.loads(await tiny.execute_tool("bg", {"action": "stop", "id": started["id"]}))
        self.assertEqual(stale["status"], "stale")
        os.kill(started["pid"], 0)

        tiny.write_bg_meta(original)
        stopped = json.loads(await tiny.execute_tool("bg", {"action": "stop", "id": started["id"]}))
        self.assertEqual(stopped["status"], "stopped")

        failed_text = await tiny.execute_tool("bg", {"action": "start", "command": "echo boom >&2; exit 7"})
        failed = json.loads(failed_text.splitlines()[0])
        self.assertEqual(failed["status"], "exited")
        self.assertEqual(failed["exitCode"], 7)
        self.assertIn("boom", failed_text)
        await tiny.close_background_processes()

    async def test_file_tools_do_not_block_event_loop(self):
        original = Path.read_text
        started = threading.Event()
        release = threading.Event()

        def slow_read(path, *args, **kwargs):
            started.set()
            release.wait(1)
            return original(path, *args, **kwargs)

        path = tiny.ROOT / "slow.txt"
        path.write_text("ready", encoding="utf-8")
        with patch.object(Path, "read_text", slow_read):
            task = asyncio.create_task(tiny.execute_tool("read", {"path": "slow.txt"}))
            self.assertTrue(await asyncio.to_thread(started.wait, 1))
            await asyncio.sleep(0)
            self.assertFalse(task.done())
            release.set()
            self.assertEqual(await task, "ready")

    async def test_tools_paths_and_large_bash_output(self):
        self.assertEqual(await tiny.execute_tool("write", {"path": "a.txt", "content": "hello"}), "ok")
        self.assertEqual(await tiny.execute_tool("read", {"path": str(tiny.ROOT / "a.txt")}), "hello")
        self.assertEqual(await tiny.execute_tool("edit", {"path": "a.txt", "oldText": "hello", "newText": "hi"}), "ok")
        outside = Path(self.temp.name).resolve().parent / "tiny-agent-outside.txt"
        try:
            self.assertEqual(await tiny.execute_tool("write", {"path": str(outside), "content": "secret"}), "ok")
            self.assertEqual(await tiny.execute_tool("read", {"path": str(outside)}), "secret")
        finally: outside.unlink(missing_ok=True)
        result = await tiny.execute_tool(
            "bash", {"command": "printf begin; yes x | head -n 30000; printf end"}
        )
        path = Path(re.search(r"Full output: (.*\.log)\]", result).group(1))
        self.assertTrue(path.read_text(encoding="utf-8").startswith("begin")); self.assertTrue(path.read_text(encoding="utf-8").endswith("end"))
        self.assertLess(len(result), path.stat().st_size)

    async def test_bash_error_preserves_output_and_cancel_kills_children(self):
        self.assertIn("captured", await tiny.execute_tool("bash", {"command": "printf captured; exit 7"}))
        old_limit = tiny.MAX_BASH_OUTPUT; tiny.MAX_BASH_OUTPUT = 1024
        try:
            with self.assertRaisesRegex(RuntimeError, "10MB limit"): await tiny.execute_bash("yes x | head -n 10000", asyncio.Event())
        finally: tiny.MAX_BASH_OUTPUT = old_limit
        cancelled = asyncio.Event()
        sleeper = "python3 -c 'import time; time.sleep(30)'"
        task = asyncio.create_task(tiny.execute_bash(sleeper, cancelled))
        await asyncio.sleep(0.1); cancelled.set()
        with self.assertRaises(InterruptedError): await asyncio.wait_for(task, 1)

    @staticmethod
    def _capture_error(out, call):
        try: call()
        except BaseException as error: out.append(error)

    async def _wait_for_pid(self, path):
        deadline = time.monotonic() + 1
        while time.monotonic() < deadline:
            try: return int(path.read_text(encoding="utf-8"))
            except (FileNotFoundError, ValueError): await asyncio.sleep(0.01)
        self.fail(f"process did not write PID file: {path}")

    async def _assert_process_group_gone(self, process_group):
        deadline = time.monotonic() + 1
        while time.monotonic() < deadline:
            try: os.killpg(process_group, 0)
            except ProcessLookupError: return
            await asyncio.sleep(0.01)
        self.fail(f"process group {process_group} still exists")

    async def test_bash_monitors_eof_cancellation_and_total_timeout(self):
        cancel_pid = tiny.ROOT / "cancel.pid"
        cancelled = asyncio.Event()
        task = asyncio.create_task(tiny.execute_bash(
            f"echo $$ > {cancel_pid}; exec 1>&-; sleep 30", cancelled,
        ))
        process_group = await self._wait_for_pid(cancel_pid)
        started = time.monotonic(); cancelled.set()
        with self.assertRaisesRegex(InterruptedError, "aborted"):
            await asyncio.wait_for(task, 1)
        self.assertLess(time.monotonic() - started, 1)
        await self._assert_process_group_gone(process_group)

        timeout_pid = tiny.ROOT / "timeout.pid"
        with patch.object(tiny, "BASH_TIMEOUT_SECONDS", 0.15):
            started = time.monotonic()
            with self.assertRaisesRegex(TimeoutError, "bash timed out after 0.15 seconds"):
                await asyncio.wait_for(tiny.execute_bash(
                    f"echo $$ > {timeout_pid}; exec 1>&-; sleep 30", asyncio.Event(),
                ), 1)
        self.assertLess(time.monotonic() - started, 1)
        await self._assert_process_group_gone(await self._wait_for_pid(timeout_pid))

    async def test_bash_output_overflow_immediately_kills_group(self):
        pid_path = tiny.ROOT / "overflow.pid"
        with patch.object(tiny, "MAX_BASH_OUTPUT", 1024):
            started = time.monotonic()
            with self.assertRaisesRegex(RuntimeError, "bash output exceeded 10MB limit"):
                await asyncio.wait_for(tiny.execute_bash(
                    f"echo $$ > {pid_path}; yes x", asyncio.Event(),
                ), 1)
        self.assertLess(time.monotonic() - started, 1)
        await self._assert_process_group_gone(await self._wait_for_pid(pid_path))

    async def test_bash_success_kills_redirected_background_descendant(self):
        group_path = tiny.ROOT / "group.pid"
        child_path = tiny.ROOT / "child.pid"
        self.assertEqual(await tiny.execute_bash(
            f"echo $$ > {group_path}; sleep 30 </dev/null >/dev/null 2>&1 & "
            f"echo $! > {child_path}; exit 0", asyncio.Event(),
        ), "(no output)")
        process_group = await self._wait_for_pid(group_path)
        await self._wait_for_pid(child_path)
        # A killed child can briefly remain a zombie on macOS, where PID probes are
        # unreliable. Group absence proves no live descendant can have been left behind.
        await self._assert_process_group_gone(process_group)

    async def test_chunked_openrouter_json_and_event_cancellation(self):
        connected = asyncio.Event()

        async def serve(reader, writer):
            await reader.readuntil(b"\r\n\r\n")
            connected.set()
            await asyncio.sleep(0.05)
            raw = b'{"choices":[{"message":{"role":"assistant","content":"chunked"}}]}'
            writer.write(b"HTTP/1.1 200 OK\r\nTransfer-Encoding: Chunked\r\nContent-Type: application/json\r\n\r\n")
            writer.write(f"{len(raw):x};fixture=yes\r\n".encode() + raw + b"\r\n0\r\nX-End: yes\r\n\r\n")
            await writer.drain(); writer.close()

        server = await asyncio.start_server(serve, "127.0.0.1", 0)
        try:
            port = server.sockets[0].getsockname()[1]
            value = await tiny._post_json(f"http://127.0.0.1:{port}/", {}, {}, 2)
            self.assertEqual(value["choices"][0]["message"]["content"], "chunked")
        finally:
            server.close(); await server.wait_closed()

        writers = []
        async def quiet(reader, writer):
            writers.append(writer)
            try:
                await reader.readuntil(b"\r\n\r\n"); connected.set()
                await reader.read()
            finally:
                writer.close()
                await writer.wait_closed()

        connected.clear(); server = await asyncio.start_server(quiet, "127.0.0.1", 0)
        try:
            port = server.sockets[0].getsockname()[1]; cancelled = asyncio.Event()
            task = asyncio.create_task(tiny._post_json(f"http://127.0.0.1:{port}/", {}, {}, 30, cancelled))
            await connected.wait(); cancelled.set()
            with self.assertRaisesRegex(InterruptedError, "aborted"): await asyncio.wait_for(task, 1)
            await asyncio.sleep(0); self.assertTrue(all(writer.is_closing() for writer in writers))
        finally:
            server.close(); await server.wait_closed()

    async def test_skills_project_instructions_and_prompt(self):
        (tiny.ROOT / "AGENTS.md").write_text("Always be brief.", encoding="utf-8")
        path = tiny.ROOT / ".tiny-agent/skills/hello/SKILL.md"; path.parent.mkdir(parents=True)
        path.write_text(
            "---\nname: hello\ndescription: Greets users.\n---\nSECRET", encoding="utf-8"
        )
        skills = tiny.load_skills([str(path)])
        self.assertEqual([(s["name"], s["description"]) for s in skills], [("hello", "Greets users.")])
        system = tiny.Agent(skills, instructions=tiny.load_project_instructions()).messages[0]["content"]
        self.assertIn("Use only the tools provided in this request", system)
        self.assertIn("inspect only what is needed, then make the changes and run focused tests", system)
        self.assertIn("Use the provided tool descriptions to choose the right capability", system)
        self.assertIn("Always be brief.", system); self.assertIn(str(path), system); self.assertNotIn("SECRET", system)

    async def test_session_shape_and_idle_resume(self):
        now = datetime(2026, 8, 3, 3, 55, 50, 62000, timezone.utc)
        session = tiny.Session.create(tiny.ROOT, now)
        self.assertRegex(session.id, r"^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$")
        replies = iter([{"choices": [{"message": {"role": "assistant", "content": "done"}, "finish_reason": "stop"}], "usage": {"prompt_tokens": 10, "completion_tokens": 2}}])
        agent = tiny.Agent(session=session, requester=lambda *_: async_value(next(replies)))
        self.assertEqual(await agent.run_agent_loop("work"), "done")
        session_id = session.id; session.close()
        reopened = tiny.Session.open(session_id, tiny.ROOT)
        restored = tiny.Agent(session=reopened); await restored.resume_session()
        self.assertEqual(restored.messages[1:], [{"role": "user", "content": "work"}, {"role": "assistant", "content": "done"}])
        self.assertEqual(restored.usage["input"], 10)
        reopened.close()

    async def test_recovered_model_abort_race_records_known_usage(self):
        session = tiny.Session.create(tiny.ROOT); user_id, operation_id = tiny.uuid7(), tiny.uuid7()
        session.append(
            {"kind": "entry", "id": user_id, "entry": {"type": "message", "message": {"role": "user", "content": "recover"}}},
            {"kind": "record", "record": {"type": "runStarted", "operationId": operation_id, "operationKind": "run", "inputEntryId": user_id}},
        )
        agent = None
        async def reply(*_):
            agent.abort()
            return {"choices": [{"message": {"role": "assistant", "content": "discard"}, "finish_reason": "stop"}], "usage": {"prompt_tokens": 9, "completion_tokens": 4}}
        agent = tiny.Agent(session=session, requester=reply)
        self.assertEqual(await agent.resume_session(), "Operation aborted.")
        self.assertEqual(session.load()["usage"], {"input": 9, "output": 4, "cacheRead": 0, "cacheWrite": 0})
        await self.assert_aborted_reopens_idempotently(session, "recover", {"input": 9, "output": 4})

    async def test_non_idle_resume_starts_recovery(self):
        session = tiny.Session.create(tiny.ROOT)
        user_id, operation_id = tiny.uuid7(), tiny.uuid7()
        session.append(
            {"kind": "entry", "id": user_id, "entry": {"type": "message", "message": {"role": "user", "content": "work"}}},
            {"kind": "record", "record": {"type": "runStarted", "operationId": operation_id, "operationKind": "run", "inputEntryId": user_id}},
        )
        reply = {"choices": [{"message": {"role": "assistant", "content": "recovered"}, "finish_reason": "stop"}], "usage": {}}
        self.assertEqual(await tiny.Agent(session=session, requester=lambda *_: async_value(reply)).resume_session(), "recovered")
        self.assertEqual(session.load()["operation"]["kind"], "idle")
        session.close()

    def recovery_agent(self, fixture: str, replies=()):
        data = (FIXTURES / fixture).read_bytes(); state = reduce_session(data); session_id = state["header"]["id"]
        directory = tiny.ROOT / ".tiny-agent/sessions"; directory.mkdir(parents=True, exist_ok=True)
        (directory / f"fixture_{session_id}.jsonl").write_bytes(data)
        session = tiny.Session.open(session_id, tiny.ROOT)
        snapshot = state["operation"].get("step", {}).get("configurationSnapshot")
        read_tool = tiny.TOOL_DEFINITIONS[1]
        agent = tiny.Agent(session=session, requester=lambda *_: async_value(next(replies)), tools=[read_tool])
        if snapshot:
            agent.configuration = snapshot
            agent.configuration_digest = configuration_digest(snapshot)
        return agent, session

    async def test_recovers_open_attempt_and_is_idempotent(self):
        replies = iter([{"choices": [{"message": {"role": "assistant", "content": "recovered"}, "finish_reason": "stop"}], "usage": {}}])
        with patch.dict(os.environ, {"TINY_AGENT_ENVIRONMENT_IDENTITY": "fixture"}):
            agent, session = self.recovery_agent("open-attempt.jsonl", replies)
            self.assertEqual(await agent.resume_session(), "recovered")
            before = session.path.read_bytes(); self.assertIsNone(await agent.resume_session())
            self.assertEqual(session.path.read_bytes(), before); self.assertEqual(session.load()["operation"]["kind"], "idle")
            session.close()

    async def test_recovers_pending_safe_and_never_tools(self):
        (tiny.ROOT / "README.md").write_text("evidence", encoding="utf-8")
        reply = lambda text: iter([{"choices": [{"message": {"role": "assistant", "content": text}, "finish_reason": "stop"}], "usage": {}}])
        with patch.dict(os.environ, {"TINY_AGENT_ENVIRONMENT_IDENTITY": "fixture"}):
            safe, safe_session = self.recovery_agent("pending-safe-tool.jsonl", reply("safe done"))
            self.assertEqual(await safe.resume_session(), "safe done")
            self.assertIn({"role": "tool", "content": "evidence", "tool_call_id": "call_1"}, safe.messages)
            safe_session.close()

            never, never_session = self.recovery_agent("pending-never-tool.jsonl", reply("never done"))
            self.assertEqual(await never.resume_session(), "never done")
            self.assertIn("not replayed", next(message["content"] for message in never.messages if message["role"] == "tool"))
            never_session.close()

    async def test_safe_replay_then_plain_stop_reaches_idle_without_invalid_transition(self):
        # Regression: in the TypeScript port, a safe-replay tool result committed during
        # recovery followed by the next model attempt settling with stop (no tool calls)
        # made the reducer throw INVALID_TRANSITION because the stray extra stepAttempt's
        # contextThroughEntryId no longer matched the advanced activeContextThroughEntryId.
        (tiny.ROOT / "README.md").write_text("evidence", encoding="utf-8")
        reply = iter([{"choices": [{"message": {"role": "assistant", "content": "safe done"}, "finish_reason": "stop"}], "usage": {}}])
        with patch.dict(os.environ, {"TINY_AGENT_ENVIRONMENT_IDENTITY": "fixture"}):
            agent, session = self.recovery_agent("pending-safe-tool.jsonl", reply)
            self.assertEqual(await agent.resume_session(), "safe done")
            self.assertIn({"role": "tool", "content": "evidence", "tool_call_id": "call_1"}, agent.messages)
            self.assertEqual(session.load()["operation"]["kind"], "idle")
            session.close()

    async def test_custom_read_pending_recovery_materializes_interruption(self):
        data = (FIXTURES / "pending-never-tool.jsonl").read_bytes().replace(b"builtin:read:never:v1", b"tool:read:v1")
        state = reduce_session(data); session_id = state["header"]["id"]
        directory = tiny.ROOT / ".tiny-agent/sessions"; directory.mkdir(parents=True, exist_ok=True)
        (directory / f"fixture_{session_id}.jsonl").write_bytes(data)
        session = tiny.Session.open(session_id, tiny.ROOT); executions = []
        custom_read = {"type": "function", "function": {**tiny.TOOL_DEFINITIONS[1]["function"]}, "execute": lambda *_: executions.append(True)}
        replies = iter([{"choices": [{"message": {"role": "assistant", "content": "recovered custom"}, "finish_reason": "stop"}], "usage": {}}])
        agent = tiny.Agent(session=session, requester=lambda *_: async_value(next(replies)), tools=[custom_read])
        snapshot = state["operation"]["step"]["configurationSnapshot"]
        agent.configuration = snapshot; agent.configuration_digest = configuration_digest(snapshot)
        with patch.dict(os.environ, {"TINY_AGENT_ENVIRONMENT_IDENTITY": "fixture"}):
            self.assertEqual(await agent.resume_session(), "recovered custom")
        self.assertFalse(executions)
        self.assertIn("not replayed", next(message["content"] for message in agent.messages if message["role"] == "tool"))
        session.close()

    async def test_recovers_abort_and_blocks_without_writes(self):
        with patch.dict(os.environ, {"TINY_AGENT_ENVIRONMENT_IDENTITY": "fixture"}):
            aborted, aborted_session = self.recovery_agent("abort-open-attempt.jsonl")
            self.assertIsNone(await aborted.resume_session()); self.assertEqual(aborted_session.load()["operation"]["kind"], "idle")
            aborted_session.close()

            exhausted, exhausted_session = self.recovery_agent("attempts-exhausted.jsonl")
            before = exhausted_session.path.read_bytes()
            with self.assertRaisesRegex(RuntimeError, "attempts_exhausted"): await exhausted.resume_session()
            self.assertEqual(exhausted_session.path.read_bytes(), before); exhausted_session.close()

            mismatch, mismatch_session = self.recovery_agent("open-attempt.jsonl")
            mismatch.configuration_digest = "sha256:" + "f" * 64; before = mismatch_session.path.read_bytes()
            with self.assertRaisesRegex(RuntimeError, "configuration_changed"): await mismatch.resume_session()
            self.assertEqual(mismatch_session.path.read_bytes(), before); mismatch_session.close()

    async def _completed_conversation(self, session, turns=4):
        replies = iter([
            {"choices": [{"message": {"role": "assistant", "content": f"answer {index}"}, "finish_reason": "stop"}], "usage": {"prompt_tokens": 10, "completion_tokens": 2}}
            for index in range(turns)
        ])
        agent = tiny.Agent(session=session, requester=lambda *_: async_value(next(replies)))
        for index in range(turns): self.assertEqual(await agent.run_agent_loop(f"question {index}"), f"answer {index}")
        return agent

    async def test_durable_compaction_and_idle_resume(self):
        session = tiny.Session.create(tiny.ROOT); agent = await self._completed_conversation(session)
        agent.requester = lambda *_: async_value({"choices": [{"message": {"role": "assistant", "content": "durable summary"}, "finish_reason": "stop"}], "usage": {"prompt_tokens": 20, "completion_tokens": 3}})
        self.assertEqual(await agent.compact(), "Compacted 2 messages (kept last 6).")
        state = session.load()
        self.assertEqual(state["operation"]["kind"], "idle")
        self.assertEqual(state["activeContext"][0], {"role": "user", "content": "[Compacted history]\ndurable summary"})
        self.assertEqual(state["usage"], {"input": 60, "output": 11, "cacheRead": 0, "cacheWrite": 0})
        facts = agent._facts()
        self.assertEqual([fact.get("record", {}).get("type") for fact in facts if fact.get("kind") == "record"][-3:], ["compactionStarted", "stepAttempt", "operationFinished"])
        compact = next(fact for fact in reversed(facts) if fact.get("kind") == "entry" and fact["entry"].get("type") == "compaction")
        self.assertEqual([item["message"] for item in compact["entry"]["retainedTail"]], agent.messages[2:])
        session_id = session.id; session.close()
        reopened = tiny.Session.open(session_id, tiny.ROOT); restored = tiny.Agent(session=reopened); await restored.resume_session()
        self.assertEqual(restored.messages[1:], state["activeContext"]); reopened.close()

    async def test_repeated_compaction_uses_bounded_active_context(self):
        session = tiny.Session.create(tiny.ROOT); agent = await self._completed_conversation(session)
        requests = []

        async def compact_reply(body, _cancelled):
            requests.append(json.loads(body["messages"][1]["content"]))
            summary = "first knowledge" if len(requests) == 1 else "second knowledge including first knowledge"
            return {"choices": [{"message": {"role": "assistant", "content": summary}, "finish_reason": "stop"}], "usage": {}}

        agent.requester = compact_reply
        await agent.compact()
        agent.requester = lambda *_: async_value({"choices": [{"message": {"role": "assistant", "content": "new answer"}, "finish_reason": "stop"}], "usage": {}})
        for index in range(4): await agent.run_agent_loop(f"new question {index}")
        agent.requester = compact_reply
        await agent.compact()

        self.assertLess(len(requests[1]), len(agent._message_facts()))
        self.assertEqual(requests[1][0], {"role": "user", "content": "[Compacted history]\nfirst knowledge"})
        self.assertIn("first knowledge", session.load()["activeContext"][0]["content"])
        self.assertIn("second knowledge", session.load()["activeContext"][0]["content"])
        session.close()

    async def test_recovered_compaction_abort_race_records_known_usage(self):
        session = tiny.Session.create(tiny.ROOT); agent = await self._completed_conversation(session)
        source = agent._message_facts(); operation_id, result_id = tiny.uuid7(), tiny.uuid7()
        session.append({"kind": "record", "record": {
            "type": "compactionStarted", "operationId": operation_id, "operationKind": "compaction",
            "inputThroughEntryId": source[-1]["id"], "resultEntryId": result_id,
            "compactedEntryIds": [item["id"] for item in source[:2]], "retainedEntryIds": [item["id"] for item in source[2:]],
            "sourceDigest": source_digest(agent._full_state(), source[-1]["id"]),
        }})
        agent = None
        async def reply(*_):
            agent.abort()
            return {"choices": [{"message": {"role": "assistant", "content": "discard"}, "finish_reason": "stop"}], "usage": {"prompt_tokens": 11, "completion_tokens": 6}}
        agent = tiny.Agent(session=session, requester=reply); agent.configuration_digest = agent.configuration_digest
        await agent.resume_session()
        self.assertEqual(session.load()["usage"], {"input": 51, "output": 14, "cacheRead": 0, "cacheWrite": 0})
        await self.assert_aborted_reopens_idempotently(session, "answer 3", {"input": 51, "output": 14})

    async def test_recovers_open_and_committed_compaction_idempotently(self):
        session = tiny.Session.create(tiny.ROOT); agent = await self._completed_conversation(session)
        state = session.load(); source = agent._message_facts(); input_id = source[-1]["id"]; compacted, retained = source[:2], source[2:]
        operation_id, result_id = tiny.uuid7(), tiny.uuid7()
        session.append({"kind": "record", "record": {
            "type": "compactionStarted", "operationId": operation_id, "operationKind": "compaction",
            "inputThroughEntryId": input_id, "resultEntryId": result_id,
            "compactedEntryIds": [item["id"] for item in compacted], "retainedEntryIds": [item["id"] for item in retained],
            "sourceDigest": source_digest(agent._full_state(), input_id),
        }})
        step_id, attempt_id = agent._attempt(operation_id, input_id, "compaction")
        session_id = session.id; session.close()
        blocked = tiny.Session.open(session_id, tiny.ROOT); mismatch = tiny.Agent(session=blocked)
        before = blocked.path.read_bytes(); mismatch.configuration_digest = "sha256:" + "f" * 64
        with self.assertRaisesRegex(RuntimeError, "configuration_changed"): await mismatch.resume_session()
        self.assertEqual(blocked.path.read_bytes(), before); blocked.close()

        reopened = tiny.Session.open(session_id, tiny.ROOT)
        recovered = tiny.Agent(session=reopened, requester=lambda *_: async_value({"choices": [{"message": {"role": "assistant", "content": "recovered summary"}, "finish_reason": "stop"}], "usage": {}}))
        recovered.configuration = agent.configuration; recovered.configuration_digest = agent.configuration_digest
        await recovered.resume_session(); self.assertEqual(reopened.load()["operation"]["kind"], "idle")
        before = reopened.path.read_bytes(); self.assertIsNone(await recovered.resume_session()); self.assertEqual(reopened.path.read_bytes(), before)

        # Simulate a crash after the compaction entry was committed but before operationFinished.
        lines = before.splitlines(keepends=True); reopened.close()
        path = tiny.ROOT / ".tiny-agent/sessions" / next(item.name for item in (tiny.ROOT / ".tiny-agent/sessions").iterdir() if session_id in item.name)
        path.write_bytes(b"".join(lines[:-1]))
        unfinished = tiny.Session.open(session_id, tiny.ROOT); finisher = tiny.Agent(session=unfinished)
        finisher.configuration = agent.configuration; finisher.configuration_digest = agent.configuration_digest
        await finisher.resume_session(); self.assertEqual(unfinished.load()["operation"]["kind"], "idle")
        finished = unfinished.path.read_bytes(); self.assertIsNone(await finisher.resume_session()); self.assertEqual(unfinished.path.read_bytes(), finished)
        unfinished.close()

    async def test_model_tool_loop_cache_and_no_tui_log_in_session(self):
        replies = iter([
            {"choices": [{"message": {"role": "assistant", "content": None, "tool_calls": [{"id": "1", "type": "function", "function": {"name": "write", "arguments": '{"path":"made.txt","content":"yes"}'}}]}}],
             "usage": {"prompt_tokens": 100, "completion_tokens": 10, "prompt_tokens_details": {"cached_tokens": 25}}},
            {"choices": [{"message": {"role": "assistant", "content": "done"}}],
             "usage": {"prompt_tokens": 120, "completion_tokens": 5, "prompt_cache_hit_tokens": 60}},
        ])
        requests, events = [], []

        async def request(body, _): requests.append(body); return next(replies)

        session = tiny.Session.create(tiny.ROOT); agent = tiny.Agent(session=session, requester=request, on_tool=events.append)
        self.assertEqual(await agent.run_agent_loop("make it"), "done")
        self.assertAlmostEqual(agent.usage["cacheHitRate"], 60 / 120 * 100)
        self.assertEqual({key: agent.usage[key] for key in ("input", "output", "cacheRead", "cacheWrite")}, {"input": 135, "output": 15, "cacheRead": 85, "cacheWrite": 0})
        self.assertEqual((tiny.ROOT / "made.txt").read_text(encoding="utf-8"), "yes")
        self.assertEqual([event["phase"] for event in events], ["start", "end"])
        self.assertFalse(any(fact.get("kind") == "tool_log" for line in session.path.read_text().splitlines()[1:] for fact in (json.loads(line) if isinstance(json.loads(line), list) else [json.loads(line)])))
        self.assertEqual(requests[0]["model"], os.getenv("TINY_MODEL") or tiny.DEFAULT_MODEL)
        session.close()

    async def test_provider_fields_are_normalized_before_session_persistence(self):
        response = {
            "choices": [{
                "message": {
                    "role": "assistant",
                    "content": "hello",
                    "reasoning": "provider-only",
                    "reasoning_details": [{"type": "summary", "text": "provider-only"}],
                },
                "finish_reason": "stop",
            }],
            "usage": {},
        }
        session = tiny.Session.create(tiny.ROOT)
        agent = tiny.Agent(session=session, requester=lambda *_: async_value(response))
        self.assertEqual(await agent.run_agent_loop("hi"), "hello")
        assistant = next(message for message in agent.messages if message["role"] == "assistant")
        self.assertEqual(assistant, {"role": "assistant", "content": "hello"})
        self.assertNotIn("provider-only", session.path.read_text(encoding="utf-8"))
        session.close()

    async def test_provider_tool_call_fields_are_normalized(self):
        responses = iter([
            {
                "choices": [{
                    "message": {
                        "role": "assistant",
                        "content": None,
                        "reasoning": "provider-only",
                        "tool_calls": [{
                            "id": "call-1",
                            "type": "function",
                            "index": 0,
                            "function": {"name": "read", "arguments": '{"path":"README.md"}', "extra": True},
                        }],
                    },
                    "finish_reason": "tool_calls",
                }],
                "usage": {},
            },
            {"choices": [{"message": {"role": "assistant", "content": "done"}, "finish_reason": "stop"}], "usage": {}},
        ])
        session = tiny.Session.create(tiny.ROOT)
        agent = tiny.Agent(session=session, requester=lambda *_: async_value(next(responses)))
        self.assertEqual(await agent.run_agent_loop("read"), "done")
        assistant = next(message for message in agent.messages if message.get("tool_calls"))
        self.assertEqual(assistant["tool_calls"], [{
            "id": "call-1",
            "type": "function",
            "function": {"name": "read", "arguments": '{"path":"README.md"}'},
        }])
        self.assertNotIn("provider-only", session.path.read_text(encoding="utf-8"))
        session.close()

    async def test_model_failure_and_length_are_terminal(self):
        session = tiny.Session.create(tiny.ROOT)
        agent = tiny.Agent(session=session, requester=lambda *_: async_value((_ for _ in ())).throw(RuntimeError("provider failed")))
        with self.assertRaisesRegex(RuntimeError, "provider failed"):
            await agent.run_agent_loop("fail")
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
        agent = tiny.Agent(session=session, requester=lambda *_: async_value(response))
        self.assertEqual(await agent.run_agent_loop("truncate"), "Model response was truncated.")
        self.assertEqual(agent.messages[-1]["content"], "Error: Tool call arguments were truncated by the model token limit; the tool was not executed.")
        self.assertEqual(session.load()["operation"]["kind"], "idle")
        session.close()

    async def assert_aborted_reopens_idempotently(self, session, expected, usage=None):
        self.assertEqual(session.load()["operation"]["kind"], "idle")
        facts = [fact for line in session.path.read_text().splitlines()[1:] for fact in (json.loads(line) if isinstance(json.loads(line), list) else [json.loads(line)])]
        abort_index = next(index for index, fact in enumerate(facts) if fact.get("record", {}).get("type") == "abortRequested")
        self.assertFalse(any(fact.get("record", {}).get("outcome") == "completed" for fact in facts[abort_index:]))
        session_id = session.id; session.close()
        reopened = tiny.Session.open(session_id, tiny.ROOT); restored = tiny.Agent(session=reopened)
        before = reopened.path.read_bytes()
        self.assertIsNone(await restored.resume_session()); self.assertEqual(reopened.path.read_bytes(), before)
        self.assertEqual(restored.messages[-1].get("content"), expected)
        if usage:
            for key, value in usage.items(): self.assertEqual(restored.usage[key], value)
        reopened.close()

    async def test_abort_after_successful_model_return_discards_answer(self):
        session = tiny.Session.create(tiny.ROOT); agent = None
        async def reply(*_):
            agent.abort()
            self.assertTrue(session.load()["operation"]["abortRequested"])
            return {"choices": [{"message": {"role": "assistant", "content": "must be discarded"}, "finish_reason": "stop"}], "usage": {"prompt_tokens": 8, "completion_tokens": 2}}
        agent = tiny.Agent(session=session, requester=reply)
        self.assertEqual(await agent.run_agent_loop("race"), "Operation aborted.")
        self.assertNotIn("must be discarded", [message.get("content") for message in agent.messages])
        self.assertEqual(agent.usage["input"], 8); self.assertEqual(agent.usage["output"], 2)
        self.assertEqual(session.load()["usage"]["input"], 8); self.assertEqual(session.load()["usage"]["output"], 2)
        await self.assert_aborted_reopens_idempotently(session, "race", {"input": 8, "output": 2})

    async def test_abort_race_after_model_settlement_does_not_create_durable_abort(self):
        session = tiny.Session.create(tiny.ROOT); agent = None
        original = session.append_if_active
        def settle_then_abort(operation_id, cancelled, *facts):
            committed = original(operation_id, cancelled, *facts)
            agent.abort()
            return committed
        session.append_if_active = settle_then_abort
        agent = tiny.Agent(session=session, requester=lambda *_: async_value({"choices": [{"message": {"role": "assistant", "content": "settled"}, "finish_reason": "stop"}], "usage": {}}))
        self.assertEqual(await agent.run_agent_loop("race"), "settled")
        self.assertFalse(any(fact.get("record", {}).get("type") == "abortRequested" for fact in agent._facts()))
        session_id = session.id; session.close()
        reopened = tiny.Session.open(session_id, tiny.ROOT); self.assertIsNone(await tiny.Agent(session=reopened).resume_session()); reopened.close()

    async def test_abort_after_successful_tool_return_materializes_interruption(self):
        session = tiny.Session.create(tiny.ROOT); agent = None
        tool = {"type": "function", "function": {"name": "race", "description": "race", "parameters": {"type": "object", "properties": {}, "required": []}}}
        async def execute(*_): agent.abort(); return "must be discarded"
        tool["execute"] = execute
        response = {"choices": [{"message": {"role": "assistant", "content": None, "tool_calls": [
            {"id": "race-call", "type": "function", "function": {"name": "race", "arguments": "{}"}}
        ]}, "finish_reason": "tool_calls"}], "usage": {}}
        agent = tiny.Agent(session=session, tools=[tool], requester=lambda *_: async_value(response))
        self.assertEqual(await agent.run_agent_loop("race"), "Operation aborted.")
        self.assertEqual(agent.messages[-1]["content"], "Operation interrupted after execution status became unknown; the tool was not replayed.")
        await self.assert_aborted_reopens_idempotently(session, "Operation interrupted after execution status became unknown; the tool was not replayed.")

    async def test_abort_after_successful_compaction_return_discards_summary(self):
        session = tiny.Session.create(tiny.ROOT); agent = await self._completed_conversation(session); agent.requester = None
        async def reply(*_):
            agent.abort()
            return {"choices": [{"message": {"role": "assistant", "content": "must be discarded"}, "finish_reason": "stop"}], "usage": {"prompt_tokens": 13, "completion_tokens": 5}}
        agent.requester = reply
        self.assertEqual(await agent.compact(), "Compaction aborted.")
        self.assertFalse(any(fact.get("entry", {}).get("type") == "compaction" for fact in agent._facts()))
        self.assertEqual(session.load()["usage"]["input"], 53); self.assertEqual(session.load()["usage"]["output"], 13)
        await self.assert_aborted_reopens_idempotently(session, "answer 3", {"input": 53, "output": 13})

    async def test_replay_declaration_uses_exact_builtin_read(self):
        custom_read = {"type": "function", "function": {**tiny.TOOL_DEFINITIONS[1]["function"]}, "execute": lambda *_: "custom"}
        builtin = tiny.Agent(tools=[tiny.TOOL_DEFINITIONS[1]])
        custom = tiny.Agent(tools=[custom_read])
        self.assertEqual(builtin._current_recovery_configuration()["tools"][0]["replay"], "safe")
        self.assertEqual(custom._current_recovery_configuration()["tools"][0]["replay"], "never")

        responses = iter([
            {"choices": [{"message": {"role": "assistant", "content": None, "tool_calls": [
                {"id": "read-call", "type": "function", "function": {"name": "read", "arguments": '{"path":"missing"}'}}
            ]}, "finish_reason": "tool_calls"}], "usage": {}},
            {"choices": [{"message": {"role": "assistant", "content": "done"}, "finish_reason": "stop"}], "usage": {}},
        ])
        session = tiny.Session.create(tiny.ROOT)
        agent = tiny.Agent(session=session, tools=[custom_read], requester=lambda *_: async_value(next(responses)))
        await agent.run_agent_loop("read")
        started = next(fact["record"] for fact in agent._facts() if fact.get("record", {}).get("type") == "toolStarted")
        self.assertEqual((started["replay"], started["replayKey"]), ("never", "tool:read:v1"))
        session.close()

    async def test_cli_displays_recovery_through_terminal_before_continuation(self):
        session = SimpleNamespace(id="session-id", path=Path("session.jsonl"), close=lambda: None)
        calls = []

        class FakeAgent:
            def __init__(self, *_args, **_kwargs):
                self.usage = {"input": 7, "output": 3, "cacheRead": 0, "cacheWrite": 0}; self.on_tool = None
            async def resume_session(self): calls.append("resume"); return "recovered answer"
            async def run_agent_loop(self, text): calls.append(f"run:{text}"); return "continued answer"

        class FakeTerminal:
            def __enter__(self): calls.append("terminal"); return self
            def __exit__(self, *_): return None
            async def run(self, _agent, operation): calls.append("terminal.run"); return await operation()

        output = io.StringIO()
        with patch.object(cli, "load_mcp_configs", return_value=[]), \
             patch.object(cli, "load_skills", return_value=[]), \
             patch.object(cli, "load_project_instructions", return_value=""), \
             patch.object(cli.Session, "open", return_value=session), \
             patch.object(cli, "Agent", FakeAgent), patch.object(cli, "Terminal", FakeTerminal), \
             redirect_stdout(output):
            self.assertEqual(await cli.run_cli(["--session", "session-id", "continue"]), 0)

        self.assertEqual(calls, ["terminal", "terminal.run", "resume", "terminal.run", "run:continue"])
        self.assertLess(output.getvalue().index("session: session-id"), output.getvalue().index("recovered answer"))
        self.assertIn("recovered answer\x1b[0m\n\x1b[2m↑7 ↓3", output.getvalue())

    async def test_plugin_selection_deduplicates_assembles_mcp_and_rejects_unknown_early(self):
        remote = {"type": "function", "function": {"name": "mcp_remote", "description": "remote", "parameters": {}}}
        loaded = SimpleNamespace(tools=[remote], protocol_version="test", close=lambda: None)
        session = SimpleNamespace(id="session-id", path=Path("session.jsonl"), close=lambda: None)
        captured = {}

        class FakeAgent:
            def __init__(self, _skills, _session, _instructions, tools):
                captured["tools"] = tools; self.usage = {"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0}; self.on_tool = None
            async def run_agent_loop(self, _text): return "done"

        class FakeTerminal:
            def __enter__(self): return self
            def __exit__(self, *_): return None
            async def run(self, _agent, operation): return await operation()

        output = io.StringIO()
        with patch.object(cli, "load_mcp_configs", return_value=[SimpleNamespace(alias="fixture")]), \
             patch.object(cli, "load_mcp_tools", return_value=loaded), \
             patch.object(cli, "load_skills", return_value=[]), \
             patch.object(cli, "load_project_instructions", return_value=""), \
             patch.object(cli.Session, "create", return_value=session), \
             patch.object(cli, "Agent", FakeAgent), patch.object(cli, "Terminal", FakeTerminal), \
             redirect_stdout(output):
            self.assertEqual(await cli.run_cli(["--plugin", " read, edit ", "--plugin", "read", "--mcp", "fixture", "hello"]), 0)

        self.assertEqual([tool["function"]["name"] for tool in captured["tools"]], ["read", "edit", "mcp_remote"])
        self.assertIn("tools: read, edit, mcp_remote\nmcp: fixture", output.getvalue())

        with patch.object(cli.Session, "create") as create:
            with self.assertRaisesRegex(ValueError, r"Unknown plugin: missing\. Available plugins: bash, read, write, edit"):
                await cli.run_cli(["--plugin", "missing", "hello"])
            create.assert_not_called()

    async def test_terminal_true_tty_entry_sets_raw_and_output_flags(self):
        old = [0, 0, 0, 0, 0, 0, []]
        current = [0, 0, 0, 0, 0, 0, []]
        with patch.object(cli.sys.stdin, "fileno", return_value=9), \
             patch.object(cli.sys.stdin, "isatty", return_value=True), \
             patch.object(cli.termios, "tcgetattr", side_effect=[old, current]), \
             patch.object(cli.tty, "setraw") as setraw, \
             patch.object(cli.termios, "tcsetattr") as tcsetattr:
            terminal = Terminal()
            self.assertIs(terminal.__enter__(), terminal)
        setraw.assert_called_once_with(9)
        self.assertEqual(current[1] & (cli.termios.OPOST | cli.termios.ONLCR), cli.termios.OPOST | cli.termios.ONLCR)
        tcsetattr.assert_called_once_with(9, cli.termios.TCSANOW, current)

    async def test_terminal_display_position(self):
        self.assertEqual(Terminal.display_position("你a", 80), (0, 3))
        self.assertEqual(Terminal.display_position("abcdefg你", 8), (1, 2))
        self.assertEqual(Terminal.display_position("e\u0301你", 8), (0, 3))

    async def test_terminal_edits_at_cursor_and_distinguishes_escape(self):
        read_fd, write_fd = os.pipe(); terminal = Terminal.__new__(Terminal); terminal.fd = read_fd; terminal.tty = True
        try:
            os.write(write_fd, "你a\x1b[Db\x1b[C\x7f\r".encode()); self.assertEqual(terminal.readline(""), "你b")
            os.write(write_fd, b"[D"); self.assertEqual(terminal.escape_sequence(), b"D")
            self.assertEqual(terminal.escape_sequence(), b"")
        finally: os.close(read_fd); os.close(write_fd)

    async def test_formatting(self):
        self.assertEqual(tiny.format_usage({"input": 1200, "output": 30, "cacheRead": 500, "cacheWrite": 100, "cacheHitRate": 27.777}), "↑1.2k ↓30 R500 W100 CH27.8%")
        self.assertEqual(tiny.format_tool_event({"phase": "start", "name": "read", "args": {"path": "README.md"}}), "◆ read README.md")


if __name__ == "__main__":
    unittest.main()
