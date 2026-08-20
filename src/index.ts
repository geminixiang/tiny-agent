import { exec } from "node:child_process";
import { randomBytes } from "node:crypto";
import { appendFile, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { promisify } from "node:util";

export const MODEL = process.env.TINY_MODEL || "deepseek/deepseek-v4-flash-0731";
const run = promisify(exec),
    root = process.cwd(),
    MAX_TOOL_OUTPUT = 50 * 1024;
type Message = {
    role: "system" | "user" | "assistant" | "tool";
    content: string | null;
    tool_call_id?: string;
    tool_calls?: ToolCall[];
};
type ToolCall = { id: string; type: "function"; function: { name: string; arguments: string } };
type Skill = { name: string; description: string; path: string };
type Usage = {
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
type ToolEvent = {
    phase: "start" | "end";
    name: string;
    args: Record<string, string>;
    result?: string;
};

export function formatToolEvent({ phase, name, args, result }: ToolEvent) {
    if (phase === "end")
        return `  └ ${result === "ok" || result === "(no output)" ? result : `${result?.length ?? 0} chars`}`;
    const target = name === "bash" ? args.command : args.path,
        suffix =
            name === "write"
                ? ` (${args.content?.length ?? 0} chars)`
                : name === "edit"
                  ? ` (${args.oldText?.length ?? 0}→${args.newText?.length ?? 0} chars)`
                  : "";
    return `◆ ${name}${target ? ` ${target.length > 80 ? target.slice(0, 77) + "..." : target}` : ""}${suffix}`;
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

const toolDefinitions = [
    ["bash", "Run a shell command in the working directory", { command: { type: "string" } }],
    ["read", "Read a UTF-8 text file", { path: { type: "string" } }],
    ["write", "Create or overwrite a UTF-8 text file", { path: { type: "string" }, content: { type: "string" } }],
    [
        "edit",
        "Replace one unique exact string in a UTF-8 text file",
        { path: { type: "string" }, oldText: { type: "string" }, newText: { type: "string" } },
    ],
].map(([name, description, properties]) => ({
    type: "function",
    function: {
        name,
        description,
        parameters: { type: "object", properties, required: Object.keys(properties as object) },
    },
}));

function pathInRoot(path: string) {
    const full = resolve(root, path);
    if (full !== root && !full.startsWith(root + "/")) throw Error("path must stay inside cwd");
    return full;
}

export async function executeTool(name: string, args: Record<string, string>, signal?: AbortSignal) {
    if (signal?.aborted) throw Error("Operation aborted");
    if (name === "bash") {
        const { stdout, stderr } = await run(args.command, {
                cwd: root,
                timeout: 120_000,
                maxBuffer: 10_000_000,
                signal,
            }),
            output = stdout + stderr || "(no output)";
        const bytes = Buffer.from(output);
        if (bytes.length <= MAX_TOOL_OUTPUT) return output;
        const path = resolve(root, ".tiny-agent/tool-output", `${uuid7()}.log`);
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, output);
        let start = bytes.length - MAX_TOOL_OUTPUT;
        while ((bytes[start] & 0xc0) === 0x80) start++;
        return `${bytes.subarray(start).toString()}\n\n[Output truncated. Full output: ${path}]`;
    }
    const path = pathInRoot(args.path);
    if (name === "read") return (await readFile(path, { encoding: "utf8", signal })).slice(0, 100_000);
    if (name === "write")
        return mkdir(dirname(path), { recursive: true })
            .then(() => {
                if (signal?.aborted) throw Error("Operation aborted");
                return writeFile(path, args.content, { signal });
            })
            .then(() => "ok");
    if (name === "edit") {
        const text = await readFile(path, { encoding: "utf8", signal }),
            parts = text.split(args.oldText);
        if (parts.length !== 2) throw Error(`oldText must occur exactly once (found ${parts.length - 1})`);
        if (signal?.aborted) throw Error("Operation aborted");
        await writeFile(path, parts.join(args.newText), { signal });
        return "ok";
    }
    throw Error(`unknown tool: ${name}`);
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
    ) {
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
                content: `You are tiny-agent, a concise coding agent in ${root}. Use tools to inspect and change files. Follow the project instructions below. When a task matches an available skill, use read on its location before following it.${project}\n\n<available_skills>\n${list}\n</available_skills>`,
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
    private async runModelRequest(
        messages: Message[],
        tools: unknown,
        phase: "model" | "compact",
        updateCacheRate = true,
    ) {
        const signal = this.beginOperation(phase);
        try {
            return await this.callModel(messages, tools, updateCacheRate, signal);
        } catch (error) {
            if (!signal.aborted) throw error;
            await this.recordInterruption(phase);
        } finally {
            this.endOperation();
        }
    }
    async restore() {
        if (!this.session) return;
        for (const r of (await this.session.records()).slice(1)) {
            if (r.type === "message") {
                this.messages.push(r.message);
                if (!r.usage) continue;
                for (const k of ["input", "output", "cacheRead", "cacheWrite"] as const)
                    this.usage[k] += r.usage[k] ?? 0;
                const prompt = r.usage.input + r.usage.cacheRead + r.usage.cacheWrite;
                if (prompt > 0) this.usage.cacheHitRate = (r.usage.cacheRead / prompt) * 100;
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
    }
    async callModel(
        messages = this.messages,
        tools: unknown = toolDefinitions,
        updateCacheRate = true,
        signal?: AbortSignal,
    ) {
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
        const prompt = input + cacheRead + cacheWrite;
        if (updateCacheRate && prompt > 0) this.usage.cacheHitRate = (cacheRead / prompt) * 100;
        return {
            message: data.choices[0].message as Message,
            usage: { input, output: u.completion_tokens ?? 0, cacheRead, cacheWrite },
        };
    }
    async runAgentLoop(text: string) {
        const user: Message = { role: "user", content: text };
        this.messages.push(user);
        await this.session?.append({ type: "message", message: user });
        for (;;) {
            const response = await this.runModelRequest(this.messages, toolDefinitions, "model");
            if (!response) return "Operation aborted.";
            const { message: answer, usage } = response;
            this.messages.push(answer);
            await this.session?.append({ type: "message", message: answer, usage });
            if (!answer.tool_calls?.length) return answer.content ?? "";
            for (let i = 0; i < answer.tool_calls.length; i++) {
                const c = answer.tool_calls[i];
                let content: string,
                    args: Record<string, string> = {},
                    aborted = false;
                try {
                    args = JSON.parse(c.function.arguments);
                    this.onTool({ phase: "start", name: c.function.name, args });
                    content = await executeTool(c.function.name, args, this.beginOperation("tool", c.id));
                } catch (e) {
                    aborted = !!this.active?.controller.signal.aborted;
                    content = aborted ? "Operation aborted" : `Error: ${e instanceof Error ? e.message : e}`;
                }
                this.endOperation();
                this.onTool({ phase: "end", name: c.function.name, args, result: content });
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
            false,
        );
        if (!response) return "Compaction aborted.";
        const { message: summary, usage } = response;
        const compacted: Message = { role: "user", content: `[Compacted history]\n${summary.content}` };
        this.messages = [this.messages[0], compacted, ...recent];
        await this.session?.append({
            type: "compaction",
            summary: summary.content,
            compactedMessages: old.length,
            keptMessages: keep,
            usage,
        });
        return `Compacted ${old.length} messages (kept last ${keep}).`;
    }
}
