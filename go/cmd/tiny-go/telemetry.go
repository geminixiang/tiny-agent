package main

import (
	"context"
	"strings"
	"sync"
	"time"

	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/codes"
	"go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracehttp"
	"go.opentelemetry.io/otel/sdk/resource"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/trace"
)

type openTelemetryMonitor struct {
	mu         sync.Mutex
	provider   *sdktrace.TracerProvider
	tracer     trace.Tracer
	startup    trace.Span
	operations map[string]trace.Span
	models     map[string]trace.Span
	tools      map[string]trace.Span
	mcp        map[string]trace.Span
	model      string
}

func newOpenTelemetryMonitor(env map[string]string) lifecycleSink {
	if strings.EqualFold(env["OTEL_SDK_DISABLED"], "true") || (env["OTEL_EXPORTER_OTLP_ENDPOINT"] == "" && env["OTEL_EXPORTER_OTLP_TRACES_ENDPOINT"] == "") {
		return callbackLifecycleSink(func(map[string]any) {})
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	exporter, err := otlptracehttp.New(ctx)
	if err != nil {
		return callbackLifecycleSink(func(map[string]any) {})
	}
	serviceName := env["OTEL_SERVICE_NAME"]
	if serviceName == "" {
		serviceName = "tiny-go"
	}
	base, err := resource.Merge(resource.Default(), resource.NewWithAttributes("", attribute.String("service.name", serviceName), attribute.String("openinference.project.name", serviceName)))
	if err != nil {
		return callbackLifecycleSink(func(map[string]any) {})
	}
	provider := sdktrace.NewTracerProvider(sdktrace.WithResource(base), sdktrace.WithBatcher(exporter))
	return &openTelemetryMonitor{
		provider: provider, tracer: provider.Tracer("tiny-agent"),
		operations: map[string]trace.Span{}, models: map[string]trace.Span{}, tools: map[string]trace.Span{}, mcp: map[string]trace.Span{},
	}
}

func (m *openTelemetryMonitor) Emit(event map[string]any) {
	m.mu.Lock()
	defer m.mu.Unlock()
	timestamp := lifecycleTime(event["timestamp"])
	switch stringValue(event["type"]) {
	case "startup.started":
		if m.startup != nil {
			endTelemetrySpan(m.startup, "effect_unknown", timestamp)
		}
		m.model = stringValue(event["model"])
		_, m.startup = m.tracer.Start(context.Background(), "tiny.startup", trace.WithTimestamp(timestamp), trace.WithAttributes(
			attribute.String("tiny.runtime.language", stringValue(event["runtime"])),
			attribute.Int("tiny.plugin.count", sliceLength(event["plugins"])),
			attribute.Int("tiny.mcp.server_count", sliceLength(event["mcp"])),
		))
	case "mcp.started":
		if m.startup == nil {
			return
		}
		server := stringValue(event["server"])
		_, span := m.tracer.Start(trace.ContextWithSpan(context.Background(), m.startup), "tiny.mcp.connect", trace.WithTimestamp(timestamp), trace.WithAttributes(attribute.String("tiny.mcp.server", server)))
		m.mcp[server] = span
	case "mcp.completed":
		server := stringValue(event["server"])
		span := m.mcp[server]
		if span == nil {
			return
		}
		setTelemetryAttributes(span, map[string]any{"tiny.mcp.protocol_version": event["protocolVersion"], "tiny.mcp.tool_count": event["toolCount"], "error.type": event["errorType"]})
		endTelemetrySpan(span, stringValue(event["outcome"]), timestamp)
		delete(m.mcp, server)
	case "startup.completed":
		if m.startup == nil {
			return
		}
		setTelemetryAttributes(m.startup, map[string]any{"error.type": event["errorType"]})
		endTelemetrySpan(m.startup, stringValue(event["outcome"]), timestamp)
		m.startup = nil
	case "operation.started", "operation.recovered":
		id := stringValue(event["operationId"])
		if old := m.operations[id]; old != nil {
			endTelemetrySpan(old, "effect_unknown", timestamp)
		}
		_, span := m.tracer.Start(context.Background(), "tiny.agent.operation", trace.WithTimestamp(timestamp), trace.WithAttributes(telemetryAttributes(map[string]any{
			"openinference.span.kind": "AGENT", "gen_ai.operation.name": "invoke_agent", "gen_ai.conversation.id": event["sessionId"], "session.id": event["sessionId"],
			"tiny.session.id": event["sessionId"], "tiny.operation.id": id, "tiny.operation.kind": event["operationKind"], "tiny.recovery": event["recovery"], "tiny.runtime.language": "go",
		})...))
		m.operations[id] = span
	case "model.started":
		parent := m.operations[stringValue(event["operationId"])]
		if parent == nil {
			return
		}
		id := stringValue(event["attemptId"])
		_, span := m.tracer.Start(trace.ContextWithSpan(context.Background(), parent), "tiny.model.request", trace.WithTimestamp(timestamp), trace.WithAttributes(telemetryAttributes(map[string]any{
			"openinference.span.kind": "LLM", "gen_ai.operation.name": "chat", "gen_ai.conversation.id": event["sessionId"], "gen_ai.request.model": m.model, "llm.model_name": m.model, "session.id": event["sessionId"],
			"tiny.session.id": event["sessionId"], "tiny.operation.id": event["operationId"], "tiny.operation.kind": event["operationKind"], "tiny.step.id": event["stepId"], "tiny.attempt.id": id, "tiny.attempt.number": event["attempt"], "tiny.recovery": event["recovery"],
		})...))
		m.models[id] = span
	case "model.completed":
		id := stringValue(event["attemptId"])
		span := m.models[id]
		if span == nil {
			return
		}
		setTelemetryAttributes(span, usageTelemetryAttributes(event["usage"]))
		setTelemetryAttributes(span, map[string]any{"error.type": event["errorType"]})
		endTelemetrySpan(span, stringValue(event["outcome"]), timestamp)
		delete(m.models, id)
	case "model.reconciled", "tool.admitted", "cancel.requested":
		span := m.operations[stringValue(event["operationId"])]
		if span != nil {
			span.AddEvent(stringValue(event["type"]), trace.WithTimestamp(timestamp), trace.WithAttributes(telemetryAttributes(event)...))
		}
	case "tool.started":
		parent := m.operations[stringValue(event["operationId"])]
		if parent == nil {
			return
		}
		id := stringValue(event["attemptId"])
		_, span := m.tracer.Start(trace.ContextWithSpan(context.Background(), parent), "tiny.tool.execute", trace.WithTimestamp(timestamp), trace.WithAttributes(telemetryAttributes(map[string]any{
			"openinference.span.kind": "TOOL", "gen_ai.operation.name": "execute_tool", "gen_ai.conversation.id": event["sessionId"], "gen_ai.tool.call.id": event["toolCallId"], "gen_ai.tool.name": event["tool"], "session.id": event["sessionId"], "tool.name": event["tool"],
			"tiny.session.id": event["sessionId"], "tiny.operation.id": event["operationId"], "tiny.step.id": event["stepId"], "tiny.attempt.id": id, "tiny.parent_attempt.id": event["parentAttemptId"], "tiny.tool.started.id": event["toolStartedId"], "tiny.recovery": event["recovery"],
		})...))
		m.tools[id] = span
	case "tool.completed":
		id := stringValue(event["attemptId"])
		span := m.tools[id]
		if span == nil {
			return
		}
		endTelemetrySpan(span, stringValue(event["outcome"]), timestamp)
		delete(m.tools, id)
	case "operation.completed":
		id := stringValue(event["operationId"])
		span := m.operations[id]
		if span == nil {
			return
		}
		setTelemetryAttributes(span, map[string]any{"tiny.operation.completion": event["completion"], "error.type": event["errorType"]})
		endTelemetrySpan(span, stringValue(event["outcome"]), timestamp)
		delete(m.operations, id)
	}
}

func (m *openTelemetryMonitor) Close() error {
	m.mu.Lock()
	timestamp := time.Now()
	if m.startup != nil {
		endTelemetrySpan(m.startup, "effect_unknown", timestamp)
	}
	for _, spans := range []map[string]trace.Span{m.mcp, m.models, m.tools, m.operations} {
		for _, span := range spans {
			endTelemetrySpan(span, "effect_unknown", timestamp)
		}
	}
	m.mu.Unlock()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	return m.provider.Shutdown(ctx)
}

func usageTelemetryAttributes(value any) map[string]any {
	usage, ok := lifecycleUsage(value)
	if !ok {
		return nil
	}
	input := usage.Input + usage.CacheRead + usage.CacheWrite
	return map[string]any{
		"gen_ai.usage.input_tokens": input, "gen_ai.usage.output_tokens": usage.Output,
		"gen_ai.usage.cache_read.input_tokens": usage.CacheRead, "gen_ai.usage.cache_creation.input_tokens": usage.CacheWrite,
		"llm.token_count.prompt": input, "llm.token_count.completion": usage.Output, "llm.token_count.total": input + usage.Output,
		"tiny.usage.input_tokens": usage.Input, "tiny.usage.cache_read_tokens": usage.CacheRead, "tiny.usage.cache_write_tokens": usage.CacheWrite,
	}
}

func setTelemetryAttributes(span trace.Span, values map[string]any) {
	span.SetAttributes(telemetryAttributes(values)...)
}
func telemetryAttributes(values map[string]any) []attribute.KeyValue {
	result := make([]attribute.KeyValue, 0, len(values))
	for key, value := range values {
		switch value := value.(type) {
		case string:
			if value != "" {
				result = append(result, attribute.String(key, value))
			}
		case bool:
			result = append(result, attribute.Bool(key, value))
		case int:
			result = append(result, attribute.Int(key, value))
		case int64:
			result = append(result, attribute.Int64(key, value))
		case float64:
			result = append(result, attribute.Float64(key, value))
		}
	}
	return result
}
func endTelemetrySpan(span trace.Span, outcome string, timestamp time.Time) {
	span.SetAttributes(attribute.String("tiny.outcome", outcome))
	if outcome == "succeeded" {
		span.SetStatus(codes.Ok, "")
	} else if outcome != "cancelled" {
		span.SetStatus(codes.Error, outcome)
	}
	span.End(trace.WithTimestamp(timestamp))
}
func sliceLength(value any) int {
	if values, ok := value.([]string); ok {
		return len(values)
	}
	if values, ok := value.([]any); ok {
		return len(values)
	}
	return 0
}
