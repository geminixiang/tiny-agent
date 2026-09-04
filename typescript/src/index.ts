import { readFile, readdir } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { ENDPOINT, MODEL, chatCompletionsUrl, requireOpenRouterApiKey } from "./env.js";
import { type ExecutionLifecycle, noLifecycle } from "./lifecycle.js";
import {
    buildConfiguration,
    currentConfiguration,
    projectSession,
    runFacts,
    sourceDigest,
    syntheticToolResult,
    type RuntimeMessage as Message,
    type RuntimeUsage as Usage,
} from "./session-runtime.js";
import { environmentIdentity, SessionStore } from "./session.js";
import { planRecovery, SYNTHETIC_CONTENT } from "./session-recovery.js";
import { expect } from "./session-reducer.js";
import {
    builtInTools,
    durableToolReplay,
    executeDurableTool,
    toolDefinitions,
    type Tool,
    type ToolArgs,
    type ToolEvent,
} from "./tools.js";

export { displayToolName } from "./mcp.js";
export {
    ExecutionLifecycleProjector,
    callbackSink,
    noLifecycle,
    type ExecutionLifecycle,
    type LifecycleEvent,
    type LifecycleObservation,
    type LifecycleSink,
} from "./lifecycle.js";
export {
    planRecovery,
    SYNTHETIC_CONTENT,
    type CurrentConfiguration,
    type CurrentTool,
    type RecoveryPlan,
} from "./session-recovery.js";
export {
    buildConfiguration,
    currentConfiguration,
    projectSession,
    runFacts,
    sourceDigest,
    syntheticToolResult,
    type RuntimeConfiguration,
    type RuntimeMessage,
    type RuntimeUsage,
} from "./session-runtime.js";
export { SessionStore, SessionStore as Session, environmentIdentity } from "./session.js";
export { reduceSession, SessionCorruption, type SessionCorruptionCode, type SessionState } from "./session-reducer.js";
export {
    builtInPlugins,
    builtInTools,
    durableToolReplay,
    closeBackgroundProcesses,
    executeTool,
    formatToolEvent,
    type Plugin,
    type Tool,
    type ToolArgs,
    type ToolEvent,
} from "./tools.js";

export { ENDPOINT, MODEL };
function root() {
    return process.cwd();
}
type Skill = { name: string; description: string; path: string };
export type { RuntimeUsage as Usage } from "./session-runtime.js";

class ModelResponseError extends Error {
    constructor(
        message: string,
        readonly usage: Usage,
    ) {
        super(message);
    }
}

function usageFactIfModelError(error: unknown, operationId: string, attemptId: string) {
    return error instanceof ModelResponseError
        ? [{ kind: "usage" as const, operationId, attemptId, usage: error.usage }]
        : [];
}

// Names the `...(condition ? { field } : {})` idiom used to conditionally include an optional
// key in an object literal, instead of repeating the ternary-spread at every call site.
function when<T extends object>(condition: unknown, value: T): T | Record<string, never> {
    return condition ? value : {};
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

export async function loadProjectInstructions(cwd = root()) {
    return readFile(resolve(cwd, "AGENTS.md"), "utf8").catch(() => "");
}

export async function loadSkills(extra: string[] = []) {
    const files = [
        ...new Set([
            ...(await findSkillFiles(resolve(root(), ".tiny-agent/skills"))),
            ...extra.map((path) => resolve(path)),
        ]),
    ];
    return Promise.all(
        files.map(async (path) => {
            const text = await readFile(path, "utf8");
            const head = text.match(/^---\n([\s\S]*?)\n---/)?.[1] ?? "";
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

function normalizeAssistantMessage(value: unknown): Message {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw Error("invalid assistant message");
    const message = value as Record<string, unknown>;
    if (message.role !== "assistant") throw Error("invalid assistant message role");
    if (message.content !== null && typeof message.content !== "string") throw Error("invalid assistant content");
    const normalized: Message = { role: "assistant", content: message.content };
    if (message.tool_calls === undefined || message.tool_calls === null) return normalized;
    if (!Array.isArray(message.tool_calls) || !message.tool_calls.length) throw Error("invalid assistant tool_calls");
    normalized.tool_calls = message.tool_calls.map((value) => {
        if (!value || typeof value !== "object" || Array.isArray(value)) throw Error("invalid assistant tool call");
        const call = value as Record<string, unknown>;
        const fn = call.function;
        if (
            typeof call.id !== "string" ||
            !call.id ||
            call.type !== "function" ||
            !fn ||
            typeof fn !== "object" ||
            Array.isArray(fn)
        )
            throw Error("invalid assistant tool call");
        const definition = fn as Record<string, unknown>;
        if (typeof definition.name !== "string" || !definition.name || typeof definition.arguments !== "string")
            throw Error("invalid assistant tool call function");
        return {
            id: call.id,
            type: "function",
            function: { name: definition.name, arguments: definition.arguments },
        };
    });
    return normalized;
}

function stopReason(finishReason: string | null | undefined, message: Message): StopReason {
    if (finishReason === "length") return "length";
    if (finishReason === "tool_calls" || finishReason === "function_call") {
        if (!message.tool_calls?.length) throw Error(`Provider finish_reason ${finishReason} requires tool calls`);
        return "toolUse";
    }
    if (finishReason === "content_filter" || finishReason === "network_error")
        throw Error(`Provider finish_reason: ${finishReason}`);
    if (finishReason && finishReason !== "stop") throw Error(`Unknown provider finish_reason: ${finishReason}`);
    return message.tool_calls?.length ? "toolUse" : "stop";
}

function validateRunResponse<T extends { message: Message; stopReason: StopReason; usage: Usage }>(
    response: T | undefined,
): T | undefined {
    if (response?.stopReason === "length" && !response.message.tool_calls?.length)
        throw new ModelResponseError("Provider finish_reason length requires tool calls", response.usage);
    return response;
}

function parseToolArgs(value: string): ToolArgs {
    const args: unknown = JSON.parse(value);
    if (args === null || typeof args !== "object" || Array.isArray(args)) {
        throw Error("tool arguments must be a JSON object");
    }
    return args as ToolArgs;
}

type ActiveOperation = {
    controller: AbortController;
    phase: "model" | "tool" | "compact";
    operationId: string;
    toolCallId?: string;
    abortPersisted: boolean;
    aborting?: Promise<void>;
};

type DurableToolCall = {
    operationId: string;
    stepId: string;
    parentAttemptId: string;
    assistantEntryId: string;
    toolIndex: number;
    toolCallId: string;
    tool: Tool;
    args: ToolArgs;
    environmentIdentity: string;
    recovery: boolean;
} & ({ mode: "start" } | { mode: "replay"; toolStartedId: string; resultEntryId: string });

type DurableToolResult = {
    message: Message;
    resultEntryId: string;
    aborted: boolean;
};

export class Agent {
    messages: Message[];
    usage: Usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    public readonly systemPrompt: string;
    private active?: ActiveOperation;
    constructor(
        public skills: Skill[] = [],
        public fetcher: typeof fetch = fetch,
        public session?: SessionStore,
        public onTool: (event: ToolEvent) => void = () => {},
        instructions = "",
        public lifecycle: ExecutionLifecycle = noLifecycle,
        public tools: readonly Tool[] = builtInTools,
    ) {
        const duplicate = tools.find(
            (tool, index) => tools.findIndex((candidate) => candidate.name === tool.name) !== index,
        );
        if (duplicate) throw Error(`duplicate tool name: ${duplicate.name}`);
        session?.observeCommits((facts) => lifecycle.committed(facts));
        const list =
            skills
                .map(
                    (s) =>
                        `<skill>\n<name>${s.name}</name>\n<description>${s.description}</description>\n<location>${s.path}</location>\n</skill>`,
                )
                .join("\n") || "(none)";
        const project = instructions
            ? `\n\n<project_context>\n\nProject-specific instructions and guidelines:\n\n<project_instructions path="${resolve(root(), "AGENTS.md")}">\n${instructions}\n</project_instructions>\n\n</project_context>`
            : "";
        this.systemPrompt = `You are tiny-agent, a concise coding agent in ${root()}. Use only the tools provided in this request. If the available tools cannot complete the task, explain the missing capability instead of calling an unavailable tool. Follow the project instructions below. When a task matches an available skill, use its location only when a provided tool can read it.

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
    async abort() {
        const active = this.active;
        if (!active || active.abortPersisted) return;
        if (active.aborting) return active.aborting;
        active.aborting = (async () => {
            await this.recordAbort(active.operationId, active.phase, active.toolCallId);
            active.abortPersisted = true;
            active.controller.abort();
        })();
        try {
            await active.aborting;
        } finally {
            active.aborting = undefined;
        }
    }
    private beginOperation(phase: "model" | "tool" | "compact", operationId: string, toolCallId?: string) {
        const controller = new AbortController();
        const active: ActiveOperation = { controller, phase, operationId, toolCallId, abortPersisted: false };
        this.active = active;
        return active;
    }
    private endOperation(active: ActiveOperation) {
        if (this.active === active) this.active = undefined;
    }
    private async settleOperation(active: ActiveOperation) {
        if (active.aborting) await active.aborting;
        const aborted = active.abortPersisted || active.controller.signal.aborted;
        this.endOperation(active);
        return aborted;
    }
    private async recordAbort(operationId: string, phase: "model" | "tool" | "compact", toolCallId?: string) {
        await this.session?.append({
            kind: "record",
            record: {
                type: "abortRequested",
                operationId,
                operationKind: phase === "compact" ? "compaction" : "run",
                phase,
                ...when(toolCallId, { toolCallId }),
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
        const active = this.beginOperation(phase, operationId);
        const signal = active.controller.signal;
        try {
            const response = await this.callModel(messages, tools, signal);
            if (await this.settleOperation(active)) {
                await this.session?.append([
                    { kind: "usage", operationId, attemptId, usage: response.usage },
                    {
                        kind: "record",
                        record: {
                            type: "stepFailed",
                            operationId,
                            stepId,
                            attemptId,
                            error: { code: "aborted", message: "Operation aborted" },
                        },
                    },
                ]);
                return;
            }
            return response;
        } catch (error) {
            if (!(await this.settleOperation(active))) throw error;
            await this.session?.append([
                ...usageFactIfModelError(error, operationId, attemptId),
                {
                    kind: "record",
                    record: {
                        type: "stepFailed",
                        operationId,
                        stepId,
                        attemptId,
                        error: { code: "aborted", message: "Operation aborted" },
                    },
                },
            ]);
        } finally {
            this.endOperation(active);
        }
    }
    async resumeSession() {
        if (!this.session) return;
        let recoveryError: Error | undefined;
        const attached = new Set<string>();
        for (;;) {
            const state = await this.session.load();
            this.restoreState(state);
            if (state.operation.kind === "idle") {
                await this.restoreLatestCacheHitRate();
                if (recoveryError) throw recoveryError;
                return;
            }
            const operation = state.operation;
            if (!attached.has(operation.operationId)) {
                attached.add(operation.operationId);
                this.lifecycle.observe({
                    type: "recovery.attached",
                    timestamp: new Date().toISOString(),
                    operationId: operation.operationId,
                    operationKind: operation.kind,
                });
            }

            const configuration = buildConfiguration(this.systemPrompt, this.tools);
            const current = currentConfiguration(
                configuration,
                this.tools,
                await environmentIdentity(state.header.cwd),
            );
            const plan = planRecovery(state, current);
            const operationId = operation.operationId;
            if (plan.type === "blocked") {
                if (plan.reason !== "attempts_exhausted" || operation.kind === "compaction")
                    throw Error(`Session recovery blocked: ${plan.reason}`);
                await this.session.append({
                    kind: "record",
                    record: {
                        type: "operationFinished",
                        operationId,
                        operationKind: operation.kind,
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
                        operationKind: operation.kind,
                        outcome: plan.outcome,
                        ...when(plan.completion, { completion: plan.completion }),
                        ...when(plan.finalEntryId, { finalEntryId: plan.finalEntryId }),
                        ...when(plan.error, { error: plan.error }),
                    },
                });
                continue;
            }
            if (plan.type === "closeAttempt") {
                const step = expect(state.operation.step, "resumeSession: closeAttempt without an active step");
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
                const step = expect(state.operation.step, "resumeSession: appendSynthetic without an active step");
                await this.session.append(plan.results.map((result) => syntheticToolResult(step.stepId, result)));
                continue;
            }
            if (plan.type === "startTool") {
                await this.executeRecoveryTool(state, plan);
                continue;
            }

            if (operation.kind === "compaction") {
                try {
                    await this.continueCompaction(operationId, plan, configuration);
                } catch (error) {
                    recoveryError = error instanceof Error ? error : Error(String(error));
                }
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
                const response = validateRunResponse(
                    await this.runModelRequest(
                        this.messages,
                        toolDefinitions(this.tools),
                        "model",
                        operationId,
                        stepId,
                        attemptId,
                    ),
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
                this.setLatestCacheHitRate(response.usage);
            } catch (error) {
                recoveryError = error instanceof Error ? error : Error(String(error));
                await this.session.append([
                    ...usageFactIfModelError(error, operationId, attemptId),
                    {
                        kind: "record",
                        record: {
                            type: "stepFailed",
                            operationId,
                            stepId,
                            attemptId,
                            error: { code: "model_error", message: recoveryError.message },
                        },
                    },
                ]);
            }
        }
    }
    private restoreState(state: Awaited<ReturnType<SessionStore["load"]>>) {
        const projection = projectSession(state, this.messages[0]);
        this.messages = projection.messages;
        this.usage = projection.usage;
    }
    private setLatestCacheHitRate(usage: Usage) {
        const prompt = usage.input + usage.cacheRead + usage.cacheWrite;
        if (prompt > 0) this.usage.cacheHitRate = (usage.cacheRead / prompt) * 100;
    }
    private async restoreLatestCacheHitRate() {
        if (!this.session) return;
        const facts = await this.session.facts();
        const usageByAttempt = new Map<string, Usage>();
        for (const fact of facts) {
            if (fact.kind !== "usage" || typeof fact.attemptId !== "string") continue;
            usageByAttempt.set(fact.attemptId, fact.usage as Usage);
        }
        for (const fact of facts.toReversed()) {
            const entry = fact.entry as Record<string, unknown> | undefined;
            const message = entry?.message as Record<string, unknown> | undefined;
            if (fact.kind !== "entry" || entry?.type !== "message" || message?.role !== "assistant") continue;
            const requestUsage = usageByAttempt.get(String(entry.attemptId));
            if (!requestUsage) continue;
            const prompt = requestUsage.input + requestUsage.cacheRead + requestUsage.cacheWrite;
            if (prompt > 0) this.setLatestCacheHitRate(requestUsage);
            return;
        }
    }
    private async executeRecoveryTool(
        state: Awaited<ReturnType<SessionStore["load"]>>,
        plan: Extract<ReturnType<typeof planRecovery>, { type: "startTool" }>,
    ) {
        if (!this.session || state.operation.kind !== "run" || !state.operation.step) return;
        const tool = expect(
            this.tools.find((candidate) => candidate.name === plan.toolName),
            `Missing recovery tool: ${plan.toolName}`,
        );
        const call = {
            operationId: state.operation.operationId,
            stepId: state.operation.step.stepId,
            parentAttemptId: state.operation.step.attemptId,
            recovery: true,
            assistantEntryId: plan.assistantEntryId,
            toolIndex: plan.toolIndex,
            tool,
            args: plan.arguments,
            environmentIdentity: state.header.environmentIdentity,
        };
        if (plan.mode === "start") {
            await this.executeDurableToolCall({
                ...call,
                mode: "start",
                toolCallId: this.currentRecoveryToolCallId(state, plan.assistantEntryId, plan.toolIndex),
            });
            return;
        }
        const toolStartedId = expect(plan.toolStartedId, "Replay plan is missing its durable tool identity");
        const pending = expect(
            state.operation.toolCalls.find((candidate) => candidate.toolStartedId === toolStartedId),
            `Missing pending recovery tool call: ${toolStartedId}`,
        );
        await this.executeDurableToolCall({
            ...call,
            mode: "replay",
            toolCallId: pending.toolCallId,
            toolStartedId,
            resultEntryId: pending.resultEntryId,
        });
    }
    private currentRecoveryToolCallId(
        state: Awaited<ReturnType<SessionStore["load"]>>,
        assistantEntryId: string,
        toolIndex: number,
    ) {
        if (state.operation.kind !== "run" || state.operation.step?.settledEntryId !== assistantEntryId)
            throw Error(`Recovery assistant is not the current settled step: ${assistantEntryId}`);
        const assistant = state.transcript.findLast((message) => message.role === "assistant");
        const call = assistant?.role === "assistant" ? assistant.tool_calls?.[toolIndex] : undefined;
        return expect(call, `Missing recovery tool call ${assistantEntryId}:${toolIndex}`).id;
    }
    private async executeDurableToolCall(call: DurableToolCall): Promise<DurableToolResult> {
        if (!this.session) throw Error("Session is required");
        const session = this.session;
        const toolStartedId = call.mode === "start" ? session.allocateId() : call.toolStartedId;
        const resultEntryId = call.mode === "start" ? session.allocateId() : call.resultEntryId;
        const executionAttemptId = session.allocateId();
        if (call.mode === "start") {
            await session.append({
                kind: "record",
                id: toolStartedId,
                record: {
                    type: "toolStarted",
                    operationId: call.operationId,
                    stepId: call.stepId,
                    assistantEntryId: call.assistantEntryId,
                    toolIndex: call.toolIndex,
                    toolCallId: call.toolCallId,
                    toolName: call.tool.name,
                    arguments: call.args,
                    ...durableToolReplay(call.tool),
                    environmentIdentity: call.environmentIdentity,
                    resultEntryId,
                },
            });
        }

        this.lifecycle.observe({
            type: "tool.started",
            timestamp: new Date().toISOString(),
            operationId: call.operationId,
            stepId: call.stepId,
            attemptId: executionAttemptId,
            parentAttemptId: call.parentAttemptId,
            toolStartedId,
            recovery: call.recovery,
            toolCallId: call.toolCallId,
            tool: call.tool.name,
        });
        this.onTool({ phase: "start", name: call.tool.name, args: call.args });
        const active = this.beginOperation("tool", call.operationId, call.toolCallId);
        let content: string;
        let ok = false;
        try {
            content = await executeDurableTool(call.tool, call.args, active.controller.signal);
            ok = true;
        } catch (error) {
            content = `Error: ${error instanceof Error ? error.message : String(error)}`;
        }
        const aborted = await this.settleOperation(active);
        if (aborted) {
            content = SYNTHETIC_CONTENT.interrupted;
            ok = false;
        }
        this.onTool({ phase: "end", name: call.tool.name, args: call.args, result: content });

        const message: Message = { role: "tool", tool_call_id: call.toolCallId, content };
        await session.append({
            kind: "entry",
            id: resultEntryId,
            entry: {
                type: "message",
                stepId: call.stepId,
                message,
                toolName: call.tool.name,
                toolStartedId,
                result: aborted ? { type: "synthetic", reason: "interrupted" } : { type: ok ? "success" : "error" },
            },
        });
        return { message, resultEntryId, aborted };
    }
    async callModel(messages = this.messages, tools: unknown = toolDefinitions(this.tools), signal?: AbortSignal) {
        const key = requireOpenRouterApiKey();
        const body = { model: MODEL, messages, ...when(tools, { tools }) };
        const r = await this.fetcher(chatCompletionsUrl(), {
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
        const data = (await r.json()) as any;
        const u = data.usage ?? {};
        const details = u.prompt_tokens_details ?? {};
        const cacheRead = details.cached_tokens ?? u.prompt_cache_hit_tokens ?? 0;
        const cacheWrite = details.cache_write_tokens ?? 0;
        const input = Math.max(0, (u.prompt_tokens ?? 0) - cacheRead - cacheWrite);
        this.usage.input += input;
        this.usage.output += u.completion_tokens ?? 0;
        this.usage.cacheRead += cacheRead;
        this.usage.cacheWrite += cacheWrite;
        const prompt = input + cacheRead + cacheWrite;
        const cacheHitRate = prompt > 0 ? (cacheRead / prompt) * 100 : undefined;
        const choice = data.choices?.[0];
        const usage = { input, output: u.completion_tokens ?? 0, cacheRead, cacheWrite };
        if (!choice?.message) throw new ModelResponseError("OpenRouter returned no assistant message", usage);
        let message: Message;
        let reason: StopReason;
        try {
            message = normalizeAssistantMessage(choice.message);
            reason = stopReason(choice.finish_reason, message);
        } catch (error) {
            throw new ModelResponseError(error instanceof Error ? error.message : String(error), usage);
        }
        return {
            message,
            stopReason: reason,
            usage,
            cacheHitRate,
        };
    }
    async runAgentLoop(text: string) {
        if (!this.session) throw Error("Session is required");
        const session = this.session;
        const accepted = runFacts(session, text);
        await session.append(accepted.facts);
        const user: Message = { role: "user", content: text };
        this.messages.push(user);
        const operationId = accepted.operationId;
        let contextThroughEntryId = accepted.inputEntryId;
        const configuration = buildConfiguration(this.systemPrompt, this.tools);
        const finish = (outcome: "completed" | "aborted" | "failed", extra: Record<string, unknown> = {}) =>
            session.append({
                kind: "record",
                record: { type: "operationFinished", operationId, operationKind: "run", outcome, ...extra },
            });
        for (;;) {
            const stepId = session.allocateId();
            const attemptId = session.allocateId();
            await session.append({
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
                response = validateRunResponse(
                    await this.runModelRequest(
                        this.messages,
                        toolDefinitions(this.tools),
                        "model",
                        operationId,
                        stepId,
                        attemptId,
                    ),
                );
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                await session.append([
                    ...usageFactIfModelError(error, operationId, attemptId),
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
            const assistantEntryId = session.allocateId();
            await session.append([
                {
                    kind: "entry",
                    id: assistantEntryId,
                    entry: { type: "message", stepId, attemptId, stopReason, message: answer },
                },
                { kind: "usage", operationId, attemptId, usage },
            ]);
            this.setLatestCacheHitRate(usage);
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
                    const id = session.allocateId();
                    await session.append({
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
                const result = await this.executeDurableToolCall({
                    mode: "start",
                    operationId,
                    stepId,
                    parentAttemptId: attemptId,
                    recovery: false,
                    assistantEntryId,
                    toolIndex: i,
                    toolCallId: call.id,
                    tool,
                    args,
                    environmentIdentity: (await session.load()).header.environmentIdentity,
                });
                this.messages.push(result.message);
                contextThroughEntryId = result.resultEntryId;
                if (!result.aborted) continue;
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
        if (!this.session) throw Error("Session is required");
        const state = await this.session.load();
        if (state.operation.kind !== "idle") throw Error("Another session operation is active");
        const messages = state.activeContext;
        let cut = Math.max(messages.length - 6, 0);
        while (cut > 0 && messages[cut]?.role !== "user") cut--;
        if (!cut) return "Nothing to compact.";

        const source = await this.messageFacts();
        const retainedCount = messages.length - cut;
        const retained = retainedCount ? source.slice(-retainedCount) : [];
        const compacted = retainedCount ? source.slice(0, -retainedCount) : source;
        if (!compacted.length || !source.length) return "Nothing to compact.";

        const operationId = this.session.allocateId();
        const resultEntryId = this.session.allocateId();
        const inputThroughEntryId = expect(source.at(-1), "compact: source unexpectedly empty").id;
        await this.session.append({
            kind: "record",
            record: {
                type: "compactionStarted",
                operationId,
                operationKind: "compaction",
                inputThroughEntryId,
                resultEntryId,
                compactedEntryIds: compacted.map((item) => item.id),
                retainedEntryIds: retained.map((item) => item.id),
                sourceDigest: sourceDigest(source),
            },
        });
        const result = await this.continueCompaction(
            operationId,
            { type: "startStep", stepKind: "compaction", attempt: 1, contextThroughEntryId: inputThroughEntryId },
            buildConfiguration(this.systemPrompt, this.tools),
        );
        this.restoreState(await this.session.load());
        await this.restoreLatestCacheHitRate();
        return result;
    }

    private async continueCompaction(
        operationId: string,
        plan: Extract<ReturnType<typeof planRecovery>, { type: "startStep" }>,
        configuration: ReturnType<typeof buildConfiguration>,
    ) {
        if (!this.session) throw Error("Session is required");
        const state = await this.session.load();
        if (state.operation.kind !== "compaction") throw Error("Compaction operation is not active");
        const record = await this.compactionRecord(operationId);
        const stepId = plan.stepId ?? this.session.allocateId();
        const attemptId = this.session.allocateId();
        await this.session.append({
            kind: "record",
            record: {
                type: "stepAttempt",
                operationId,
                stepId,
                attemptId,
                stepKind: "compaction",
                attempt: plan.attempt,
                contextThroughEntryId: plan.contextThroughEntryId,
                ...configuration,
            },
        });
        try {
            const retainedCount = record.retainedEntryIds.length;
            const compactable = retainedCount ? state.activeContext.slice(0, -retainedCount) : state.activeContext;
            const response = await this.runModelRequest(
                [
                    {
                        role: "system",
                        content:
                            "Summarize this coding session compactly. Preserve decisions, changed files, errors, and next steps.",
                    },
                    { role: "user", content: JSON.stringify(compactable) },
                ],
                undefined,
                "compact",
                operationId,
                stepId,
                attemptId,
            );
            if (!response) {
                await this.session.append({
                    kind: "record",
                    record: { type: "operationFinished", operationId, operationKind: "compaction", outcome: "aborted" },
                });
                return "Compaction aborted.";
            }
            await this.session.append({ kind: "usage", operationId, attemptId, usage: response.usage });
            const summary = response.message.content;
            if (response.stopReason !== "stop" || !summary?.trim())
                throw Error("Model returned an invalid compaction summary");
            const source = await this.messageFacts(state.operation.inputThroughEntryId);
            const retainedIds = new Set(record.retainedEntryIds);
            const retainedTail = source
                .filter((item) => retainedIds.has(item.id))
                .map((item) => ({ sourceEntryId: item.id, message: item.message }));
            await this.session.append({
                kind: "entry",
                id: state.operation.resultEntryId,
                entry: {
                    type: "compaction",
                    operationId,
                    summary,
                    compactedThroughEntryId: record.compactedEntryIds.at(-1),
                    retainedTail,
                },
            });
            await this.session.append({
                kind: "record",
                record: {
                    type: "operationFinished",
                    operationId,
                    operationKind: "compaction",
                    outcome: "completed",
                    finalEntryId: state.operation.resultEntryId,
                },
            });
            return `Compacted ${source.length - retainedTail.length} messages (kept last ${retainedTail.length}).`;
        } catch (error) {
            if (error instanceof ModelResponseError) {
                await this.session.append({ kind: "usage", operationId, attemptId, usage: error.usage });
            }
            const current = await this.session.load();
            if (current.operation.kind === "compaction" && current.operation.step?.status === "attempting") {
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
                            operationKind: "compaction",
                            outcome: "failed",
                            error: { code: "model_error", message },
                        },
                    },
                ]);
            }
            throw error;
        }
    }

    private async messageFacts(throughId?: string) {
        if (!this.session) return [];
        const result: { id: string; message: Message }[] = [];
        for (const fact of await this.session.facts()) {
            const entry = fact.entry as Record<string, unknown> | undefined;
            if (fact.kind === "entry" && entry?.type === "message")
                result.push({ id: String(fact.id), message: entry.message as Message });
            if (throughId && fact.id === throughId) break;
        }
        return result;
    }

    private async compactionRecord(operationId: string) {
        if (!this.session) throw Error("Session is required");
        for (const fact of (await this.session.facts()).toReversed()) {
            const record = fact.record as Record<string, unknown> | undefined;
            if (record?.type === "compactionStarted" && record.operationId === operationId)
                return record as { compactedEntryIds: string[]; retainedEntryIds: string[] };
        }
        throw Error(`Missing compaction record: ${operationId}`);
    }
}
