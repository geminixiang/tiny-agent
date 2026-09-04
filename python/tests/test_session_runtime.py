import unittest

from tiny_agent.session_runtime import current_configuration, entry_fact, project_session, record_fact, replay_declaration, runtime_configuration, step_failed_record, usage_fact


class SessionRuntimeTest(unittest.TestCase):
    def setUp(self):
        self.read = {"function": {"name": "read", "description": "Read", "parameters": {"type": "object"}}}
        self.write = {"function": {"name": "write", "description": "Write", "parameters": {"type": "object"}}}

    def test_runtime_configuration_and_replay_declarations(self):
        snapshot, digest = runtime_configuration("system", [self.read, self.write], "model")
        self.assertEqual(snapshot["model"], "model")
        self.assertTrue(digest.startswith("sha256:"))
        self.assertEqual(replay_declaration(self.read, self.read, "read"), ("safe", "builtin:read:v1"))
        self.assertEqual(replay_declaration(self.write, self.read, "write"), ("never", "tool:write:v1"))
        current = current_configuration(snapshot, digest, [self.read, self.write], self.read, "workspace")
        self.assertEqual(current["environmentIdentity"], "workspace")
        self.assertEqual([(tool["name"], tool["replay"]) for tool in current["tools"]], [("read", "safe"), ("write", "never")])

    def test_fact_builders_and_projection(self):
        self.assertEqual(entry_fact("entry", {"type": "message"})["id"], "entry")
        self.assertEqual(record_fact({"type": "runStarted"}, "record")["id"], "record")
        self.assertEqual(usage_fact("run", "attempt", {"input": 1})["kind"], "usage")
        self.assertEqual(step_failed_record("run", "step", "attempt", "model_error", "failed")["error"]["code"], "model_error")
        messages, usage = project_session({"activeContext": [{"role": "user", "content": "hello"}], "usage": {"input": 1}}, {"role": "system", "content": "system"})
        self.assertEqual(messages, [{"role": "system", "content": "system"}, {"role": "user", "content": "hello"}])
        self.assertEqual(usage, {"input": 1})


if __name__ == "__main__":
    unittest.main()
