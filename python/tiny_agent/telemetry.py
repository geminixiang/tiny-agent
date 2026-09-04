import os
from datetime import datetime, timezone

from opentelemetry import trace
from opentelemetry.context import Context
from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter
from opentelemetry.sdk.resources import Resource
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import BatchSpanProcessor
from opentelemetry.trace import Span, Status, StatusCode


class NoTelemetry:
    def emit(self, event: dict) -> None:
        pass

    def close(self) -> None:
        pass


class OpenTelemetryMonitor:
    def __init__(self, tracer, shutdown=lambda: None, runtime: str = "python"):
        self.tracer, self.shutdown, self.runtime = tracer, shutdown, runtime
        self.startup: tuple[Span, Context] | None = None
        self.operations: dict[str, tuple[Span, Context]] = {}
        self.models: dict[str, Span] = {}
        self.tools: dict[str, Span] = {}
        self.mcp: dict[str, Span] = {}
        self.model: str | None = None

    def emit(self, event: dict) -> None:
        try:
            self._record(event)
        except Exception:
            pass

    def close(self) -> None:
        for span in [*self.mcp.values(), *self.models.values(), *self.tools.values(), *(item[0] for item in self.operations.values())]:
            _end(span, "effect_unknown")
        if self.startup:
            _end(self.startup[0], "effect_unknown")
        self.mcp.clear()
        self.models.clear()
        self.tools.clear()
        self.operations.clear()
        self.startup = None
        try:
            self.shutdown()
        except Exception:
            pass

    def _record(self, event: dict) -> None:
        kind = event.get("type")
        if kind == "startup.started":
            if self.startup:
                _end(self.startup[0], "effect_unknown")
            self.model = event.get("model")
            span = self.tracer.start_span(
                "tiny.startup",
                start_time=_event_time(event),
                attributes={
                    "tiny.runtime.language": self.runtime,
                    "tiny.plugin.count": len(event.get("plugins", [])),
                    "tiny.mcp.server_count": len(event.get("mcp", [])),
                },
            )
            self.startup = span, trace.set_span_in_context(span)
            return
        if kind == "mcp.started":
            context = self.startup[1] if self.startup else None
            self.mcp[event["server"]] = self.tracer.start_span("tiny.mcp.connect", context=context, start_time=_event_time(event), attributes={"tiny.mcp.server": event["server"]})
            return
        if kind == "mcp.completed":
            span = self.mcp.pop(event.get("server"), None)
            if not span:
                return
            span.set_attributes(_attributes({"tiny.mcp.protocol_version": event.get("protocolVersion"), "tiny.mcp.tool_count": event.get("toolCount"), "error.type": event.get("errorType")}))
            _end(span, event.get("outcome", "failed"), _event_time(event))
            return
        if kind == "startup.completed":
            if not self.startup:
                return
            span, _ = self.startup
            self.startup = None
            span.set_attributes(_attributes({"error.type": event.get("errorType")}))
            _end(span, event.get("outcome", "failed"), _event_time(event))
            return
        if kind in ("operation.started", "operation.recovered"):
            operation_id = event["operationId"]
            existing = self.operations.pop(operation_id, None)
            if existing:
                _end(existing[0], "effect_unknown")
            span = self.tracer.start_span(
                "tiny.agent.operation",
                start_time=_event_time(event),
                attributes={
                    "openinference.span.kind": "AGENT",
                    "gen_ai.operation.name": "invoke_agent",
                    "gen_ai.conversation.id": event["sessionId"],
                    "session.id": event["sessionId"],
                    "tiny.session.id": event["sessionId"],
                    "tiny.operation.id": operation_id,
                    "tiny.operation.kind": event["operationKind"],
                    "tiny.recovery": event["recovery"],
                    "tiny.runtime.language": self.runtime,
                },
            )
            self.operations[operation_id] = span, trace.set_span_in_context(span)
            return
        if kind == "model.started":
            parent = self.operations.get(event.get("operationId"))
            if not parent:
                return
            self.models[event["attemptId"]] = self.tracer.start_span(
                "tiny.model.request",
                context=parent[1],
                start_time=_event_time(event),
                attributes=_attributes(
                    {
                        "openinference.span.kind": "LLM",
                        "gen_ai.operation.name": "chat",
                        "gen_ai.conversation.id": event["sessionId"],
                        "gen_ai.request.model": self.model,
                        "llm.model_name": self.model,
                        "session.id": event["sessionId"],
                        "tiny.session.id": event["sessionId"],
                        "tiny.operation.id": event["operationId"],
                        "tiny.operation.kind": event["operationKind"],
                        "tiny.step.id": event["stepId"],
                        "tiny.attempt.id": event["attemptId"],
                        "tiny.attempt.number": event["attempt"],
                        "tiny.recovery": event["recovery"],
                    }
                ),
            )
            return
        if kind == "model.completed":
            span = self.models.pop(event.get("attemptId"), None)
            if not span:
                return
            span.set_attributes(_attributes({**_usage_attributes(event.get("usage")), "error.type": event.get("errorType")}))
            _end(span, event.get("outcome", "failed"), _event_time(event))
            return
        if kind in ("model.reconciled", "tool.admitted", "cancel.requested"):
            operation = self.operations.get(event.get("operationId"))
            if not operation:
                return
            values = (
                {"tiny.step.id": event.get("stepId"), "tiny.attempt.id": event.get("attemptId"), "tiny.outcome": event.get("outcome"), "error.type": event.get("errorType")}
                if kind == "model.reconciled"
                else {
                    "tiny.step.id": event.get("stepId"),
                    "tiny.tool.started.id": event.get("toolStartedId"),
                    "gen_ai.tool.call.id": event.get("toolCallId"),
                    "gen_ai.tool.name": event.get("tool"),
                    "tiny.tool.replay": event.get("replay"),
                }
                if kind == "tool.admitted"
                else {"tiny.cancel.phase": event.get("phase"), "gen_ai.tool.call.id": event.get("toolCallId")}
            )
            operation[0].add_event(kind, _attributes(values), _event_time(event))
            return
        if kind == "tool.started":
            parent = self.operations.get(event.get("operationId"))
            if not parent:
                return
            attempt_id = event["attemptId"]
            existing = self.tools.pop(attempt_id, None)
            if existing:
                _end(existing, "effect_unknown")
            self.tools[attempt_id] = self.tracer.start_span(
                "tiny.tool.execute",
                context=parent[1],
                start_time=_event_time(event),
                attributes={
                    "openinference.span.kind": "TOOL",
                    "gen_ai.operation.name": "execute_tool",
                    "gen_ai.conversation.id": event["sessionId"],
                    "gen_ai.tool.call.id": event["toolCallId"],
                    "gen_ai.tool.name": event["tool"],
                    "session.id": event["sessionId"],
                    "tool.name": event["tool"],
                    "tiny.session.id": event["sessionId"],
                    "tiny.operation.id": event["operationId"],
                    "tiny.step.id": event["stepId"],
                    "tiny.attempt.id": attempt_id,
                    "tiny.parent_attempt.id": event["parentAttemptId"],
                    "tiny.tool.started.id": event["toolStartedId"],
                    "tiny.recovery": event["recovery"],
                },
            )
            return
        if kind == "tool.completed":
            span = self.tools.pop(event.get("attemptId"), None)
            if span:
                _end(span, event.get("outcome", "failed"), _event_time(event))
            return
        if kind == "operation.completed":
            operation = self.operations.pop(event.get("operationId"), None)
            if not operation:
                return
            operation[0].set_attributes(_attributes({"tiny.operation.completion": event.get("completion"), "error.type": event.get("errorType")}))
            _end(operation[0], event.get("outcome", "failed"), _event_time(event))


def create_telemetry(env: dict[str, str] | None = None):
    env = os.environ if env is None else env
    if env.get("OTEL_SDK_DISABLED", "").lower() == "true":
        return NoTelemetry()
    if not (env.get("OTEL_EXPORTER_OTLP_ENDPOINT") or env.get("OTEL_EXPORTER_OTLP_TRACES_ENDPOINT")):
        return NoTelemetry()
    try:
        service_name = env.get("OTEL_SERVICE_NAME") or "tiny-py"
        provider = TracerProvider(resource=Resource.create({"service.name": service_name, "openinference.project.name": service_name}))
        provider.add_span_processor(BatchSpanProcessor(OTLPSpanExporter()))
        return OpenTelemetryMonitor(provider.get_tracer("tiny-agent", "1"), provider.shutdown)
    except Exception:
        return NoTelemetry()


def _event_time(event: dict) -> int:
    value = event.get("timestamp")
    try:
        return int(datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp() * 1_000_000_000)
    except AttributeError, ValueError:
        return int(datetime.now(timezone.utc).timestamp() * 1_000_000_000)


def _attributes(values: dict) -> dict:
    return {key: value for key, value in values.items() if isinstance(value, (str, int, float, bool))}


def _usage_attributes(usage: dict | None) -> dict:
    if not usage:
        return {}
    prompt = usage["input"] + usage["cacheRead"] + usage["cacheWrite"]
    return {
        "gen_ai.usage.input_tokens": prompt,
        "gen_ai.usage.output_tokens": usage["output"],
        "gen_ai.usage.cache_read.input_tokens": usage["cacheRead"],
        "gen_ai.usage.cache_creation.input_tokens": usage["cacheWrite"],
        "llm.token_count.prompt": prompt,
        "llm.token_count.completion": usage["output"],
        "llm.token_count.total": prompt + usage["output"],
        "tiny.usage.input_tokens": usage["input"],
        "tiny.usage.cache_read_tokens": usage["cacheRead"],
        "tiny.usage.cache_write_tokens": usage["cacheWrite"],
    }


def _end(span: Span, outcome: str, end_time: int | None = None) -> None:
    span.set_attribute("tiny.outcome", outcome)
    span.set_status(Status(StatusCode.OK if outcome == "succeeded" else StatusCode.UNSET if outcome == "cancelled" else StatusCode.ERROR))
    span.end(end_time=end_time)
