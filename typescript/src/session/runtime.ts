import { canonicalDigest } from "../canonical-json.js";
import { MODEL } from "../env.js";
import type { SessionFactInput, SessionStore } from "./index.js";
import type { CurrentConfiguration } from "./recovery.js";
import { runStarted, userMessage } from "./facts.js";
import type { ConfigurationSnapshot, SessionState, ToolCall } from "./reducer.js";
import { durableToolReplay, type Tool } from "../tools.js";

export type RuntimeMessage = {
    role: "system" | "user" | "assistant" | "tool";
    content: string | null;
    tool_call_id?: string;
    tool_calls?: ToolCall[];
};

export type RuntimeUsage = {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    cacheHitRate?: number;
};

export type RuntimeConfiguration = {
    configurationSnapshot: ConfigurationSnapshot;
    configurationDigest: string;
};

export function buildConfiguration(systemPrompt: string, tools: readonly Tool[]): RuntimeConfiguration {
    const configurationSnapshot: ConfigurationSnapshot = {
        model: MODEL,
        systemPromptDigest: canonicalDigest(systemPrompt),
        tools: tools.map((tool) => ({
            name: tool.name,
            definitionDigest: canonicalDigest({
                name: tool.name,
                description: tool.description,
                parameters: tool.parameters,
                ...(tool.definitionIdentity ? { definitionIdentity: tool.definitionIdentity } : {}),
            }),
        })),
        adapterIdentity: "openrouter:chat-completions:v1",
        routingIdentity: `openrouter:${MODEL}`,
        outputOptionsDigest: canonicalDigest({}),
    };
    return { configurationSnapshot, configurationDigest: canonicalDigest(configurationSnapshot) };
}

export function currentConfiguration(
    configuration: RuntimeConfiguration,
    tools: readonly Tool[],
    environmentIdentity: string,
): CurrentConfiguration {
    return {
        configurationDigest: configuration.configurationDigest,
        environmentIdentity,
        tools: tools.map((tool, index) => ({
            ...configuration.configurationSnapshot.tools[index],
            ...durableToolReplay(tool),
        })),
    };
}

export function runFacts(session: SessionStore, content: string) {
    const inputEntryId = session.allocateId();
    const operationId = session.allocateId();
    return {
        inputEntryId,
        operationId,
        facts: [userMessage(inputEntryId, content), runStarted(operationId, inputEntryId)] satisfies SessionFactInput[],
    };
}

export function sourceDigest(source: readonly { id: string; message: unknown }[]): string {
    return canonicalDigest(source.map((item) => ({ sourceEntryId: item.id, message: item.message })));
}

export function projectSession(
    state: SessionState,
    systemMessage: RuntimeMessage,
): { messages: RuntimeMessage[]; usage: RuntimeUsage } {
    return {
        messages: [systemMessage, ...state.activeContext],
        usage: { ...state.usage },
    };
}
