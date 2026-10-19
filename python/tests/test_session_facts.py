import tempfile
import unittest
from pathlib import Path

from tiny_agent.agent import TOOL_DEFINITIONS
from tiny_agent.session import Session, environment_identity, uuid7
from tiny_agent.session import facts as fact
from tiny_agent.session.runtime import replay_declaration, runtime_configuration

USAGE = {"input": 1, "output": 1, "cacheRead": 0, "cacheWrite": 0}


class SessionFactsTest(unittest.TestCase):
    def test_fact_builders_produce_a_run_the_reducer_accepts_end_to_end(self):
        with tempfile.TemporaryDirectory() as directory:
            cwd = Path(directory)
            session = Session.create(cwd)
            snapshot, digest = runtime_configuration("system", TOOL_DEFINITIONS, "model")
            tool = TOOL_DEFINITIONS[1]
            name = tool["function"]["name"]

            input_entry_id, operation_id = uuid7(), uuid7()
            session.append(fact.user_message(input_entry_id, "inspect"), fact.run_started(operation_id, input_entry_id))

            step_id, attempt_id, assistant_entry_id, tool_started_id, result_entry_id = uuid7(), uuid7(), uuid7(), uuid7(), uuid7()
            call = {"id": "call_1", "type": "function", "function": {"name": name, "arguments": "{}"}}
            session.append(fact.step_attempt(operation_id, step_id, attempt_id, "assistant", 1, input_entry_id, snapshot, digest))
            session.append(
                fact.assistant_message(assistant_entry_id, step_id, attempt_id, "toolUse", {"role": "assistant", "content": None, "tool_calls": [call]}),
                fact.usage_fact(operation_id, attempt_id, USAGE),
            )
            replay, replay_key = replay_declaration(tool, TOOL_DEFINITIONS[1], name)
            session.append(fact.tool_started(tool_started_id, operation_id, step_id, assistant_entry_id, 0, call["id"], name, {}, replay, replay_key, environment_identity(cwd), result_entry_id))
            session.append(fact.tool_result(result_entry_id, step_id, tool_started_id, name, {"role": "tool", "tool_call_id": call["id"], "content": "ok"}, "success"))

            final_step_id, final_attempt_id, answer_id = uuid7(), uuid7(), uuid7()
            session.append(fact.step_attempt(operation_id, final_step_id, final_attempt_id, "assistant", 1, result_entry_id, snapshot, digest))
            session.append(
                fact.assistant_message(answer_id, final_step_id, final_attempt_id, "stop", {"role": "assistant", "content": "done"}),
                fact.usage_fact(operation_id, final_attempt_id, USAGE),
            )
            session.append(fact.operation_finished(operation_id, "run", "completed", completion="normal", final_entry_id=answer_id))

            state = session.load()
            self.assertEqual(state["operation"]["kind"], "idle")
            self.assertEqual([message["role"] for message in state["transcript"]], ["user", "assistant", "tool", "assistant"])
            session.close()


if __name__ == "__main__":
    unittest.main()
