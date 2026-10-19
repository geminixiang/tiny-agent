//! Session fact builders: the single place where the agent loop shapes durable
//! entries and records. The reducer validates these shapes; the builders keep
//! the JSON key names out of the agent loop. See docs/session-design.md.

use serde_json::{Map, Value, json};

use crate::session::SessionFact;
use crate::session_runtime::{RuntimeConfiguration, RuntimeTool};
use crate::{Message, UsageJSON};

fn fact(value: Value) -> SessionFact {
    value
        .as_object()
        .expect("session fact must be an object")
        .clone()
}

pub fn user_message(entry_id: &str, content: &str) -> SessionFact {
    fact(json!({
        "kind":"entry", "id":entry_id,
        "entry":{"type":"message","message":{"role":"user","content":content}}
    }))
}

pub fn run_started(record_id: &str, operation_id: &str, input_entry_id: &str) -> SessionFact {
    fact(json!({
        "kind":"record", "id":record_id,
        "record":{"type":"runStarted","operationId":operation_id,"operationKind":"run","inputEntryId":input_entry_id}
    }))
}

pub fn compaction_started(
    record_id: &str,
    operation_id: &str,
    input_through_entry_id: &str,
    result_entry_id: &str,
    compacted_entry_ids: &[String],
    retained_entry_ids: &[String],
    source_digest: &str,
) -> SessionFact {
    fact(json!({
        "kind":"record", "id":record_id,
        "record":{
            "type":"compactionStarted", "operationId":operation_id,
            "operationKind":"compaction", "inputThroughEntryId":input_through_entry_id,
            "resultEntryId":result_entry_id, "compactedEntryIds":compacted_entry_ids,
            "retainedEntryIds":retained_entry_ids, "sourceDigest":source_digest,
        }
    }))
}

pub fn compaction_entry(
    entry_id: &str,
    operation_id: &str,
    summary: &str,
    compacted_through_entry_id: &str,
    retained_tail: &[(String, Value)],
) -> SessionFact {
    let retained_tail = retained_tail
        .iter()
        .map(
            |(source_entry_id, message)| json!({"sourceEntryId":source_entry_id,"message":message}),
        )
        .collect::<Vec<_>>();
    fact(json!({
        "kind":"entry", "id":entry_id,
        "entry":{
            "type":"compaction", "operationId":operation_id, "summary":summary,
            "compactedThroughEntryId":compacted_through_entry_id,
            "retainedTail":retained_tail,
        }
    }))
}

#[allow(clippy::too_many_arguments)]
pub fn step_attempt(
    record_id: &str,
    operation_id: &str,
    step_id: &str,
    attempt_id: &str,
    step_kind: &str,
    attempt: u64,
    context_through_entry_id: &str,
    configuration: &RuntimeConfiguration,
) -> SessionFact {
    fact(json!({
        "kind":"record", "id":record_id,
        "record":{
            "type":"stepAttempt", "operationId":operation_id, "stepId":step_id,
            "attemptId":attempt_id, "stepKind":step_kind, "attempt":attempt,
            "contextThroughEntryId":context_through_entry_id,
            "configurationSnapshot":configuration.snapshot,
            "configurationDigest":configuration.digest,
        }
    }))
}

pub fn assistant_message(
    entry_id: &str,
    step_id: &str,
    attempt_id: &str,
    stop_reason: &str,
    message: &Message,
) -> SessionFact {
    let mut persisted = json!({"role":"assistant","content":message.content});
    if !message.tool_calls.is_empty() {
        persisted["tool_calls"] = serde_json::to_value(&message.tool_calls).unwrap();
    }
    fact(json!({
        "kind":"entry", "id":entry_id,
        "entry":{
            "type":"message", "stepId":step_id, "attemptId":attempt_id,
            "stopReason":stop_reason, "message":persisted,
        }
    }))
}

pub fn step_failed(
    record_id: &str,
    operation_id: &str,
    step_id: &str,
    attempt_id: &str,
    code: &str,
    message: &str,
) -> SessionFact {
    fact(json!({
        "kind":"record", "id":record_id,
        "record":{
            "type":"stepFailed", "operationId":operation_id, "stepId":step_id,
            "attemptId":attempt_id, "error":{"code":code,"message":message},
        }
    }))
}

pub fn usage_fact(
    fact_id: &str,
    operation_id: &str,
    attempt_id: Option<&str>,
    tool_started_id: Option<&str>,
    value: UsageJSON,
) -> SessionFact {
    let mut value = json!({
        "kind":"usage", "id":fact_id, "operationId":operation_id,
        "usage":value,
    });
    if let Some(attempt_id) = attempt_id {
        value["attemptId"] = json!(attempt_id);
    }
    if let Some(tool_started_id) = tool_started_id {
        value["toolStartedId"] = json!(tool_started_id);
    }
    fact(value)
}

#[allow(clippy::too_many_arguments)]
pub fn tool_started(
    record_id: &str,
    operation_id: &str,
    step_id: &str,
    assistant_entry_id: &str,
    tool_index: u64,
    tool_call_id: &str,
    tool_name: &str,
    arguments: Map<String, Value>,
    declaration: &RuntimeTool,
    environment_identity: &str,
    result_entry_id: &str,
) -> SessionFact {
    fact(json!({
        "kind":"record", "id":record_id,
        "record":{
            "type":"toolStarted", "operationId":operation_id, "stepId":step_id,
            "assistantEntryId":assistant_entry_id, "toolIndex":tool_index,
            "toolCallId":tool_call_id, "toolName":tool_name, "arguments":arguments,
            "replay":declaration.replay, "replayKey":declaration.replay_key,
            "environmentIdentity":environment_identity, "resultEntryId":result_entry_id,
        }
    }))
}

pub fn tool_result(
    entry_id: &str,
    step_id: &str,
    tool_started_id: &str,
    tool_call_id: &str,
    tool_name: &str,
    content: &str,
    result_type: &str,
) -> SessionFact {
    let result = if result_type == "synthetic" {
        json!({"type":"synthetic","reason":"interrupted"})
    } else {
        json!({"type":result_type})
    };
    fact(json!({
        "kind":"entry", "id":entry_id,
        "entry":{
            "type":"message", "stepId":step_id, "toolStartedId":tool_started_id,
            "toolName":tool_name, "result":result,
            "message":{"role":"tool","content":content,"tool_call_id":tool_call_id},
        }
    }))
}

#[allow(clippy::too_many_arguments)]
pub fn synthetic_tool_result(
    entry_id: &str,
    step_id: &str,
    assistant_entry_id: &str,
    tool_index: u64,
    tool_call_id: &str,
    tool_name: &str,
    content: &str,
    reason: &str,
) -> SessionFact {
    fact(json!({
        "kind":"entry", "id":entry_id,
        "entry":{
            "type":"message", "stepId":step_id,
            "assistantEntryId":assistant_entry_id, "toolIndex":tool_index,
            "toolName":tool_name, "result":{"type":"synthetic","reason":reason},
            "message":{"role":"tool","content":content,"tool_call_id":tool_call_id},
        }
    }))
}

pub fn abort_requested(
    record_id: &str,
    operation_id: &str,
    operation_kind: &str,
    phase: &str,
    tool_call_id: Option<&str>,
) -> SessionFact {
    let mut value = json!({
        "kind":"record", "id":record_id,
        "record":{
            "type":"abortRequested", "operationId":operation_id,
            "operationKind":operation_kind, "phase":phase, "reason":"escape",
        }
    });
    if let Some(tool_call_id) = tool_call_id {
        value["record"]["toolCallId"] = json!(tool_call_id);
    }
    fact(value)
}

pub fn operation_finished(
    record_id: &str,
    operation_id: &str,
    operation_kind: &str,
    outcome: &str,
    final_entry_id: Option<&str>,
    error: Option<(&str, &str)>,
) -> SessionFact {
    let mut value = json!({
        "kind":"record", "id":record_id,
        "record":{
            "type":"operationFinished", "operationId":operation_id,
            "operationKind":operation_kind, "outcome":outcome,
        }
    });
    if outcome == "completed" && operation_kind == "run" {
        value["record"]["completion"] = json!("normal");
    }
    if let Some(final_entry_id) = final_entry_id {
        value["record"]["finalEntryId"] = json!(final_entry_id);
    }
    if let Some((code, message)) = error {
        value["record"]["error"] = json!({"code":code,"message":message});
    }
    fact(value)
}
