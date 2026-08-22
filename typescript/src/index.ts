import { randomBytes } from "node:crypto";
import { appendFile, mkdir, readFile, readdir } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { builtInTools, toolDefinitions, type Tool, type ToolArgs, type ToolEvent } from "./tools.js";

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
type SessionRecord = {
    type: "session" | "message" | "compaction" | "interruption";
    [key: string]: unknown;
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
      };

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

// prettier-ignore
function uuid7(now = Date.now()) { const b = randomBytes(16); let t = BigInt(now); for (let i = 5; i >= 0; i--) { b[i] = Number(t & 0xffn); t >>= 8n; } b[6] = (b[6] & 15) | 0x70; b[8] = (b[8] & 63) | 0x80; const h = b.toString("hex"); return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`; }

export class Session {
    private constructor(
        public id: string,
        public path: string,
    ) {}
    static async create(cwd = root, now = new Date()) {
        const id = uuid7(now.getTime()),
            dir = resolve(cwd, ".tiny-agent/sessions");
        const path = resolve(dir, `${now.toISOString().replace(/[:.]/g, "-")}_${id}.jsonl`);
        await mkdir(dir, { recursive: true });
        const session = new Session(id, path);
        await session.append({
            type: "session",
            version: 1,
            id,
            createdAt: now.toISOString(),
            cwd,
            provider: "openrouter",
            model: MODEL,
        });
        return session;
    }
    static async open(id: string, cwd = root) {
        if (!/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id))
            throw Error(`Invalid session ID: ${id}`);
        const dir = resolve(cwd, ".tiny-agent/sessions"),
            matches = (await readdir(dir).catch(() => [])).filter((f) => f.endsWith(`_${id}.jsonl`));
        if (matches.length !== 1)
            throw Error(matches.length ? `Duplicate session ID: ${id}` : `Session not found: ${id}`);
        return new Session(id, resolve(dir, matches[0]));
    }
    async records() {
        return (await readFile(this.path, "utf8"))
            .trim()
            .split("\n")
            .filter(Boolean)
            .map((line) => JSON.parse(line) as any);
    }
    async append(record: SessionRecord) {
        await appendFile(this.path, JSON.stringify({ ...record, timestamp: new Date().toISOString() }) + "\n");
    }
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
    private active?: {
        controller: AbortController;
        phase: "model" | "tool" | "compact";
        toolCallId?: string;
    };
    constructor(
        public skills: Skill[] = [],
        public fetcher: typeof fetch = fetch,
        public session?: Session,
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
        this.messages = [
            {
                role: "system",
                content: `You are tiny-agent, a concise coding agent in ${root}. Use only the tools provided in this request. If the available tools cannot complete the task, explain the missing capability instead of calling an unavailable tool. Follow the project instructions below. When a task matches an available skill, use its location only when a provided tool can read it.

For implementation tasks, inspect only what is needed, then make the changes and run focused tests. Do not keep researching the same uncertainty when a mature dependency or direct implementation is available.
Use the provided tool descriptions to choose the right capability. Not every run enables file access, shell access, or file modification.
Prefer completing a small working implementation over exhaustively researching every option. If repeated experiments fail, reconsider the approach instead of making another similar attempt.${project}

<available_skills>
${list}
</available_skills>`,
            },
        ];
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
    private async recordInterruption(phase: "model" | "tool" | "compact", toolCallId?: string) {
        await this.session?.append({ type: "interruption", phase, toolCallId, reason: "escape" });
    }
    private async runModelRequest(messages: Message[], tools: unknown, phase: "model" | "compact") {
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
            await this.recordInterruption(phase);
        } finally {
            this.endOperation();
        }
    }
    async resumeSession() {
        if (!this.session) return;
        for (const r of (await this.session.records()).slice(1)) {
            if (r.type === "message") {
                this.messages.push(r.message);
                if (!r.usage) continue;
                for (const k of ["input", "output", "cacheRead", "cacheWrite"] as const)
                    this.usage[k] += r.usage[k] ?? 0;
                continue;
            }
            if (r.type === "compaction") {
                const recent = r.keptMessages > 0 ? this.messages.slice(-r.keptMessages) : [];
                this.messages = [
                    this.messages[0],
                    { role: "user", content: `[Compacted history]\n${r.summary}` },
                    ...recent,
                ];
                for (const k of ["input", "output", "cacheRead", "cacheWrite"] as const)
                    this.usage[k] += r.usage[k] ?? 0;
            }
        }
        const totalPrompt = this.usage.input + this.usage.cacheRead + this.usage.cacheWrite;
        if (totalPrompt > 0) this.usage.cacheHitRate = (this.usage.cacheRead / totalPrompt) * 100;
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
        const user: Message = { role: "user", content: text };
        this.messages.push(user);
        await this.session?.append({ type: "message", message: user });
        for (;;) {
            const response = await this.runModelRequest(this.messages, toolDefinitions(this.tools), "model");
            if (!response) return "Operation aborted.";
            const { message: answer, usage, stopReason } = response;
            this.messages.push(answer);
            await this.session?.append({ type: "message", message: answer, usage });
            if (!answer.tool_calls?.length) {
                if (answer.content?.trim()) return answer.content;
                throw Error(`Model returned an empty response (finish_reason: ${stopReason}).`);
            }
            for (let i = 0; i < answer.tool_calls.length; i++) {
                const c = answer.tool_calls[i];
                let content: string,
                    args: ToolArgs = {},
                    aborted = false,
                    ok = false;
                const toolStarted = performance.now();
                this.onEvent({
                    type: "tool.started",
                    timestamp: new Date().toISOString(),
                    toolCallId: c.id,
                    tool: c.function.name,
                });
                try {
                    if (stopReason === "length") {
                        content =
                            "Error: Tool call arguments were truncated by the model token limit; the tool was not executed.";
                    } else {
                        args = parseToolArgs(c.function.arguments);
                        this.onTool({ phase: "start", name: c.function.name, args });
                        const tool = this.tools.find((candidate) => candidate.name === c.function.name);
                        if (!tool) throw Error(`unknown tool: ${c.function.name}`);
                        content = await tool.execute(args, this.beginOperation("tool", c.id));
                        ok = true;
                    }
                } catch (e) {
                    aborted = !!this.active?.controller.signal.aborted;
                    content = aborted ? "Operation aborted" : `Error: ${e instanceof Error ? e.message : e}`;
                }
                this.endOperation();
                this.onTool({ phase: "end", name: c.function.name, args, result: content });
                this.onEvent({
                    type: "tool.completed",
                    timestamp: new Date().toISOString(),
                    toolCallId: c.id,
                    tool: c.function.name,
                    durationMs: performance.now() - toolStarted,
                    ok,
                });
                const result: Message = { role: "tool", tool_call_id: c.id, content };
                this.messages.push(result);
                await this.session?.append({ type: "message", message: result, toolName: c.function.name });
                if (!aborted) continue;
                for (const pending of answer.tool_calls.slice(i + 1)) {
                    const skipped: Message = {
                        role: "tool",
                        tool_call_id: pending.id,
                        content: "Operation aborted before execution",
                    };
                    this.messages.push(skipped);
                    await this.session?.append({
                        type: "message",
                        message: skipped,
                        toolName: pending.function.name,
                    });
                }
                await this.recordInterruption("tool", c.id);
                return "Operation aborted.";
            }
        }
    }
    async compact() {
        const keep = 6;
        if (this.messages.length <= 1) return "Nothing to compact.";
        let cut = Math.max(this.messages.length - keep, 1);
        while (cut > 1 && this.messages[cut].role !== "user") cut--;
        const recent = this.messages.slice(cut),
            old = this.messages.slice(1, cut);
        if (!old.length) return "Nothing to compact.";
        const response = await this.runModelRequest(
            [
                {
                    role: "system",
                    content:
                        "Summarize this coding session compactly. Preserve decisions, changed files, errors, and next steps.",
                },
                { role: "user", content: JSON.stringify(old) },
            ],
            null,
            "compact",
        );
        if (!response) return "Compaction aborted.";
        const { message: summary, usage } = response;
        const compacted: Message = { role: "user", content: `[Compacted history]\n${summary.content}` };
        this.messages = [this.messages[0], compacted, ...recent];
        await this.session?.append({
            type: "compaction",
            summary: summary.content,
            compactedMessages: old.length,
            keptMessages: recent.length,
            usage,
        });
        return `Compacted ${old.length} messages (kept last ${recent.length}).`;
    }
}
