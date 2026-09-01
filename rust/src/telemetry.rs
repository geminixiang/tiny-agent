use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use opentelemetry::trace::{Status, TraceContextExt, Tracer, TracerProvider as _};
use opentelemetry::{Context, KeyValue};
use opentelemetry_otlp::{Protocol, WithExportConfig};
use opentelemetry_sdk::Resource;
use opentelemetry_sdk::trace::{SdkTracer, SdkTracerProvider};
use serde_json::Value;

use crate::lifecycle::LifecycleSink;

struct ActiveSpan {
    context: Context,
}

#[derive(Default)]
struct State {
    startup: Option<ActiveSpan>,
    operations: HashMap<String, ActiveSpan>,
    models: HashMap<String, ActiveSpan>,
    tools: HashMap<String, ActiveSpan>,
    mcp: HashMap<String, ActiveSpan>,
    model: Option<String>,
}

pub struct OpenTelemetryMonitor {
    tracer: Option<SdkTracer>,
    provider: Option<SdkTracerProvider>,
    state: Mutex<State>,
}

impl OpenTelemetryMonitor {
    pub fn from_env() -> Self {
        if telemetry_disabled() {
            return Self::disabled();
        }
        let exporter = match opentelemetry_otlp::SpanExporter::builder()
            .with_http()
            .with_protocol(Protocol::HttpBinary)
            .build()
        {
            Ok(exporter) => exporter,
            Err(_) => return Self::disabled(),
        };
        let service_name = std::env::var("OTEL_SERVICE_NAME").unwrap_or_else(|_| "tiny-rs".into());
        let resource = Resource::builder()
            .with_service_name(service_name.clone())
            .with_attribute(KeyValue::new("openinference.project.name", service_name))
            .build();
        let provider = SdkTracerProvider::builder()
            .with_resource(resource)
            .with_batch_exporter(exporter)
            .build();
        let tracer = provider.tracer("tiny-agent");
        Self {
            tracer: Some(tracer),
            provider: Some(provider),
            state: Mutex::new(State::default()),
        }
    }

    fn disabled() -> Self {
        Self {
            tracer: None,
            provider: None,
            state: Mutex::new(State::default()),
        }
    }

    #[cfg(test)]
    fn with_provider(provider: SdkTracerProvider) -> Self {
        let tracer = provider.tracer("tiny-agent");
        Self {
            tracer: Some(tracer),
            provider: Some(provider),
            state: Mutex::new(State::default()),
        }
    }

    fn record(&self, event: &Value) {
        let Some(tracer) = &self.tracer else {
            return;
        };
        let mut state = self.state.lock().unwrap();
        let event_type = event["type"].as_str().unwrap_or_default();
        match event_type {
            "startup.started" => {
                if let Some(span) = state.startup.take() {
                    end_span(span, "effect_unknown", SystemTime::now());
                }
                state.model = event["model"].as_str().map(str::to_string);
                state.startup = Some(start_span(
                    tracer,
                    "tiny.startup",
                    event,
                    attributes(&[
                        ("tiny.runtime.language", event.get("runtime").cloned()),
                        (
                            "tiny.plugin.count",
                            Some(Value::from(event["plugins"].as_array().map_or(0, Vec::len))),
                        ),
                        (
                            "tiny.mcp.server_count",
                            Some(Value::from(event["mcp"].as_array().map_or(0, Vec::len))),
                        ),
                    ]),
                    &Context::new(),
                ));
            }
            "mcp.started" => {
                let Some(parent) = state.startup.as_ref().map(|span| span.context.clone()) else {
                    return;
                };
                let server = event["server"].as_str().unwrap_or_default().to_string();
                state.mcp.insert(
                    server,
                    start_span(
                        tracer,
                        "tiny.mcp.connect",
                        event,
                        attributes(&[("tiny.mcp.server", event.get("server").cloned())]),
                        &parent,
                    ),
                );
            }
            "mcp.completed" => {
                let server = event["server"].as_str().unwrap_or_default();
                if let Some(span) = state.mcp.remove(server) {
                    set_attributes(
                        &span,
                        attributes(&[
                            (
                                "tiny.mcp.protocol_version",
                                event.get("protocolVersion").cloned(),
                            ),
                            ("tiny.mcp.tool_count", event.get("toolCount").cloned()),
                            ("error.type", event.get("errorType").cloned()),
                        ]),
                    );
                    end_span(span, outcome(event), event_time(event));
                }
            }
            "startup.completed" => {
                if let Some(span) = state.startup.take() {
                    set_attributes(
                        &span,
                        attributes(&[("error.type", event.get("errorType").cloned())]),
                    );
                    end_span(span, outcome(event), event_time(event));
                }
            }
            "operation.started" | "operation.recovered" => {
                let id = string(event, "operationId");
                if let Some(span) = state.operations.remove(&id) {
                    end_span(span, "effect_unknown", event_time(event));
                }
                state.operations.insert(
                    id,
                    start_span(
                        tracer,
                        "tiny.agent.operation",
                        event,
                        attributes(&[
                            ("openinference.span.kind", Some(Value::from("AGENT"))),
                            ("gen_ai.operation.name", Some(Value::from("invoke_agent"))),
                            ("gen_ai.conversation.id", event.get("sessionId").cloned()),
                            ("session.id", event.get("sessionId").cloned()),
                            ("tiny.session.id", event.get("sessionId").cloned()),
                            ("tiny.operation.id", event.get("operationId").cloned()),
                            ("tiny.operation.kind", event.get("operationKind").cloned()),
                            ("tiny.recovery", event.get("recovery").cloned()),
                            ("tiny.runtime.language", Some(Value::from("rust"))),
                        ]),
                        &Context::new(),
                    ),
                );
            }
            "model.started" => {
                let Some(parent) = event["operationId"]
                    .as_str()
                    .and_then(|id| state.operations.get(id))
                    .map(|span| span.context.clone())
                else {
                    return;
                };
                let id = string(event, "attemptId");
                let model = state.model.clone().map(Value::from);
                state.models.insert(
                    id,
                    start_span(
                        tracer,
                        "tiny.model.request",
                        event,
                        attributes(&[
                            ("openinference.span.kind", Some(Value::from("LLM"))),
                            ("gen_ai.operation.name", Some(Value::from("chat"))),
                            ("gen_ai.conversation.id", event.get("sessionId").cloned()),
                            ("gen_ai.request.model", model.clone()),
                            ("llm.model_name", model),
                            ("session.id", event.get("sessionId").cloned()),
                            ("tiny.session.id", event.get("sessionId").cloned()),
                            ("tiny.operation.id", event.get("operationId").cloned()),
                            ("tiny.operation.kind", event.get("operationKind").cloned()),
                            ("tiny.step.id", event.get("stepId").cloned()),
                            ("tiny.attempt.id", event.get("attemptId").cloned()),
                            ("tiny.attempt.number", event.get("attempt").cloned()),
                            ("tiny.recovery", event.get("recovery").cloned()),
                        ]),
                        &parent,
                    ),
                );
            }
            "model.completed" => {
                let id = event["attemptId"].as_str().unwrap_or_default();
                if let Some(span) = state.models.remove(id) {
                    set_attributes(&span, usage_attributes(event.get("usage")));
                    set_attributes(
                        &span,
                        attributes(&[("error.type", event.get("errorType").cloned())]),
                    );
                    end_span(span, outcome(event), event_time(event));
                }
            }
            "model.reconciled" | "tool.admitted" | "cancel.requested" => {
                let Some(operation) = event["operationId"]
                    .as_str()
                    .and_then(|id| state.operations.get(id))
                else {
                    return;
                };
                operation.context.span().add_event_with_timestamp(
                    event_type.to_string(),
                    event_time(event),
                    event_attributes(event_type, event),
                );
            }
            "tool.started" => {
                let Some(parent) = event["operationId"]
                    .as_str()
                    .and_then(|id| state.operations.get(id))
                    .map(|span| span.context.clone())
                else {
                    return;
                };
                let id = string(event, "attemptId");
                if let Some(span) = state.tools.remove(&id) {
                    end_span(span, "effect_unknown", event_time(event));
                }
                state.tools.insert(
                    id,
                    start_span(
                        tracer,
                        "tiny.tool.execute",
                        event,
                        attributes(&[
                            ("openinference.span.kind", Some(Value::from("TOOL"))),
                            ("gen_ai.operation.name", Some(Value::from("execute_tool"))),
                            ("gen_ai.conversation.id", event.get("sessionId").cloned()),
                            ("gen_ai.tool.call.id", event.get("toolCallId").cloned()),
                            ("gen_ai.tool.name", event.get("tool").cloned()),
                            ("session.id", event.get("sessionId").cloned()),
                            ("tool.name", event.get("tool").cloned()),
                            ("tiny.session.id", event.get("sessionId").cloned()),
                            ("tiny.operation.id", event.get("operationId").cloned()),
                            ("tiny.step.id", event.get("stepId").cloned()),
                            ("tiny.attempt.id", event.get("attemptId").cloned()),
                            (
                                "tiny.parent_attempt.id",
                                event.get("parentAttemptId").cloned(),
                            ),
                            ("tiny.tool.started.id", event.get("toolStartedId").cloned()),
                            ("tiny.recovery", event.get("recovery").cloned()),
                        ]),
                        &parent,
                    ),
                );
            }
            "tool.completed" => {
                let id = event["attemptId"].as_str().unwrap_or_default();
                if let Some(span) = state.tools.remove(id) {
                    end_span(span, outcome(event), event_time(event));
                }
            }
            "operation.completed" => {
                let id = event["operationId"].as_str().unwrap_or_default();
                if let Some(span) = state.operations.remove(id) {
                    set_attributes(
                        &span,
                        attributes(&[
                            (
                                "tiny.operation.completion",
                                event.get("completion").cloned(),
                            ),
                            ("error.type", event.get("errorType").cloned()),
                        ]),
                    );
                    end_span(span, outcome(event), event_time(event));
                }
            }
            _ => {}
        }
    }

    fn finish_dangling(&self) {
        let mut state = self.state.lock().unwrap();
        let end = SystemTime::now();
        for (_, span) in std::mem::take(&mut state.mcp) {
            end_span(span, "effect_unknown", end);
        }
        for (_, span) in std::mem::take(&mut state.models) {
            end_span(span, "effect_unknown", end);
        }
        for (_, span) in std::mem::take(&mut state.tools) {
            end_span(span, "effect_unknown", end);
        }
        for (_, span) in std::mem::take(&mut state.operations) {
            end_span(span, "effect_unknown", end);
        }
        if let Some(span) = state.startup.take() {
            end_span(span, "effect_unknown", end);
        }
    }
}

impl LifecycleSink for OpenTelemetryMonitor {
    fn emit(&self, event: Value) {
        let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| self.record(&event)));
    }

    fn close(&self) {
        self.finish_dangling();
        if let Some(provider) = &self.provider {
            let _ = provider.shutdown();
        }
    }
}

fn telemetry_disabled() -> bool {
    if std::env::var("OTEL_SDK_DISABLED").is_ok_and(|value| value.eq_ignore_ascii_case("true")) {
        return true;
    }
    let traces = std::env::var("OTEL_EXPORTER_OTLP_TRACES_ENDPOINT").unwrap_or_default();
    let general = std::env::var("OTEL_EXPORTER_OTLP_ENDPOINT").unwrap_or_default();
    traces.is_empty() && general.is_empty()
}

fn start_span(
    tracer: &SdkTracer,
    name: &'static str,
    event: &Value,
    attributes: Vec<KeyValue>,
    parent: &Context,
) -> ActiveSpan {
    let span = tracer
        .span_builder(name)
        .with_start_time(event_time(event))
        .with_attributes(attributes)
        .start_with_context(tracer, parent);
    ActiveSpan {
        context: Context::new().with_span(span),
    }
}

fn set_attributes(span: &ActiveSpan, attributes: Vec<KeyValue>) {
    span.context.span().set_attributes(attributes);
}

fn end_span(span: ActiveSpan, outcome: &str, end: SystemTime) {
    let current = span.context.span();
    current.set_attribute(KeyValue::new("tiny.outcome", outcome.to_string()));
    if outcome == "succeeded" {
        current.set_status(Status::Ok);
    } else if outcome != "cancelled" {
        current.set_status(Status::error(outcome.to_string()));
    }
    current.end_with_timestamp(end);
}

fn attributes(values: &[(&'static str, Option<Value>)]) -> Vec<KeyValue> {
    values
        .iter()
        .filter_map(|(key, value)| value.as_ref().and_then(|value| attribute(key, value)))
        .collect()
}

fn attribute(key: &'static str, value: &Value) -> Option<KeyValue> {
    if let Some(value) = value.as_str() {
        return Some(KeyValue::new(key, value.to_string()));
    }
    if let Some(value) = value.as_bool() {
        return Some(KeyValue::new(key, value));
    }
    if let Some(value) = value.as_i64() {
        return Some(KeyValue::new(key, value));
    }
    value.as_f64().map(|value| KeyValue::new(key, value))
}

fn usage_attributes(usage: Option<&Value>) -> Vec<KeyValue> {
    let Some(usage) = usage else {
        return Vec::new();
    };
    let input = usage["input"].as_i64().unwrap_or(0);
    let output = usage["output"].as_i64().unwrap_or(0);
    let cache_read = usage["cacheRead"].as_i64().unwrap_or(0);
    let cache_write = usage["cacheWrite"].as_i64().unwrap_or(0);
    let prompt = input + cache_read + cache_write;
    vec![
        KeyValue::new("gen_ai.usage.input_tokens", prompt),
        KeyValue::new("gen_ai.usage.output_tokens", output),
        KeyValue::new("gen_ai.usage.cache_read.input_tokens", cache_read),
        KeyValue::new("gen_ai.usage.cache_creation.input_tokens", cache_write),
        KeyValue::new("llm.token_count.prompt", prompt),
        KeyValue::new("llm.token_count.completion", output),
        KeyValue::new("llm.token_count.total", prompt + output),
        KeyValue::new("tiny.usage.input_tokens", input),
        KeyValue::new("tiny.usage.cache_read_tokens", cache_read),
        KeyValue::new("tiny.usage.cache_write_tokens", cache_write),
    ]
}

fn event_attributes(kind: &str, event: &Value) -> Vec<KeyValue> {
    match kind {
        "model.reconciled" => attributes(&[
            ("tiny.step.id", event.get("stepId").cloned()),
            ("tiny.attempt.id", event.get("attemptId").cloned()),
            ("tiny.outcome", event.get("outcome").cloned()),
            ("error.type", event.get("errorType").cloned()),
        ]),
        "tool.admitted" => attributes(&[
            ("tiny.step.id", event.get("stepId").cloned()),
            ("tiny.tool.started.id", event.get("toolStartedId").cloned()),
            ("gen_ai.tool.call.id", event.get("toolCallId").cloned()),
            ("gen_ai.tool.name", event.get("tool").cloned()),
            ("tiny.tool.replay", event.get("replay").cloned()),
        ]),
        _ => attributes(&[
            ("tiny.cancel.phase", event.get("phase").cloned()),
            ("gen_ai.tool.call.id", event.get("toolCallId").cloned()),
        ]),
    }
}

fn string(event: &Value, key: &str) -> String {
    event[key].as_str().unwrap_or_default().to_string()
}

fn outcome(event: &Value) -> &str {
    event["outcome"].as_str().unwrap_or("failed")
}

fn event_time(event: &Value) -> SystemTime {
    event["timestamp"]
        .as_str()
        .and_then(crate::lifecycle::timestamp_millis)
        .map(|value| UNIX_EPOCH + Duration::from_millis(value))
        .unwrap_or_else(SystemTime::now)
}

#[cfg(test)]
mod tests {
    use super::*;
    use opentelemetry_sdk::trace::InMemorySpanExporter;
    use serde_json::json;

    #[test]
    fn projects_phoenix_metadata_without_payloads() {
        let exporter = InMemorySpanExporter::default();
        let provider = SdkTracerProvider::builder()
            .with_simple_exporter(exporter.clone())
            .build();
        let monitor = OpenTelemetryMonitor::with_provider(provider);
        monitor.emit(json!({
            "type":"startup.started", "timestamp":"2026-01-01T00:00:00.000Z",
            "model":"test-model", "runtime":"rust", "plugins":["read"], "mcp":[],
            "endpoint":"endpoint-secret"
        }));
        monitor.emit(json!({
            "type":"startup.completed", "timestamp":"2026-01-01T00:00:00.001Z",
            "durationMs":1, "outcome":"succeeded"
        }));
        monitor.emit(json!({
            "type":"operation.started", "timestamp":"2026-01-01T00:00:00.002Z",
            "sessionId":"session-1", "operationId":"operation-1", "operationKind":"run",
            "recovery":false, "prompt":"prompt-secret"
        }));
        monitor.emit(json!({
            "type":"model.started", "timestamp":"2026-01-01T00:00:00.003Z",
            "sessionId":"session-1", "operationId":"operation-1", "operationKind":"run",
            "stepId":"step-1", "attemptId":"model-1", "attempt":1, "recovery":false
        }));
        monitor.emit(json!({
            "type":"model.completed", "timestamp":"2026-01-01T00:00:00.004Z",
            "sessionId":"session-1", "operationId":"operation-1", "operationKind":"run",
            "stepId":"step-1", "attemptId":"model-1", "recovery":false,
            "durationMs":1, "outcome":"succeeded",
            "usage":{"input":7,"output":2,"cacheRead":3,"cacheWrite":1},
            "answer":"answer-secret"
        }));
        monitor.emit(json!({
            "type":"tool.started", "timestamp":"2026-01-01T00:00:00.005Z",
            "sessionId":"session-1", "operationId":"operation-1", "stepId":"step-1",
            "attemptId":"tool-1", "parentAttemptId":"model-1", "toolStartedId":"started-1",
            "toolCallId":"call-1", "tool":"read", "recovery":false,
            "args":{"path":"args-secret"}
        }));
        monitor.emit(json!({
            "type":"tool.completed", "timestamp":"2026-01-01T00:00:00.006Z",
            "sessionId":"session-1", "operationId":"operation-1", "stepId":"step-1",
            "attemptId":"tool-1", "parentAttemptId":"model-1", "toolStartedId":"started-1",
            "toolCallId":"call-1", "tool":"read", "recovery":false,
            "durationMs":1, "outcome":"failed", "result":"result-secret"
        }));
        monitor.emit(json!({
            "type":"operation.completed", "timestamp":"2026-01-01T00:00:00.007Z",
            "sessionId":"session-1", "operationId":"operation-1", "operationKind":"run",
            "recovery":false, "durationMs":5, "outcome":"failed",
            "errorType":"model_error", "errorMessage":"error-secret"
        }));

        let spans = exporter.get_finished_spans().unwrap();
        let encoded = format!("{spans:?}");
        for secret in [
            "endpoint-secret",
            "prompt-secret",
            "answer-secret",
            "args-secret",
            "result-secret",
            "error-secret",
        ] {
            assert!(
                !encoded.contains(secret),
                "exported payload canary: {secret}"
            );
        }
        let operation = spans
            .iter()
            .find(|span| span.name == "tiny.agent.operation")
            .unwrap();
        let model = spans
            .iter()
            .find(|span| span.name == "tiny.model.request")
            .unwrap();
        let tool = spans
            .iter()
            .find(|span| span.name == "tiny.tool.execute")
            .unwrap();
        assert!(
            operation
                .attributes
                .iter()
                .any(|value| value.key.as_str() == "session.id")
        );
        assert!(
            operation
                .attributes
                .iter()
                .any(|value| value.key.as_str() == "openinference.span.kind"
                    && value.value.to_string() == "AGENT")
        );
        assert!(
            model
                .attributes
                .iter()
                .any(|value| value.key.as_str() == "llm.model_name"
                    && value.value.to_string() == "test-model")
        );
        assert!(
            model
                .attributes
                .iter()
                .any(|value| value.key.as_str() == "llm.token_count.total"
                    && value.value.to_string() == "13")
        );
        assert!(
            tool.attributes
                .iter()
                .any(|value| value.key.as_str() == "openinference.span.kind"
                    && value.value.to_string() == "TOOL")
        );
    }
}
