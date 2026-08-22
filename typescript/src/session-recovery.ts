import type { SessionState, ToolCallState } from "./session-reducer.js";

export const SYNTHETIC_CONTENT = {
    invalidArguments: "Error: Tool arguments were invalid; the tool was not executed.",
    unknownTool: "Error: Unknown tool; the tool was not executed.",
    truncated: "Error: Tool call arguments were truncated by the model token limit; the tool was not executed.",
    aborted: "Operation aborted before execution.",
    interrupted: "Operation interrupted after execution status became unknown; the tool was not replayed.",
} as const;

type SyntheticReason = keyof typeof SYNTHETIC_CONTENT;
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

type SyntheticResult = {
    toolCallId: string;
    toolName: string;
    toolStartedId?: string;
    resultEntryId?: string;
    reason: SyntheticReason;
    content: string;
};

function toolDeclaration(current: CurrentConfiguration, name: string) {
    return current.tools.find((tool) => tool.name === name);
}

function synthetic(tool: ToolCallState, reason: SyntheticReason): SyntheticResult {
    return {
        toolCallId: tool.toolCallId,
        toolName: tool.toolName,
        toolStartedId: tool.toolStartedId,
        resultEntryId: tool.resultEntryId,
        reason,
        content: SYNTHETIC_CONTENT[reason],
    };
}

function assistantSynthetic(state: SessionState, reason: SyntheticReason): SyntheticResult[] {
    if (state.operation.kind !== "run" || !state.operation.step?.settledEntryId) return [];
    const message = [...state.transcript]
        .reverse()
        .find((item) => item.role === "assistant" && item.tool_calls?.length);
    if (!message || message.role !== "assistant") return [];
    return (message.tool_calls ?? []).map((call) => ({
        toolCallId: call.id,
        toolName: call.function.name,
        reason,
        content: SYNTHETIC_CONTENT[reason],
    }));
}

export function planRecovery(state: SessionState, current: CurrentConfiguration): RecoveryPlan {
    const operation = state.operation;
    if (operation.kind === "idle") return { type: "finish", outcome: "completed", completion: "normal" };

    const pending = operation.kind === "run" ? operation.toolCalls.filter((tool) => tool.status === "pending") : [];
    if (operation.abortRequested) {
        if (operation.step?.status === "attempting")
            return { type: "closeAttempt", error: { code: "aborted", message: "Operation aborted" } };
        if (pending.length)
            return { type: "appendSynthetic", results: pending.map((tool) => synthetic(tool, "aborted")) };
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
    if (step.status === "failed")
        return {
            type: "finish",
            outcome: "failed",
            error: { code: "model_error", message: "provider request failed" },
        };
    if (step.status === "attempting") {
        if (step.attempt === 2) return { type: "blocked", reason: "attempts_exhausted" };
        if (step.configurationDigest !== current.configurationDigest)
            return { type: "blocked", reason: "configuration_changed" };
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

    if (step.stopReason === "length") {
        const results = assistantSynthetic(state, "truncated");
        if (results.length) return { type: "appendSynthetic", results };
        return { type: "finish", outcome: "completed", completion: "truncated", finalEntryId: step.settledEntryId };
    }

    const assistant = [...state.transcript].reverse().find((message) => message.role === "assistant");
    if (!assistant) return { type: "blocked", reason: "configuration_changed" };
    if (!assistant.tool_calls?.length)
        return { type: "finish", outcome: "completed", completion: "normal", finalEntryId: step.settledEntryId };

    const untouched = assistant.tool_calls.findIndex(
        (call) => !operation.toolCalls.some((tool) => tool.toolCallId === call.id),
    );
    if (untouched >= 0) {
        const call = assistant.tool_calls[untouched];
        const declaration = toolDeclaration(current, call.function.name);
        if (!declaration)
            return {
                type: "appendSynthetic",
                results: [
                    {
                        toolCallId: call.id,
                        toolName: call.function.name,
                        reason: "unknownTool",
                        content: SYNTHETIC_CONTENT.unknownTool,
                    },
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
                    {
                        toolCallId: call.id,
                        toolName: call.function.name,
                        reason: "invalidArguments",
                        content: SYNTHETIC_CONTENT.invalidArguments,
                    },
                ],
            };
        return {
            type: "startTool",
            mode: "start",
            assistantEntryId: step.settledEntryId!,
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
    const tool = pending[0];
    if (tool.environmentIdentity !== current.environmentIdentity)
        return { type: "blocked", reason: "environment_changed" };
    const declaration = toolDeclaration(current, tool.toolName);
    if (!declaration || declaration.definitionDigest === "")
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
    return { type: "appendSynthetic", results: [synthetic(tool, "interrupted")] };
}
