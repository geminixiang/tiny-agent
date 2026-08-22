from __future__ import annotations

import json
from typing import Any

from .session_reducer import SYNTHETIC_CONTENT


def _synthetic(assistant_id, index, call, reason, tool=None):
    value = {
        "assistantEntryId": assistant_id, "toolIndex": index, "toolCallId": call["id"],
        "toolName": call["function"]["name"], "reason": reason, "content": SYNTHETIC_CONTENT[reason],
    }
    if tool:
        value.update(toolStartedId=tool["toolStartedId"], resultEntryId=tool["resultEntryId"])
    return value


def _assistant(state):
    operation = state["operation"]
    settled = operation.get("step", {}).get("settledEntryId")
    if operation["kind"] != "run" or not settled: return None
    message = next((item for item in reversed(state["transcript"]) if item["role"] == "assistant" and item.get("tool_calls")), None)
    return {"assistantEntryId": settled, "calls": message.get("tool_calls", [])} if message else None


def plan_recovery(state: dict, current: dict) -> dict:
    operation = state["operation"]
    if operation["kind"] == "idle": return {"type": "finish", "outcome": "completed", "completion": "normal"}
    assistant = _assistant(state)
    pending = [tool for tool in operation.get("toolCalls", []) if tool["status"] == "pending"]
    if operation.get("abortRequested"):
        if operation.get("step", {}).get("status") == "attempting":
            return {"type": "closeAttempt", "error": {"code": "aborted", "message": "Operation aborted"}}
        if assistant:
            started = {(tool["assistantEntryId"], tool["toolIndex"]): tool for tool in operation.get("toolCalls", [])}
            results = []
            for index, call in enumerate(assistant["calls"]):
                tool = started.get((assistant["assistantEntryId"], index))
                if tool and tool["status"] == "pending": results.append(_synthetic(assistant["assistantEntryId"], index, call, "interrupted", tool))
                elif not tool: results.append(_synthetic(assistant["assistantEntryId"], index, call, "aborted"))
            if results: return {"type": "appendSynthetic", "results": results}
        return {"type": "finish", "outcome": "aborted"}
    if not operation.get("step"):
        return {"type": "startStep", "stepKind": "assistant" if operation["kind"] == "run" else "compaction", "attempt": 1, "contextThroughEntryId": operation.get("inputEntryId", operation.get("inputThroughEntryId"))}
    step = operation["step"]
    if step["status"] == "failed": return {"type": "finish", "outcome": "failed", "error": {"code": "model_error", "message": "provider request failed"}}
    if step["status"] == "attempting":
        if step["attempt"] == 2: return {"type": "blocked", "reason": "attempts_exhausted"}
        if step["configurationDigest"] != current["configurationDigest"]: return {"type": "blocked", "reason": "configuration_changed"}
        return {"type": "startStep", "stepKind": step["stepKind"], "attempt": 2, "stepId": step["stepId"], "contextThroughEntryId": step["contextThroughEntryId"]}
    if operation["kind"] == "compaction": return {"type": "finish", "outcome": "completed", "finalEntryId": operation["resultEntryId"]}
    if step.get("stopReason") == "length" and assistant:
        processed = {(tool["assistantEntryId"], tool["toolIndex"]) for tool in operation.get("toolCalls", [])}
        results = [_synthetic(assistant["assistantEntryId"], i, call, "truncated") for i, call in enumerate(assistant["calls"]) if (assistant["assistantEntryId"], i) not in processed]
        return {"type": "appendSynthetic", "results": results} if results else {"type": "finish", "outcome": "completed", "completion": "truncated", "finalEntryId": assistant["assistantEntryId"]}
    if not assistant: return {"type": "finish", "outcome": "completed", "completion": "normal", "finalEntryId": step["settledEntryId"]}
    processed = {(tool["assistantEntryId"], tool["toolIndex"]) for tool in operation.get("toolCalls", [])}
    for index, call in enumerate(assistant["calls"]):
        if (assistant["assistantEntryId"], index) in processed: continue
        declaration = next((tool for tool in current["tools"] if tool["name"] == call["function"]["name"]), None)
        if not declaration: return {"type": "appendSynthetic", "results": [_synthetic(assistant["assistantEntryId"], index, call, "unknownTool")]}
        try: args = json.loads(call["function"]["arguments"])
        except (json.JSONDecodeError, TypeError): args = None
        if not isinstance(args, dict): return {"type": "appendSynthetic", "results": [_synthetic(assistant["assistantEntryId"], index, call, "invalidArguments")]}
        return {"type": "startTool", "mode": "start", "assistantEntryId": assistant["assistantEntryId"], "toolIndex": index, "toolName": call["function"]["name"], "arguments": args}
    if not pending:
        return {"type": "startStep", "stepKind": "assistant", "attempt": 1, "contextThroughEntryId": operation["toolCalls"][-1]["resultEntryId"]}
    tool = sorted(pending, key=lambda item: item["toolIndex"])[0]
    if tool["environmentIdentity"] != current["environmentIdentity"]: return {"type": "blocked", "reason": "environment_changed"}
    declaration = next((item for item in current["tools"] if item["name"] == tool["toolName"]), None)
    if not declaration or not declaration["definitionDigest"]: return {"type": "blocked", "reason": "configuration_changed"}
    if tool["replay"] == declaration["replay"] == "safe" and tool["replayKey"] == declaration["replayKey"]:
        return {"type": "startTool", "mode": "replay", "assistantEntryId": tool["assistantEntryId"], "toolIndex": tool["toolIndex"], "toolStartedId": tool["toolStartedId"], "toolName": tool["toolName"], "arguments": tool["arguments"]}
    if tool["replay"] == "safe": return {"type": "blocked", "reason": "replay_declaration_changed"}
    call = assistant["calls"][tool["toolIndex"]]
    return {"type": "appendSynthetic", "results": [_synthetic(tool["assistantEntryId"], tool["toolIndex"], call, "interrupted", tool)]}
