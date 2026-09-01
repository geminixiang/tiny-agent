from datetime import datetime, timezone
from typing import Callable, Protocol


class LifecycleSink(Protocol):
    def emit(self, event: dict) -> None: ...
    def close(self) -> None: ...


class CallbackSink:
    def __init__(self, emit: Callable[[dict], None]): self._emit = emit
    def emit(self, event: dict) -> None: self._emit(event)
    def close(self) -> None: pass


class ExecutionLifecycle:
    def __init__(self, sinks: list[LifecycleSink] | None = None):
        self.sinks = sinks or []
        self.session_id: str | None = None
        self.operations: dict[str, dict] = {}
        self.models: dict[str, dict] = {}
        self.tools: dict[str, dict] = {}
        self.usage: dict[str, dict] = {}
        self.operation_usage: dict[str, dict] = {}
        self.answers: dict[str, tuple[str, str]] = {}

    def observe(self, event: dict) -> None:
        try: self._observe(event)
        except Exception: pass

    def committed(self, facts: list[dict]) -> None:
        try: self._committed(facts)
        except Exception: pass

    def close(self) -> None:
        now = _timestamp()
        for attempt_id in list(self.models): self._complete_model(attempt_id, now, "effect_unknown")
        for started_id, attempt in list(self.tools.items()):
            self._publish(self._tool_completed(started_id, attempt, now, "effect_unknown"))
            self.tools.pop(started_id, None)
        for sink in self.sinks:
            try: sink.close()
            except Exception: pass

    def _observe(self, event: dict) -> None:
        kind = event.get("type")
        if kind == "session.attached":
            self.session_id = event.get("sessionId")
        elif kind == "recovery.attached":
            if not self.session_id: return
            operation_id = event.get("operationId")
            operation_kind = event.get("operationKind")
            if not isinstance(operation_id, str) or operation_kind not in ("run", "compaction"): return
            self.operations[operation_id] = {"kind": operation_kind, "startedAt": _time(event.get("timestamp")), "recovery": True}
            self.operation_usage[operation_id] = _empty_usage()
            self._publish({**event, "type": "operation.recovered", "sessionId": self.session_id, "recovery": True})
            return
        elif kind == "tool.started":
            if not self.session_id or not isinstance(event.get("toolStartedId"), str): return
            self.tools[event["toolStartedId"]] = {**event, "startedAt": _time(event.get("timestamp"))}
            self._publish({**event, "sessionId": self.session_id})
            return
        self._publish(event)

    def _committed(self, facts: list[dict]) -> None:
        transaction_usage = {}
        for fact in facts:
            usage = _usage(fact.get("usage")) if fact.get("kind") == "usage" else None
            attempt_id = fact.get("attemptId")
            if usage is None or not isinstance(attempt_id, str): continue
            transaction_usage[attempt_id] = usage
            self.usage[attempt_id] = usage
            operation_id = fact.get("operationId")
            if isinstance(operation_id, str): self._add_operation_usage(operation_id, usage)
        for fact in facts: self._fact(fact, transaction_usage)

    def _fact(self, fact: dict, transaction_usage: dict[str, dict]) -> None:
        timestamp = _fact_timestamp(fact)
        if fact.get("kind") == "record" and isinstance(fact.get("record"), dict):
            self._record(fact, fact["record"], timestamp)
            return
        entry = fact.get("entry")
        if fact.get("kind") != "entry" or not isinstance(entry, dict): return
        if entry.get("type") == "message":
            message = entry.get("message", {})
            if message.get("role") == "assistant" and isinstance(entry.get("attemptId"), str):
                attempt_id = entry["attemptId"]
                attempt = self.models.get(attempt_id)
                if attempt and isinstance(fact.get("id"), str) and isinstance(message.get("content"), str):
                    self.answers[fact["id"]] = (attempt["operationId"], message["content"])
                self._complete_model(attempt_id, timestamp, "succeeded", transaction_usage.get(attempt_id))
            elif message.get("role") == "tool" and isinstance(entry.get("toolStartedId"), str):
                self._complete_tool(entry["toolStartedId"], entry, timestamp)
            return
        if entry.get("type") != "compaction" or not isinstance(entry.get("operationId"), str): return
        attempt_id = next((key for key, value in self.models.items() if value["operationId"] == entry["operationId"] and value["kind"] == "compaction"), None)
        if attempt_id: self._complete_model(attempt_id, timestamp, "succeeded", self.usage.get(attempt_id))

    def _record(self, fact: dict, record: dict, timestamp: str) -> None:
        if not self.session_id: return
        kind = record.get("type")
        if kind in ("runStarted", "compactionStarted"):
            operation_id = record.get("operationId")
            if not isinstance(operation_id, str): return
            operation_kind = "run" if kind == "runStarted" else "compaction"
            self.operations[operation_id] = {"kind": operation_kind, "startedAt": _time(timestamp), "recovery": False}
            self.operation_usage[operation_id] = _empty_usage()
            self._publish({"type": "operation.started", "timestamp": timestamp, "sessionId": self.session_id, "operationId": operation_id, "operationKind": operation_kind, "recovery": False})
            return
        if kind == "stepAttempt":
            operation_id, step_id, attempt_id, attempt = (record.get(key) for key in ("operationId", "stepId", "attemptId", "attempt"))
            if not all(isinstance(value, str) for value in (operation_id, step_id, attempt_id)) or not isinstance(attempt, int): return
            operation_kind = "compaction" if record.get("stepKind") == "compaction" else "run"
            recovery = self.operations.get(operation_id, {}).get("recovery", False)
            self.models[attempt_id] = {"operationId": operation_id, "kind": operation_kind, "stepId": step_id, "startedAt": _time(timestamp), "recovery": recovery}
            self._publish({"type": "model.started", "timestamp": timestamp, "sessionId": self.session_id, "operationId": operation_id, "operationKind": operation_kind, "stepId": step_id, "attemptId": attempt_id, "attempt": attempt, "recovery": recovery})
            return
        if kind == "stepFailed":
            operation_id, step_id, attempt_id = (record.get(key) for key in ("operationId", "stepId", "attemptId"))
            if not all(isinstance(value, str) for value in (operation_id, step_id, attempt_id)): return
            error_type = record.get("error", {}).get("code")
            outcome = "cancelled" if error_type == "aborted" else "failed"
            operation = self.operations.get(operation_id)
            if attempt_id not in self.models and operation and operation["recovery"]:
                event = {"type": "model.reconciled", "timestamp": timestamp, "sessionId": self.session_id, "operationId": operation_id, "operationKind": operation["kind"], "stepId": step_id, "attemptId": attempt_id, "recovery": True, "outcome": outcome}
                if isinstance(error_type, str): event["errorType"] = error_type
                self._publish(event)
                return
            self._complete_model(attempt_id, timestamp, outcome, self.usage.get(attempt_id), error_type)
            return
        if kind == "toolStarted":
            values = [fact.get("id"), record.get("operationId"), record.get("stepId"), record.get("toolCallId"), record.get("toolName")]
            if not all(isinstance(value, str) for value in values) or record.get("replay") not in ("safe", "never"): return
            started_id, operation_id, step_id, call_id, tool = values
            self._publish({"type": "tool.admitted", "timestamp": timestamp, "sessionId": self.session_id, "operationId": operation_id, "stepId": step_id, "toolStartedId": started_id, "toolCallId": call_id, "tool": tool, "replay": record["replay"], "recovery": self.operations.get(operation_id, {}).get("recovery", False)})
            return
        if kind == "abortRequested":
            operation_id = record.get("operationId")
            if not isinstance(operation_id, str): return
            event = {"type": "cancel.requested", "timestamp": timestamp, "sessionId": self.session_id, "operationId": operation_id, "operationKind": record.get("operationKind"), "phase": record.get("phase"), "recovery": self.operations.get(operation_id, {}).get("recovery", False)}
            if isinstance(record.get("toolCallId"), str): event["toolCallId"] = record["toolCallId"]
            self._publish(event)
            return
        if kind != "operationFinished" or not isinstance(record.get("operationId"), str): return
        operation_id = record["operationId"]
        operation = self.operations.get(operation_id)
        if not operation: return
        outcome = "succeeded" if record.get("outcome") == "completed" else "cancelled" if record.get("outcome") == "aborted" else "failed"
        event = {"type": "operation.completed", "timestamp": timestamp, "sessionId": self.session_id, "operationId": operation_id, "operationKind": operation["kind"], "recovery": operation["recovery"], "durationMs": _duration(operation["startedAt"], timestamp), "outcome": outcome}
        if record.get("completion") in ("normal", "truncated"): event["completion"] = record["completion"]
        answer = self.answers.get(record.get("finalEntryId"))
        if answer: event["answer"] = answer[1]
        if operation_id in self.operation_usage: event["usage"] = self.operation_usage[operation_id]
        error = record.get("error", {})
        if isinstance(error.get("code"), str): event["errorType"] = error["code"]
        if isinstance(error.get("message"), str): event["errorMessage"] = error["message"]
        self._publish(event)
        self.operations.pop(operation_id, None); self.operation_usage.pop(operation_id, None)
        self.answers = {key: value for key, value in self.answers.items() if value[0] != operation_id}

    def _complete_model(self, attempt_id: str, timestamp: str, outcome: str, usage: dict | None = None, error_type: str | None = None) -> None:
        attempt = self.models.pop(attempt_id, None)
        if not self.session_id or not attempt: return
        event = {"type": "model.completed", "timestamp": timestamp, "sessionId": self.session_id, "operationId": attempt["operationId"], "operationKind": attempt["kind"], "stepId": attempt["stepId"], "attemptId": attempt_id, "recovery": attempt["recovery"], "durationMs": _duration(attempt["startedAt"], timestamp), "outcome": outcome}
        if usage: event["usage"] = _with_cache_rate(usage)
        if isinstance(error_type, str): event["errorType"] = error_type
        self.usage.pop(attempt_id, None); self._publish(event)

    def _complete_tool(self, started_id: str, entry: dict, timestamp: str) -> None:
        attempt = self.tools.pop(started_id, None)
        if not attempt: return
        result = entry.get("result", {})
        outcome = "succeeded" if result.get("type") == "success" else "cancelled" if result.get("reason") == "interrupted" else "failed"
        self._publish(self._tool_completed(started_id, attempt, timestamp, outcome))

    def _tool_completed(self, started_id: str, attempt: dict, timestamp: str, outcome: str) -> dict:
        return {"type": "tool.completed", "timestamp": timestamp, "sessionId": self.session_id, "operationId": attempt["operationId"], "stepId": attempt["stepId"], "attemptId": attempt["attemptId"], "parentAttemptId": attempt["parentAttemptId"], "toolStartedId": started_id, "toolCallId": attempt["toolCallId"], "tool": attempt["tool"], "recovery": attempt["recovery"], "durationMs": _duration(attempt["startedAt"], timestamp), "outcome": outcome}

    def _add_operation_usage(self, operation_id: str, usage: dict) -> None:
        current = self.operation_usage.setdefault(operation_id, _empty_usage())
        for key in _empty_usage(): current[key] += usage[key]
        current["cacheHitRate"] = _with_cache_rate(usage)["cacheHitRate"]

    def _publish(self, event: dict) -> None:
        for sink in self.sinks:
            try: sink.emit(event)
            except Exception: pass


def _empty_usage() -> dict: return {"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0}
def _usage(value: object) -> dict | None:
    if not isinstance(value, dict) or any(not isinstance(value.get(key), (int, float)) for key in _empty_usage()): return None
    return {key: value[key] for key in _empty_usage()}
def _with_cache_rate(usage: dict) -> dict:
    prompt = usage["input"] + usage["cacheRead"] + usage["cacheWrite"]
    return {**usage, "cacheHitRate": usage["cacheRead"] / prompt * 100 if prompt else 0}
def _timestamp() -> str: return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
def _fact_timestamp(fact: dict) -> str: return datetime.fromtimestamp(fact.get("timestamp", 0) / 1000, timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
def _time(value: object) -> float:
    if not isinstance(value, str): return datetime.now(timezone.utc).timestamp() * 1000
    try: return datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp() * 1000
    except ValueError: return datetime.now(timezone.utc).timestamp() * 1000
def _duration(started: float, timestamp: str) -> float: return max(0, _time(timestamp) - started)
