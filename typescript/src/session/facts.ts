// Session fact builders: the single place where the agent loop shapes durable
// entries and records. The reducer validates these shapes; the builders keep
// the JSON key names out of the agent loop. See docs/session-design.md.
import type { SessionFactInput } from "./index.js";
import type { SyntheticResult } from "./recovery.js";
import type { ConfigurationSnapshot } from "./reducer.js";
import type { RuntimeMessage, RuntimeUsage } from "./runtime.js";

export type OperationKind = "run" | "compaction";
export type FactError = { code: string; message: string };
type Configuration = { configurationSnapshot: ConfigurationSnapshot; configurationDigest: string };

const when = <T extends object>(value: unknown, fields: T) => (value === undefined ? {} : fields);
const record = (body: Record<string, unknown>, id?: string): SessionFactInput => ({
    kind: "record",
    ...when(id, { id }),
    record: body,
});
const entry = (id: string | undefined, body: Record<string, unknown>): SessionFactInput => ({
    kind: "entry",
    ...when(id, { id }),
    entry: body,
});

export function usageFact(operationId: string, attemptId: string, usage: RuntimeUsage): SessionFactInput {
    return { kind: "usage", operationId, attemptId, usage };
}

export function userMessage(id: string, content: string) {
    return entry(id, { type: "message", message: { role: "user", content } });
}

export function runStarted(operationId: string, inputEntryId: string) {
    return record({ type: "runStarted", operationId, operationKind: "run", inputEntryId });
}

export function compactionStarted(fields: {
    operationId: string;
    inputThroughEntryId: string;
    resultEntryId: string;
    compactedEntryIds: string[];
    retainedEntryIds: string[];
    sourceDigest: string;
}) {
    return record({
        type: "compactionStarted",
        operationId: fields.operationId,
        operationKind: "compaction",
        inputThroughEntryId: fields.inputThroughEntryId,
        resultEntryId: fields.resultEntryId,
        compactedEntryIds: fields.compactedEntryIds,
        retainedEntryIds: fields.retainedEntryIds,
        sourceDigest: fields.sourceDigest,
    });
}

export function stepAttempt(fields: {
    operationId: string;
    stepId: string;
    attemptId: string;
    stepKind: "assistant" | "compaction";
    attempt: number;
    contextThroughEntryId: string;
    configuration: Configuration;
}) {
    const { configuration, ...step } = fields;
    return record({ type: "stepAttempt", ...step, ...configuration });
}

export function stepFailed(operationId: string, stepId: string, attemptId: string, error: FactError) {
    return record({ type: "stepFailed", operationId, stepId, attemptId, error });
}

export function abortRequested(operationId: string, phase: "model" | "tool" | "compact", toolCallId?: string) {
    const operationKind: OperationKind = phase === "compact" ? "compaction" : "run";
    return record({
        type: "abortRequested",
        operationId,
        operationKind,
        phase,
        ...when(toolCallId, { toolCallId }),
        reason: "escape",
    });
}

export function operationFinished(
    operationId: string,
    operationKind: OperationKind,
    outcome: "completed" | "aborted" | "failed",
    extra: { completion?: string; finalEntryId?: string; error?: FactError } = {},
) {
    return record({
        type: "operationFinished",
        operationId,
        operationKind,
        outcome,
        ...when(extra.completion, { completion: extra.completion }),
        ...when(extra.finalEntryId, { finalEntryId: extra.finalEntryId }),
        ...when(extra.error, { error: extra.error }),
    });
}

export function assistantMessage(
    id: string,
    stepId: string,
    attemptId: string,
    stopReason: string,
    message: RuntimeMessage,
) {
    return entry(id, { type: "message", stepId, attemptId, stopReason, message });
}

export function toolStarted(fields: {
    id: string;
    operationId: string;
    stepId: string;
    assistantEntryId: string;
    toolIndex: number;
    toolCallId: string;
    toolName: string;
    arguments: unknown;
    replay: Record<string, unknown>;
    environmentIdentity: string;
    resultEntryId: string;
}) {
    const { id, replay, environmentIdentity, resultEntryId, ...call } = fields;
    return record({ type: "toolStarted", ...call, ...replay, environmentIdentity, resultEntryId }, id);
}

export function toolResult(fields: {
    id: string;
    stepId: string;
    toolStartedId: string;
    toolName: string;
    message: RuntimeMessage;
    outcome: "success" | "error" | "interrupted";
}) {
    const result =
        fields.outcome === "interrupted" ? { type: "synthetic", reason: "interrupted" } : { type: fields.outcome };
    return entry(fields.id, {
        type: "message",
        stepId: fields.stepId,
        message: fields.message,
        toolName: fields.toolName,
        toolStartedId: fields.toolStartedId,
        result,
    });
}

export function syntheticToolResult(stepId: string, result: SyntheticResult) {
    return entry(result.resultEntryId, {
        type: "message",
        stepId,
        ...(result.toolStartedId
            ? { toolStartedId: result.toolStartedId }
            : { assistantEntryId: result.assistantEntryId, toolIndex: result.toolIndex }),
        message: { role: "tool", tool_call_id: result.toolCallId, content: result.content },
        toolName: result.toolName,
        result: { type: "synthetic", reason: result.reason },
    });
}

export function compactionEntry(fields: {
    id: string;
    operationId: string;
    summary: string;
    compactedThroughEntryId: string | undefined;
    retainedTail: { sourceEntryId: string; message: unknown }[];
}) {
    const { id, ...body } = fields;
    return entry(id, { type: "compaction", ...body });
}
