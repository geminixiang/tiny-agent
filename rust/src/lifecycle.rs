use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use serde_json::{Map, Value, json};

use crate::session::SessionFact;

pub trait LifecycleSink: Send + Sync {
    fn emit(&self, event: Value);
    fn close(&self) {}
}

pub struct CallbackSink(pub Arc<dyn Fn(Value) + Send + Sync>);

impl LifecycleSink for CallbackSink {
    fn emit(&self, event: Value) {
        (self.0)(event);
    }
}

#[derive(Clone)]
struct Operation {
    kind: String,
    started_at: u64,
    recovery: bool,
}

#[derive(Clone)]
struct ModelAttempt {
    operation_id: String,
    operation_kind: String,
    step_id: String,
    started_at: u64,
    recovery: bool,
}

#[derive(Clone)]
struct ToolAttempt {
    operation_id: String,
    step_id: String,
    attempt_id: String,
    parent_attempt_id: String,
    tool_call_id: String,
    tool: String,
    started_at: u64,
    recovery: bool,
}

#[derive(Default)]
struct State {
    session_id: Option<String>,
    operations: HashMap<String, Operation>,
    models: HashMap<String, ModelAttempt>,
    tools: HashMap<String, ToolAttempt>,
    usage: HashMap<String, Value>,
    operation_usage: HashMap<String, Value>,
    answers: HashMap<String, (String, String)>,
}

pub struct ExecutionLifecycle {
    sinks: Vec<Arc<dyn LifecycleSink>>,
    state: Mutex<State>,
}

impl ExecutionLifecycle {
    pub fn new(sinks: Vec<Arc<dyn LifecycleSink>>) -> Arc<Self> {
        Arc::new(Self {
            sinks,
            state: Mutex::new(State::default()),
        })
    }

    pub fn observe(&self, event: Value) {
        let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            self.apply_observation(event)
        }));
    }

    pub fn committed(&self, facts: &[SessionFact]) {
        let _ =
            std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| self.apply_committed(facts)));
    }

    pub fn close(&self) {
        let timestamp = crate::timestamp();
        let mut state = self.state.lock().unwrap();
        let session_id = state.session_id.clone();
        if let Some(session_id) = session_id {
            let models = std::mem::take(&mut state.models);
            for (attempt_id, attempt) in models {
                self.publish(json!({
                    "type":"model.completed", "timestamp":timestamp, "sessionId":session_id,
                    "operationId":attempt.operation_id, "operationKind":attempt.operation_kind,
                    "stepId":attempt.step_id, "attemptId":attempt_id, "recovery":attempt.recovery,
                    "durationMs":duration(attempt.started_at, now_millis()), "outcome":"effect_unknown"
                }));
            }
            let tools = std::mem::take(&mut state.tools);
            for (tool_started_id, attempt) in tools {
                self.publish(json!({
                    "type":"tool.completed", "timestamp":timestamp, "sessionId":session_id,
                    "operationId":attempt.operation_id, "stepId":attempt.step_id,
                    "attemptId":attempt.attempt_id, "parentAttemptId":attempt.parent_attempt_id,
                    "toolStartedId":tool_started_id, "toolCallId":attempt.tool_call_id,
                    "tool":attempt.tool, "recovery":attempt.recovery,
                    "durationMs":duration(attempt.started_at, now_millis()), "outcome":"effect_unknown"
                }));
            }
        }
        drop(state);
        for sink in &self.sinks {
            let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| sink.close()));
        }
    }

    fn apply_observation(&self, event: Value) {
        let event_type = event["type"].as_str().unwrap_or_default();
        let mut state = self.state.lock().unwrap();
        if event_type == "session.attached" {
            state.session_id = event["sessionId"].as_str().map(str::to_string);
        } else if event_type == "recovery.attached" {
            let Some(session_id) = state.session_id.clone() else {
                return;
            };
            let Some(operation_id) = event["operationId"].as_str() else {
                return;
            };
            let operation_kind = event["operationKind"].as_str().unwrap_or("run");
            state.operations.insert(
                operation_id.into(),
                Operation {
                    kind: operation_kind.into(),
                    started_at: time_value(&event),
                    recovery: true,
                },
            );
            state
                .operation_usage
                .insert(operation_id.into(), empty_usage());
            self.publish(json!({
                "type":"operation.recovered", "timestamp":event["timestamp"], "sessionId":session_id,
                "operationId":operation_id, "operationKind":operation_kind, "recovery":true
            }));
            return;
        } else if event_type == "tool.started" {
            let Some(session_id) = state.session_id.clone() else {
                return;
            };
            let Some(tool_started_id) = event["toolStartedId"].as_str() else {
                return;
            };
            state.tools.insert(
                tool_started_id.into(),
                ToolAttempt {
                    operation_id: string(&event, "operationId"),
                    step_id: string(&event, "stepId"),
                    attempt_id: string(&event, "attemptId"),
                    parent_attempt_id: string(&event, "parentAttemptId"),
                    tool_call_id: string(&event, "toolCallId"),
                    tool: string(&event, "tool"),
                    started_at: time_value(&event),
                    recovery: event["recovery"].as_bool().unwrap_or(false),
                },
            );
            let mut published = event;
            published["sessionId"] = json!(session_id);
            self.publish(published);
            return;
        }
        drop(state);
        self.publish(event);
    }

    fn apply_committed(&self, facts: &[SessionFact]) {
        let mut state = self.state.lock().unwrap();
        let mut transaction_usage = HashMap::new();
        for fact in facts {
            if fact.get("kind").and_then(Value::as_str) != Some("usage") {
                continue;
            }
            let (Some(attempt_id), Some(usage)) = (
                fact.get("attemptId").and_then(Value::as_str),
                usage_value(fact.get("usage")),
            ) else {
                continue;
            };
            transaction_usage.insert(attempt_id.to_string(), usage.clone());
            state.usage.insert(attempt_id.to_string(), usage.clone());
            if let Some(operation_id) = fact.get("operationId").and_then(Value::as_str) {
                let total = state
                    .operation_usage
                    .entry(operation_id.into())
                    .or_insert_with(empty_usage);
                add_usage(total, &usage);
            }
        }
        for fact in facts {
            self.apply_fact(&mut state, fact, &transaction_usage);
        }
    }

    fn apply_fact(
        &self,
        state: &mut State,
        fact: &SessionFact,
        transaction_usage: &HashMap<String, Value>,
    ) {
        let timestamp = fact_timestamp(fact);
        if fact.get("kind").and_then(Value::as_str) == Some("record") {
            let Some(record) = fact.get("record").and_then(Value::as_object) else {
                return;
            };
            self.apply_record(state, fact, record, &timestamp);
            return;
        }
        if fact.get("kind").and_then(Value::as_str) != Some("entry") {
            return;
        }
        let Some(entry) = fact.get("entry").and_then(Value::as_object) else {
            return;
        };
        if entry.get("type").and_then(Value::as_str) == Some("message") {
            let message = entry.get("message").and_then(Value::as_object);
            let role = message
                .and_then(|value| value.get("role"))
                .and_then(Value::as_str);
            if role == Some("assistant") {
                let Some(attempt_id) = entry.get("attemptId").and_then(Value::as_str) else {
                    return;
                };
                if let (Some(attempt), Some(entry_id), Some(content)) = (
                    state.models.get(attempt_id),
                    fact.get("id").and_then(Value::as_str),
                    message
                        .and_then(|value| value.get("content"))
                        .and_then(Value::as_str),
                ) {
                    state.answers.insert(
                        entry_id.into(),
                        (attempt.operation_id.clone(), content.into()),
                    );
                }
                let usage = transaction_usage.get(attempt_id).cloned();
                self.complete_model(state, attempt_id, &timestamp, "succeeded", usage, None);
            } else if role == Some("tool")
                && let Some(tool_started_id) = entry.get("toolStartedId").and_then(Value::as_str)
            {
                self.complete_tool(state, tool_started_id, entry, &timestamp);
            }
            return;
        }
        if entry.get("type").and_then(Value::as_str) != Some("compaction") {
            return;
        }
        let Some(operation_id) = entry.get("operationId").and_then(Value::as_str) else {
            return;
        };
        let attempt_id = state
            .models
            .iter()
            .find(|(_, attempt)| {
                attempt.operation_id == operation_id && attempt.operation_kind == "compaction"
            })
            .map(|(id, _)| id.clone());
        if let Some(attempt_id) = attempt_id {
            let usage = state.usage.get(&attempt_id).cloned();
            self.complete_model(state, &attempt_id, &timestamp, "succeeded", usage, None);
        }
    }

    fn apply_record(
        &self,
        state: &mut State,
        fact: &SessionFact,
        record: &Map<String, Value>,
        timestamp: &str,
    ) {
        let Some(session_id) = state.session_id.clone() else {
            return;
        };
        match record
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or_default()
        {
            "runStarted" | "compactionStarted" => {
                let Some(operation_id) = record.get("operationId").and_then(Value::as_str) else {
                    return;
                };
                let kind = if record.get("type").and_then(Value::as_str) == Some("runStarted") {
                    "run"
                } else {
                    "compaction"
                };
                state.operations.insert(
                    operation_id.into(),
                    Operation {
                        kind: kind.into(),
                        started_at: parse_timestamp(timestamp),
                        recovery: false,
                    },
                );
                state
                    .operation_usage
                    .insert(operation_id.into(), empty_usage());
                self.publish(json!({"type":"operation.started","timestamp":timestamp,"sessionId":session_id,"operationId":operation_id,"operationKind":kind,"recovery":false}));
            }
            "stepAttempt" => {
                let (Some(operation_id), Some(step_id), Some(attempt_id), Some(attempt)) = (
                    record.get("operationId").and_then(Value::as_str),
                    record.get("stepId").and_then(Value::as_str),
                    record.get("attemptId").and_then(Value::as_str),
                    record.get("attempt").and_then(Value::as_u64),
                ) else {
                    return;
                };
                let kind = if record.get("stepKind").and_then(Value::as_str) == Some("compaction") {
                    "compaction"
                } else {
                    "run"
                };
                let recovery = state
                    .operations
                    .get(operation_id)
                    .is_some_and(|operation| operation.recovery);
                state.models.insert(
                    attempt_id.into(),
                    ModelAttempt {
                        operation_id: operation_id.into(),
                        operation_kind: kind.into(),
                        step_id: step_id.into(),
                        started_at: parse_timestamp(timestamp),
                        recovery,
                    },
                );
                self.publish(json!({"type":"model.started","timestamp":timestamp,"sessionId":session_id,"operationId":operation_id,"operationKind":kind,"stepId":step_id,"attemptId":attempt_id,"attempt":attempt,"recovery":recovery}));
            }
            "stepFailed" => {
                let (Some(operation_id), Some(step_id), Some(attempt_id)) = (
                    record.get("operationId").and_then(Value::as_str),
                    record.get("stepId").and_then(Value::as_str),
                    record.get("attemptId").and_then(Value::as_str),
                ) else {
                    return;
                };
                let error = record.get("error").and_then(Value::as_object);
                let error_type = error
                    .and_then(|value| value.get("code"))
                    .and_then(Value::as_str);
                let outcome = if error_type == Some("aborted") {
                    "cancelled"
                } else {
                    "failed"
                };
                if !state.models.contains_key(attempt_id)
                    && state
                        .operations
                        .get(operation_id)
                        .is_some_and(|operation| operation.recovery)
                {
                    let kind = state
                        .operations
                        .get(operation_id)
                        .map(|operation| operation.kind.as_str())
                        .unwrap_or("run");
                    self.publish(json!({"type":"model.reconciled","timestamp":timestamp,"sessionId":session_id,"operationId":operation_id,"operationKind":kind,"stepId":step_id,"attemptId":attempt_id,"recovery":true,"outcome":outcome,"errorType":error_type}));
                } else {
                    let usage = state.usage.get(attempt_id).cloned();
                    self.complete_model(state, attempt_id, timestamp, outcome, usage, error_type);
                }
            }
            "toolStarted" => {
                let (
                    Some(id),
                    Some(operation_id),
                    Some(step_id),
                    Some(call_id),
                    Some(tool),
                    Some(replay),
                ) = (
                    fact.get("id").and_then(Value::as_str),
                    record.get("operationId").and_then(Value::as_str),
                    record.get("stepId").and_then(Value::as_str),
                    record.get("toolCallId").and_then(Value::as_str),
                    record.get("toolName").and_then(Value::as_str),
                    record.get("replay").and_then(Value::as_str),
                )
                else {
                    return;
                };
                let recovery = state
                    .operations
                    .get(operation_id)
                    .is_some_and(|operation| operation.recovery);
                self.publish(json!({"type":"tool.admitted","timestamp":timestamp,"sessionId":session_id,"operationId":operation_id,"stepId":step_id,"toolStartedId":id,"toolCallId":call_id,"tool":tool,"replay":replay,"recovery":recovery}));
            }
            "abortRequested" => {
                self.publish(json!({"type":"cancel.requested","timestamp":timestamp,"sessionId":session_id,"operationId":record.get("operationId"),"operationKind":record.get("operationKind"),"phase":record.get("phase"),"toolCallId":record.get("toolCallId"),"recovery":record.get("operationId").and_then(Value::as_str).and_then(|id| state.operations.get(id)).is_some_and(|operation| operation.recovery)}));
            }
            "operationFinished" => {
                let Some(operation_id) = record.get("operationId").and_then(Value::as_str) else {
                    return;
                };
                let Some(operation) = state.operations.remove(operation_id) else {
                    return;
                };
                let outcome = match record.get("outcome").and_then(Value::as_str) {
                    Some("completed") => "succeeded",
                    Some("aborted") => "cancelled",
                    _ => "failed",
                };
                let final_entry_id = record.get("finalEntryId").and_then(Value::as_str);
                let answer = final_entry_id
                    .and_then(|id| state.answers.get(id))
                    .map(|(_, answer)| answer.clone());
                let usage = state.operation_usage.remove(operation_id);
                let mut event = json!({"type":"operation.completed","timestamp":timestamp,"sessionId":session_id,"operationId":operation_id,"operationKind":operation.kind,"recovery":operation.recovery,"durationMs":duration(operation.started_at,parse_timestamp(timestamp)),"outcome":outcome});
                insert_optional(&mut event, "completion", record.get("completion").cloned());
                insert_optional(&mut event, "answer", answer.map(Value::String));
                insert_optional(&mut event, "usage", usage);
                let error = record.get("error").and_then(Value::as_object);
                insert_optional(
                    &mut event,
                    "errorType",
                    error.and_then(|value| value.get("code")).cloned(),
                );
                insert_optional(
                    &mut event,
                    "errorMessage",
                    error.and_then(|value| value.get("message")).cloned(),
                );
                self.publish(event);
                state.answers.retain(|_, (id, _)| id != operation_id);
            }
            _ => {}
        }
    }

    fn complete_model(
        &self,
        state: &mut State,
        attempt_id: &str,
        timestamp: &str,
        outcome: &str,
        usage: Option<Value>,
        error_type: Option<&str>,
    ) {
        let Some(session_id) = state.session_id.clone() else {
            return;
        };
        let Some(attempt) = state.models.remove(attempt_id) else {
            return;
        };
        let mut event = json!({"type":"model.completed","timestamp":timestamp,"sessionId":session_id,"operationId":attempt.operation_id,"operationKind":attempt.operation_kind,"stepId":attempt.step_id,"attemptId":attempt_id,"recovery":attempt.recovery,"durationMs":duration(attempt.started_at,parse_timestamp(timestamp)),"outcome":outcome});
        insert_optional(&mut event, "usage", usage.map(with_cache_hit_rate));
        insert_optional(
            &mut event,
            "errorType",
            error_type.map(|value| json!(value)),
        );
        state.usage.remove(attempt_id);
        self.publish(event);
    }

    fn complete_tool(
        &self,
        state: &mut State,
        tool_started_id: &str,
        entry: &Map<String, Value>,
        timestamp: &str,
    ) {
        let Some(session_id) = state.session_id.clone() else {
            return;
        };
        let Some(attempt) = state.tools.remove(tool_started_id) else {
            return;
        };
        let result = entry.get("result").and_then(Value::as_object);
        let outcome = match result
            .and_then(|value| value.get("type"))
            .and_then(Value::as_str)
        {
            Some("success") => "succeeded",
            _ if result
                .and_then(|value| value.get("reason"))
                .and_then(Value::as_str)
                == Some("interrupted") =>
            {
                "cancelled"
            }
            _ => "failed",
        };
        self.publish(json!({"type":"tool.completed","timestamp":timestamp,"sessionId":session_id,"operationId":attempt.operation_id,"stepId":attempt.step_id,"attemptId":attempt.attempt_id,"parentAttemptId":attempt.parent_attempt_id,"toolStartedId":tool_started_id,"toolCallId":attempt.tool_call_id,"tool":attempt.tool,"recovery":attempt.recovery,"durationMs":duration(attempt.started_at,parse_timestamp(timestamp)),"outcome":outcome}));
    }

    fn publish(&self, event: Value) {
        for sink in &self.sinks {
            let _ =
                std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| sink.emit(event.clone())));
        }
    }
}

fn string(value: &Value, key: &str) -> String {
    value[key].as_str().unwrap_or_default().to_string()
}
fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}
fn time_value(event: &Value) -> u64 {
    event["timestamp"]
        .as_str()
        .map(parse_timestamp)
        .unwrap_or_else(now_millis)
}
fn parse_timestamp(value: &str) -> u64 {
    timestamp_millis(value).unwrap_or_else(now_millis)
}
pub fn timestamp_millis(value: &str) -> Option<u64> {
    let date = value.strip_suffix('Z')?;
    let (date, time) = date.split_once('T')?;
    let mut d = date.split('-').map(|part| part.parse::<i64>().ok());
    let (year, month, day) = (d.next()??, d.next()??, d.next()??);
    let (clock, millis) = time.split_once('.').unwrap_or((time, "0"));
    let mut t = clock.split(':').map(|part| part.parse::<i64>().ok());
    let (hour, minute, second) = (t.next()??, t.next()??, t.next()??);
    let days = days_from_civil(year, month, day);
    let fraction = format!("{millis:0<3}")[..3].parse::<i64>().ok()?;
    Some(((days * 86_400 + hour * 3_600 + minute * 60 + second) * 1000 + fraction) as u64)
}
fn days_from_civil(year: i64, month: i64, day: i64) -> i64 {
    let year = year - i64::from(month <= 2);
    let era = year.div_euclid(400);
    let yoe = year - era * 400;
    let mp = month + if month > 2 { -3 } else { 9 };
    let doy = (153 * mp + 2) / 5 + day - 1;
    era * 146_097 + yoe * 365 + yoe / 4 - yoe / 100 + doy - 719_468
}
fn duration(start: u64, end: u64) -> f64 {
    end.saturating_sub(start) as f64
}
fn fact_timestamp(fact: &SessionFact) -> String {
    let millis = fact
        .get("timestamp")
        .and_then(Value::as_u64)
        .unwrap_or_else(now_millis);
    crate::timestamp_at(millis)
}
fn usage_value(value: Option<&Value>) -> Option<Value> {
    let value = value?.as_object()?;
    for key in ["input", "output", "cacheRead", "cacheWrite"] {
        value.get(key)?.as_u64()?;
    }
    Some(Value::Object(value.clone()))
}
fn empty_usage() -> Value {
    json!({"input":0,"output":0,"cacheRead":0,"cacheWrite":0,"cacheHitRate":0})
}
fn add_usage(total: &mut Value, usage: &Value) {
    for key in ["input", "output", "cacheRead", "cacheWrite"] {
        total[key] = json!(total[key].as_u64().unwrap_or(0) + usage[key].as_u64().unwrap_or(0));
    }
    total["cacheHitRate"] = with_cache_hit_rate(usage.clone())["cacheHitRate"].clone();
}
fn with_cache_hit_rate(mut usage: Value) -> Value {
    let prompt = usage["input"].as_u64().unwrap_or(0)
        + usage["cacheRead"].as_u64().unwrap_or(0)
        + usage["cacheWrite"].as_u64().unwrap_or(0);
    let cache_read = usage["cacheRead"].as_u64().unwrap_or(0);
    usage["cacheHitRate"] = if cache_read == 0 || prompt == 0 {
        json!(0)
    } else {
        json!(cache_read as f64 / prompt as f64 * 100.0)
    };
    usage
}
fn insert_optional(target: &mut Value, key: &str, value: Option<Value>) {
    if let Some(value) = value {
        target[key] = value;
    }
}
