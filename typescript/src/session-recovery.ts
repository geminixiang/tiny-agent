import { SYNTHETIC_CONTENT, type SessionState, type SyntheticReason, type ToolCallState } from "./session-reducer.js";

export { SYNTHETIC_CONTENT };
export type CurrentTool = {
    name: string;
    definitionDigest: string;
    replay: "safe" | "never";
    replayKey: string;
};
export type CurrentConfiguration = {
    configurationDigest: string;
    environmentIdentity: string;
    tools: CurrentTool[];
};
export type SyntheticResult = {
    assistantEntryId: string;
    toolIndex: number;
    toolCallId: string;
    toolName: string;
    toolStartedId?: string;
    resultEntryId?: string;
    reason: SyntheticReason;
    content: string;
};
export type RecoveryPlan =
    | {
          type: "finish";
          outcome: "completed" | "aborted" | "failed";
          completion?: "normal" | "truncated";
          finalEntryId?: string;
          error?: { code: string; message: string };
      }
    | {
          type: "startStep";
          stepKind: "assistant" | "compaction";
          attempt: 1 | 2;
          stepId?: string;
          contextThroughEntryId: string;
      }
    | {
          type: "startTool";
          mode: "start" | "replay";
          assistantEntryId: string;
          toolIndex: number;
          toolStartedId?: string;
          toolName: string;
          arguments: Record<string, unknown>;
      }
    | { type: "appendSynthetic"; results: SyntheticResult[] }
    | { type: "closeAttempt"; error: { code: "aborted"; message: "Operation aborted" } }
    | {
          type: "blocked";
          reason: "configuration_changed" | "environment_changed" | "replay_declaration_changed" | "attempts_exhausted";
      };

function toolDeclaration(current: CurrentConfiguration, name: string) {
    return current.tools.find((tool) => tool.name === name);
}

function startedSynthetic(tool: ToolCallState, reason: "interrupted"): SyntheticResult {
    return {
        assistantEntryId: tool.assistantEntryId,
        toolIndex: tool.toolIndex,
        toolCallId: tool.toolCallId,
        toolName: tool.toolName,
        toolStartedId: tool.toolStartedId,
        resultEntryId: tool.resultEntryId,
        reason,
        content: SYNTHETIC_CONTENT[reason],
    };
}

function assistantCalls(state: SessionState) {
    if (state.operation.kind !== "run" || !state.operation.step?.settledEntryId) return undefined;
    // The current run step is always settled by the transcript's most recent assistant-role
    // message: a new assistant turn can only be committed once every earlier assistant message's
    // tool calls are fully resolved. Filtering this scan down to "the last assistant message that
    // ever had tool calls" is wrong once the current turn's own response is a plain stop (no tool
    // calls) — it then falls back to an older, already-resolved turn and reports its calls as
    // still pending, which plans a stepAttempt against a now-stale contextThroughEntryId.
    const assistantIndex = state.transcript.findLastIndex((item) => item.role === "assistant");
    const message = state.transcript[assistantIndex];
    if (!message || message.role !== "assistant" || !message.tool_calls?.length) return undefined;
    const completedResults = state.transcript.slice(assistantIndex + 1).filter((item) => item.role === "tool").length;
    return {
        assistantEntryId: state.operation.step.settledEntryId,
        calls: message.tool_calls ?? [],
        completedResults,
    };
}

function preExecutionSynthetic(
    assistantEntryId: string,
    toolIndex: number,
    toolCallId: string,
    toolName: string,
    reason: Exclude<SyntheticReason, "interrupted">,
): SyntheticResult {
    return {
        assistantEntryId,
        toolIndex,
        toolCallId,
        toolName,
        reason,
        content: SYNTHETIC_CONTENT[reason],
    };
}

export function planRecovery(state: SessionState, current: CurrentConfiguration): RecoveryPlan {
    const operation = state.operation;
    if (operation.kind === "idle") return { type: "finish", outcome: "completed", completion: "normal" };

    const assistant = assistantCalls(state);
    const pending = operation.kind === "run" ? operation.toolCalls.filter((tool) => tool.status === "pending") : [];
    if (operation.abortRequested) {
        if (operation.step?.status === "attempting")
            return { type: "closeAttempt", error: { code: "aborted", message: "Operation aborted" } };
        if (operation.kind === "run" && assistant) {
            const started = new Map(
                operation.toolCalls.map((tool) => [`${tool.assistantEntryId}:${tool.toolIndex}`, tool]),
            );
            const results = assistant.calls.flatMap((call, toolIndex) => {
                if (toolIndex < assistant.completedResults) return [];
                const tool = started.get(`${assistant.assistantEntryId}:${toolIndex}`);
                if (tool?.status === "pending") return [startedSynthetic(tool, "interrupted")];
                if (tool) return [];
                return [
                    preExecutionSynthetic(
                        assistant.assistantEntryId,
                        toolIndex,
                        call.id,
                        call.function.name,
                        "aborted",
                    ),
                ];
            });
            if (results.length) return { type: "appendSynthetic", results };
        }
        return { type: "finish", outcome: "aborted" };
    }

    if (!operation.step)
        return {
            type: "startStep",
            stepKind: operation.kind === "run" ? "assistant" : "compaction",
            attempt: 1,
            contextThroughEntryId: operation.kind === "run" ? operation.inputEntryId : operation.inputThroughEntryId,
        };

    const step = operation.step;
    if (step.configurationDigest !== current.configurationDigest)
        return { type: "blocked", reason: "configuration_changed" };
    if (state.header.environmentIdentity !== current.environmentIdentity)
        return { type: "blocked", reason: "environment_changed" };
    if (step.status === "failed")
        return {
            type: "finish",
            outcome: "failed",
            error: { code: "model_error", message: "provider request failed" },
        };
    if (step.status === "attempting") {
        if (step.attempt === 2) return { type: "blocked", reason: "attempts_exhausted" };
        return {
            type: "startStep",
            stepKind: step.stepKind,
            attempt: 2,
            stepId: step.stepId,
            contextThroughEntryId: step.contextThroughEntryId,
        };
    }

    if (operation.kind === "compaction")
        return { type: "finish", outcome: "completed", finalEntryId: operation.resultEntryId };

    if (step.stopReason === "length" && assistant) {
        if (assistant.completedResults === assistant.calls.length)
            return {
                type: "finish",
                outcome: "completed",
                completion: "truncated",
                finalEntryId: step.settledEntryId,
            };
        return {
            type: "appendSynthetic",
            results: assistant.calls
                .slice(assistant.completedResults)
                .map((call, offset) =>
                    preExecutionSynthetic(
                        assistant.assistantEntryId,
                        assistant.completedResults + offset,
                        call.id,
                        call.function.name,
                        "truncated",
                    ),
                ),
        };
    }

    if (!assistant)
        return { type: "finish", outcome: "completed", completion: "normal", finalEntryId: step.settledEntryId };

    const processed = new Set(operation.toolCalls.map((tool) => `${tool.assistantEntryId}:${tool.toolIndex}`));
    for (let toolIndex = 0; toolIndex < assistant.completedResults; toolIndex++)
        processed.add(`${assistant.assistantEntryId}:${toolIndex}`);
    const untouched = assistant.calls.findIndex(
        (_, toolIndex) => !processed.has(`${assistant.assistantEntryId}:${toolIndex}`),
    );
    if (untouched >= 0) {
        const call = assistant.calls[untouched];
        const declaration = toolDeclaration(current, call.function.name);
        if (!declaration)
            return {
                type: "appendSynthetic",
                results: [
                    preExecutionSynthetic(
                        assistant.assistantEntryId,
                        untouched,
                        call.id,
                        call.function.name,
                        "unknownTool",
                    ),
                ],
            };
        let args: unknown;
        try {
            args = JSON.parse(call.function.arguments);
        } catch {
            args = undefined;
        }
        if (!args || typeof args !== "object" || Array.isArray(args))
            return {
                type: "appendSynthetic",
                results: [
                    preExecutionSynthetic(
                        assistant.assistantEntryId,
                        untouched,
                        call.id,
                        call.function.name,
                        "invalidArguments",
                    ),
                ],
            };
        return {
            type: "startTool",
            mode: "start",
            assistantEntryId: assistant.assistantEntryId,
            toolIndex: untouched,
            toolName: call.function.name,
            arguments: args as Record<string, unknown>,
        };
    }

    if (!pending.length)
        return {
            type: "startStep",
            stepKind: "assistant",
            attempt: 1,
            contextThroughEntryId: operation.toolCalls.at(-1)!.resultEntryId,
        };
    const tool = pending.sort((left, right) => left.toolIndex - right.toolIndex)[0];
    if (tool.environmentIdentity !== current.environmentIdentity)
        return { type: "blocked", reason: "environment_changed" };
    const declaration = toolDeclaration(current, tool.toolName);
    const recordedDeclaration = step.configurationSnapshot.tools.find((item) => item.name === tool.toolName);
    if (!declaration || !recordedDeclaration || declaration.definitionDigest !== recordedDeclaration.definitionDigest)
        return { type: "blocked", reason: "configuration_changed" };
    if (tool.replay === "safe" && declaration.replay === "safe" && declaration.replayKey === tool.replayKey)
        return {
            type: "startTool",
            mode: "replay",
            assistantEntryId: tool.assistantEntryId,
            toolIndex: tool.toolIndex,
            toolStartedId: tool.toolStartedId,
            toolName: tool.toolName,
            arguments: tool.arguments,
        };
    if (tool.replay === "safe" && (declaration.replay !== "safe" || declaration.replayKey !== tool.replayKey))
        return { type: "blocked", reason: "replay_declaration_changed" };
    return { type: "appendSynthetic", results: [startedSynthetic(tool, "interrupted")] };
}
