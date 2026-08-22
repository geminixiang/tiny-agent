import json
import os
import stat
import threading
import unittest
from datetime import datetime, timezone
from pathlib import Path
from tempfile import TemporaryDirectory

from tiny_agent.session import Session, environment_identity
from tiny_agent.session_recovery import plan_recovery
from tiny_agent.session_reducer import reduce_session

ROOT = Path(__file__).resolve().parents[2]
PLANNERS = ROOT / "schemas/session/planner-fixtures"


class SessionStoreTest(unittest.TestCase):
    def test_all_shared_planner_fixtures(self):
        manifest = json.loads((PLANNERS / "manifest.json").read_text())
        for fixture in manifest["fixtures"]:
            with self.subTest(fixture=fixture["name"]):
                value = json.loads((PLANNERS / fixture["input"]).read_text())
                state = reduce_session((ROOT / "schemas/session/fixtures" / value["fixture"]).read_bytes())
                if fixture["name"] in ("abort-close-attempt", "abort-pending-tool", "abort-mixed-tools") and state["operation"]["kind"] != "idle":
                    state["operation"]["abortRequested"] = True
                if fixture["name"] == "attempts-exhausted" and state["operation"]["kind"] != "idle":
                    state["operation"]["step"]["attempt"] = 2
                expected = json.loads((PLANNERS / fixture["expected"]).read_text())
                self.assertEqual(plan_recovery(state, value["current"]), expected)

    def test_create_append_reopen_and_repair_torn_tail(self):
        with TemporaryDirectory() as root:
            cwd = Path(root)
            now = datetime(2026, 8, 3, 3, 55, 50, 62000, timezone.utc)
            session = Session.create(cwd, now)
            self.assertEqual(stat.S_IMODE(session.path.stat().st_mode), 0o600)
            user = {"kind": "entry", "entry": {"type": "message", "message": {"role": "user", "content": "hi"}}}
            operation = session.append(user)[0]["id"]
            session.path.write_bytes(session.path.read_bytes() + b'{"torn"')
            opened = Session.open(session.id, cwd)
            self.assertEqual(opened.path.read_bytes()[-1:], b"\n")
            self.assertEqual(opened.next_seq, 2)
            self.assertEqual(opened.load()["transcript"], [{"role": "user", "content": "hi"}])

    def test_append_is_serialized_and_environment_override(self):
        with TemporaryDirectory() as root:
            session = Session.create(Path(root)); errors = []
            def append(index):
                try: session.append({"kind": "entry", "entry": {"type": "message", "message": {"role": "user", "content": str(index)}}})
                except Exception as error: errors.append(error)
            threads = [threading.Thread(target=append, args=(index,)) for index in range(10)]
            for thread in threads: thread.start()
            for thread in threads: thread.join()
            self.assertFalse(errors)
            self.assertEqual(len(session.load()["transcript"]), 10)
        old = os.environ.get("TINY_AGENT_ENVIRONMENT_IDENTITY")
        try:
            os.environ["TINY_AGENT_ENVIRONMENT_IDENTITY"] = "job-1"
            self.assertEqual(environment_identity(), "job-1")
        finally:
            if old is None: os.environ.pop("TINY_AGENT_ENVIRONMENT_IDENTITY", None)
            else: os.environ["TINY_AGENT_ENVIRONMENT_IDENTITY"] = old


if __name__ == "__main__": unittest.main()
