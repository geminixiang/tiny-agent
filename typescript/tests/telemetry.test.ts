import assert from "node:assert/strict";
import test from "node:test";
import { InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import type { LifecycleEvent } from "../src/lifecycle.js";
import { OpenTelemetryMonitor, createTelemetry, noTelemetry } from "../src/telemetry.js";

const sessionId = "session-1";
const operationId = "operation-1";

function event<T extends LifecycleEvent>(value: T) {
    return value;
}

test("projects canonical lifecycle events into startup and operation span trees", async () => {
    const exporter = new InMemorySpanExporter();
    const provider = new NodeTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
    const monitor = new OpenTelemetryMonitor(provider.getTracer("test"), () => provider.shutdown());

    monitor.emit(
        event({
            type: "startup.started",
            timestamp: "2026-01-01T00:00:00.000Z",
            model: "test-model",
            runtime: "typescript",
            plugins: ["read"],
            mcp: ["fixture"],
        }),
    );
    monitor.emit(event({ type: "mcp.started", timestamp: "2026-01-01T00:00:00.010Z", server: "fixture" }));
    monitor.emit(
        event({
            type: "mcp.completed",
            timestamp: "2026-01-01T00:00:00.020Z",
            server: "fixture",
            durationMs: 10,
            outcome: "succeeded",
            protocolVersion: "2026-07-28",
            toolCount: 1,
        }),
    );
    monitor.emit(
        event({
            type: "startup.completed",
            timestamp: "2026-01-01T00:00:00.030Z",
            durationMs: 30,
            outcome: "succeeded",
        }),
    );
    monitor.emit(
        event({
            type: "operation.started",
            timestamp: "2026-01-01T00:00:00.040Z",
            sessionId,
            operationId,
            operationKind: "run",
            recovery: false,
        }),
    );
    monitor.emit(
        event({
            type: "model.started",
            timestamp: "2026-01-01T00:00:00.050Z",
            sessionId,
            operationId,
            operationKind: "run",
            stepId: "step-1",
            attemptId: "attempt-1",
            attempt: 1,
            recovery: false,
        }),
    );
    monitor.emit(
        event({
            type: "model.completed",
            timestamp: "2026-01-01T00:00:00.100Z",
            sessionId,
            operationId,
            operationKind: "run",
            stepId: "step-1",
            attemptId: "attempt-1",
            recovery: false,
            durationMs: 50,
            outcome: "succeeded",
            usage: { input: 7, output: 2, cacheRead: 3, cacheWrite: 1, cacheHitRate: 27.27 },
        }),
    );
    monitor.emit({
        type: "tool.started",
        timestamp: "2026-01-01T00:00:00.110Z",
        sessionId,
        operationId,
        stepId: "step-1",
        attemptId: "tool-attempt-1",
        parentAttemptId: "attempt-1",
        toolStartedId: "tool-started-1",
        recovery: false,
        toolCallId: "call-1",
        tool: "read",
        args: { path: "/secret" },
    } as LifecycleEvent);
    monitor.emit({
        type: "tool.completed",
        timestamp: "2026-01-01T00:00:00.130Z",
        sessionId,
        operationId,
        stepId: "step-1",
        attemptId: "tool-attempt-1",
        parentAttemptId: "attempt-1",
        toolStartedId: "tool-started-1",
        recovery: false,
        toolCallId: "call-1",
        tool: "read",
        durationMs: 20,
        outcome: "succeeded",
        result: "secret contents",
    } as LifecycleEvent);
    monitor.emit(
        event({
            type: "operation.completed",
            timestamp: "2026-01-01T00:00:00.150Z",
            sessionId,
            operationId,
            operationKind: "run",
            recovery: false,
            durationMs: 110,
            outcome: "succeeded",
            completion: "normal",
        }),
    );
    await provider.forceFlush();

    const spans = exporter.getFinishedSpans();
    assert.deepEqual(
        spans.map((span) => span.name),
        ["tiny.mcp.connect", "tiny.startup", "tiny.model.request", "tiny.tool.execute", "tiny.agent.operation"],
    );
    const startup = spans.find((span) => span.name === "tiny.startup")!;
    const mcp = spans.find((span) => span.name === "tiny.mcp.connect")!;
    const operation = spans.find((span) => span.name === "tiny.agent.operation")!;
    const model = spans.find((span) => span.name === "tiny.model.request")!;
    const tool = spans.find((span) => span.name === "tiny.tool.execute")!;
    assert.equal(operation.attributes["tiny.session.id"], sessionId);
    assert.equal(operation.attributes["tiny.operation.id"], operationId);
    assert.equal(operation.attributes["tiny.outcome"], "succeeded");
    assert.equal(model.attributes["gen_ai.usage.input_tokens"], 7);
    assert.equal(model.attributes["tiny.usage.cache_read_tokens"], 3);
    assert.equal(tool.attributes["gen_ai.tool.name"], "read");
    assert.equal(tool.attributes["tiny.attempt.id"], "tool-attempt-1");
    assert.equal(model.parentSpanContext?.spanId, operation.spanContext().spanId);
    assert.equal(tool.parentSpanContext?.spanId, operation.spanContext().spanId);
    assert.equal(mcp.parentSpanContext?.spanId, startup.spanContext().spanId);
    const encoded = JSON.stringify(spans.map((span) => span.attributes));
    assert.doesNotMatch(encoded, /\/secret|secret contents/);
    await monitor.close();
});

test("records recovery as a new trace segment with the same durable operation identity", async () => {
    const exporter = new InMemorySpanExporter();
    const provider = new NodeTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
    const monitor = new OpenTelemetryMonitor(provider.getTracer("test"), () => provider.shutdown());

    monitor.emit(
        event({
            type: "operation.recovered",
            timestamp: "2026-01-01T00:00:00.000Z",
            sessionId,
            operationId,
            operationKind: "run",
            recovery: true,
        }),
    );
    monitor.emit(
        event({
            type: "cancel.requested",
            timestamp: "2026-01-01T00:00:00.010Z",
            sessionId,
            operationId,
            operationKind: "run",
            phase: "model",
            recovery: true,
        }),
    );
    monitor.emit(
        event({
            type: "operation.completed",
            timestamp: "2026-01-01T00:00:00.020Z",
            sessionId,
            operationId,
            operationKind: "run",
            recovery: true,
            durationMs: 20,
            outcome: "cancelled",
        }),
    );
    await provider.forceFlush();

    const span = exporter.getFinishedSpans()[0];
    assert.equal(span.name, "tiny.agent.operation");
    assert.equal(span.attributes["tiny.operation.id"], operationId);
    assert.equal(span.attributes["tiny.recovery"], true);
    assert.equal(span.events[0].name, "cancel.requested");
    await monitor.close();
});

test("does not export canonical answers or error messages", async () => {
    const exporter = new InMemorySpanExporter();
    const provider = new NodeTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
    const monitor = new OpenTelemetryMonitor(provider.getTracer("test"), () => provider.shutdown());
    monitor.emit(
        event({
            type: "operation.started",
            timestamp: "2026-01-01T00:00:00.000Z",
            sessionId,
            operationId,
            operationKind: "run",
            recovery: false,
        }),
    );
    monitor.emit(
        event({
            type: "operation.completed",
            timestamp: "2026-01-01T00:00:00.010Z",
            sessionId,
            operationId,
            operationKind: "run",
            recovery: false,
            durationMs: 10,
            outcome: "failed",
            answer: "private answer",
            errorType: "model_error",
            errorMessage: "private API key failure",
        }),
    );
    await provider.forceFlush();

    const attributes = JSON.stringify(exporter.getFinishedSpans()[0].attributes);
    assert.doesNotMatch(attributes, /private answer|private API key failure/);
    await monitor.close();
});

test("OpenTelemetry stays disabled without a trusted OTLP endpoint", async () => {
    assert.equal(await createTelemetry({}), noTelemetry);
    assert.equal(
        await createTelemetry({ OTEL_SDK_DISABLED: "true", OTEL_EXPORTER_OTLP_ENDPOINT: "http://localhost:4318" }),
        noTelemetry,
    );
});
