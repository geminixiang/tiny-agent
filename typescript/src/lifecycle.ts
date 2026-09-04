import type { SessionFact } from "./session/index.js";

export type Usage = { input: number; output: number; cacheRead: number; cacheWrite: number; cacheHitRate?: number };
export type LifecycleOutcome = "succeeded" | "failed" | "cancelled" | "effect_unknown";

export type LifecycleEvent =
    | {
          type: "startup.started";
          timestamp: string;
          model: string;
          runtime: "typescript";
          plugins: string[];
          mcp: string[];
      }
    | { type: "session.attached"; timestamp: string; sessionId: string; resumed: boolean }
    | { type: "mcp.started"; timestamp: string; server: string }
    | {
          type: "mcp.completed";
          timestamp: string;
          server: string;
          durationMs: number;
          outcome: "succeeded" | "failed";
          protocolVersion?: string;
          toolCount?: number;
          errorType?: string;
      }
    | {
          type: "startup.completed";
          timestamp: string;
          durationMs: number;
          outcome: "succeeded" | "failed";
          errorType?: string;
      }
    | {
          type: "operation.started" | "operation.recovered";
          timestamp: string;
          sessionId: string;
          operationId: string;
          operationKind: "run" | "compaction";
          recovery: boolean;
      }
    | {
          type: "model.started";
          timestamp: string;
          sessionId: string;
          operationId: string;
          operationKind: "run" | "compaction";
          stepId: string;
          attemptId: string;
          attempt: number;
          recovery: boolean;
      }
    | {
          type: "model.completed";
          timestamp: string;
          sessionId: string;
          operationId: string;
          operationKind: "run" | "compaction";
          stepId: string;
          attemptId: string;
          recovery: boolean;
          durationMs: number;
          outcome: "succeeded" | "failed" | "cancelled" | "effect_unknown";
          usage?: Usage;
          errorType?: string;
      }
    | {
          type: "model.reconciled";
          timestamp: string;
          sessionId: string;
          operationId: string;
          operationKind: "run" | "compaction";
          stepId: string;
          attemptId: string;
          recovery: true;
          outcome: "failed" | "cancelled";
          errorType?: string;
      }
    | {
          type: "tool.admitted";
          timestamp: string;
          sessionId: string;
          operationId: string;
          stepId: string;
          toolStartedId: string;
          toolCallId: string;
          tool: string;
          replay: "safe" | "never";
          recovery: boolean;
      }
    | {
          type: "tool.started";
          timestamp: string;
          sessionId: string;
          operationId: string;
          stepId: string;
          attemptId: string;
          parentAttemptId: string;
          toolStartedId: string;
          toolCallId: string;
          tool: string;
          recovery: boolean;
      }
    | {
          type: "tool.completed";
          timestamp: string;
          sessionId: string;
          operationId: string;
          stepId: string;
          attemptId: string;
          parentAttemptId: string;
          toolStartedId: string;
          toolCallId: string;
          tool: string;
          recovery: boolean;
          durationMs: number;
          outcome: "succeeded" | "failed" | "cancelled" | "effect_unknown";
      }
    | {
          type: "cancel.requested";
          timestamp: string;
          sessionId: string;
          operationId: string;
          operationKind: "run" | "compaction";
          phase: "model" | "tool" | "compact";
          toolCallId?: string;
          recovery: boolean;
      }
    | {
          type: "operation.completed";
          timestamp: string;
          sessionId: string;
          operationId: string;
          operationKind: "run" | "compaction";
          recovery: boolean;
          durationMs: number;
          outcome: "succeeded" | "failed" | "cancelled";
          completion?: "normal" | "truncated";
          answer?: string;
          usage?: Usage;
          errorType?: string;
          errorMessage?: string;
      };

export type LifecycleObservation =
    | Extract<
          LifecycleEvent,
          { type: "startup.started" | "session.attached" | "mcp.started" | "mcp.completed" | "startup.completed" }
      >
    | {
          type: "recovery.attached";
          timestamp: string;
          operationId: string;
          operationKind: "run" | "compaction";
      }
    | Omit<Extract<LifecycleEvent, { type: "tool.started" }>, "sessionId">;

export interface LifecycleSink {
    emit(event: LifecycleEvent): void;
    close(): Promise<void>;
}

export interface ExecutionLifecycle {
    observe(event: LifecycleObservation): void;
    committed(facts: readonly SessionFact[]): void;
    close(): Promise<void>;
}

export const noLifecycle: ExecutionLifecycle = {
    observe() {},
    committed() {},
    async close() {},
};

type Operation = {
    operationKind: "run" | "compaction";
    startedAt: number;
    recovery: boolean;
};

type ModelAttempt = {
    operationId: string;
    operationKind: "run" | "compaction";
    stepId: string;
    attemptId: string;
    startedAt: number;
    recovery: boolean;
};

type ToolAttempt = Omit<Extract<LifecycleEvent, { type: "tool.started" }>, "type" | "sessionId" | "timestamp"> & {
    startedAt: number;
};

export class ExecutionLifecycleProjector implements ExecutionLifecycle {
    private sessionId?: string;
    private readonly operations = new Map<string, Operation>();
    private readonly models = new Map<string, ModelAttempt>();
    private readonly tools = new Map<string, ToolAttempt>();
    private readonly usage = new Map<string, Usage>();
    private readonly operationUsage = new Map<string, Usage>();
    private readonly answers = new Map<string, { operationId: string; content: string }>();

    constructor(private readonly sinks: readonly LifecycleSink[]) {}

    observe(event: LifecycleObservation) {
        try {
            this.applyObservation(event);
        } catch {
            // Lifecycle projections are lossy and never change execution.
        }
    }

    committed(facts: readonly SessionFact[]) {
        try {
            this.applyCommitted(facts);
        } catch {
            // A projection bug or sink failure never invalidates a durable commit.
        }
    }

    async close() {
        this.finishPhysicalAttempts();
        this.answers.clear();
        await Promise.all(
            this.sinks.map(async (sink) => {
                try {
                    await sink.close();
                } catch {
                    // Export and flush failures never replace the agent result.
                }
            }),
        );
    }

    private applyObservation(event: LifecycleObservation) {
        if (event.type === "session.attached") this.sessionId = event.sessionId;
        if (event.type === "recovery.attached") {
            const sessionId = this.sessionId;
            if (!sessionId) return;
            const startedAt = timeValue(event.timestamp);
            this.operations.set(event.operationId, {
                operationKind: event.operationKind,
                startedAt,
                recovery: true,
            });
            this.operationUsage.set(event.operationId, emptyUsage());
            this.publish({
                type: "operation.recovered",
                timestamp: event.timestamp,
                sessionId,
                operationId: event.operationId,
                operationKind: event.operationKind,
                recovery: true,
            });
            return;
        }
        if (event.type === "tool.started") {
            const sessionId = this.sessionId;
            if (!sessionId) return;
            const tool = { ...event, startedAt: timeValue(event.timestamp) };
            this.tools.set(event.toolStartedId, tool);
            this.publish({ ...event, sessionId });
            return;
        }
        this.publish(event);
    }

    private applyCommitted(facts: readonly SessionFact[]) {
        const transactionUsage = new Map<string, Usage>();
        for (const fact of facts) {
            if (fact.kind !== "usage" || typeof fact.attemptId !== "string") continue;
            const usage = usageValue(fact.usage);
            if (!usage) continue;
            transactionUsage.set(fact.attemptId, usage);
            this.usage.set(fact.attemptId, usage);
            if (typeof fact.operationId === "string") this.addOperationUsage(fact.operationId, usage);
        }
        for (const fact of facts) this.applyFact(fact, transactionUsage);
    }

    private applyFact(fact: SessionFact, transactionUsage: ReadonlyMap<string, Usage>) {
        const timestamp = timestampValue(fact.timestamp);
        const record = objectValue(fact.record);
        if (fact.kind === "record" && record) {
            this.applyRecord(fact, record, timestamp);
            return;
        }
        const entry = objectValue(fact.entry);
        if (fact.kind !== "entry" || !entry) return;
        if (entry.type === "message") {
            const message = objectValue(entry.message);
            if (message?.role === "assistant" && typeof entry.attemptId === "string") {
                const attempt = this.models.get(entry.attemptId);
                if (attempt && typeof fact.id === "string" && typeof message.content === "string")
                    this.answers.set(fact.id, { operationId: attempt.operationId, content: message.content });
                this.completeModel(entry.attemptId, timestamp, "succeeded", transactionUsage.get(entry.attemptId));
                return;
            }
            if (message?.role === "tool" && typeof entry.toolStartedId === "string") {
                this.completeTool(entry.toolStartedId, entry, timestamp);
            }
            return;
        }
        if (entry.type !== "compaction" || typeof entry.operationId !== "string") return;
        const attempt = [...this.models.values()].find(
            (candidate) => candidate.operationId === entry.operationId && candidate.operationKind === "compaction",
        );
        if (attempt) this.completeModel(attempt.attemptId, timestamp, "succeeded", this.usage.get(attempt.attemptId));
    }

    private applyRecord(fact: SessionFact, record: Record<string, unknown>, timestamp: string) {
        const sessionId = this.sessionId;
        if (!sessionId) return;
        if (record.type === "runStarted" || record.type === "compactionStarted") {
            if (typeof record.operationId !== "string") return;
            const operationKind = record.type === "runStarted" ? "run" : "compaction";
            this.operations.set(record.operationId, {
                operationKind,
                startedAt: timeValue(timestamp),
                recovery: false,
            });
            this.operationUsage.set(record.operationId, emptyUsage());
            this.publish({
                type: "operation.started",
                timestamp,
                sessionId,
                operationId: record.operationId,
                operationKind,
                recovery: false,
            });
            return;
        }
        if (record.type === "stepAttempt") {
            if (
                typeof record.operationId !== "string" ||
                typeof record.stepId !== "string" ||
                typeof record.attemptId !== "string" ||
                typeof record.attempt !== "number"
            )
                return;
            const operation = this.operations.get(record.operationId);
            const operationKind = record.stepKind === "compaction" ? "compaction" : "run";
            const attempt: ModelAttempt = {
                operationId: record.operationId,
                operationKind,
                stepId: record.stepId,
                attemptId: record.attemptId,
                startedAt: timeValue(timestamp),
                recovery: operation?.recovery ?? false,
            };
            this.models.set(record.attemptId, attempt);
            this.publish({
                type: "model.started",
                timestamp,
                sessionId,
                operationId: attempt.operationId,
                operationKind,
                stepId: attempt.stepId,
                attemptId: attempt.attemptId,
                attempt: record.attempt,
                recovery: attempt.recovery,
            });
            return;
        }
        if (record.type === "stepFailed") {
            if (
                typeof record.operationId !== "string" ||
                typeof record.stepId !== "string" ||
                typeof record.attemptId !== "string"
            )
                return;
            const error = objectValue(record.error);
            const cancelled = error?.code === "aborted";
            if (!this.models.has(record.attemptId) && this.operations.get(record.operationId)?.recovery) {
                const operation = this.operations.get(record.operationId);
                if (!operation) return;
                this.publish({
                    type: "model.reconciled",
                    timestamp,
                    sessionId,
                    operationId: record.operationId,
                    operationKind: operation.operationKind,
                    stepId: record.stepId,
                    attemptId: record.attemptId,
                    recovery: true,
                    outcome: cancelled ? "cancelled" : "failed",
                    ...(typeof error?.code === "string" ? { errorType: error.code } : {}),
                });
                return;
            }
            this.completeModel(
                record.attemptId,
                timestamp,
                cancelled ? "cancelled" : "failed",
                this.usage.get(record.attemptId),
                typeof error?.code === "string" ? error.code : undefined,
            );
            return;
        }
        if (record.type === "toolStarted") {
            if (
                typeof fact.id !== "string" ||
                typeof record.operationId !== "string" ||
                typeof record.stepId !== "string" ||
                typeof record.toolCallId !== "string" ||
                typeof record.toolName !== "string" ||
                (record.replay !== "safe" && record.replay !== "never")
            )
                return;
            this.publish({
                type: "tool.admitted",
                timestamp,
                sessionId,
                operationId: record.operationId,
                stepId: record.stepId,
                toolStartedId: fact.id,
                toolCallId: record.toolCallId,
                tool: record.toolName,
                replay: record.replay,
                recovery: this.operations.get(record.operationId)?.recovery ?? false,
            });
            return;
        }
        if (record.type === "abortRequested") {
            if (
                typeof record.operationId !== "string" ||
                (record.operationKind !== "run" && record.operationKind !== "compaction") ||
                (record.phase !== "model" && record.phase !== "tool" && record.phase !== "compact")
            )
                return;
            this.publish({
                type: "cancel.requested",
                timestamp,
                sessionId,
                operationId: record.operationId,
                operationKind: record.operationKind,
                phase: record.phase,
                ...(typeof record.toolCallId === "string" ? { toolCallId: record.toolCallId } : {}),
                recovery: this.operations.get(record.operationId)?.recovery ?? false,
            });
            return;
        }
        if (record.type !== "operationFinished" || typeof record.operationId !== "string") return;
        const operation = this.operations.get(record.operationId);
        if (!operation) return;
        const error = objectValue(record.error);
        const outcome =
            record.outcome === "completed" ? "succeeded" : record.outcome === "aborted" ? "cancelled" : "failed";
        const finalEntryId = typeof record.finalEntryId === "string" ? record.finalEntryId : undefined;
        const usage = this.operationUsage.get(record.operationId);
        this.publish({
            type: "operation.completed",
            timestamp,
            sessionId,
            operationId: record.operationId,
            operationKind: operation.operationKind,
            recovery: operation.recovery,
            durationMs: duration(operation.startedAt, timestamp),
            outcome,
            ...(record.completion === "normal" || record.completion === "truncated"
                ? { completion: record.completion }
                : {}),
            ...(finalEntryId && this.answers.has(finalEntryId)
                ? { answer: this.answers.get(finalEntryId)?.content }
                : {}),
            ...(usage ? { usage } : {}),
            ...(typeof error?.code === "string" ? { errorType: error.code } : {}),
            ...(typeof error?.message === "string" ? { errorMessage: error.message } : {}),
        });
        this.operations.delete(record.operationId);
        this.operationUsage.delete(record.operationId);
        for (const [entryId, answer] of this.answers) {
            if (answer.operationId === record.operationId) this.answers.delete(entryId);
        }
    }

    private completeModel(
        attemptId: string,
        timestamp: string,
        outcome: "succeeded" | "failed" | "cancelled" | "effect_unknown",
        usage?: Usage,
        errorType?: string,
    ) {
        const sessionId = this.sessionId;
        const attempt = this.models.get(attemptId);
        if (!sessionId || !attempt) return;
        this.publish({
            type: "model.completed",
            timestamp,
            sessionId,
            operationId: attempt.operationId,
            operationKind: attempt.operationKind,
            stepId: attempt.stepId,
            attemptId,
            recovery: attempt.recovery,
            durationMs: duration(attempt.startedAt, timestamp),
            outcome,
            ...(usage ? { usage: withCacheHitRate(usage) } : {}),
            ...(errorType ? { errorType } : {}),
        });
        this.models.delete(attemptId);
        this.usage.delete(attemptId);
    }

    private completeTool(toolStartedId: string, entry: Record<string, unknown>, timestamp: string) {
        const sessionId = this.sessionId;
        const attempt = this.tools.get(toolStartedId);
        if (!sessionId || !attempt) return;
        const result = objectValue(entry.result);
        const outcome =
            result?.type === "success" ? "succeeded" : result?.reason === "interrupted" ? "cancelled" : "failed";
        this.publish({
            type: "tool.completed",
            timestamp,
            sessionId,
            operationId: attempt.operationId,
            stepId: attempt.stepId,
            attemptId: attempt.attemptId,
            parentAttemptId: attempt.parentAttemptId,
            toolStartedId,
            toolCallId: attempt.toolCallId,
            tool: attempt.tool,
            recovery: attempt.recovery,
            durationMs: duration(attempt.startedAt, timestamp),
            outcome,
        });
        this.tools.delete(toolStartedId);
    }

    private finishPhysicalAttempts() {
        const sessionId = this.sessionId;
        if (!sessionId) return;
        const timestamp = new Date().toISOString();
        for (const attempt of this.models.values()) {
            this.completeModel(attempt.attemptId, timestamp, "effect_unknown", this.usage.get(attempt.attemptId));
        }
        for (const [toolStartedId, attempt] of this.tools) {
            this.publish({
                type: "tool.completed",
                timestamp,
                sessionId,
                operationId: attempt.operationId,
                stepId: attempt.stepId,
                attemptId: attempt.attemptId,
                parentAttemptId: attempt.parentAttemptId,
                toolStartedId,
                toolCallId: attempt.toolCallId,
                tool: attempt.tool,
                recovery: attempt.recovery,
                durationMs: duration(attempt.startedAt, timestamp),
                outcome: "effect_unknown",
            });
            this.tools.delete(toolStartedId);
        }
    }

    private addOperationUsage(operationId: string, usage: Usage) {
        const current = this.operationUsage.get(operationId) ?? emptyUsage();
        current.input += usage.input;
        current.output += usage.output;
        current.cacheRead += usage.cacheRead;
        current.cacheWrite += usage.cacheWrite;
        current.cacheHitRate = withCacheHitRate(usage).cacheHitRate;
        this.operationUsage.set(operationId, current);
    }

    private publish(event: LifecycleEvent) {
        for (const sink of this.sinks) {
            try {
                sink.emit(event);
            } catch {
                // One broken projection must not block the others.
            }
        }
    }
}

export function callbackSink(emit: (event: LifecycleEvent) => void): LifecycleSink {
    return { emit, async close() {} };
}

function objectValue(value: unknown) {
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function usageValue(value: unknown): Usage | undefined {
    const usage = objectValue(value);
    if (!usage) return undefined;
    const input = numberValue(usage.input);
    const output = numberValue(usage.output);
    const cacheRead = numberValue(usage.cacheRead);
    const cacheWrite = numberValue(usage.cacheWrite);
    if (input === undefined || output === undefined || cacheRead === undefined || cacheWrite === undefined)
        return undefined;
    return { input, output, cacheRead, cacheWrite };
}

function emptyUsage(): Usage {
    return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
}

function withCacheHitRate(usage: Usage): Usage {
    const prompt = usage.input + usage.cacheRead + usage.cacheWrite;
    return { ...usage, cacheHitRate: prompt ? (usage.cacheRead / prompt) * 100 : 0 };
}

function numberValue(value: unknown) {
    return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function timestampValue(value: unknown) {
    return new Date(typeof value === "number" ? value : Date.now()).toISOString();
}

function timeValue(value: string) {
    const time = new Date(value).getTime();
    return Number.isFinite(time) ? time : Date.now();
}

function duration(startedAt: number, timestamp: string) {
    return Math.max(0, timeValue(timestamp) - startedAt);
}
