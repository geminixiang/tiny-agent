#!/usr/bin/env node
import { exec } from "node:child_process";
import { randomBytes } from "node:crypto";
import { appendFile, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { createInterface, emitKeypressEvents } from "node:readline";
import { promisify } from "node:util";

export const MODEL = "deepseek/deepseek-v4-flash-0731";
const run = promisify(exec), root = process.cwd(), MAX_TOOL_OUTPUT = 50 * 1024;
type Msg = { role: "system" | "user" | "assistant" | "tool"; content: string | null; tool_call_id?: string; tool_calls?: Call[] };
type Call = { id: string; type: "function"; function: { name: string; arguments: string } };
type Skill = { name: string; description: string; path: string };
type Usage = { input: number; output: number; cacheRead: number; cacheWrite: number; cacheHitRate?: number };
type SessionRecord = { type: "session" | "message" | "compaction" | "interruption"; [key: string]: unknown };
type ToolEvent = { phase: "start" | "end"; name: string; args: Record<string, string>; result?: string };

export function toolLine({ phase, name, args, result }: ToolEvent) {
  if (phase === "end") return `  └ ${result === "ok" || result === "(no output)" ? result : `${result?.length ?? 0} chars`}`;
  const target = name === "bash" ? args.command : args.path, suffix = name === "write" ? ` (${args.content?.length ?? 0} chars)` : name === "edit" ? ` (${args.oldText?.length ?? 0}→${args.newText?.length ?? 0} chars)` : "";
  return `◆ ${name}${target ? ` ${target.length > 80 ? target.slice(0, 77) + "..." : target}` : ""}${suffix}`;
}

function uuid7(now = Date.now()) {
  const b = randomBytes(16); let t = BigInt(now);
  for (let i = 5; i >= 0; i--) { b[i] = Number(t & 0xffn); t >>= 8n; }
  b[6] = b[6] & 15 | 0x70; b[8] = b[8] & 63 | 0x80;
  const h = b.toString("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export class Session {
  private constructor(public id: string, public path: string) {}
  static async create(cwd = root, now = new Date()) {
    const id = uuid7(now.getTime()), dir = resolve(cwd, ".tiny-agent/sessions");
    const path = resolve(dir, `${now.toISOString().replace(/[:.]/g, "-")}_${id}.jsonl`);
    await mkdir(dir, { recursive: true });
    const session = new Session(id, path);
    await session.append({ type: "session", version: 1, id, createdAt: now.toISOString(), cwd, provider: "openrouter", model: MODEL });
    return session;
  }
  static async open(id: string, cwd = root) {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) throw Error(`Invalid session ID: ${id}`);
    const dir = resolve(cwd, ".tiny-agent/sessions"), matches = (await readdir(dir).catch(() => [])).filter(f => f.endsWith(`_${id}.jsonl`));
    if (matches.length !== 1) throw Error(matches.length ? `Duplicate session ID: ${id}` : `Session not found: ${id}`);
    return new Session(id, resolve(dir, matches[0]));
  }
  async records() { return (await readFile(this.path, "utf8")).trim().split("\n").filter(Boolean).map(line => JSON.parse(line) as any); }
  async append(record: SessionRecord) { await appendFile(this.path, JSON.stringify({ ...record, timestamp: new Date().toISOString() }) + "\n"); }
}

function formatTokens(n: number) {
  return n < 1e3 ? `${n}` : n < 1e4 ? `${(n / 1e3).toFixed(1)}k` : n < 1e6 ? `${Math.round(n / 1e3)}k` : n < 1e7 ? `${(n / 1e6).toFixed(1)}M` : `${Math.round(n / 1e6)}M`;
}

export function usageLine({ input, output, cacheRead, cacheWrite, cacheHitRate }: Usage) {
  return [`↑${formatTokens(input)}`, `↓${formatTokens(output)}`, cacheRead && `R${formatTokens(cacheRead)}`, cacheWrite && `W${formatTokens(cacheWrite)}`, (cacheRead > 0 || cacheWrite > 0) && cacheHitRate !== undefined && `CH${cacheHitRate.toFixed(1)}%`].filter(Boolean).join(" ");
}

const specs = [
  ["bash", "Run a shell command in the working directory", { command: { type: "string" } }],
  ["read", "Read a UTF-8 text file", { path: { type: "string" } }],
  ["write", "Create or overwrite a UTF-8 text file", { path: { type: "string" }, content: { type: "string" } }],
  ["edit", "Replace one unique exact string in a UTF-8 text file", { path: { type: "string" }, oldText: { type: "string" }, newText: { type: "string" } }],
].map(([name, description, properties]) => ({ type: "function", function: { name, description, parameters: { type: "object", properties, required: Object.keys(properties as object) } } }));

function pathInRoot(path: string) {
  const full = resolve(root, path);
  if (full !== root && !full.startsWith(root + "/")) throw Error("path must stay inside cwd");
  return full;
}

export async function tool(name: string, a: Record<string, string>, signal?: AbortSignal) {
  if (signal?.aborted) throw Error("Operation aborted");
  if (name === "bash") {
    const { stdout, stderr } = await run(a.command, { cwd: root, timeout: 120_000, maxBuffer: 10_000_000, signal }), output = stdout + stderr || "(no output)";
    const bytes = Buffer.from(output); if (bytes.length <= MAX_TOOL_OUTPUT) return output;
    const path = resolve(root, ".tiny-agent/tool-output", `${uuid7()}.log`); await mkdir(dirname(path), { recursive: true }); await writeFile(path, output);
    let start = bytes.length - MAX_TOOL_OUTPUT; while ((bytes[start] & 0xc0) === 0x80) start++;
    return `${bytes.subarray(start).toString()}\n\n[Output truncated. Full output: ${path}]`;
  }
  const path = pathInRoot(a.path);
  if (name === "read") return (await readFile(path, { encoding: "utf8", signal })).slice(0, 100_000);
  if (name === "write") return mkdir(dirname(path), { recursive: true }).then(() => { if (signal?.aborted) throw Error("Operation aborted"); return writeFile(path, a.content, { signal }); }).then(() => "ok");
  if (name === "edit") {
    const text = await readFile(path, { encoding: "utf8", signal }), parts = text.split(a.oldText);
    if (parts.length !== 2) throw Error(`oldText must occur exactly once (found ${parts.length - 1})`);
    if (signal?.aborted) throw Error("Operation aborted");
    await writeFile(path, parts.join(a.newText), { signal }); return "ok";
  }
  throw Error(`unknown tool: ${name}`);
}

async function walk(dir: string): Promise<string[]> {
  try {
    const out: string[] = [];
    for (const e of await readdir(dir, { withFileTypes: true })) e.isDirectory() ? out.push(...await walk(resolve(dir, e.name))) : e.name === "SKILL.md" && out.push(resolve(dir, e.name));
    return out;
  } catch { return []; }
}

export async function loadAgents(cwd = root) {
  return readFile(resolve(cwd, "AGENTS.md"), "utf8").catch(() => "");
}

export async function loadSkills(extra: string[] = []) {
  const files = [...new Set([...await walk(resolve(root, ".tiny-agent/skills")), ...extra.map(path => resolve(path))])];
  return Promise.all(files.map(async path => {
    const text = await readFile(path, "utf8"), head = text.match(/^---\n([\s\S]*?)\n---/)?.[1] ?? "";
    const field = (key: string) => head.match(new RegExp(`^${key}:\\s*["']?(.*?)["']?$`, "m"))?.[1] ?? "";
    return { name: field("name") || basename(dirname(path)), description: field("description"), path };
  }));
}

export class Agent {
  messages: Msg[];
  usage: Usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  private active?: { controller: AbortController; phase: "model" | "tool" | "compact"; toolCallId?: string };
  constructor(public skills: Skill[] = [], public fetcher: typeof fetch = fetch, public session?: Session, public onTool: (event: ToolEvent) => void = () => {}, instructions = "") {
    const list = skills.map(s => `<skill>\n<name>${s.name}</name>\n<description>${s.description}</description>\n<location>${s.path}</location>\n</skill>`).join("\n") || "(none)";
    const project = instructions ? `\n\n<project_context>\n\nProject-specific instructions and guidelines:\n\n<project_instructions path="${resolve(root, "AGENTS.md")}">\n${instructions}\n</project_instructions>\n\n</project_context>` : "";
    this.messages = [{ role: "system", content: `You are tiny-agent, a concise coding agent in ${root}. Use tools to inspect and change files. Follow the project instructions below. When a task matches an available skill, use read on its location before following it.${project}\n\n<available_skills>\n${list}\n</available_skills>` }];
  }
  get busy() { return !!this.active; }
  abort() { this.active?.controller.abort(); }
  private start(phase: "model" | "tool" | "compact", toolCallId?: string) {
    const controller = new AbortController(); this.active = { controller, phase, toolCallId }; return controller.signal;
  }
  private finish() { this.active = undefined; }
  private async interrupted(phase: "model" | "tool" | "compact", toolCallId?: string) {
    await this.session?.append({ type: "interruption", phase, toolCallId, reason: "escape" });
  }
  async restore() {
    if (!this.session) return;
    for (const r of (await this.session.records()).slice(1)) {
      if (r.type === "message") {
        this.messages.push(r.message);
        if (r.usage) {
          for (const k of ["input", "output", "cacheRead", "cacheWrite"] as const) this.usage[k] += r.usage[k] ?? 0;
          const prompt = r.usage.input + r.usage.cacheRead + r.usage.cacheWrite;
          if (prompt > 0) this.usage.cacheHitRate = r.usage.cacheRead / prompt * 100;
        }
      } else if (r.type === "compaction") {
        const recent = r.keptMessages > 0 ? this.messages.slice(-r.keptMessages) : [];
        this.messages = [this.messages[0], { role: "user", content: `[Compacted history]\n${r.summary}` }, ...recent];
        for (const k of ["input", "output", "cacheRead", "cacheWrite"] as const) this.usage[k] += r.usage[k] ?? 0;
      }
    }
  }
  async call(messages = this.messages, tools: unknown = specs, updateCacheRate = true, signal?: AbortSignal) {
    const key = process.env.OPENROUTER_API_KEY;
    if (!key) throw Error("Set OPENROUTER_API_KEY");
    const body = { model: MODEL, messages, ...(tools ? { tools } : {}) };
    const r = await this.fetcher("https://openrouter.ai/api/v1/chat/completions", { method: "POST", signal, headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", "HTTP-Referer": "https://github.com/tiny-agent" }, body: JSON.stringify(body) });
    if (!r.ok) throw Error(`OpenRouter ${r.status}: ${await r.text()}`);
    const data = await r.json() as any, u = data.usage ?? {}, details = u.prompt_tokens_details ?? {};
    const cacheRead = details.cached_tokens ?? u.prompt_cache_hit_tokens ?? 0, cacheWrite = details.cache_write_tokens ?? 0;
    const input = Math.max(0, (u.prompt_tokens ?? 0) - cacheRead - cacheWrite);
    this.usage.input += input;
    this.usage.output += u.completion_tokens ?? 0;
    this.usage.cacheRead += cacheRead;
    this.usage.cacheWrite += cacheWrite;
    const prompt = input + cacheRead + cacheWrite;
    if (updateCacheRate && prompt > 0) this.usage.cacheHitRate = cacheRead / prompt * 100;
    return { message: data.choices[0].message as Msg, usage: { input, output: u.completion_tokens ?? 0, cacheRead, cacheWrite } };
  }
  async prompt(text: string) {
    const user: Msg = { role: "user", content: text };
    this.messages.push(user); await this.session?.append({ type: "message", message: user });
    for (;;) {
      let answer: Msg, usage: Omit<Usage, "cacheHitRate">;
      try { ({ message: answer, usage } = await this.call(this.messages, specs, true, this.start("model"))); }
      catch (e) {
        const aborted = this.active?.controller.signal.aborted; this.finish();
        if (aborted) { await this.interrupted("model"); return "Operation aborted."; }
        throw e;
      }
      this.finish(); this.messages.push(answer);
      await this.session?.append({ type: "message", message: answer, usage });
      if (!answer.tool_calls?.length) return answer.content ?? "";
      for (let i = 0; i < answer.tool_calls.length; i++) {
        const c = answer.tool_calls[i]; let content: string, args: Record<string, string> = {}, aborted = false;
        try {
          args = JSON.parse(c.function.arguments); this.onTool({ phase: "start", name: c.function.name, args });
          content = await tool(c.function.name, args, this.start("tool", c.id));
        }
        catch (e) { aborted = !!this.active?.controller.signal.aborted; content = aborted ? "Operation aborted" : `Error: ${e instanceof Error ? e.message : e}`; }
        this.finish(); this.onTool({ phase: "end", name: c.function.name, args, result: content });
        const result: Msg = { role: "tool", tool_call_id: c.id, content };
        this.messages.push(result); await this.session?.append({ type: "message", message: result, toolName: c.function.name });
        if (aborted) {
          for (const pending of answer.tool_calls.slice(i + 1)) {
            const skipped: Msg = { role: "tool", tool_call_id: pending.id, content: "Operation aborted before execution" };
            this.messages.push(skipped); await this.session?.append({ type: "message", message: skipped, toolName: pending.function.name });
          }
          await this.interrupted("tool", c.id);
          return "Operation aborted.";
        }
      }
    }
  }
  async compact() {
    const keep = 6;
    if (this.messages.length <= 1) return "Nothing to compact.";
    let cut = Math.max(this.messages.length - keep, 1);
    while (cut > 1 && this.messages[cut].role !== "user") cut--;
    const recent = this.messages.slice(cut), old = this.messages.slice(1, cut);
    if (!old.length) return "Nothing to compact.";
    let summary: Msg, usage: Omit<Usage, "cacheHitRate">;
    try { ({ message: summary, usage } = await this.call([{ role: "system", content: "Summarize this coding session compactly. Preserve decisions, changed files, errors, and next steps." }, { role: "user", content: JSON.stringify(old) }], null, false, this.start("compact"))); }
    catch (e) {
      const aborted = this.active?.controller.signal.aborted; this.finish();
      if (aborted) { await this.interrupted("compact"); return "Compaction aborted."; }
      throw e;
    }
    this.finish();
    const compacted: Msg = { role: "user", content: `[Compacted history]\n${summary.content}` };
    this.messages = [this.messages[0], compacted, ...recent];
    await this.session?.append({ type: "compaction", summary: summary.content, compactedMessages: old.length, keptMessages: keep, usage });
    return `Compacted ${old.length} messages (kept last ${keep}).`;
  }
}

async function main() {
  const args = process.argv.slice(2), value = (flag: string) => args[args.indexOf(flag) + 1], sessionId = value("--session");
  if (args.includes("--session") && !sessionId) throw Error("--session requires a UUIDv7");
  const extras = args.flatMap((x, i) => x === "--skill" && args[i + 1] ? [args[i + 1]] : []), skills = await loadSkills(extras), instructions = await loadAgents();
  const session = sessionId ? await Session.open(sessionId) : await Session.create();
  const showTool = (event: ToolEvent) => console.log(`\x1b[${event.phase === "start" ? "33" : "2"}m${toolLine(event)}\x1b[0m`);
  const agent = new Agent(skills, fetch, session, showTool, instructions);
  if (sessionId) await agent.restore();
  const oneShot = args.filter((x, i) => !["--skill", "--session"].includes(x) && !["--skill", "--session"].includes(args[i - 1])).join(" ");
  const resume = () => console.log(`\nResume: npm run dev -- --session ${session.id}`);
  const rl = createInterface({ input: process.stdin, output: process.stdout }), ask = (q: string) => new Promise<string>(ok => rl.question(q, ok));
  emitKeypressEvents(process.stdin, rl); if (process.stdin.isTTY) process.stdin.setRawMode(true);
  const escape = (_: string, key: { name?: string }) => { if (key.name === "escape" && agent.busy) { console.log("\n\x1b[33mAborting...\x1b[0m"); agent.abort(); } };
  process.stdin.on("keypress", escape);
  const close = () => { process.stdin.off("keypress", escape); rl.close(); resume(); };
  console.log(`\x1b[36mtiny-agent\x1b[0m\nprovider: openrouter\nmodel: ${MODEL}\nsession: ${session.id}\npath: ${session.path}${sessionId ? "\nrestored: yes" : ""}`);
  if (oneShot) {
    console.log(`\n${await agent.prompt(oneShot)}`);
    console.log(`\x1b[2m${usageLine(agent.usage)}\x1b[0m`); return close();
  }
  console.log("Esc aborts the active model/tool/compact operation.\n/compact  /skill:name  /exit");
  while (true) {
    const input = (await ask("\x1b[32m›\x1b[0m ")).trim();
    if (!input) continue; if (input === "/exit") break;
    if (input === "/compact") {
      console.log(await agent.compact());
      console.log(`\x1b[2m${usageLine(agent.usage)}\x1b[0m`);
    }
    else if (input.startsWith("/skill:")) {
      const [name, ...rest] = input.slice(7).split(" "), skill = skills.find(s => s.name === name);
      console.log(skill ? await agent.prompt(`${await readFile(skill.path, "utf8")}\n\nUser: ${rest.join(" ")}`) : `Unknown skill: ${name}`);
      if (skill) console.log(`\x1b[2m${usageLine(agent.usage)}\x1b[0m`);
    } else {
      console.log(`\x1b[36m${await agent.prompt(input)}\x1b[0m`);
      console.log(`\x1b[2m${usageLine(agent.usage)}\x1b[0m`);
    }
  }
  close();
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)) main().catch(e => { console.error(e.message); process.exitCode = 1; });
