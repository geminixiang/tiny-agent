import { exec, execFile, type ExecException } from "node:child_process";
import { randomBytes } from "node:crypto";
import { appendFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, delimiter, dirname, resolve } from "node:path";
import { promisify } from "node:util";

export const MODEL = process.env.TINY_MODEL || "deepseek/deepseek-v4-flash-0731";
const run = promisify(exec),
    runFile = promisify(execFile),
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
type ToolEdit = { oldText: string; newText: string };
type ToolArgs = {
    command?: string;
    timeout?: number;
    path?: string;
    content?: string;
    offset?: number;
    limit?: number;
    edits?: ToolEdit[];
};
type ToolEvent = {
    phase: "start" | "end";
    name: string;
    args: ToolArgs;
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
                  ? ` (${args.edits?.length ?? 0} blocks)`
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
    {
        name: "bash",
        description:
            "Run commands, builds, tests, and file discovery in the working directory. Use read, write, or edit for ordinary text file operations. Output is limited to the last 2,000 lines or 50KB; truncated output includes a full-output path.",
        properties: {
            command: { type: "string", description: "Shell command to execute in the working directory." },
            timeout: {
                type: "number",
                exclusiveMinimum: 0,
                description: "Optional timeout in seconds. Defaults to 120.",
            },
        },
        required: ["command"],
    },
    {
        name: "read",
        description:
            "Read a UTF-8 text file. Prefer this over cat or sed. Returns at most 2,000 complete lines or 50KB and includes an offset hint when more lines remain.",
        properties: {
            path: { type: "string", description: "Path to the UTF-8 text file within the working directory." },
            offset: { type: "integer", minimum: 1, description: "1-indexed line number to start reading from." },
            limit: { type: "integer", minimum: 1, description: "Maximum number of lines to return." },
        },
        required: ["path"],
    },
    {
        name: "write",
        description:
            "Create a new UTF-8 text file or completely rewrite an existing file. Parent directories are created automatically. Use edit for partial changes.",
        properties: {
            path: { type: "string", description: "Path to create or completely rewrite." },
            content: { type: "string", description: "Complete UTF-8 file content." },
        },
        required: ["path", "content"],
    },
    {
        name: "edit",
        description:
            "Make precise replacements in an existing UTF-8 text file. Every oldText must match exactly once in the original file, and edits must not overlap. All edits are validated before writing.",
        properties: {
            path: { type: "string", description: "Path to the existing UTF-8 text file." },
            edits: {
                type: "array",
                minItems: 1,
                description: "Non-overlapping replacements, all matched against the original file.",
                items: {
                    type: "object",
                    properties: {
                        oldText: {
                            type: "string",
                            minLength: 1,
                            description: "Exact text that must occur exactly once in the original file.",
                        },
                        newText: { type: "string", description: "Replacement text." },
                    },
                    required: ["oldText", "newText"],
                },
            },
        },
        required: ["path", "edits"],
    },
].map(({ name, description, properties, required }) => ({
    type: "function",
    function: { name, description, parameters: { type: "object", properties, required } },
}));

function pathInRoot(path: string) {
    const full = resolve(root, path);
    if (full !== root && !full.startsWith(root + "/")) throw Error("path must stay inside cwd");
    return full;
}

async function limitBashOutput(output: string, complete = true) {
    const lines = output.split("\n");
    if (lines.at(-1) === "") lines.pop();
    if (lines.length <= 2_000 && Buffer.byteLength(output) <= MAX_TOOL_OUTPUT) return output;
    const buffer = Buffer.from(output);
    let byteStart = Math.max(0, buffer.length - MAX_TOOL_OUTPUT);
    while (byteStart < buffer.length && (buffer[byteStart] & 0xc0) === 0x80) byteStart++;
    let tailLines = buffer.subarray(byteStart).toString().split("\n");
    if (tailLines.length > 2_000) tailLines = tailLines.slice(-2_000);
    const tail = tailLines.join("\n"),
        start = Math.max(1, lines.length - tailLines.length + 1),
        path = resolve(root, ".tiny-agent/tool-output", `${uuid7()}.log`);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, output);
    const label = complete ? "Full output" : "Captured output; command exceeded the 10MB safety cap";
    return `${tail}\n\n[Showing lines ${start}-${lines.length} of ${lines.length}. ${label}: ${path}]`;
}

function readLines(text: string, offset = 1, limit = 2_000) {
    if (!Number.isInteger(offset) || offset < 1) throw Error("offset must be an integer >= 1");
    if (!Number.isInteger(limit) || limit < 1) throw Error("limit must be an integer >= 1");
    const lines = text === "" ? [] : text.replace(/\r\n/g, "\n").split("\n");
    if (lines.at(-1) === "") lines.pop();
    if (!lines.length) {
        if (offset === 1) return "";
        throw Error(`Offset ${offset} is beyond end of file (0 lines total).`);
    }
    if (offset > lines.length) throw Error(`Offset ${offset} is beyond end of file (${lines.length} lines total).`);
    const selected: string[] = [];
    for (const line of lines.slice(offset - 1, offset - 1 + Math.min(limit, 2_000))) {
        const next = selected.length ? `${selected.join("\n")}\n${line}` : line;
        if (Buffer.byteLength(next) > MAX_TOOL_OUTPUT) break;
        selected.push(line);
    }
    if (!selected.length)
        return `Line ${offset} exceeds 50KB. Use bash with a byte-oriented command to inspect this line.`;
    const end = offset + selected.length - 1;
    return `${selected.join("\n")}${end < lines.length ? `\n\n[Showing lines ${offset}-${end} of ${lines.length}. Use offset=${end + 1} to continue.]` : ""}`;
}

async function runBash(command: string, timeout: number, sandbox: boolean, signal?: AbortSignal) {
    const options = {
        cwd: root,
        timeout: timeout * 1_000,
        maxBuffer: 10_000_000,
        signal,
    };
    if (!sandbox) return run(command, options);
    const rustupHome = process.env.RUSTUP_HOME || resolve(homedir(), ".rustup");
    const sandboxPath = (process.env.PATH ?? "")
        .split(delimiter)
        .filter((path) => path && !path.includes(`${delimiter}.pi${delimiter}`) && !path.includes("/.pi/"))
        .filter((path, index, paths) => paths.indexOf(path) === index);
    const dir = await mkdtemp(resolve(tmpdir(), "tiny-agent-fence-")),
        sandboxHome = resolve(dir, "home"),
        sandboxTmp = resolve(dir, "tmp"),
        settings = resolve(dir, "fence.json");
    try {
        await mkdir(sandboxHome);
        await mkdir(sandboxTmp);
        await writeFile(
            settings,
            JSON.stringify({
                network: { allowedDomains: [] },
                filesystem: {
                    defaultDenyRead: true,
                    allowRead: [root, resolve(dirname(process.execPath), ".."), rustupHome, ...sandboxPath],
                    allowWrite: [root, tmpdir()],
                    denyWrite: [resolve(root, ".git")],
                },
                command: { deny: ["git commit", "git push", "npm publish"] },
            }),
        );
        const env = Object.fromEntries(
            Object.entries(process.env).filter(([key]) => !/(?:KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|AUTH)/i.test(key)),
        );
        env.CARGO_HOME = resolve(sandboxHome, ".cargo");
        env.HOME = sandboxHome;
        env.PATH = sandboxPath.join(delimiter);
        env.RUSTUP_HOME = rustupHome;
        env.TMPDIR = sandboxTmp;
        return await runFile("fence", ["--settings", settings, "--", "/bin/sh", "-c", command], {
            ...options,
            env,
        });
    } catch (error) {
        const commandError = error as NodeJS.ErrnoException;
        if (commandError.code === "ENOENT") {
            throw Error("Fence sandbox is required but was not found. Install: brew install fencesandbox/tap/fence.");
        }
        throw error;
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
}

export async function executeTool(name: string, args: ToolArgs, signal?: AbortSignal, sandbox = false) {
    if (signal?.aborted) throw Error("Operation aborted");
    if (name === "bash") {
        if (!args.command) throw Error("command is required");
        const timeout = args.timeout ?? 120;
        if (typeof timeout !== "number" || !Number.isFinite(timeout) || timeout <= 0)
            throw Error("timeout must be a positive number of seconds");
        let stdout = "",
            stderr = "";
        try {
            ({ stdout, stderr } = await runBash(args.command, timeout, sandbox, signal));
        } catch (error) {
            if (signal?.aborted) throw Error("Operation aborted");
            const commandError = error as ExecException & { stdout?: string; stderr?: string };
            stdout = commandError.stdout ?? "";
            stderr = commandError.stderr ?? "";
            if (commandError.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER")
                return limitBashOutput(
                    `${stdout}${stderr}${stdout || stderr ? "\n\n" : ""}Bash output exceeded the 10MB safety cap; complete output was not captured.`,
                    false,
                );
            if (commandError.killed)
                return limitBashOutput(
                    `${stdout}${stderr}${stdout || stderr ? "\n\n" : ""}Command timed out after ${timeout} seconds.`,
                );
            const code = typeof commandError.code === "number" ? commandError.code : "unknown";
            return limitBashOutput(
                `${stdout}${stderr}${stdout || stderr ? "\n\n" : ""}Command exited with code ${code}`,
            );
        }
        return limitBashOutput(stdout + stderr || "(no output)");
    }
    if (!args.path) throw Error("path is required");
    const path = pathInRoot(args.path);
    if (name === "read") {
        const text = await readFile(path, { encoding: "utf8", signal });
        return readLines(text, args.offset, args.limit);
    }
    if (name === "write") {
        if (args.content === undefined) throw Error("content is required");
        await mkdir(dirname(path), { recursive: true });
        if (signal?.aborted) throw Error("Operation aborted");
        await writeFile(path, args.content, { signal });
        return `Successfully wrote ${Buffer.byteLength(args.content)} bytes to ${args.path}.`;
    }
    if (name === "edit") {
        if (!args.edits?.length) throw Error("edits must be a nonempty array");
        const original = await readFile(path, { encoding: "utf8", signal }),
            bom = original.startsWith("\uFEFF"),
            text = bom ? original.slice(1) : original,
            ending = text.match(/\r\n|\n/)?.[0] ?? "\n";
        let normalized = "",
            source = 0;
        const positions = [0];
        while (source < text.length) {
            if (text.startsWith("\r\n", source)) {
                normalized += "\n";
                source += 2;
            } else {
                normalized += text[source++];
            }
            positions.push(source);
        }
        const ranges = args.edits.map((edit, index) => {
            const oldText = edit.oldText.replace(/\r\n/g, "\n");
            if (!oldText) throw Error(`edits[${index}].oldText must not be empty`);
            const start = normalized.indexOf(oldText),
                second = start < 0 ? -1 : normalized.indexOf(oldText, start + 1);
            if (start < 0) throw Error(`edits[${index}].oldText was not found in ${args.path}.`);
            if (second >= 0)
                throw Error(`edits[${index}].oldText occurs more than once in ${args.path}; add more context.`);
            return {
                index,
                start: positions[start],
                end: positions[start + oldText.length],
                newText: edit.newText.replace(/\r\n|\n/g, ending),
            };
        });
        const sorted = [...ranges].sort((a, b) => a.start - b.start);
        for (let i = 1; i < sorted.length; i++) {
            if (sorted[i].start >= sorted[i - 1].end) continue;
            throw Error(`edits[${sorted[i - 1].index}] and edits[${sorted[i].index}] overlap in ${args.path}.`);
        }
        let edited = text;
        for (const range of [...ranges].sort((a, b) => b.start - a.start))
            edited = edited.slice(0, range.start) + range.newText + edited.slice(range.end);
        if (bom) edited = "\uFEFF" + edited;
        if (signal?.aborted) throw Error("Operation aborted");
        await writeFile(path, edited, { signal });
        return `Successfully replaced ${args.edits.length} block(s) in ${args.path}.`;
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

type StopReason = "stop" | "length" | "toolUse";

function stopReason(finishReason: string | null | undefined, message: Message): StopReason {
    if (finishReason === "length") return "length";
    if (finishReason === "tool_calls" || finishReason === "function_call") return "toolUse";
    if (finishReason === "content_filter" || finishReason === "network_error")
        throw Error(`Provider finish_reason: ${finishReason}`);
    if (finishReason && finishReason !== "stop") throw Error(`Unknown provider finish_reason: ${finishReason}`);
    return message.tool_calls?.length ? "toolUse" : "stop";
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
        public sandbox = false,
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
                content: `You are tiny-agent, a concise coding agent in ${root}. Use tools to inspect and change files. Follow the project instructions below. When a task matches an available skill, use read on its location before following it.

For implementation tasks, inspect only what is needed, then make the changes and run focused tests. Do not keep researching the same uncertainty when a mature dependency or direct implementation is available.
Use read to inspect files, write for new files, edit for existing files, and bash for discovery, commands, builds, and tests.
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
    async resumeSession() {
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
        const choice = data.choices?.[0];
        if (!choice?.message) throw Error("OpenRouter returned no assistant message");
        return {
            message: choice.message as Message,
            stopReason: stopReason(choice.finish_reason, choice.message),
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
                    aborted = false;
                try {
                    if (stopReason === "length") {
                        content =
                            "Error: Tool call arguments were truncated by the model token limit; the tool was not executed.";
                    } else {
                        args = JSON.parse(c.function.arguments);
                        this.onTool({ phase: "start", name: c.function.name, args });
                        content = await executeTool(
                            c.function.name,
                            args,
                            this.beginOperation("tool", c.id),
                            this.sandbox,
                        );
                    }
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
            keptMessages: recent.length,
            usage,
        });
        return `Compacted ${old.length} messages (kept last ${recent.length}).`;
    }
}
