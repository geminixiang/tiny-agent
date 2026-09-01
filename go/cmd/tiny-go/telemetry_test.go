package main

import (
	"fmt"
	"strings"
	"testing"
	"time"

	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/codes"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/sdk/trace/tracetest"
	"go.opentelemetry.io/otel/trace"
)

func TestOpenTelemetryProjectsPhoenixSpanTreeWithoutPrivatePayloads(t *testing.T) {
	exporter := tracetest.NewInMemoryExporter()
	provider := sdktrace.NewTracerProvider(sdktrace.WithSyncer(exporter))
	monitor := &openTelemetryMonitor{
		provider:   provider,
		tracer:     provider.Tracer("test"),
		operations: map[string]trace.Span{},
		models:     map[string]trace.Span{},
		tools:      map[string]trace.Span{},
		mcp:        map[string]trace.Span{},
	}
	sessionID, operationID := "session-1", "operation-1"
	monitor.Emit(map[string]any{"type": "startup.started", "timestamp": "2026-01-01T00:00:00.000Z", "model": "test-model", "runtime": "go", "plugins": []string{"read"}, "mcp": []string{"fixture"}})
	monitor.Emit(map[string]any{"type": "mcp.started", "timestamp": "2026-01-01T00:00:00.010Z", "server": "fixture"})
	monitor.Emit(map[string]any{"type": "mcp.completed", "timestamp": "2026-01-01T00:00:00.020Z", "server": "fixture", "outcome": "succeeded", "protocolVersion": "2026-07-28", "toolCount": 1})
	monitor.Emit(map[string]any{"type": "startup.completed", "timestamp": "2026-01-01T00:00:00.030Z", "outcome": "succeeded"})
	monitor.Emit(map[string]any{"type": "operation.started", "timestamp": "2026-01-01T00:00:00.040Z", "sessionId": sessionID, "operationId": operationID, "operationKind": "run", "recovery": false})
	monitor.Emit(map[string]any{"type": "model.started", "timestamp": "2026-01-01T00:00:00.050Z", "sessionId": sessionID, "operationId": operationID, "operationKind": "run", "stepId": "step-1", "attemptId": "attempt-1", "attempt": 1, "recovery": false})
	monitor.Emit(map[string]any{"type": "model.completed", "timestamp": "2026-01-01T00:00:00.100Z", "sessionId": sessionID, "operationId": operationID, "operationKind": "run", "stepId": "step-1", "attemptId": "attempt-1", "recovery": false, "outcome": "succeeded", "usage": map[string]any{"input": 7, "output": 2, "cacheRead": 3, "cacheWrite": 1}})
	monitor.Emit(map[string]any{"type": "tool.started", "timestamp": "2026-01-01T00:00:00.110Z", "sessionId": sessionID, "operationId": operationID, "stepId": "step-1", "attemptId": "tool-attempt-1", "parentAttemptId": "attempt-1", "toolStartedId": "tool-started-1", "toolCallId": "call-1", "tool": "read", "recovery": false, "args": map[string]any{"path": "/secret"}})
	monitor.Emit(map[string]any{"type": "tool.completed", "timestamp": "2026-01-01T00:00:00.130Z", "sessionId": sessionID, "operationId": operationID, "stepId": "step-1", "attemptId": "tool-attempt-1", "parentAttemptId": "attempt-1", "toolStartedId": "tool-started-1", "toolCallId": "call-1", "tool": "read", "recovery": false, "outcome": "succeeded", "result": "secret contents"})
	monitor.Emit(map[string]any{"type": "operation.completed", "timestamp": "2026-01-01T00:00:00.150Z", "sessionId": sessionID, "operationId": operationID, "operationKind": "run", "recovery": false, "outcome": "succeeded", "completion": "normal", "answer": "private answer", "errorMessage": "private error"})

	monitor.Emit(map[string]any{"type": "operation.started", "timestamp": "2026-01-01T00:00:00.160Z", "sessionId": sessionID, "operationId": "cancelled-operation", "operationKind": "run", "recovery": false})
	monitor.Emit(map[string]any{"type": "operation.completed", "timestamp": "2026-01-01T00:00:00.170Z", "sessionId": sessionID, "operationId": "cancelled-operation", "operationKind": "run", "recovery": false, "outcome": "cancelled"})
	monitor.Emit(map[string]any{"type": "operation.started", "timestamp": "2026-01-01T00:00:00.180Z", "sessionId": sessionID, "operationId": "unknown-operation", "operationKind": "run", "recovery": false})
	monitor.Emit(map[string]any{"type": "model.started", "timestamp": "2026-01-01T00:00:00.190Z", "sessionId": sessionID, "operationId": "unknown-operation", "operationKind": "run", "stepId": "step-2", "attemptId": "dangling-attempt", "attempt": 1, "recovery": false})

	monitor.mu.Lock()
	end := time.Now()
	for _, span := range monitor.models {
		endTelemetrySpan(span, "effect_unknown", end)
	}
	for _, span := range monitor.operations {
		endTelemetrySpan(span, "effect_unknown", end)
	}
	monitor.mu.Unlock()
	if err := provider.ForceFlush(t.Context()); err != nil {
		t.Fatalf("flush telemetry: %v", err)
	}
	spans := exporter.GetSpans()
	operation := findSpan(t, spans, "tiny.agent.operation", operationID)
	model := findSpan(t, spans, "tiny.model.request", "attempt-1")
	tool := findSpan(t, spans, "tiny.tool.execute", "tool-attempt-1")
	startup := findSpan(t, spans, "tiny.startup", "")
	mcp := findSpan(t, spans, "tiny.mcp.connect", "")
	cancelled := findSpan(t, spans, "tiny.agent.operation", "cancelled-operation")
	dangling := findSpan(t, spans, "tiny.model.request", "dangling-attempt")

	assertSpanAttribute(t, operation, "openinference.span.kind", "AGENT")
	assertSpanAttribute(t, operation, "session.id", sessionID)
	assertSpanAttribute(t, model, "openinference.span.kind", "LLM")
	assertSpanAttribute(t, model, "gen_ai.request.model", "test-model")
	assertSpanAttribute(t, model, "gen_ai.usage.input_tokens", int64(11))
	assertSpanAttribute(t, model, "llm.token_count.total", int64(13))
	assertSpanAttribute(t, tool, "openinference.span.kind", "TOOL")
	assertSpanAttribute(t, tool, "tool.name", "read")
	if model.Parent.SpanID() != operation.SpanContext.SpanID() || tool.Parent.SpanID() != operation.SpanContext.SpanID() {
		t.Fatal("model and tool spans must be children of the agent operation")
	}
	if mcp.Parent.SpanID() != startup.SpanContext.SpanID() {
		t.Fatal("MCP span must be a child of startup")
	}
	if operation.Status.Code != codes.Ok || cancelled.Status.Code != codes.Unset || dangling.Status.Code != codes.Error {
		t.Fatalf("unexpected statuses: operation=%v cancelled=%v dangling=%v", operation.Status.Code, cancelled.Status.Code, dangling.Status.Code)
	}
	encoded := fmt.Sprint(spans)
	for _, secret := range []string{"/secret", "secret contents", "private answer", "private error"} {
		if strings.Contains(encoded, secret) {
			t.Fatalf("telemetry leaked private payload %q", secret)
		}
	}
	if err := provider.Shutdown(t.Context()); err != nil {
		t.Fatalf("shutdown telemetry: %v", err)
	}
}

func findSpan(t *testing.T, spans tracetest.SpanStubs, name, identity string) tracetest.SpanStub {
	t.Helper()
	for _, span := range spans {
		if span.Name != name {
			continue
		}
		if identity == "" || spanAttribute(span, "tiny.operation.id") == identity || spanAttribute(span, "tiny.attempt.id") == identity {
			return span
		}
	}
	t.Fatalf("span not found: name=%s identity=%s spans=%v", name, identity, spans)
	return tracetest.SpanStub{}
}

func assertSpanAttribute(t *testing.T, span tracetest.SpanStub, key string, expected any) {
	t.Helper()
	if actual := spanAttribute(span, key); actual != expected {
		t.Fatalf("%s: got %v, want %v", key, actual, expected)
	}
}

func spanAttribute(span tracetest.SpanStub, key string) any {
	for _, value := range span.Attributes {
		if string(value.Key) == key {
			return attributeValue(value.Value)
		}
	}
	return nil
}

func attributeValue(value attribute.Value) any {
	switch value.Type() {
	case attribute.BOOL:
		return value.AsBool()
	case attribute.INT64:
		return value.AsInt64()
	case attribute.FLOAT64:
		return value.AsFloat64()
	case attribute.STRING:
		return value.AsString()
	default:
		return nil
	}
}
