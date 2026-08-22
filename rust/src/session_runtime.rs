use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};

use crate::session::SessionFact;
use crate::session_reducer::{
    ConfigurationSnapshot, ConfigurationTool, OperationState, SessionState,
};
use crate::{Message, UsageJSON, UsageState};

const ZERO_DIGEST: &str = "sha256:0000000000000000000000000000000000000000000000000000000000000000";

#[derive(Debug, Clone)]
pub struct RuntimeTool {
    pub name: String,
    pub definition: Value,
    pub replay: String,
    pub replay_key: String,
}

#[derive(Debug, Clone)]
pub struct RuntimeConfiguration {
    pub snapshot: ConfigurationSnapshot,
    pub digest: String,
    pub tools: Vec<RuntimeTool>,
}

#[derive(Debug, Clone)]
pub struct SessionProjection {
    pub messages: Vec<Message>,
    pub usage: UsageState,
}

fn fact(value: Value) -> SessionFact {
    value
        .as_object()
        .expect("session fact must be an object")
        .clone()
}

fn digest(value: &Value) -> String {
    format!("sha256:{:x}", Sha256::digest(canonical(value).as_bytes()))
}

fn canonical(value: &Value) -> String {
    match value {
        Value::Null | Value::Bool(_) | Value::Number(_) => value.to_string(),
        Value::String(value) => serde_json::to_string(value).unwrap(),
        Value::Array(values) => format!(
            "[{}]",
            values.iter().map(canonical).collect::<Vec<_>>().join(",")
        ),
        Value::Object(values) => {
            let mut keys = values.keys().collect::<Vec<_>>();
            keys.sort();
            format!(
                "{{{}}}",
                keys.into_iter()
                    .map(|key| format!(
                        "{}:{}",
                        serde_json::to_string(key).unwrap(),
                        canonical(&values[key])
                    ))
                    .collect::<Vec<_>>()
                    .join(",")
            )
        }
    }
}

pub fn runtime_configuration(
    model: &str,
    system_prompt: &str,
    tools: Vec<RuntimeTool>,
    adapter_identity: &str,
    routing_identity: &str,
) -> RuntimeConfiguration {
    let snapshot = ConfigurationSnapshot {
        model: model.to_string(),
        system_prompt_digest: digest(&Value::String(system_prompt.to_string())),
        tools: tools
            .iter()
            .map(|tool| ConfigurationTool {
                name: tool.name.clone(),
                definition_digest: digest(&tool.definition),
            })
            .collect(),
        adapter_identity: adapter_identity.to_string(),
        routing_identity: routing_identity.to_string(),
        output_options_digest: ZERO_DIGEST.to_string(),
    };
    let value = serde_json::to_value(&snapshot).unwrap();
    RuntimeConfiguration {
        digest: digest(&value),
        snapshot,
        tools,
    }
}

pub fn tool_declaration<'a>(
    configuration: &'a RuntimeConfiguration,
    name: &str,
) -> Option<&'a RuntimeTool> {
    configuration.tools.iter().find(|tool| tool.name == name)
}

pub fn start_run(
    user_entry_id: &str,
    run_record_id: &str,
    operation_id: &str,
    content: &str,
) -> Vec<SessionFact> {
    vec![
        fact(json!({
            "kind":"entry", "id":user_entry_id,
            "entry":{"type":"message","message":{"role":"user","content":content}}
        })),
        fact(json!({
            "kind":"record", "id":run_record_id,
            "record":{"type":"runStarted","operationId":operation_id,"operationKind":"run","inputEntryId":user_entry_id}
        })),
    ]
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

pub fn assistant_entry(
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

pub fn usage(
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
    fact(json!({
        "kind":"entry", "id":entry_id,
        "entry":{
            "type":"message", "stepId":step_id, "toolStartedId":tool_started_id,
            "toolName":tool_name, "result":{"type":result_type},
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

pub fn project_idle(
    state: &SessionState,
    system_prompt: &str,
) -> Result<SessionProjection, String> {
    if !matches!(state.operation, OperationState::Idle) {
        return Err("session operation is not idle".into());
    }
    let mut messages = vec![Message {
        role: "system".into(),
        content: Some(system_prompt.into()),
        tool_call_id: String::new(),
        tool_calls: Vec::new(),
    }];
    for value in &state.active_context {
        messages.push(serde_json::from_value(value.clone()).map_err(|error| error.to_string())?);
    }
    let denominator = state.usage.input + state.usage.cache_read + state.usage.cache_write;
    let usage = UsageState {
        input: state.usage.input,
        output: state.usage.output,
        cache_read: state.usage.cache_read,
        cache_write: state.usage.cache_write,
        cache_hit_rate: if denominator == 0 {
            0.0
        } else {
            state.usage.cache_read as f64 / denominator as f64 * 100.0
        },
    };
    Ok(SessionProjection { messages, usage })
}
