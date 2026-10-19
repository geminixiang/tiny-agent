# Session fact builders: the single place where the agent loop shapes durable
# entries and records. The reducer validates these shapes; the builders keep
# the JSON key names out of the agent loop. See docs/session-design.md.


def _record(body: dict, fact_id: str | None = None) -> dict:
    fact = {"kind": "record"}
    if fact_id is not None:
        fact["id"] = fact_id
    fact["record"] = body
    return fact


def _entry(fact_id: str, body: dict) -> dict:
    return {"kind": "entry", "id": fact_id, "entry": body}


def usage_fact(operation_id: str, attempt_id: str, usage: dict) -> dict:
    return {"kind": "usage", "operationId": operation_id, "attemptId": attempt_id, "usage": usage}


def user_message(fact_id: str, content: str) -> dict:
    return _entry(fact_id, {"type": "message", "message": {"role": "user", "content": content}})


def run_started(operation_id: str, input_entry_id: str) -> dict:
    return _record({"type": "runStarted", "operationId": operation_id, "operationKind": "run", "inputEntryId": input_entry_id})


def compaction_started(operation_id: str, input_through_entry_id: str, result_entry_id: str, compacted_entry_ids: list[str], retained_entry_ids: list[str], source_digest: str) -> dict:
    return _record(
        {
            "type": "compactionStarted",
            "operationId": operation_id,
            "operationKind": "compaction",
            "inputThroughEntryId": input_through_entry_id,
            "resultEntryId": result_entry_id,
            "compactedEntryIds": compacted_entry_ids,
            "retainedEntryIds": retained_entry_ids,
            "sourceDigest": source_digest,
        }
    )


def step_attempt(operation_id: str, step_id: str, attempt_id: str, step_kind: str, attempt: int, context_through_entry_id: str, configuration_snapshot: dict, configuration_digest: str) -> dict:
    return _record(
        {
            "type": "stepAttempt",
            "operationId": operation_id,
            "stepId": step_id,
            "attemptId": attempt_id,
            "stepKind": step_kind,
            "attempt": attempt,
            "contextThroughEntryId": context_through_entry_id,
            "configurationSnapshot": configuration_snapshot,
            "configurationDigest": configuration_digest,
        }
    )


def step_failed(operation_id: str, step_id: str, attempt_id: str, error: dict) -> dict:
    return _record({"type": "stepFailed", "operationId": operation_id, "stepId": step_id, "attemptId": attempt_id, "error": error})


def abort_requested(operation_id: str, phase: str, tool_call_id: str | None = None) -> dict:
    record = {"type": "abortRequested", "operationId": operation_id, "operationKind": "compaction" if phase == "compact" else "run", "phase": phase}
    if tool_call_id:
        record["toolCallId"] = tool_call_id
    record["reason"] = "escape"
    return _record(record)


def operation_finished(operation_id: str, operation_kind: str, outcome: str, completion: str | None = None, final_entry_id: str | None = None, error: dict | None = None) -> dict:
    record = {"type": "operationFinished", "operationId": operation_id, "operationKind": operation_kind, "outcome": outcome}
    if completion is not None:
        record["completion"] = completion
    if final_entry_id is not None:
        record["finalEntryId"] = final_entry_id
    if error is not None:
        record["error"] = error
    return _record(record)


def assistant_message(fact_id: str, step_id: str, attempt_id: str, stop_reason: str, message: dict) -> dict:
    return _entry(fact_id, {"type": "message", "stepId": step_id, "attemptId": attempt_id, "stopReason": stop_reason, "message": message})


def tool_started(
    fact_id: str,
    operation_id: str,
    step_id: str,
    assistant_entry_id: str,
    tool_index: int,
    tool_call_id: str,
    tool_name: str,
    arguments: dict,
    replay: str,
    replay_key: str,
    environment_identity: str,
    result_entry_id: str,
) -> dict:
    return _record(
        {
            "type": "toolStarted",
            "operationId": operation_id,
            "stepId": step_id,
            "assistantEntryId": assistant_entry_id,
            "toolIndex": tool_index,
            "toolCallId": tool_call_id,
            "toolName": tool_name,
            "arguments": arguments,
            "replay": replay,
            "replayKey": replay_key,
            "environmentIdentity": environment_identity,
            "resultEntryId": result_entry_id,
        },
        fact_id,
    )


def tool_result(fact_id: str, step_id: str, tool_started_id: str, tool_name: str, message: dict, outcome: str) -> dict:
    result = {"type": "synthetic", "reason": "interrupted"} if outcome == "interrupted" else {"type": outcome}
    return _entry(fact_id, {"type": "message", "stepId": step_id, "message": message, "toolName": tool_name, "toolStartedId": tool_started_id, "result": result})


def synthetic_tool_result(step_id: str, result: dict) -> dict:
    entry = {"type": "message", "stepId": step_id}
    if result.get("toolStartedId"):
        entry["toolStartedId"] = result["toolStartedId"]
    else:
        entry.update(assistantEntryId=result["assistantEntryId"], toolIndex=result["toolIndex"])
    entry["message"] = {"role": "tool", "tool_call_id": result["toolCallId"], "content": result["content"]}
    entry["toolName"] = result["toolName"]
    entry["result"] = {"type": "synthetic", "reason": result["reason"]}
    return _entry(result["resultEntryId"], entry)


def compaction_entry(fact_id: str, operation_id: str, summary: str, compacted_through_entry_id: str, retained_tail: list[dict]) -> dict:
    return _entry(fact_id, {"type": "compaction", "operationId": operation_id, "summary": summary, "compactedThroughEntryId": compacted_through_entry_id, "retainedTail": retained_tail})
