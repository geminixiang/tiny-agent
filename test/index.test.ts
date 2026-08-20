import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

const dir = await mkdtemp(join(tmpdir(), "tiny-agent-"));
process.chdir(dir);
const { Agent, MODEL, Session, loadAgents, loadSkills, tool, toolLine, usageLine } = await import("../src/index.js");

test("loads cwd AGENTS.md into the system prompt", async () => {
  await writeFile("AGENTS.md", "Always answer briefly.\n");
  const context = await loadAgents();
  assert.deepEqual(context, [{ path: resolve(process.cwd(), "AGENTS.md"), content: "Always answer briefly.\n" }]);
  const system = new Agent([], fetch, undefined, () => {}, context).messages[0].content!;
  assert.match(system, /<project_context>/);
  assert.match(system, /<project_instructions path=".*\/AGENTS\.md">\nAlways answer briefly\./);
  assert.deepEqual(await loadAgents(resolve(dir, "missing")), []);
});

test("formats concise TUI tool events", () => {
  assert.equal(toolLine({ phase: "start", name: "read", args: { path: "README.md" } }), "◆ read README.md");
  assert.equal(toolLine({ phase: "start", name: "write", args: { path: "a.txt", content: "hello" } }), "◆ write a.txt (5 chars)");
  assert.equal(toolLine({ phase: "end", name: "read", args: {}, result: "hello" }), "  └ 5 chars");
  assert.equal(toolLine({ phase: "end", name: "write", args: {}, result: "ok" }), "  └ ok");
});

test("creates versioned UUIDv7 JSONL sessions", async () => {
  const now = new Date("2026-08-03T03:55:50.062Z"), session = await Session.create(dir, now);
  assert.match(session.path, /\.tiny-agent\/sessions\/2026-08-03T03-55-50-062Z_[0-9a-f-]+\.jsonl$/);
  assert.match(session.id, /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  await session.append({ type: "message", message: { role: "user", content: "hi" } });
  assert.equal((await Session.open(session.id, dir)).path, session.path);
  const lines = (await readFile(session.path, "utf8")).trim().split("\n").map(line => JSON.parse(line));
  assert.deepEqual(lines[0], { type: "session", version: 1, id: session.id, createdAt: now.toISOString(), cwd: dir, provider: "openrouter", model: MODEL, timestamp: lines[0].timestamp });
  assert.equal(lines[1].message.content, "hi");
});

test("restores messages, compaction, and cumulative usage", async () => {
  const session = await Session.create(dir, new Date("2026-08-04T00:00:00Z"));
  await session.append({ type: "message", message: { role: "user", content: "old" } });
  await session.append({ type: "message", message: { role: "assistant", content: "answer" }, usage: { input: 80, output: 5, cacheRead: 20, cacheWrite: 0 } });
  await session.append({ type: "compaction", summary: "summary", compactedMessages: 2, keptMessages: 0, usage: { input: 40, output: 4, cacheRead: 0, cacheWrite: 0 } });
  await session.append({ type: "message", message: { role: "user", content: "new" } });
  const agent = new Agent([], fetch, session); await agent.restore();
  assert.deepEqual(agent.messages.slice(1), [{ role: "user", content: "[Compacted history]\nsummary" }, { role: "user", content: "new" }]);
  assert.deepEqual(agent.usage, { input: 120, output: 9, cacheRead: 20, cacheWrite: 0, cacheHitRate: 20 });
});

test("formats pi-style token usage and cache ratio", () => {
  assert.equal(usageLine({ input: 1200, output: 30, cacheRead: 500, cacheWrite: 100, cacheHitRate: 27.777 }), "↑1.2k ↓30 R500 W100 CH27.8%");
  assert.equal(usageLine({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }), "↑0 ↓0");
});

test("pins the requested OpenRouter model", () => assert.equal(MODEL, "deepseek/deepseek-v4-flash-0731"));

test("write, read, edit", async () => {
  assert.equal(await tool("write", { path: "a.txt", content: "hello" }), "ok");
  assert.equal(await tool("read", { path: "a.txt" }), "hello");
  assert.equal(await tool("edit", { path: "a.txt", oldText: "hello", newText: "hi" }), "ok");
  assert.equal(await tool("read", { path: "a.txt" }), "hi");
  await assert.rejects(() => tool("read", { path: "../secret" }), /inside cwd/);
});

test("discovers skills and fills system prompt", async () => {
  await mkdir(".tiny-agent/skills/teach", { recursive: true });
  await writeFile(".tiny-agent/skills/teach/SKILL.md", "---\nname: teach\ndescription: Teaches tiny agents.\n---\nSECRET INSTRUCTIONS");
  await mkdir(".pi/skills/demo", { recursive: true });
  await writeFile(".pi/skills/demo/SKILL.md", "---\nname: demo\ndescription: Teaches demos.\n---\n# Demo");
  const skills = await loadSkills();
  assert.deepEqual(skills.map(({ name, description }) => ({ name, description })), [{ name: "teach", description: "Teaches tiny agents." }, { name: "demo", description: "Teaches demos." }]);
  const system = new Agent(skills).messages[0].content!;
  assert.match(system, /^You are tiny-agent, a concise coding agent/);
  assert.match(system, /<name>teach<\/name>/);
  assert.match(system, /<description>Teaches tiny agents\.<\/description>/);
  assert.match(system, /\.tiny-agent\/skills\/teach\/SKILL\.md/);
  assert.doesNotMatch(system, /SECRET INSTRUCTIONS/);
});

test("counts cache from DeepSeek-style prompt_cache_hit_tokens", async () => {
  process.env.OPENROUTER_API_KEY = "test";
  const fakeFetch = async () => new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content: "ok" } }], usage: { prompt_tokens: 200, completion_tokens: 10, prompt_cache_hit_tokens: 80, prompt_cache_miss_tokens: 120 } }), { status: 200 });
  const agent = new Agent([], fakeFetch as typeof fetch);
  assert.equal(await agent.prompt("hi"), "ok");
  assert.deepEqual(agent.usage, { input: 120, output: 10, cacheRead: 80, cacheWrite: 0, cacheHitRate: 40 });
});

test("runs tool calls and compacts through mocked OpenRouter", async () => {
  process.env.OPENROUTER_API_KEY = "test";
  const replies = [
    { choices: [{ message: { role: "assistant", content: null, tool_calls: [{ id: "1", type: "function", function: { name: "write", arguments: '{"path":"made.txt","content":"yes"}' } }] } }], usage: { prompt_tokens: 100, completion_tokens: 10, prompt_tokens_details: { cached_tokens: 25 } } },
    { choices: [{ message: { role: "assistant", content: "done" } }], usage: { prompt_tokens: 120, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 60 } } },
    { choices: [{ message: { role: "assistant", content: "summary" } }], usage: { prompt_tokens: 80, completion_tokens: 8, prompt_tokens_details: { cached_tokens: 20 } } },
  ];
  const requests: any[] = [];
  const fakeFetch = async (_url: unknown, init: any) => { requests.push(JSON.parse(init.body)); return new Response(JSON.stringify(replies.shift()), { status: 200 }); };
  const events: any[] = [], agent = new Agent([], fakeFetch as typeof fetch, undefined, event => events.push(event));
  assert.equal(await agent.prompt("make it"), "done");
  assert.deepEqual(events.map(({ phase, name, result }) => ({ phase, name, result })), [{ phase: "start", name: "write", result: undefined }, { phase: "end", name: "write", result: "ok" }]);
  assert.deepEqual(agent.usage, { input: 135, output: 15, cacheRead: 85, cacheWrite: 0, cacheHitRate: 50 });
  assert.equal(await tool("read", { path: "made.txt" }), "yes");
  agent.messages.push({ role: "user", content: "one" }, { role: "assistant", content: "two" }, { role: "user", content: "three" }, { role: "assistant", content: "four" });
  assert.match(await agent.compact(), /Compacted/);
  assert.deepEqual(agent.usage, { input: 195, output: 23, cacheRead: 105, cacheWrite: 0, cacheHitRate: 50 });
  assert.equal(requests[0].model, MODEL);
  assert.equal(requests[2].tools, undefined);
});
