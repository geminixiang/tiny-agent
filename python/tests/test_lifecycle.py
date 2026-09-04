import tempfile
import unittest
from pathlib import Path
from tiny_agent.lifecycle import CallbackSink, ExecutionLifecycle
from tiny_agent.session import Session


class LifecycleTest(unittest.TestCase):
    def recorder(self):
        events = []
        lifecycle = ExecutionLifecycle([CallbackSink(events.append)])
        lifecycle.observe(
            {
                "type": "session.attached",
                "timestamp": "2026-01-01T00:00:00.000Z",
                "sessionId": "session-1",
                "resumed": False,
            }
        )
        return events, lifecycle

    def test_session_notifies_after_write_and_ignores_observer_failure(self):
        with tempfile.TemporaryDirectory() as directory:
            session = Session.create(Path(directory))
            observed = []
            session.observe_commits(lambda facts: observed.append(facts))
            committed = session.append({"kind": "entry", "entry": {"type": "message", "message": {"role": "user", "content": "hello"}}})
            self.assertEqual(observed, [committed])
            session.observe_commits(lambda _facts: (_ for _ in ()).throw(RuntimeError("sink failed")))
            session.append({"kind": "entry", "entry": {"type": "message", "message": {"role": "user", "content": "still durable"}}})
            session.close()

    def test_projects_committed_tool_admission_separately_from_physical_attempt(self):
        events, lifecycle = self.recorder()
        lifecycle.committed(
            [
                {
                    "kind": "record",
                    "id": "tool-started-1",
                    "timestamp": 10,
                    "record": {
                        "type": "toolStarted",
                        "operationId": "operation-1",
                        "stepId": "step-1",
                        "toolCallId": "call-1",
                        "toolName": "read",
                        "replay": "safe",
                    },
                }
            ]
        )
        lifecycle.observe(
            {
                "type": "tool.started",
                "timestamp": "2026-01-01T00:00:00.020Z",
                "operationId": "operation-1",
                "stepId": "step-1",
                "attemptId": "physical-1",
                "parentAttemptId": "model-1",
                "toolStartedId": "tool-started-1",
                "toolCallId": "call-1",
                "tool": "read",
                "recovery": False,
            }
        )

        self.assertEqual([event["type"] for event in events if event["type"].startswith("tool.")], ["tool.admitted", "tool.started"])
        lifecycle.close()
        self.assertEqual(events[-1]["type"], "tool.completed")
        self.assertEqual(events[-1]["outcome"], "effect_unknown")

    def test_recovery_reconciles_without_inventing_cross_process_model_attempt(self):
        events, lifecycle = self.recorder()
        lifecycle.observe(
            {
                "type": "recovery.attached",
                "timestamp": "2026-01-01T00:00:00.010Z",
                "operationId": "operation-1",
                "operationKind": "run",
            }
        )
        lifecycle.committed(
            [
                {
                    "kind": "record",
                    "timestamp": 20,
                    "record": {
                        "type": "stepFailed",
                        "operationId": "operation-1",
                        "stepId": "step-1",
                        "attemptId": "old-process-attempt",
                        "error": {"code": "aborted"},
                    },
                }
            ]
        )

        reconciled = next(event for event in events if event["type"] == "model.reconciled")
        self.assertEqual(reconciled["outcome"], "cancelled")
        self.assertTrue(reconciled["recovery"])
        self.assertFalse(any(event["type"] == "model.completed" for event in events))
        lifecycle.close()


if __name__ == "__main__":
    unittest.main()
