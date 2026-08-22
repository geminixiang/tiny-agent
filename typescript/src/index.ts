import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { environmentIdentity, SessionStore, type SessionFactInput } from "./session.js";
import { planRecovery, SYNTHETIC_CONTENT, type SyntheticResult } from "./session-recovery.js";
import { builtInTools, toolDefinitions, type Tool, type ToolArgs, type ToolEvent } from "./tools.js";

export { loadMcpConfigs, type McpServerCatalog } from "./mcp-config.js";
export { displayToolName, loadMcpTools, type LoadedMcpTools, type McpConfig } from "./mcp.js";
export {
    planRecovery,
    SYNTHETIC_CONTENT,
    type CurrentConfiguration,
    type CurrentTool,
    type RecoveryPlan,
} from "./session-recovery.js";
export { SessionStore, SessionStore as Session, environmentIdentity } from "./session.js";
export { reduceSession, SessionCorruption, type SessionCorruptionCode, type SessionState } from "./session-reducer.js";
export {
    builtInPlugins,
    builtInTools,
    executeTool,
    formatToolEvent,
    type Plugin,
    type Tool,
    type ToolArgs,
    type ToolEvent,
} from "./tools.js";

export const MODEL = process.env.TINY_MODEL || "deepseek/deepseek-v4-flash-0731";
const root = process.cwd();
type Message = {
    role: "system" | "user" | "assistant" | "tool";
    content: string | null;
    tool_call_id?: string;
    tool_calls?: ToolCall[];
};
type ToolCall = { id: string; type: "function"; function: { name: string; arguments: string } };
type Skill = { name: string; description: string; path: string };
export type Usage = {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    cacheHitRate?: number;
};

export type RunResult = {
    status: "succeeded" | "failed" | "cancelled";
    answer?: string;
    cause?: string;
    message?: string;
    sessionId: string;
    usage: Usage;
};
export type RunEvent =
    | { type: "model.completed"; timestamp: string; durationMs: number; usage: Usage }
    | { type: "tool.started"; timestamp: string; toolCallId: string; tool: string }
    | {
          type: "tool.completed";
          timestamp: string;
          toolCallId: string;
          tool: string;
          durationMs: number;
          ok: boolean;
      }
    | {
          type: "mcp.connected";
          timestamp: string;
          server: string;
          protocolEra: "modern" | "legacy";
          protocolVersion: string;
          toolCount: number;
          durationMs: number;
      }
    | { type: "mcp.failed"; timestamp: string; server: string; stage: "connect"; cause: string };

type ConfigurationSnapshot = {
    model: string;
    systemPromptDigest: string;
    tools: { name: string; definitionDigest: string }[];
    adapterIdentity: string;
    routingIdentity: string;
    outputOptionsDigest: string;
};

function canonical(value: unknown): string {
    if (value === null || typeof value === "boolean" || typeof value === "number") return JSON.stringify(value);
    if (typeof value === "string") return JSON.stringify(value);
    if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
    if (!value || typeof value !== "object") throw Error("unsupported canonical value");
    const item = value as Record<string, unknown>;
    return `{${Object.keys(item)
        .sort()
        .map((key) => `${JSON.stringify(key)}:${canonical(item[key])}`)
        .join(",")}}`;
}

function digest(value: unknown) {
    return `sha256:${createHash("sha256").update(canonical(value)).digest("hex")}`;
}

export function buildConfiguration(systemPrompt: string, tools: Tool[]) {
    const configurationSnapshot: ConfigurationSnapshot = {
        model: MODEL,
        systemPromptDigest: digest(systemPrompt),
        tools: tools.map((tool) => ({
            name: tool.name,
            definitionDigest: digest({
                name: tool.name,
                description: tool.description,
                parameters: tool.parameters,
            }),
        })),
        adapterIdentity: "openrouter:chat-completions:v1",
        routingIdentity: `openrouter:${MODEL}`,
        outputOptionsDigest: digest({}),
    };
    return { configurationSnapshot, configurationDigest: digest(configurationSnapshot) };
}

export function runFacts(session: SessionStore, content: string) {
    const inputEntryId = session.allocateId();
    const operationId = session.allocateId();
    return {
        inputEntryId,
        operationId,
        facts: [
            { kind: "entry", id: inputEntryId, entry: { type: "message", message: { role: "user", content } } },
            {
                kind: "record",
                record: { type: "runStarted", operationId, operationKind: "run", inputEntryId },
            },
        ] satisfies SessionFactInput[],
    };
}

// prettier-ignore
function formatTokens(n: number) { return n < 1e3 ? `${n}` : n < 1e4 ? `${(n / 1e3).toFixed(1)}k` : n < 1e6 ? `${Math.round(n / 1e3)}k` : n < 1e7 ? `${(n / 1e6).toFixed(1)}M` : `${Math.round(n / 1e6)}M`; }

// prettier-ignore
export function formatUsage({ input, output, cacheRead, cacheWrite, cacheHitRate }: Usage) { return [`↑${formatTokens(input)}`, `↓${formatTokens(output)}`, cacheRead && `R${formatTokens(cacheRead)}`, cacheWrite && `W${formatTokens(cacheWrite)}`, (cacheRead > 0 || cacheWrite > 0) && cacheHitRate !== undefined && `CH${cacheHitRate.toFixed(1)}%`].filter(Boolean).join(" "); }

async function findSkillFiles(dir: string): Promise<string[]> {
    const out: string[] = [];
    for (const e of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
        if (e.isDirectory()) out.push(...(await findSkillFiles(resolve(dir, e.name))));
        else if (e.name === "SKILL.md") out.push(resolve(dir, e.name));
    }
    return out;
}

export async function loadProjectInstructions(cwd = root) {
    return readFile(resolve(cwd, "AGENTS.md"), "utf8").catch(() => "");
}

export async function loadSkills(extra: string[] = []) {
    const files = [
        ...new Set([
            ...(await findSkillFiles(resolve(root, ".tiny-agent/skills"))),
            ...extra.map((path) => resolve(path)),
        ]),
    ];
    return Promise.all(
        files.map(async (path) => {
            const text = await readFile(path, "utf8"),
                head = text.match(/^---\n([\s\S]*?)\n---/)?.[1] ?? "";
            const field = (key: string) => head.match(new RegExp(`^${key}:\\s*["']?(.*?)["']?$`, "m"))?.[1] ?? "";
            return {
                name: field("name") || basename(dirname(path)),
                description: field("description"),
                path,
            };
        }),
    );
}

type StopReason = "stop" | "length" | "toolUse";

function stopReason(finishReason: string | null | undefined, message: Message): StopReason {
    if (finishReason === "length") return "length";
    if (finishReason === "tool_calls" || finishReason === "function_call") return "toolUse";
    if (finishReason === "content_filter" || finishReason === "network_error")
        throw Error(`Provider finish_reason: ${finishReason}`);
    if (finishReason && finishReason !== "stop") throw Error(`Unknown provider finish_reason: ${finishReason}`);
    return message.tool_calls?.length ? "toolUse" : "stop";
}

function parseToolArgs(value: string): ToolArgs {
    const args: unknown = JSON.parse(value);
    if (args === null || typeof args !== "object" || Array.isArray(args)) {
        throw Error("tool arguments must be a JSON object");
    }
    return args as ToolArgs;
}

export class Agent {
    messages: Message[];
    usage: Usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    public readonly systemPrompt: string;
    private active?: {
        controller: AbortController;
        phase: "model" | "tool" | "compact";
        toolCallId?: string;
    };
    constructor(
        public skills: Skill[] = [],
        public fetcher: typeof fetch = fetch,
        public session?: SessionStore,
        public onTool: (event: ToolEvent) => void = () => {},
        instructions = "",
        public onEvent: (event: RunEvent) => void = () => {},
        public tools: Tool[] = builtInTools,
    ) {
        const duplicate = tools.find(
            (tool, index) => tools.findIndex((candidate) => candidate.name === tool.name) !== index,
        );
        if (duplicate) throw Error(`duplicate tool name: ${duplicate.name}`);
        const list =
            skills
                .map(
                    (s) =>
                        `<skill>\n<name>${s.name}</name>\n<description>${s.description}</description>\n<location>${s.path}</location>\n</skill>`,
                )
                .join("\n") || "(none)";
        const project = instructions
            ? `\n\n<project_context>\n\nProject-specific instructions and guidelines:\n\n<project_instructions path="${resolve(root, "AGENTS.md")}">\n${instructions}\n</project_instructions>\n\n</project_context>`
            : "";
        this.systemPrompt = `You are tiny-agent, a concise coding agent in ${root}. Use only the tools provided in this request. If the available tools cannot complete the task, explain the missing capability instead of calling an unavailable tool. Follow the project instructions below. When a task matches an available skill, use its location only when a provided tool can read it.

For implementation tasks, inspect only what is needed, then make the changes and run focused tests. Do not keep researching the same uncertainty when a mature dependency or direct implementation is available.
Use the provided tool descriptions to choose the right capability. Not every run enables file access, shell access, or file modification.
Prefer completing a small working implementation over exhaustively researching every option. If repeated experiments fail, reconsider the approach instead of making another similar attempt.${project}

<available_skills>
${list}
</available_skills>`;
        this.messages = [{ role: "system", content: this.systemPrompt }];
    }
    get busy() {
        return !!this.active;
    }
    abort() {
        this.active?.controller.abort();
    }
    private beginOperation(phase: "model" | "tool" | "compact", toolCallId?: string) {
        const controller = new AbortController();
        this.active = { controller, phase, toolCallId };
        return controller.signal;
    }
    private endOperation() {
        this.active = undefined;
    }
    private async recordAbort(operationId: string, phase: "model" | "tool" | "compact", toolCallId?: string) {
        await this.session?.append({
            kind: "record",
            record: {
                type: "abortRequested",
                operationId,
                operationKind: phase === "compact" ? "compaction" : "run",
                phase,
                ...(toolCallId ? { toolCallId } : {}),
                reason: "escape",
            },
        });
    }
    private async runModelRequest(
        messages: Message[],
        tools: unknown,
        phase: "model" | "compact",
        operationId: string,
        stepId: string,
        attemptId: string,
    ) {
        const signal = this.beginOperation(phase),
            started = performance.now();
        try {
            const response = await this.callModel(messages, tools, signal);
            this.onEvent({
                type: "model.completed",
                timestamp: new Date().toISOString(),
                durationMs: performance.now() - started,
                usage: {
                    ...response.usage,
                    ...(response.cacheHitRate === undefined ? {} : { cacheHitRate: response.cacheHitRate }),
                },
            });
            return response;
        } catch (error) {
            if (!signal.aborted) throw error;
            await this.recordAbort(operationId, phase);
            await this.session?.append({
                kind: "record",
                record: {
                    type: "stepFailed",
                    operationId,
                    stepId,
                    attemptId,
                    error: { code: "aborted", message: "Operation aborted" },
                },
            });
        } finally {
            this.endOperation();
        }
    }
    async resumeSession() {
        if (!this.session) return;
        let recoveryError: Error | undefined;
        for (;;) {
            const state = await this.session.load();
            this.restoreState(state);
            if (state.operation.kind === "idle") {
                if (recoveryError) throw recoveryError;
                return;
            }
            const operation = state.operation;
            if (operation.kind === "compaction") throw Error("Compaction requires Phase 2b durable integration");

            const configuration = buildConfiguration(this.systemPrompt, this.tools);
            const current = {
                configurationDigest: configuration.configurationDigest,
                environmentIdentity: await environmentIdentity(state.header.cwd),
                tools: configuration.configurationSnapshot.tools.map((snapshot) => {
                    const tool = this.tools.find((candidate) => candidate.name === snapshot.name)!;
                    return {
                        ...snapshot,
                        replay: tool.replay ?? "never",
                        replayKey: tool.replayKey ?? `tool:${tool.name}:v1`,
                    };
                }),
            };
            const plan = planRecovery(state, current);
            const operationId = operation.operationId;
            if (plan.type === "blocked") {
                if (plan.reason !== "attempts_exhausted") throw Error(`Session recovery blocked: ${plan.reason}`);
                await this.session.append({
                    kind: "record",
                    record: {
                        type: "operationFinished",
                        operationId,
                        operationKind: "run",
                        outcome: "failed",
                        error: { code: "model_error", message: "provider request attempts exhausted" },
                    },
                });
                continue;
            }
            if (plan.type === "finish") {
                await this.session.append({
                    kind: "record",
                    record: {
                        type: "operationFinished",
                        operationId,
                        operationKind: "run",
                        outcome: plan.outcome,
                        ...(plan.completion ? { completion: plan.completion } : {}),
                        ...(plan.finalEntryId ? { finalEntryId: plan.finalEntryId } : {}),
                        ...(plan.error ? { error: plan.error } : {}),
                    },
                });
                continue;
            }
            if (plan.type === "closeAttempt") {
                const step = state.operation.step!;
                await this.session.append({
                    kind: "record",
                    record: {
                        type: "stepFailed",
                        operationId,
                        stepId: step.stepId,
                        attemptId: step.attemptId,
                        error: plan.error,
                    },
                });
                continue;
            }
            if (plan.type === "appendSynthetic") {
                await this.session.append(
                    plan.results.map((result) => this.syntheticRecoveryFact(operation.step!.stepId, result)),
                );
                continue;
            }
            if (plan.type === "startTool") {
                await this.executeRecoveryTool(state, plan);
                continue;
            }

            const stepId = plan.stepId ?? this.session.allocateId();
            const attemptId = this.session.allocateId();
            await this.session.append({
                kind: "record",
                record: {
                    type: "stepAttempt",
                    operationId,
                    stepId,
                    attemptId,
                    stepKind: plan.stepKind,
                    attempt: plan.attempt,
                    contextThroughEntryId: plan.contextThroughEntryId,
                    ...configuration,
                },
            });
            try {
                const response = await this.runModelRequest(
                    this.messages,
                    toolDefinitions(this.tools),
                    "model",
                    operationId,
                    stepId,
                    attemptId,
                );
                if (!response) continue;
                const assistantEntryId = this.session.allocateId();
                await this.session.append([
                    {
                        kind: "entry",
                        id: assistantEntryId,
                        entry: {
                            type: "message",
                            stepId,
                            attemptId,
                            stopReason: response.stopReason,
                            message: response.message,
                        },
                    },
                    { kind: "usage", operationId, attemptId, usage: response.usage },
                ]);
            } catch (error) {
                recoveryError = error instanceof Error ? error : Error(String(error));
                await this.session.append({
                    kind: "record",
                    record: {
                        type: "stepFailed",
                        operationId,
                        stepId,
                        attemptId,
                        error: { code: "model_error", message: recoveryError.message },
                    },
                });
            }
        }
    }
    private restoreState(state: Awaited<ReturnType<SessionStore["load"]>>) {
        this.messages = [this.messages[0], ...state.activeContext];
        this.usage = { ...state.usage };
        const totalPrompt = this.usage.input + this.usage.cacheRead + this.usage.cacheWrite;
        if (totalPrompt > 0) this.usage.cacheHitRate = (this.usage.cacheRead / totalPrompt) * 100;
    }
    private syntheticRecoveryFact(stepId: string, result: SyntheticResult): SessionFactInput {
        return {
            kind: "entry",
            id: result.resultEntryId,
            entry: {
                type: "message",
                stepId,
                ...(result.toolStartedId
                    ? { toolStartedId: result.toolStartedId }
                    : { assistantEntryId: result.assistantEntryId, toolIndex: result.toolIndex }),
                message: { role: "tool", tool_call_id: result.toolCallId, content: result.content },
                toolName: result.toolName,
                result: { type: "synthetic", reason: result.reason },
            },
        };
    }
    private async executeRecoveryTool(
        state: Awaited<ReturnType<SessionStore["load"]>>,
        plan: Extract<ReturnType<typeof planRecovery>, { type: "startTool" }>,
    ) {
        if (!this.session || state.operation.kind !== "run" || !state.operation.step) return;
        const tool = this.tools.find((candidate) => candidate.name === plan.toolName)!;
        let toolStartedId = plan.toolStartedId;
        let resultEntryId: string;
        if (plan.mode === "start") {
            toolStartedId = this.session.allocateId();
            resultEntryId = this.session.allocateId();
            await this.session.append({
                kind: "record",
                id: toolStartedId,
                record: {
                    type: "toolStarted",
                    operationId: state.operation.operationId,
                    stepId: state.operation.step.stepId,
                    assistantEntryId: plan.assistantEntryId,
                    toolIndex: plan.toolIndex,
                    toolCallId: this.recoveryToolCallId(state, plan.assistantEntryId, plan.toolIndex),
                    toolName: plan.toolName,
                    arguments: plan.arguments,
                    replay: tool.replay ?? "never",
                    replayKey: tool.replayKey ?? `tool:${tool.name}:v1`,
                    environmentIdentity: state.header.environmentIdentity,
                    resultEntryId,
                },
            });
        } else {
            const pending = state.operation.toolCalls.find((call) => call.toolStartedId === toolStartedId)!;
            resultEntryId = pending.resultEntryId;
        }
        const toolCallId = this.recoveryToolCallId(state, plan.assistantEntryId, plan.toolIndex);
        let content: string;
        let result: { type: "success" } | { type: "error" } = { type: "success" };
        try {
            content = await tool.execute(plan.arguments, this.beginOperation("tool", toolCallId));
        } catch (error) {
            content = `Error: ${error instanceof Error ? error.message : String(error)}`;
            result = { type: "error" };
        } finally {
            this.endOperation();
        }
        await this.session.append({
            kind: "entry",
            id: resultEntryId,
            entry: {
                type: "message",
                stepId: state.operation.step.stepId,
                message: { role: "tool", tool_call_id: toolCallId, content },
                toolName: plan.toolName,
                toolStartedId,
                result,
            },
        });
    }
    private recoveryToolCallId(
        state: Awaited<ReturnType<SessionStore["load"]>>,
        assistantEntryId: string,
        toolIndex: number,
    ) {
        const assistant = state.transcript.findLast(
            (message) => message.role === "assistant" && message.tool_calls?.[toolIndex],
        );
        if (!assistant || assistant.role !== "assistant") throw Error(`Missing recovery tool call ${assistantEntryId}`);
        return assistant.tool_calls![toolIndex].id;
    }
    async callModel(messages = this.messages, tools: unknown = toolDefinitions(this.tools), signal?: AbortSignal) {
        const key = process.env.OPENROUTER_API_KEY;
        if (!key) throw Error("Set OPENROUTER_API_KEY");
        const body = { model: MODEL, messages, ...(tools ? { tools } : {}) };
        const r = await this.fetcher("https://openrouter.ai/api/v1/chat/completions", {
            method: "POST",
            signal,
            headers: {
                Authorization: `Bearer ${key}`,
                "Content-Type": "application/json",
                "HTTP-Referer": "https://github.com/geminixiang/tiny-agent",
            },
            body: JSON.stringify(body),
        });
        if (!r.ok) throw Error(`OpenRouter ${r.status}: ${await r.text()}`);
        const data = (await r.json()) as any,
            u = data.usage ?? {},
            details = u.prompt_tokens_details ?? {};
        const cacheRead = details.cached_tokens ?? u.prompt_cache_hit_tokens ?? 0,
            cacheWrite = details.cache_write_tokens ?? 0;
        const input = Math.max(0, (u.prompt_tokens ?? 0) - cacheRead - cacheWrite);
        this.usage.input += input;
        this.usage.output += u.completion_tokens ?? 0;
        this.usage.cacheRead += cacheRead;
        this.usage.cacheWrite += cacheWrite;
        const prompt = input + cacheRead + cacheWrite,
            cacheHitRate = prompt > 0 ? (cacheRead / prompt) * 100 : undefined;
        const totalPrompt = this.usage.input + this.usage.cacheRead + this.usage.cacheWrite;
        if (totalPrompt > 0) this.usage.cacheHitRate = (this.usage.cacheRead / totalPrompt) * 100;
        const choice = data.choices?.[0];
        if (!choice?.message) throw Error("OpenRouter returned no assistant message");
        return {
            message: choice.message as Message,
            stopReason: stopReason(choice.finish_reason, choice.message),
            usage: { input, output: u.completion_tokens ?? 0, cacheRead, cacheWrite },
            cacheHitRate,
        };
    }
    async runAgentLoop(text: string) {
        if (!this.session) throw Error("Session is required");
        const accepted = runFacts(this.session, text);
        await this.session.append(accepted.facts);
        const user: Message = { role: "user", content: text };
        this.messages.push(user);
        const operationId = accepted.operationId;
        let contextThroughEntryId = accepted.inputEntryId;
        const configuration = buildConfiguration(this.systemPrompt, this.tools);
        const finish = (outcome: "completed" | "aborted" | "failed", extra: Record<string, unknown> = {}) =>
            this.session!.append({
                kind: "record",
                record: { type: "operationFinished", operationId, operationKind: "run", outcome, ...extra },
            });
        for (;;) {
            const stepId = this.session.allocateId();
            const attemptId = this.session.allocateId();
            await this.session.append({
                kind: "record",
                record: {
                    type: "stepAttempt",
                    operationId,
                    stepId,
                    attemptId,
                    stepKind: "assistant",
                    attempt: 1,
                    contextThroughEntryId,
                    ...configuration,
                },
            });
            let response: Awaited<ReturnType<Agent["callModel"]>> | undefined;
            try {
                response = await this.runModelRequest(
                    this.messages,
                    toolDefinitions(this.tools),
                    "model",
                    operationId,
                    stepId,
                    attemptId,
                );
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                await this.session.append([
                    {
                        kind: "record",
                        record: {
                            type: "stepFailed",
                            operationId,
                            stepId,
                            attemptId,
                            error: { code: "model_error", message },
                        },
                    },
                    {
                        kind: "record",
                        record: {
                            type: "operationFinished",
                            operationId,
                            operationKind: "run",
                            outcome: "failed",
                            error: { code: "model_error", message },
                        },
                    },
                ]);
                throw error;
            }
            if (!response) {
                await finish("aborted");
                return "Operation aborted.";
            }
            const { message: answer, usage, stopReason } = response;
            const assistantEntryId = this.session.allocateId();
            await this.session.append([
                {
                    kind: "entry",
                    id: assistantEntryId,
                    entry: { type: "message", stepId, attemptId, stopReason, message: answer },
                },
                { kind: "usage", operationId, attemptId, usage },
            ]);
            this.messages.push(answer);
            contextThroughEntryId = assistantEntryId;
            if (!answer.tool_calls?.length) {
                if (!answer.content?.trim()) {
                    const message = `Model returned an empty response (finish_reason: ${stopReason}).`;
                    await finish("failed", { error: { code: "empty_response", message } });
                    throw Error(message);
                }
                await finish("completed", {
                    completion: "normal",
                    finalEntryId: assistantEntryId,
                });
                return answer.content;
            }
            for (let i = 0; i < answer.tool_calls.length; i++) {
                const call = answer.tool_calls[i];
                let args: ToolArgs = {};
                const tool = this.tools.find((candidate) => candidate.name === call.function.name);
                const synthetic = async (reason: "invalidArguments" | "unknownTool" | "truncated" | "aborted") => {
                    const result: Message = {
                        role: "tool",
                        tool_call_id: call.id,
                        content: SYNTHETIC_CONTENT[reason],
                    };
                    const id = this.session!.allocateId();
                    await this.session!.append({
                        kind: "entry",
                        id,
                        entry: {
                            type: "message",
                            stepId,
                            assistantEntryId,
                            toolIndex: i,
                            message: result,
                            toolName: call.function.name,
                            result: { type: "synthetic", reason },
                        },
                    });
                    this.messages.push(result);
                    contextThroughEntryId = id;
                };
                if (stopReason === "length") {
                    await synthetic("truncated");
                    continue;
                }
                try {
                    args = parseToolArgs(call.function.arguments);
                } catch {
                    await synthetic("invalidArguments");
                    continue;
                }
                if (!tool) {
                    await synthetic("unknownTool");
                    continue;
                }
                const toolStartedId = this.session.allocateId();
                const resultEntryId = this.session.allocateId();
                const environment = (await this.session.load()).header.environmentIdentity;
                await this.session.append({
                    kind: "record",
                    id: toolStartedId,
                    record: {
                        type: "toolStarted",
                        operationId,
                        stepId,
                        assistantEntryId,
                        toolIndex: i,
                        toolCallId: call.id,
                        toolName: tool.name,
                        arguments: args,
                        replay: tool.replay ?? "never",
                        replayKey: tool.replayKey ?? `tool:${tool.name}:v1`,
                        environmentIdentity: environment,
                        resultEntryId,
                    },
                });
                const started = performance.now();
                let content: string,
                    aborted = false,
                    ok = false;
                this.onEvent({
                    type: "tool.started",
                    timestamp: new Date().toISOString(),
                    toolCallId: call.id,
                    tool: tool.name,
                });
                this.onTool({ phase: "start", name: tool.name, args });
                try {
                    content = await tool.execute(args, this.beginOperation("tool", call.id));
                    ok = true;
                } catch (error) {
                    aborted = !!this.active?.controller.signal.aborted;
                    content = aborted
                        ? "Operation interrupted after execution status became unknown; the tool was not replayed."
                        : `Error: ${error instanceof Error ? error.message : error}`;
                }
                this.endOperation();
                this.onTool({ phase: "end", name: tool.name, args, result: content });
                this.onEvent({
                    type: "tool.completed",
                    timestamp: new Date().toISOString(),
                    toolCallId: call.id,
                    tool: tool.name,
                    durationMs: performance.now() - started,
                    ok,
                });
                if (aborted) await this.recordAbort(operationId, "tool", call.id);
                const result: Message = { role: "tool", tool_call_id: call.id, content };
                await this.session.append({
                    kind: "entry",
                    id: resultEntryId,
                    entry: {
                        type: "message",
                        stepId,
                        message: result,
                        toolName: tool.name,
                        toolStartedId,
                        result: aborted
                            ? { type: "synthetic", reason: "interrupted" }
                            : { type: ok ? "success" : "error" },
                    },
                });
                this.messages.push(result);
                contextThroughEntryId = resultEntryId;
                if (!aborted) continue;
                for (let pendingIndex = i + 1; pendingIndex < answer.tool_calls.length; pendingIndex++) {
                    i = pendingIndex;
                    await synthetic("aborted");
                }
                await finish("aborted");
                return "Operation aborted.";
            }
            if (stopReason !== "length") continue;
            await finish("completed", { completion: "truncated", finalEntryId: assistantEntryId });
            return answer.content?.trim() || "Model output was truncated.";
        }
    }
    async compact() {
        throw Error("Compaction requires Phase 2b durable integration");
    }
}
