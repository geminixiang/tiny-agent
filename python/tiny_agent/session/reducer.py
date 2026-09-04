import copy
import hashlib
import json
import re
from typing import Any

UUID7 = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$")
DIGEST = re.compile(r"^sha256:[0-9a-f]{64}$")
MAX_SAFE_INTEGER = 9_007_199_254_740_991


class SessionCorruption(Exception):
    def __init__(self, code: str, line: int, seq: int | None = None, message: str | None = None):
        super().__init__(message or code)
        self.code, self.line, self.seq = code, line, seq


def fail(code: str, line: int, seq: int | None = None, message: str | None = None):
    raise SessionCorruption(code, line, seq, message)


def obj(value: Any, code: str, line: int, seq: int | None = None) -> dict[str, Any]:
    if not isinstance(value, dict):
        fail(code, line, seq)
    return value


def exact(value: dict[str, Any], keys: list[str], code: str, line: int, seq: int | None = None):
    if any(key not in keys for key in value):
        fail(code, line, seq)


def text(value: Any, code: str, line: int, seq: int | None = None) -> str:
    if not isinstance(value, str) or not value:
        fail(code, line, seq)
    return value


def safe_int(value: Any, code: str, line: int, seq: int | None = None, minimum: int = 0) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value < minimum or value > MAX_SAFE_INTEGER:
        fail(code, line, seq)
    return value


def uuid(value: Any, code: str, line: int, seq: int | None = None) -> str:
    result = text(value, code, line, seq)
    if not UUID7.fullmatch(result):
        fail(code, line, seq)
    return result


def add_usage(total: int, amount: int, line: int, seq: int) -> int:
    if total > MAX_SAFE_INTEGER - amount:
        fail("INVALID_FACT", line, seq)
    return total + amount


def has_lone_surrogate(value: Any) -> bool:
    if isinstance(value, str):
        return any(0xD800 <= ord(character) <= 0xDFFF for character in value)
    if isinstance(value, list):
        return any(has_lone_surrogate(item) for item in value)
    if isinstance(value, dict):
        return any(has_lone_surrogate(key) or has_lone_surrogate(item) for key, item in value.items())
    return False


def reject_duplicate_keys(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("duplicate JSON key")
        result[key] = value
    return result


def parse_message(value: Any, line: int, seq: int) -> dict[str, Any]:
    message = obj(value, "INVALID_FACT", line, seq)
    role = message.get("role")
    if role == "user":
        exact(message, ["role", "content"], "INVALID_FACT", line, seq)
        return {"role": role, "content": text(message.get("content"), "INVALID_FACT", line, seq)}
    if role == "tool":
        exact(message, ["role", "content", "tool_call_id"], "INVALID_FACT", line, seq)
        if not isinstance(message.get("content"), str):
            fail("INVALID_FACT", line, seq)
        return {
            "role": role,
            "content": message["content"],
            "tool_call_id": text(message.get("tool_call_id"), "INVALID_FACT", line, seq),
        }
    if role != "assistant":
        fail("INVALID_FACT", line, seq)
    exact(message, ["role", "content", "tool_calls"], "INVALID_FACT", line, seq)
    content = message.get("content")
    if content is not None and not isinstance(content, str):
        fail("INVALID_FACT", line, seq)
    if "tool_calls" not in message:
        return {"role": role, "content": content}
    raw_calls = message["tool_calls"]
    if not isinstance(raw_calls, list) or not raw_calls:
        fail("INVALID_FACT", line, seq)
    calls = []
    for raw in raw_calls:
        call = obj(raw, "INVALID_FACT", line, seq)
        exact(call, ["id", "type", "function"], "INVALID_FACT", line, seq)
        if call.get("type") != "function":
            fail("INVALID_FACT", line, seq)
        function = obj(call.get("function"), "INVALID_FACT", line, seq)
        exact(function, ["name", "arguments"], "INVALID_FACT", line, seq)
        if not isinstance(function.get("arguments"), str):
            fail("INVALID_FACT", line, seq)
        calls.append(
            {
                "id": text(call.get("id"), "INVALID_FACT", line, seq),
                "type": "function",
                "function": {
                    "name": text(function.get("name"), "INVALID_FACT", line, seq),
                    "arguments": function["arguments"],
                },
            }
        )
    if len({call["id"] for call in calls}) != len(calls):
        fail("INVALID_TRANSCRIPT", line, seq)
    return {"role": role, "content": content, "tool_calls": calls}


def reserve(state: dict[str, Any], value: Any, line: int, seq: int, kind: str = "identity") -> str:
    key = uuid(value, "INVALID_FACT", line, seq)
    if key in state["ids"] or key in state["reserved"]:
        fail("DUPLICATE_ID", line, seq)
    state["reserved"][key] = kind
    return key


def canonical_configuration(value: Any) -> str:
    if isinstance(value, str):
        for character in value:
            if 0xD800 <= ord(character) <= 0xDFFF:
                raise ValueError("invalid Unicode scalar string")
        return json.dumps(value, ensure_ascii=False, separators=(",", ":"))
    if isinstance(value, list):
        return "[" + ",".join(canonical_configuration(item) for item in value) + "]"
    if not isinstance(value, dict):
        raise ValueError("configuration supports strings, arrays, and objects only")
    keys = sorted(value, key=lambda key: key.encode("utf-16-be", "surrogatepass"))
    return "{" + ",".join(f"{canonical_configuration(key)}:{canonical_configuration(value[key])}" for key in keys) + "}"


def configuration(value: Any, line: int, seq: int) -> dict[str, Any]:
    snapshot = obj(value, "INVALID_FACT", line, seq)
    exact(snapshot, ["model", "systemPromptDigest", "tools", "adapterIdentity", "routingIdentity", "outputOptionsDigest"], "INVALID_FACT", line, seq)
    model = text(snapshot.get("model"), "INVALID_FACT", line, seq)
    prompt_digest = snapshot.get("systemPromptDigest")
    if not isinstance(prompt_digest, str) or not DIGEST.fullmatch(prompt_digest):
        fail("INVALID_FACT", line, seq)
    adapter = text(snapshot.get("adapterIdentity"), "INVALID_FACT", line, seq)
    routing = text(snapshot.get("routingIdentity"), "INVALID_FACT", line, seq)
    output_digest = snapshot.get("outputOptionsDigest")
    if not isinstance(output_digest, str) or not DIGEST.fullmatch(output_digest):
        fail("INVALID_FACT", line, seq)
    if not isinstance(snapshot.get("tools"), list):
        fail("INVALID_FACT", line, seq)
    names, tools = set(), []
    for raw in snapshot["tools"]:
        tool = obj(raw, "INVALID_FACT", line, seq)
        exact(tool, ["name", "definitionDigest"], "INVALID_FACT", line, seq)
        name = text(tool.get("name"), "INVALID_FACT", line, seq)
        schema_digest = tool.get("definitionDigest")
        if name in names or not isinstance(schema_digest, str) or not DIGEST.fullmatch(schema_digest):
            fail("INVALID_FACT", line, seq)
        names.add(name)
        tools.append({"name": name, "definitionDigest": schema_digest})
    return {"model": model, "systemPromptDigest": prompt_digest, "tools": tools, "adapterIdentity": adapter, "routingIdentity": routing, "outputOptionsDigest": output_digest}


def configuration_digest(snapshot: dict[str, Any]) -> str:
    digest = hashlib.sha256(canonical_configuration(snapshot).encode()).hexdigest()
    return f"sha256:{digest}"


def get_operation(state: dict[str, Any], value: Any, line: int, seq: int):
    key = uuid(value, "INVALID_FACT", line, seq)
    found = state["operations"].get(key)
    if not found:
        fail("INVALID_REFERENCE", line, seq)
    if found["finished"]:
        fail("INVALID_TRANSITION", line, seq)
    return key, found


def validate_transcript(messages: list[dict[str, Any]], line: int, seq: int | None = None):
    pending: set[str] = set()
    for message in messages:
        if message["role"] == "assistant":
            if pending:
                fail("INVALID_TRANSCRIPT", line, seq)
            pending.update(call["id"] for call in message.get("tool_calls", []))
        elif message["role"] == "tool":
            if message["tool_call_id"] not in pending:
                fail("INVALID_TRANSCRIPT", line, seq)
            pending.remove(message["tool_call_id"])
        elif pending:
            fail("INVALID_TRANSCRIPT", line, seq)


SYNTHETIC_CONTENT = {
    "invalidArguments": "Error: Tool arguments were invalid; the tool was not executed.",
    "unknownTool": "Error: Unknown tool; the tool was not executed.",
    "truncated": "Error: Tool call arguments were truncated by the model token limit; the tool was not executed.",
    "aborted": "Operation aborted before execution.",
    "interrupted": "Operation interrupted after execution status became unknown; the tool was not replayed.",
}


def canonical_value(value: Any) -> str:
    if value is None or isinstance(value, (bool, int, float)):
        return json.dumps(value, separators=(",", ":"))
    if isinstance(value, str):
        return canonical_configuration(value)
    if isinstance(value, list):
        return "[" + ",".join(canonical_value(item) for item in value) + "]"
    if not isinstance(value, dict):
        raise ValueError("unsupported canonical value")
    return "{" + ",".join(f"{canonical_configuration(key)}:{canonical_value(value[key])}" for key in sorted(value)) + "}"


def source_digest(state: dict[str, Any], input_entry_id: str) -> str:
    source = []
    for source_id, info in state["entries"].items():
        if info["entry"].get("type") == "message":
            source.append({"sourceEntryId": source_id, "message": info["entry"]["message"]})
        if source_id == input_entry_id:
            break
    return "sha256:" + hashlib.sha256(canonical_value(source).encode()).hexdigest()


def validate_synthetic_content(reason: str, content: str, line: int, seq: int):
    if content != SYNTHETIC_CONTENT[reason]:
        fail("INVALID_TRANSCRIPT", line, seq)


def apply_entry(state: dict[str, Any], fact: dict[str, Any], line: int):
    seq = fact["seq"]
    exact(fact, ["kind", "seq", "id", "timestamp", "entry"], "INVALID_FACT", line, seq)
    entry = obj(fact.get("entry"), "INVALID_FACT", line, seq)
    entry_type = entry.get("type")
    if entry_type == "message":
        message = parse_message(entry.get("message"), line, seq)
        if message["role"] == "user":
            if fact["id"] in state["reserved"]:
                fail("DUPLICATE_ID", line, seq)
            exact(entry, ["type", "message"], "INVALID_FACT", line, seq)
            info = {"entry": entry}
        elif message["role"] == "assistant":
            if fact["id"] in state["reserved"]:
                fail("DUPLICATE_ID", line, seq)
            exact(entry, ["type", "stepId", "attemptId", "stopReason", "message"], "INVALID_FACT", line, seq)
            step_id = uuid(entry.get("stepId"), "INVALID_FACT", line, seq)
            attempt_id = uuid(entry.get("attemptId"), "INVALID_FACT", line, seq)
            stop_reason = entry.get("stopReason")
            if stop_reason not in ("stop", "toolUse", "length"):
                fail("INVALID_FACT", line, seq)
            attempt = state["attempts"].get(attempt_id)
            if not attempt or attempt["stepId"] != step_id or attempt["closed"] or attempt["kind"] != "assistant":
                fail("INVALID_REFERENCE", line, seq)
            operation = state["operation"]
            if operation["kind"] != "run" or operation["operationId"] != attempt["operationId"]:
                fail("INVALID_TRANSITION", line, seq)
            if stop_reason == "toolUse" and not message.get("tool_calls"):
                fail("INVALID_TRANSCRIPT", line, seq)
            if stop_reason == "stop" and message.get("tool_calls"):
                fail("INVALID_TRANSCRIPT", line, seq)
            attempt["closed"], attempt["settledEntryId"] = True, fact["id"]
            if operation.get("step", {}).get("attemptId") == attempt_id:
                operation["step"]["status"] = "settled"
                operation["step"]["settledEntryId"] = fact["id"]
                operation["step"]["stopReason"] = stop_reason
            info = {"entry": entry, "operationId": attempt["operationId"], "stepId": step_id, "attemptId": attempt_id}
        else:
            pre_execution = "assistantEntryId" in entry or "toolIndex" in entry
            exact(
                entry,
                ["type", "stepId", "assistantEntryId", "toolIndex", "message", "toolName", "result"] if pre_execution else ["type", "stepId", "message", "toolName", "toolStartedId", "result"],
                "INVALID_FACT",
                line,
                seq,
            )
            step_id = uuid(entry.get("stepId"), "INVALID_FACT", line, seq)
            result = obj(entry.get("result"), "INVALID_FACT", line, seq)
            exact(result, ["type", "reason"], "INVALID_FACT", line, seq)
            tool_name = text(entry.get("toolName"), "INVALID_FACT", line, seq)
            if pre_execution:
                reason = result.get("reason")
                if result.get("type") != "synthetic" or reason not in ("invalidArguments", "unknownTool", "truncated", "aborted"):
                    fail("INVALID_FACT", line, seq)
                assistant_id = uuid(entry.get("assistantEntryId"), "INVALID_FACT", line, seq)
                tool_index = safe_int(entry.get("toolIndex"), "INVALID_FACT", line, seq)
                assistant_info = state["entries"].get(assistant_id)
                assistant = assistant_info.get("entry") if assistant_info else None
                operation = state["operation"]
                if (
                    not assistant
                    or assistant.get("type") != "message"
                    or assistant_info.get("stepId") != step_id
                    or operation["kind"] != "run"
                    or assistant_info.get("operationId") != operation["operationId"]
                ):
                    fail("INVALID_REFERENCE", line, seq)
                calls = parse_message(assistant.get("message"), line, seq).get("tool_calls", [])
                call = calls[tool_index] if tool_index < len(calls) else None
                if not call or call["id"] != message["tool_call_id"] or call["function"]["name"] != tool_name:
                    fail("INVALID_REFERENCE", line, seq)
                pair = f"{assistant_id}:{tool_index}"
                if pair in state["toolPairs"]:
                    fail("INVALID_TRANSITION", line, seq)
                validate_synthetic_content(reason, message["content"], line, seq)
                state["toolPairs"].add(pair)
                info = {"entry": entry, "operationId": assistant_info["operationId"], "stepId": step_id}
            else:
                if state["reserved"].get(fact["id"]) != "toolResult":
                    fail("INVALID_REFERENCE", line, seq)
                result_type = result.get("type")
                if result_type not in ("success", "error", "synthetic"):
                    fail("INVALID_FACT", line, seq)
                if result_type == "synthetic":
                    if result.get("reason") != "interrupted":
                        fail("INVALID_FACT", line, seq)
                    validate_synthetic_content("interrupted", message["content"], line, seq)
                elif "reason" in result:
                    fail("INVALID_FACT", line, seq)
                started_id = uuid(entry.get("toolStartedId"), "INVALID_FACT", line, seq)
                started = state["tools"].get(started_id)
                if (
                    not started
                    or started["stepId"] != step_id
                    or started["resultEntryId"] != fact["id"]
                    or started["toolCallId"] != message["tool_call_id"]
                    or started["toolName"] != tool_name
                    or started["status"] != "pending"
                ):
                    fail("INVALID_REFERENCE", line, seq)
                started["status"] = "completed"
                del state["reserved"][fact["id"]]
                info = {"entry": entry, "operationId": started["operationId"], "stepId": started["stepId"]}
        state["transcript"].append(message)
        state["activeContext"].append(message)
        state["activeContextThroughEntryId"] = fact["id"]
        state["entries"][fact["id"]] = info
        return
    if entry_type != "compaction":
        fail("INVALID_FACT", line, seq)
    if state["reserved"].get(fact["id"]) != "compactionResult":
        fail("INVALID_REFERENCE", line, seq)
    exact(entry, ["type", "operationId", "summary", "compactedThroughEntryId", "retainedTail"], "INVALID_FACT", line, seq)
    key, found = get_operation(state, entry.get("operationId"), line, seq)
    operation = state["operation"]
    if found["kind"] != "compaction" or operation["kind"] != "compaction" or operation["operationId"] != key:
        fail("INVALID_TRANSITION", line, seq)
    if operation["resultEntryId"] != fact["id"]:
        fail("INVALID_REFERENCE", line, seq)
    through = uuid(entry.get("compactedThroughEntryId"), "INVALID_FACT", line, seq)
    if through not in state["entries"]:
        fail("INVALID_REFERENCE", line, seq)
    if not isinstance(entry.get("summary"), str) or not isinstance(entry.get("retainedTail"), list):
        fail("INVALID_FACT", line, seq)
    if operation["inputThroughEntryId"] not in state["entries"]:
        fail("INVALID_REFERENCE", line, seq)
    entry_ids = list(state["entries"])
    boundary, input_boundary = entry_ids.index(through), entry_ids.index(operation["inputThroughEntryId"])
    if input_boundary < boundary:
        fail("INVALID_REFERENCE", line, seq)
    expected_ids = [key for key in entry_ids[boundary + 1 : input_boundary + 1] if state["entries"][key]["entry"].get("type") == "message"]
    retained = []
    for index, raw in enumerate(entry["retainedTail"]):
        item = obj(raw, "INVALID_FACT", line, seq)
        exact(item, ["sourceEntryId", "message"], "INVALID_FACT", line, seq)
        source_id = uuid(item.get("sourceEntryId"), "INVALID_FACT", line, seq)
        message = parse_message(item.get("message"), line, seq)
        source = state["entries"].get(source_id, {}).get("entry")
        if index >= len(expected_ids) or source_id != expected_ids[index] or source is None or source.get("type") != "message" or source.get("message") != message:
            fail("INVALID_REFERENCE", line, seq)
        retained.append(message)
    if len(entry["retainedTail"]) != len(expected_ids):
        fail("INVALID_REFERENCE", line, seq)
    validate_transcript(retained, line, seq)
    state["activeContext"] = [{"role": "user", "content": f"[Compacted history]\n{entry['summary']}"}, *retained]
    state["activeContextThroughEntryId"] = operation["inputThroughEntryId"]
    attempt_id = operation.get("step", {}).get("attemptId")
    attempt = state["attempts"].get(attempt_id)
    if not attempt or attempt["closed"] or attempt["kind"] != "compaction":
        fail("INVALID_TRANSITION", line, seq)
    attempt["closed"], attempt["settledEntryId"] = True, fact["id"]
    del state["reserved"][fact["id"]]
    operation["step"]["status"] = "settled"
    operation["step"]["settledEntryId"] = fact["id"]
    state["entries"][fact["id"]] = {"entry": entry, "operationId": key, "stepId": attempt["stepId"], "attemptId": attempt_id}


def apply_record(state: dict[str, Any], fact: dict[str, Any], line: int):
    seq = fact["seq"]
    exact(fact, ["kind", "seq", "id", "timestamp", "record"], "INVALID_FACT", line, seq)
    record = obj(fact.get("record"), "INVALID_FACT", line, seq)
    kind = record.get("type")
    if kind == "runStarted":
        exact(record, ["type", "operationId", "operationKind", "inputEntryId"], "INVALID_FACT", line, seq)
        if record.get("operationKind") != "run" or state["operation"]["kind"] != "idle":
            fail("INVALID_TRANSITION", line, seq)
        operation_id = reserve(state, record.get("operationId"), line, seq)
        input_id = uuid(record.get("inputEntryId"), "INVALID_FACT", line, seq)
        source = state["entries"].get(input_id, {}).get("entry")
        if not source or source.get("type") != "message" or obj(source.get("message"), "INVALID_REFERENCE", line, seq).get("role") != "user":
            fail("INVALID_REFERENCE", line, seq)
        state["operations"][operation_id] = {"kind": "run", "finished": False, "inputThroughEntryId": input_id}
        state["operation"] = {"kind": "run", "operationId": operation_id, "inputEntryId": input_id, "toolCalls": [], "abortRequested": False}
    elif kind == "compactionStarted":
        exact(record, ["type", "operationId", "operationKind", "inputThroughEntryId", "resultEntryId", "compactedEntryIds", "retainedEntryIds", "sourceDigest"], "INVALID_FACT", line, seq)
        if record.get("operationKind") != "compaction" or state["operation"]["kind"] != "idle":
            fail("INVALID_TRANSITION", line, seq)
        operation_id = reserve(state, record.get("operationId"), line, seq)
        input_id = uuid(record.get("inputThroughEntryId"), "INVALID_FACT", line, seq)
        result_id = reserve(state, record.get("resultEntryId"), line, seq, "compactionResult")
        if input_id not in state["entries"]:
            fail("INVALID_REFERENCE", line, seq)
        compacted_ids = record.get("compactedEntryIds")
        retained_ids = record.get("retainedEntryIds")
        if not isinstance(compacted_ids, list) or not compacted_ids or not isinstance(retained_ids, list):
            fail("INVALID_FACT", line, seq)
        partition = [uuid(value, "INVALID_FACT", line, seq) for value in [*compacted_ids, *retained_ids]]
        source_ids = [entry_id for entry_id, info in state["entries"].items() if info["entry"].get("type") == "message"]
        try:
            input_index = source_ids.index(input_id)
        except ValueError:
            fail("INVALID_REFERENCE", line, seq)
        if partition != source_ids[: input_index + 1]:
            fail("INVALID_REFERENCE", line, seq)
        source_digest_value = record.get("sourceDigest")
        if not isinstance(source_digest_value, str) or not DIGEST.fullmatch(source_digest_value):
            fail("INVALID_FACT", line, seq)
        if source_digest(state, input_id) != source_digest_value:
            fail("INVALID_REFERENCE", line, seq)
        state["operations"][operation_id] = {"kind": "compaction", "finished": False, "inputThroughEntryId": input_id, "resultEntryId": result_id}
        state["operation"] = {"kind": "compaction", "operationId": operation_id, "inputThroughEntryId": input_id, "resultEntryId": result_id, "abortRequested": False}
    elif kind == "stepAttempt":
        exact(record, ["type", "operationId", "stepId", "attemptId", "stepKind", "attempt", "contextThroughEntryId", "configurationSnapshot", "configurationDigest"], "INVALID_FACT", line, seq)
        operation_id, found = get_operation(state, record.get("operationId"), line, seq)
        number = safe_int(record.get("attempt"), "INVALID_FACT", line, seq, 1)
        step_id = reserve(state, record.get("stepId"), line, seq) if number == 1 else uuid(record.get("stepId"), "INVALID_FACT", line, seq)
        attempt_id = reserve(state, record.get("attemptId"), line, seq)
        step_kind = record.get("stepKind")
        if number > 2 or step_kind not in ("assistant", "compaction"):
            fail("INVALID_FACT", line, seq)
        if step_kind != ("assistant" if found["kind"] == "run" else "compaction"):
            fail("INVALID_TRANSITION", line, seq)
        context_id = uuid(record.get("contextThroughEntryId"), "INVALID_FACT", line, seq)
        if context_id not in state["entries"]:
            fail("INVALID_REFERENCE", line, seq)
        if number == 1 and context_id != state["activeContextThroughEntryId"]:
            fail("INVALID_TRANSITION", line, seq)
        snapshot = configuration(record.get("configurationSnapshot"), line, seq)
        digest = record.get("configurationDigest")
        if not isinstance(digest, str) or not DIGEST.fullmatch(digest) or configuration_digest(snapshot) != digest:
            fail("INVALID_FACT", line, seq)
        prior = state["steps"].get(step_id, [])
        active = state["operation"].get("step")
        if number == 1:
            if prior or (active and active["status"] != "settled"):
                fail("INVALID_TRANSITION", line, seq)
            if active:
                previous = state["attempts"].get(active["attemptId"])
                settled = state["entries"].get(previous.get("settledEntryId"), {}).get("entry") if previous else None
                if (
                    found["kind"] != "run"
                    or not settled
                    or settled.get("stopReason") != "toolUse"
                    or state["operation"]["kind"] != "run"
                    or any(tool["status"] == "pending" for tool in state["operation"]["toolCalls"])
                ):
                    fail("INVALID_TRANSITION", line, seq)
        else:
            first = prior[0] if prior else None
            if (
                len(prior) != 1
                or first["attempt"] != 1
                or first["closed"]
                or first["failed"]
                or first["kind"] != step_kind
                or first["operationId"] != operation_id
                or first["contextThroughEntryId"] != context_id
                or first["configurationDigest"] != digest
            ):
                fail("INVALID_TRANSITION", line, seq)
            first["closed"] = True
        attempt = {
            "operationId": operation_id,
            "stepId": step_id,
            "attemptId": attempt_id,
            "attempt": number,
            "kind": step_kind,
            "contextThroughEntryId": context_id,
            "closed": False,
            "failed": False,
            "configurationSnapshot": snapshot,
            "configurationDigest": digest,
        }
        state["attempts"][attempt_id] = attempt
        state["steps"][step_id] = [*prior, attempt]
        found["latestStepId"] = step_id
        state["operation"]["step"] = {
            "operationId": operation_id,
            "stepId": step_id,
            "attemptId": attempt_id,
            "attempt": number,
            "stepKind": step_kind,
            "status": "attempting",
            "contextThroughEntryId": context_id,
            "configurationSnapshot": snapshot,
            "configurationDigest": digest,
        }
    elif kind == "stepFailed":
        exact(record, ["type", "operationId", "stepId", "attemptId", "error"], "INVALID_FACT", line, seq)
        operation_id, _ = get_operation(state, record.get("operationId"), line, seq)
        attempt_id = uuid(record.get("attemptId"), "INVALID_FACT", line, seq)
        attempt = state["attempts"].get(attempt_id)
        error = obj(record.get("error"), "INVALID_FACT", line, seq)
        exact(error, ["code", "message"], "INVALID_FACT", line, seq)
        text(error.get("code"), "INVALID_FACT", line, seq)
        text(error.get("message"), "INVALID_FACT", line, seq)
        if not attempt or attempt["operationId"] != operation_id or attempt["stepId"] != record.get("stepId") or attempt["closed"]:
            fail("INVALID_REFERENCE", line, seq)
        attempt["closed"], attempt["failed"] = True, True
        if state["operation"].get("step", {}).get("attemptId") == attempt_id:
            state["operation"]["step"]["status"] = "failed"
    elif kind == "toolStarted":
        exact(
            record,
            ["type", "operationId", "stepId", "assistantEntryId", "toolIndex", "toolCallId", "toolName", "arguments", "replay", "replayKey", "environmentIdentity", "resultEntryId"],
            "INVALID_FACT",
            line,
            seq,
        )
        operation_id, found = get_operation(state, record.get("operationId"), line, seq)
        operation = state["operation"]
        if found["kind"] != "run" or operation["kind"] != "run" or operation["operationId"] != operation_id:
            fail("INVALID_TRANSITION", line, seq)
        assistant_id = uuid(record.get("assistantEntryId"), "INVALID_FACT", line, seq)
        assistant_info = state["entries"].get(assistant_id)
        assistant = assistant_info.get("entry") if assistant_info else None
        if not assistant or assistant.get("type") != "message" or assistant.get("stopReason") != "toolUse" or assistant_info.get("operationId") != operation_id:
            fail("INVALID_REFERENCE", line, seq)
        message = parse_message(assistant.get("message"), line, seq)
        index = safe_int(record.get("toolIndex"), "INVALID_FACT", line, seq)
        calls = message.get("tool_calls", [])
        call = calls[index] if index < len(calls) else None
        call_id = text(record.get("toolCallId"), "INVALID_FACT", line, seq)
        tool_name = text(record.get("toolName"), "INVALID_FACT", line, seq)
        if not call or call["id"] != call_id or call["function"]["name"] != tool_name or assistant.get("stepId") != record.get("stepId"):
            fail("INVALID_REFERENCE", line, seq)
        pair = f"{assistant_id}:{index}"
        if pair in state["toolPairs"]:
            fail("INVALID_TRANSITION", line, seq)
        arguments = obj(record.get("arguments"), "INVALID_FACT", line, seq)
        replay = record.get("replay")
        if replay not in ("safe", "never"):
            fail("INVALID_FACT", line, seq)
        attempt = state["attempts"].get(assistant_info.get("attemptId"))
        declaration = next((tool for tool in attempt["configurationSnapshot"]["tools"] if tool["name"] == tool_name), None) if attempt else None
        replay_key = text(record.get("replayKey"), "INVALID_FACT", line, seq)
        if not declaration:
            fail("INVALID_TRANSITION", line, seq)
        result_id = reserve(state, record.get("resultEntryId"), line, seq, "toolResult")
        tool = {
            "operationId": operation_id,
            "toolStartedId": fact["id"],
            "stepId": uuid(record.get("stepId"), "INVALID_FACT", line, seq),
            "assistantEntryId": assistant_id,
            "toolIndex": index,
            "toolCallId": call_id,
            "toolName": tool_name,
            "arguments": arguments,
            "replay": replay,
            "replayKey": replay_key,
            "environmentIdentity": text(record.get("environmentIdentity"), "INVALID_FACT", line, seq),
            "resultEntryId": result_id,
            "status": "pending",
        }
        state["tools"][fact["id"]] = tool
        state["toolPairs"].add(pair)
        operation["toolCalls"].append(tool)
    elif kind == "abortRequested":
        exact(record, ["type", "operationId", "operationKind", "phase", "toolCallId", "reason"], "INVALID_FACT", line, seq)
        operation_id, found = get_operation(state, record.get("operationId"), line, seq)
        if record.get("operationKind") != found["kind"] or record.get("reason") != "escape":
            fail("INVALID_TRANSITION", line, seq)
        if record.get("phase") not in ("model", "tool", "compact"):
            fail("INVALID_FACT", line, seq)
        if (record.get("phase") == "tool") != isinstance(record.get("toolCallId"), str):
            fail("INVALID_FACT", line, seq)
        if state["operation"]["kind"] == "idle" or state["operation"]["operationId"] != operation_id or state["operation"]["abortRequested"]:
            fail("INVALID_TRANSITION", line, seq)
        state["operation"]["abortRequested"] = True
    elif kind == "operationFinished":
        finish_operation(state, record, line, seq)
    else:
        fail("INVALID_FACT", line, seq)
    state["records"][fact["id"]] = record


def finish_operation(state: dict[str, Any], record: dict[str, Any], line: int, seq: int):
    exact(record, ["type", "operationId", "operationKind", "outcome", "completion", "finalEntryId", "error"], "INVALID_FACT", line, seq)
    operation_id, found = get_operation(state, record.get("operationId"), line, seq)
    outcome = record.get("outcome")
    if record.get("operationKind") != found["kind"] or outcome not in ("completed", "aborted", "failed"):
        fail("INVALID_TRANSITION", line, seq)
    operation = state["operation"]
    if operation["kind"] == "idle" or operation["operationId"] != operation_id:
        fail("INVALID_TRANSITION", line, seq)
    if outcome == "completed":
        if found["kind"] == "run" and record.get("completion") not in ("normal", "truncated"):
            fail("INVALID_FACT", line, seq)
        if found["kind"] == "compaction" and "completion" in record:
            fail("INVALID_FACT", line, seq)
        final_id = uuid(record.get("finalEntryId"), "INVALID_FACT", line, seq)
        info = state["entries"].get(final_id)
        if found["kind"] == "run":
            if (
                not info
                or info.get("operationId") != operation_id
                or info["entry"].get("type") != "message"
                or (record.get("completion") == "normal" and info["entry"].get("stopReason") != "stop")
                or (record.get("completion") == "truncated" and info["entry"].get("stopReason") != "length")
            ):
                fail("INVALID_REFERENCE", line, seq)
            attempt = state["attempts"].get(info.get("attemptId"))
            if not attempt or not attempt["closed"] or attempt["failed"] or attempt["stepId"] != found.get("latestStepId") or attempt.get("settledEntryId") != final_id:
                fail("INVALID_REFERENCE", line, seq)
            message = parse_message(info["entry"].get("message"), line, seq)
            if (
                message["role"] != "assistant"
                or (record.get("completion") == "normal" and not (message.get("content") or "").strip())
                or (record.get("completion") == "truncated" and not message.get("tool_calls"))
                or any(tool["status"] == "pending" for tool in operation["toolCalls"])
            ):
                fail("INVALID_TRANSCRIPT", line, seq)
        else:
            if not info or info.get("operationId") != operation_id or info["entry"].get("type") != "compaction" or found.get("resultEntryId") != final_id:
                fail("INVALID_REFERENCE", line, seq)
            attempt = state["attempts"].get(info.get("attemptId"))
            if not attempt or attempt["stepId"] != found.get("latestStepId") or attempt.get("settledEntryId") != final_id:
                fail("INVALID_REFERENCE", line, seq)
    elif "finalEntryId" in record:
        fail("INVALID_FACT", line, seq)
    if outcome == "aborted":
        pending_tools = operation["kind"] == "run" and any(tool["status"] == "pending" for tool in operation["toolCalls"])
        open_attempt = operation.get("step", {}).get("status") == "attempting"
        if not operation["abortRequested"] or pending_tools or open_attempt:
            fail("INVALID_TRANSITION", line, seq)
    if outcome != "completed" and "completion" in record:
        fail("INVALID_FACT", line, seq)
    if outcome == "failed":
        error = obj(record.get("error"), "INVALID_FACT", line, seq)
        exact(error, ["code", "message"], "INVALID_FACT", line, seq)
        text(error.get("code"), "INVALID_FACT", line, seq)
        text(error.get("message"), "INVALID_FACT", line, seq)
    elif "error" in record:
        fail("INVALID_FACT", line, seq)
    found["finished"] = True
    state["operation"] = {"kind": "idle"}


def apply_usage(state: dict[str, Any], fact: dict[str, Any], line: int):
    seq = fact["seq"]
    exact(fact, ["kind", "seq", "id", "timestamp", "operationId", "attemptId", "toolStartedId", "usage"], "INVALID_FACT", line, seq)
    operation_id = uuid(fact.get("operationId"), "INVALID_FACT", line, seq)
    if operation_id not in state["operations"]:
        fail("INVALID_REFERENCE", line, seq)
    has_attempt, has_tool = "attemptId" in fact, "toolStartedId" in fact
    if has_attempt == has_tool:
        fail("INVALID_FACT", line, seq)
    if has_attempt:
        attempt = state["attempts"].get(uuid(fact["attemptId"], "INVALID_FACT", line, seq))
        if not attempt or attempt["operationId"] != operation_id:
            fail("INVALID_REFERENCE", line, seq)
    else:
        tool = state["tools"].get(uuid(fact["toolStartedId"], "INVALID_FACT", line, seq))
        if not tool or tool["operationId"] != operation_id:
            fail("INVALID_REFERENCE", line, seq)
    usage = obj(fact.get("usage"), "INVALID_FACT", line, seq)
    exact(usage, ["input", "output", "cacheRead", "cacheWrite"], "INVALID_FACT", line, seq)
    for key in ("input", "output", "cacheRead", "cacheWrite"):
        amount = safe_int(usage.get(key), "INVALID_FACT", line, seq)
        state["usage"][key] = add_usage(state["usage"][key], amount, line, seq)


def apply_fact(state: dict[str, Any], value: Any, line: int):
    fact = obj(value, "INVALID_FACT", line)
    seq = safe_int(fact.get("seq"), "INVALID_FACT", line, minimum=1)
    if seq != state["nextSeq"]:
        fail("SEQ_MISMATCH", line, seq)
    fact_id = uuid(fact.get("id"), "INVALID_FACT", line, seq)
    safe_int(fact.get("timestamp"), "INVALID_FACT", line, seq)
    if fact_id in state["ids"]:
        fail("DUPLICATE_ID", line, seq)
    kind = fact.get("kind")
    if kind == "entry":
        apply_entry(state, fact, line)
    elif kind == "record":
        apply_record(state, fact, line)
    elif kind == "usage":
        apply_usage(state, fact, line)
    else:
        fail("INVALID_FACT", line, seq)
    if fact_id in state["reserved"]:
        fail("DUPLICATE_ID", line, seq)
    state["ids"].add(fact_id)
    state["nextSeq"] += 1


def validate_header(value: Any, line: int) -> dict[str, Any]:
    header = obj(value, "INVALID_HEADER", line)
    exact(header, ["kind", "version", "id", "createdAt", "cwd", "provider", "model", "environmentIdentity"], "INVALID_HEADER", line)
    if header.get("kind") != "header":
        fail("INVALID_HEADER", line)
    if header.get("version") != 2:
        fail("UNSUPPORTED_VERSION", line)
    return {
        "id": uuid(header.get("id"), "INVALID_HEADER", line),
        "createdAt": safe_int(header.get("createdAt"), "INVALID_HEADER", line),
        "cwd": text(header.get("cwd"), "INVALID_HEADER", line),
        "provider": text(header.get("provider"), "INVALID_HEADER", line),
        "model": text(header.get("model"), "INVALID_HEADER", line),
        "environmentIdentity": text(header.get("environmentIdentity"), "INVALID_HEADER", line),
    }


def reduce_session(data: bytes) -> dict[str, Any]:
    last_lf = data.rfind(b"\n")
    if last_lf < 0:
        fail("MISSING_HEADER", 1)
    committed = data[: last_lf + 1]
    raw_line = 1
    for index in range(len(committed) - 2):
        if committed[index] == 0x0A:
            raw_line += 1
        if committed[index] == 0xED and 0xA0 <= committed[index + 1] <= 0xBF and committed[index + 2] & 0xC0 == 0x80:
            fail("MALFORMED_JSON", raw_line)
    try:
        source = committed.decode("utf-8", "strict")
    except UnicodeDecodeError:
        fail("INVALID_UTF8", 1)
    lines = source[:-1].split("\n")
    if not lines or not lines[0]:
        fail("MISSING_HEADER", 1)

    def parse(raw: str, line: int):
        if not raw:
            fail("BLANK_LINE", line)
        if raw.endswith("\r"):
            fail("CRLF_NOT_ALLOWED", line)
        try:
            value = json.loads(
                raw,
                parse_constant=lambda _: (_ for _ in ()).throw(ValueError()),
                object_pairs_hook=reject_duplicate_keys,
            )
            if has_lone_surrogate(value):
                raise ValueError("lone surrogate")
            return value
        except json.JSONDecodeError, ValueError:
            fail("MALFORMED_JSON", line)

    header = validate_header(parse(lines[0], 1), 1)
    state = {
        "header": header,
        "transcript": [],
        "activeContext": [],
        "activeContextThroughEntryId": None,
        "usage": {"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0},
        "operation": {"kind": "idle"},
        "repairedLength": last_lf + 1,
        "nextSeq": 1,
        "ids": set(),
        "reserved": {},
        "entries": {},
        "records": {},
        "operations": {},
        "attempts": {},
        "steps": {},
        "tools": {},
        "toolPairs": set(),
    }
    for index, raw in enumerate(lines[1:], 2):
        value = parse(raw, index)
        transaction = value if isinstance(value, list) else [value]
        if not transaction:
            fail("EMPTY_TRANSACTION", index)
        candidate = copy.deepcopy(state)
        for fact in transaction:
            apply_fact(candidate, fact, index)
        validate_transcript(candidate["transcript"], index, candidate["nextSeq"] - 1)
        state = candidate
    return {key: state[key] for key in ("header", "transcript", "activeContext", "usage", "operation", "repairedLength")}
