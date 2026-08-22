use serde::Deserialize;
use serde_json::{Value, json};

use crate::session_reducer::{OperationState, SessionState, ToolCallState};

pub const SYNTHETIC_INVALID_ARGUMENTS: &str =
    "Error: Tool arguments were invalid; the tool was not executed.";
pub const SYNTHETIC_UNKNOWN_TOOL: &str = "Error: Unknown tool; the tool was not executed.";
pub const SYNTHETIC_TRUNCATED: &str = "Error: Tool call arguments were truncated by the model token limit; the tool was not executed.";
pub const SYNTHETIC_ABORTED: &str = "Operation aborted before execution.";
pub const SYNTHETIC_INTERRUPTED: &str =
    "Operation interrupted after execution status became unknown; the tool was not replayed.";

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CurrentTool {
    pub name: String,
    pub definition_digest: String,
    pub replay: String,
    pub replay_key: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CurrentConfiguration {
    pub configuration_digest: String,
    pub environment_identity: String,
    pub tools: Vec<CurrentTool>,
}

fn declaration<'a>(current: &'a CurrentConfiguration, name: &str) -> Option<&'a CurrentTool> {
    current.tools.iter().find(|tool| tool.name == name)
}

fn assistant(state: &SessionState) -> Option<(String, Vec<Value>)> {
    let step = match &state.operation {
        OperationState::Run {
            step: Some(step), ..
        } => step,
        _ => return None,
    };
    let entry_id = step.settled_entry_id.clone()?;
    let message = state.transcript.iter().rev().find(|message| {
        message.get("role").and_then(Value::as_str) == Some("assistant")
            && message
                .get("tool_calls")
                .and_then(Value::as_array)
                .is_some_and(|calls| !calls.is_empty())
    })?;
    Some((entry_id, message.get("tool_calls")?.as_array()?.clone()))
}

fn call(call: &Value) -> (&str, &str, &str) {
    (
        call.get("id").and_then(Value::as_str).unwrap_or_default(),
        call.pointer("/function/name")
            .and_then(Value::as_str)
            .unwrap_or_default(),
        call.pointer("/function/arguments")
            .and_then(Value::as_str)
            .unwrap_or_default(),
    )
}

fn synthetic(assistant_id: &str, index: usize, tool_call: &Value, reason: &str) -> Value {
    let (call_id, tool_name, _) = call(tool_call);
    json!({
        "assistantEntryId": assistant_id,
        "toolIndex": index,
        "toolCallId": call_id,
        "toolName": tool_name,
        "reason": reason,
        "content": synthetic_content(reason),
    })
}

fn interrupted(tool: &ToolCallState) -> Value {
    json!({
        "assistantEntryId": tool.assistant_entry_id,
        "toolIndex": tool.tool_index,
        "toolCallId": tool.tool_call_id,
        "toolName": tool.tool_name,
        "toolStartedId": tool.tool_started_id,
        "resultEntryId": tool.result_entry_id,
        "reason": "interrupted",
        "content": SYNTHETIC_INTERRUPTED,
    })
}

fn synthetic_content(reason: &str) -> &'static str {
    match reason {
        "invalidArguments" => SYNTHETIC_INVALID_ARGUMENTS,
        "unknownTool" => SYNTHETIC_UNKNOWN_TOOL,
        "truncated" => SYNTHETIC_TRUNCATED,
        "aborted" => SYNTHETIC_ABORTED,
        _ => SYNTHETIC_INTERRUPTED,
    }
}

pub fn plan_recovery(state: &SessionState, current: &CurrentConfiguration) -> Value {
    let operation = &state.operation;
    if matches!(operation, OperationState::Idle) {
        return json!({"type":"finish","outcome":"completed","completion":"normal"});
    }
    let assistant = assistant(state);
    let pending = match operation {
        OperationState::Run { tool_calls, .. } => tool_calls
            .iter()
            .filter(|tool| tool.status == "pending")
            .collect::<Vec<_>>(),
        _ => Vec::new(),
    };
    let (kind, step, abort_requested, context_id) = match operation {
        OperationState::Run {
            input_entry_id,
            step,
            abort_requested,
            ..
        } => ("run", step.as_ref(), *abort_requested, input_entry_id),
        OperationState::Compaction {
            input_through_entry_id,
            step,
            abort_requested,
            ..
        } => (
            "compaction",
            step.as_ref(),
            *abort_requested,
            input_through_entry_id,
        ),
        OperationState::Idle => unreachable!(),
    };
    if abort_requested {
        if step.is_some_and(|step| step.status == "attempting") {
            return json!({"type":"closeAttempt","error":{"code":"aborted","message":"Operation aborted"}});
        }
        if let (OperationState::Run { tool_calls, .. }, Some((assistant_id, calls))) =
            (operation, &assistant)
        {
            let mut results = Vec::new();
            for (index, call) in calls.iter().enumerate() {
                match tool_calls.iter().find(|tool| {
                    tool.assistant_entry_id == *assistant_id && tool.tool_index == index as u64
                }) {
                    Some(tool) if tool.status == "pending" => results.push(interrupted(tool)),
                    Some(_) => {}
                    None => results.push(synthetic(assistant_id, index, call, "aborted")),
                }
            }
            if !results.is_empty() {
                return json!({"type":"appendSynthetic","results":results});
            }
        }
        return json!({"type":"finish","outcome":"aborted"});
    }
    let Some(step) = step else {
        return json!({
            "type":"startStep",
            "stepKind": if kind == "run" { "assistant" } else { "compaction" },
            "attempt":1,
            "contextThroughEntryId":context_id,
        });
    };
    if step.status == "failed" {
        return json!({"type":"finish","outcome":"failed","error":{"code":"model_error","message":"provider request failed"}});
    }
    if step.status == "attempting" {
        if step.attempt == 2 {
            return json!({"type":"blocked","reason":"attempts_exhausted"});
        }
        if step.configuration_digest != current.configuration_digest {
            return json!({"type":"blocked","reason":"configuration_changed"});
        }
        return json!({
            "type":"startStep","stepKind":step.step_kind,"attempt":2,
            "stepId":step.step_id,"contextThroughEntryId":step.context_through_entry_id,
        });
    }
    if let OperationState::Compaction {
        result_entry_id, ..
    } = operation
    {
        return json!({"type":"finish","outcome":"completed","finalEntryId":result_entry_id});
    }
    if step.stop_reason.as_deref() == Some("length")
        && let Some((assistant_id, calls)) = &assistant
    {
        return json!({
            "type":"appendSynthetic",
            "results":calls.iter().enumerate().map(|(index, call)| synthetic(assistant_id, index, call, "truncated")).collect::<Vec<_>>()
        });
    }
    let Some((assistant_id, calls)) = &assistant else {
        return json!({"type":"finish","outcome":"completed","completion":"normal","finalEntryId":step.settled_entry_id});
    };
    let tools = match operation {
        OperationState::Run { tool_calls, .. } => tool_calls,
        _ => unreachable!(),
    };
    for (index, raw) in calls.iter().enumerate() {
        if tools
            .iter()
            .any(|tool| tool.assistant_entry_id == *assistant_id && tool.tool_index == index as u64)
        {
            continue;
        }
        let (_, name, arguments) = call(raw);
        if declaration(current, name).is_none() {
            return json!({"type":"appendSynthetic","results":[synthetic(assistant_id, index, raw, "unknownTool")]});
        }
        let Ok(Value::Object(arguments)) = serde_json::from_str::<Value>(arguments) else {
            return json!({"type":"appendSynthetic","results":[synthetic(assistant_id, index, raw, "invalidArguments")]});
        };
        return json!({
            "type":"startTool","mode":"start","assistantEntryId":assistant_id,
            "toolIndex":index,"toolName":name,"arguments":arguments,
        });
    }
    if pending.is_empty() {
        return json!({
            "type":"startStep","stepKind":"assistant","attempt":1,
            "contextThroughEntryId":tools.last().unwrap().result_entry_id,
        });
    }
    let tool = *pending.iter().min_by_key(|tool| tool.tool_index).unwrap();
    if tool.environment_identity != current.environment_identity {
        return json!({"type":"blocked","reason":"environment_changed"});
    }
    let Some(current_tool) = declaration(current, &tool.tool_name) else {
        return json!({"type":"blocked","reason":"configuration_changed"});
    };
    if current_tool.definition_digest.is_empty() {
        return json!({"type":"blocked","reason":"configuration_changed"});
    }
    if tool.replay == "safe"
        && current_tool.replay == "safe"
        && current_tool.replay_key == tool.replay_key
    {
        return json!({
            "type":"startTool","mode":"replay","assistantEntryId":tool.assistant_entry_id,
            "toolIndex":tool.tool_index,"toolStartedId":tool.tool_started_id,
            "toolName":tool.tool_name,"arguments":tool.arguments,
        });
    }
    if tool.replay == "safe" {
        return json!({"type":"blocked","reason":"replay_declaration_changed"});
    }
    json!({"type":"appendSynthetic","results":[interrupted(tool)]})
}
