import hashlib
import json
from .session_reducer import configuration_digest


def entry_fact(fact_id: str, entry: dict) -> dict:
    return {"kind": "entry", "id": fact_id, "entry": entry}


def record_fact(record: dict, fact_id: str | None = None) -> dict:
    fact = {"kind": "record", "record": record}
    if fact_id:
        fact["id"] = fact_id
    return fact


def usage_fact(operation_id: str, attempt_id: str, usage: dict) -> dict:
    return {"kind": "usage", "operationId": operation_id, "attemptId": attempt_id, "usage": usage}


def step_failed_record(operation_id: str, step_id: str, attempt_id: str, code: str, message: str) -> dict:
    return {
        "type": "stepFailed",
        "operationId": operation_id,
        "stepId": step_id,
        "attemptId": attempt_id,
        "error": {"code": code, "message": message},
    }


def runtime_configuration(prompt: str, tools: list[dict], model: str) -> tuple[dict, str]:
    digest = lambda value: "sha256:" + hashlib.sha256(value.encode()).hexdigest()
    declarations = []
    for tool in tools:
        function = tool["function"]
        definition = json.dumps({key: function[key] for key in ("name", "description", "parameters")}, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
        declarations.append({"name": function["name"], "definitionDigest": digest(definition)})
    snapshot = {
        "model": model,
        "systemPromptDigest": digest(prompt),
        "tools": declarations,
        "adapterIdentity": "openrouter:chat-completions:v1",
        "routingIdentity": f"openrouter:{model}",
        "outputOptionsDigest": digest("{}"),
    }
    return snapshot, configuration_digest(snapshot)


def replay_declaration(tool: dict | None, read_tool: dict, name: str) -> tuple[str, str]:
    if tool is read_tool:
        return "safe", "builtin:read:v1"
    return "never", f"tool:{name}:v1"


def current_configuration(snapshot: dict, configuration_digest_value: str, tools: list[dict], read_tool: dict, environment_identity: str) -> dict:
    declarations = []
    for configured in snapshot["tools"]:
        tool = next((item for item in tools if item["function"]["name"] == configured["name"]), None)
        replay, replay_key = replay_declaration(tool, read_tool, configured["name"])
        declarations.append({**configured, "replay": replay, "replayKey": replay_key})
    return {"configurationDigest": configuration_digest_value, "environmentIdentity": environment_identity, "tools": declarations}


def project_session(state: dict, system_message: dict) -> tuple[list[dict], dict]:
    return [system_message, *state["activeContext"]], {**state["usage"]}
