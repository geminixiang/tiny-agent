import { ROOT_CONTEXT, SpanStatusCode, trace, type Context, type Span, type Tracer } from "@opentelemetry/api";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto";
import { defaultResource, detectResources, envDetector, resourceFromAttributes } from "@opentelemetry/resources";
import { BatchSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import type { LifecycleEvent, LifecycleOutcome, LifecycleSink, Usage } from "./lifecycle.js";

export const noTelemetry: LifecycleSink = {
    emit() {},
    async close() {},
};

type ActiveSpan = { span: Span; context: Context };

export class OpenTelemetryMonitor implements LifecycleSink {
    private startup?: ActiveSpan;
    private readonly operations = new Map<string, ActiveSpan>();
    private readonly models = new Map<string, Span>();
    private readonly tools = new Map<string, Span>();
    private readonly mcp = new Map<string, Span>();
    private model?: string;

    constructor(
        private readonly tracer: Tracer,
        private readonly shutdown: () => Promise<void> = async () => {},
    ) {}

    emit(event: LifecycleEvent) {
        try {
            this.record(event);
        } catch {
            // Telemetry is a lossy projection and must never change agent execution.
        }
    }

    async close() {
        this.finishDangling();
        try {
            await this.shutdown();
        } catch {
            // Export and flush failures never replace the agent result.
        }
    }

    private record(event: LifecycleEvent) {
        switch (event.type) {
            case "startup.started":
                this.startStartup(event);
                return;
            case "mcp.started":
                this.startMcp(event);
                return;
            case "mcp.completed":
                this.endMcp(event);
                return;
            case "startup.completed":
                this.endStartup(event);
                return;
            case "operation.started":
            case "operation.recovered":
                this.startOperation(event);
                return;
            case "model.started":
                this.startModel(event);
                return;
            case "model.completed":
                this.endModel(event);
                return;
            case "model.reconciled":
                this.operations.get(event.operationId)?.span.addEvent(
                    "model.reconciled",
                    compactAttributes({
                        "tiny.step.id": event.stepId,
                        "tiny.attempt.id": event.attemptId,
                        "tiny.outcome": event.outcome,
                        "error.type": event.errorType,
                    }),
                    eventTime(event),
                );
                return;
            case "tool.admitted":
                this.operations.get(event.operationId)?.span.addEvent(
                    "tool.admitted",
                    {
                        "tiny.step.id": event.stepId,
                        "tiny.tool.started.id": event.toolStartedId,
                        "gen_ai.tool.call.id": event.toolCallId,
                        "gen_ai.tool.name": event.tool,
                        "tiny.tool.replay": event.replay,
                    },
                    eventTime(event),
                );
                return;
            case "tool.started":
                this.startTool(event);
                return;
            case "tool.completed":
                this.endTool(event);
                return;
            case "cancel.requested":
                this.operations.get(event.operationId)?.span.addEvent(
                    "cancel.requested",
                    {
                        "tiny.cancel.phase": event.phase,
                        ...(event.toolCallId ? { "gen_ai.tool.call.id": event.toolCallId } : {}),
                    },
                    eventTime(event),
                );
                return;
            case "operation.completed":
                this.endOperation(event);
                return;
            case "session.attached":
                return;
        }
    }

    private startStartup(event: Extract<LifecycleEvent, { type: "startup.started" }>) {
        if (this.startup) endSpan(this.startup.span, "effect_unknown");
        this.model = event.model;
        const span = this.tracer.startSpan("tiny.startup", {
            startTime: eventTime(event),
            attributes: {
                "tiny.runtime.language": event.runtime,
                "tiny.plugin.count": event.plugins.length,
                "tiny.mcp.server_count": event.mcp.length,
            },
        });
        this.startup = { span, context: trace.setSpan(ROOT_CONTEXT, span) };
    }

    private startMcp(event: Extract<LifecycleEvent, { type: "mcp.started" }>) {
        const existing = this.mcp.get(event.server);
        if (existing) endSpan(existing, "effect_unknown");
        const span = this.tracer.startSpan(
            "tiny.mcp.connect",
            { startTime: eventTime(event), attributes: { "tiny.mcp.server": event.server } },
            this.startup?.context ?? ROOT_CONTEXT,
        );
        this.mcp.set(event.server, span);
    }

    private endMcp(event: Extract<LifecycleEvent, { type: "mcp.completed" }>) {
        const span = this.mcp.get(event.server);
        if (!span) return;
        span.setAttributes(
            compactAttributes({
                "tiny.outcome": event.outcome,
                "tiny.mcp.protocol_version": event.protocolVersion,
                "tiny.mcp.tool_count": event.toolCount,
                "error.type": event.errorType,
            }),
        );
        endSpan(span, event.outcome, eventTime(event));
        this.mcp.delete(event.server);
    }

    private endStartup(event: Extract<LifecycleEvent, { type: "startup.completed" }>) {
        const startup = this.startup;
        if (!startup) return;
        startup.span.setAttributes(compactAttributes({ "tiny.outcome": event.outcome, "error.type": event.errorType }));
        endSpan(startup.span, event.outcome, eventTime(event));
        this.startup = undefined;
    }

    private startOperation(event: Extract<LifecycleEvent, { type: "operation.started" | "operation.recovered" }>) {
        const existing = this.operations.get(event.operationId);
        if (existing) endSpan(existing.span, "effect_unknown");
        const span = this.tracer.startSpan("tiny.agent.operation", {
            startTime: eventTime(event),
            attributes: {
                "openinference.span.kind": "AGENT",
                "gen_ai.operation.name": "invoke_agent",
                "gen_ai.conversation.id": event.sessionId,
                "session.id": event.sessionId,
                "tiny.session.id": event.sessionId,
                "tiny.operation.id": event.operationId,
                "tiny.operation.kind": event.operationKind,
                "tiny.recovery": event.recovery,
                "tiny.runtime.language": "typescript",
            },
        });
        this.operations.set(event.operationId, { span, context: trace.setSpan(ROOT_CONTEXT, span) });
    }

    private startModel(event: Extract<LifecycleEvent, { type: "model.started" }>) {
        const parent = this.operations.get(event.operationId);
        if (!parent) return;
        const span = this.tracer.startSpan(
            "tiny.model.request",
            {
                startTime: eventTime(event),
                attributes: compactAttributes({
                    "openinference.span.kind": "LLM",
                    "gen_ai.operation.name": "chat",
                    "gen_ai.conversation.id": event.sessionId,
                    "gen_ai.request.model": this.model,
                    "llm.model_name": this.model,
                    "session.id": event.sessionId,
                    "tiny.session.id": event.sessionId,
                    "tiny.operation.id": event.operationId,
                    "tiny.operation.kind": event.operationKind,
                    "tiny.step.id": event.stepId,
                    "tiny.attempt.id": event.attemptId,
                    "tiny.attempt.number": event.attempt,
                    "tiny.recovery": event.recovery,
                }),
            },
            parent.context,
        );
        this.models.set(event.attemptId, span);
    }

    private endModel(event: Extract<LifecycleEvent, { type: "model.completed" }>) {
        const span = this.models.get(event.attemptId);
        if (!span) return;
        span.setAttributes(
            compactAttributes({
                "tiny.outcome": event.outcome,
                "error.type": event.errorType,
                ...usageAttributes(event.usage),
            }),
        );
        endSpan(span, event.outcome, eventTime(event));
        this.models.delete(event.attemptId);
    }

    private startTool(event: Extract<LifecycleEvent, { type: "tool.started" }>) {
        const parent = this.operations.get(event.operationId);
        if (!parent) return;
        const existing = this.tools.get(event.attemptId);
        if (existing) endSpan(existing, "effect_unknown");
        const span = this.tracer.startSpan(
            "tiny.tool.execute",
            {
                startTime: eventTime(event),
                attributes: {
                    "openinference.span.kind": "TOOL",
                    "gen_ai.operation.name": "execute_tool",
                    "gen_ai.conversation.id": event.sessionId,
                    "gen_ai.tool.call.id": event.toolCallId,
                    "gen_ai.tool.name": event.tool,
                    "session.id": event.sessionId,
                    "tool.name": event.tool,
                    "tiny.session.id": event.sessionId,
                    "tiny.operation.id": event.operationId,
                    "tiny.step.id": event.stepId,
                    "tiny.attempt.id": event.attemptId,
                    "tiny.parent_attempt.id": event.parentAttemptId,
                    "tiny.tool.started.id": event.toolStartedId,
                    "tiny.recovery": event.recovery,
                },
            },
            parent.context,
        );
        this.tools.set(event.attemptId, span);
    }

    private endTool(event: Extract<LifecycleEvent, { type: "tool.completed" }>) {
        const span = this.tools.get(event.attemptId);
        if (!span) return;
        span.setAttribute("tiny.outcome", event.outcome);
        endSpan(span, event.outcome, eventTime(event));
        this.tools.delete(event.attemptId);
    }

    private endOperation(event: Extract<LifecycleEvent, { type: "operation.completed" }>) {
        const operation = this.operations.get(event.operationId);
        if (!operation) return;
        operation.span.setAttributes(
            compactAttributes({
                "tiny.outcome": event.outcome,
                "tiny.operation.completion": event.completion,
                "error.type": event.errorType,
            }),
        );
        endSpan(operation.span, event.outcome, eventTime(event));
        this.operations.delete(event.operationId);
    }

    private finishDangling() {
        for (const span of this.mcp.values()) endSpan(span, "effect_unknown");
        for (const span of this.models.values()) endSpan(span, "effect_unknown");
        for (const span of this.tools.values()) endSpan(span, "effect_unknown");
        for (const operation of this.operations.values()) endSpan(operation.span, "effect_unknown");
        if (this.startup) endSpan(this.startup.span, "effect_unknown");
        this.mcp.clear();
        this.models.clear();
        this.tools.clear();
        this.operations.clear();
        this.startup = undefined;
    }
}

export async function createTelemetry(env: NodeJS.ProcessEnv = process.env): Promise<LifecycleSink> {
    if (!telemetryEnabled(env)) return noTelemetry;
    try {
        const detected = await detectResources({ detectors: [envDetector] });
        const serviceName = env.OTEL_SERVICE_NAME || "tiny-ts";
        const resource = defaultResource()
            .merge(detected)
            .merge(resourceFromAttributes({ "service.name": serviceName, "openinference.project.name": serviceName }));
        const provider = new NodeTracerProvider({
            resource,
            spanProcessors: [new BatchSpanProcessor(new OTLPTraceExporter())],
        });
        provider.register();
        return new OpenTelemetryMonitor(provider.getTracer("tiny-agent", "1"), () => provider.shutdown());
    } catch {
        return noTelemetry;
    }
}

function telemetryEnabled(env: NodeJS.ProcessEnv) {
    if (env.OTEL_SDK_DISABLED?.toLowerCase() === "true") return false;
    return Boolean(env.OTEL_EXPORTER_OTLP_ENDPOINT || env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT);
}

function eventTime(event: { timestamp: string }) {
    const date = new Date(event.timestamp);
    return Number.isNaN(date.getTime()) ? new Date() : date;
}

function usageAttributes(usage: Usage | undefined) {
    const input = usage ? usage.input + usage.cacheRead + usage.cacheWrite : undefined;
    const total = input === undefined || usage === undefined ? undefined : input + usage.output;
    return {
        "gen_ai.usage.input_tokens": input,
        "gen_ai.usage.output_tokens": usage?.output,
        "gen_ai.usage.cache_read.input_tokens": usage?.cacheRead,
        "gen_ai.usage.cache_creation.input_tokens": usage?.cacheWrite,
        "llm.token_count.prompt": input,
        "llm.token_count.completion": usage?.output,
        "llm.token_count.total": total,
        "tiny.usage.input_tokens": usage?.input,
        "tiny.usage.cache_read_tokens": usage?.cacheRead,
        "tiny.usage.cache_write_tokens": usage?.cacheWrite,
    };
}

function endSpan(span: Span, outcome: LifecycleOutcome | "succeeded" | "failed", endTime?: Date) {
    span.setAttribute("tiny.outcome", outcome);
    if (outcome === "succeeded") span.setStatus({ code: SpanStatusCode.OK });
    else if (outcome !== "cancelled") span.setStatus({ code: SpanStatusCode.ERROR });
    span.end(endTime);
}

function compactAttributes(values: Record<string, string | number | boolean | undefined>) {
    return Object.fromEntries(
        Object.entries(values).filter((entry): entry is [string, string | number | boolean] => entry[1] !== undefined),
    );
}
