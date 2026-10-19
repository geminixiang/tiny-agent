use serde_json::{Value, json};
use sha2::{Digest, Sha256};

use crate::session::SessionFact;
use crate::session::facts::{run_started, user_message};
use crate::session_reducer::{
    ConfigurationSnapshot, ConfigurationTool, OperationState, SessionState,
};
use crate::{Message, UsageState};

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

pub fn source_digest(source: &[(String, Value)]) -> String {
    let value = Value::Array(
        source
            .iter()
            .map(|(source_entry_id, message)| {
                json!({"sourceEntryId":source_entry_id,"message":message})
            })
            .collect(),
    );
    digest(&value)
}

pub fn start_run(
    user_entry_id: &str,
    run_record_id: &str,
    operation_id: &str,
    content: &str,
) -> Vec<SessionFact> {
    vec![
        user_message(user_entry_id, content),
        run_started(run_record_id, operation_id, user_entry_id),
    ]
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
    let usage = UsageState {
        input: state.usage.input,
        output: state.usage.output,
        cache_read: state.usage.cache_read,
        cache_write: state.usage.cache_write,
        cache_hit_rate: -1.0,
    };
    Ok(SessionProjection { messages, usage })
}
