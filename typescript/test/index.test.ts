import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

const dir = await mkdtemp(join(tmpdir(), "tiny-agent-"));
process.chdir(dir);
const { Agent, MODEL, Session, loadProjectInstructions, loadSkills, executeTool, formatToolEvent, formatUsage } =
    await import("../src/index.js");

test("loads cwd AGENTS.md into the system prompt", async () => {
    await writeFile("AGENTS.md", "Always answer briefly.\n");
    const instructions = await loadProjectInstructions();
    assert.equal(instructions, "Always answer briefly.\n");
    const system = new Agent([], fetch, undefined, () => {}, instructions).messages[0].content!;
    assert.match(system, /<project_context>/);
    assert.match(system, /inspect only what is needed, then make the changes and run focused tests/);
    assert.match(system, /Use read to inspect files, write for new files, edit for existing files/);
    assert.match(system, /If repeated experiments fail, reconsider the approach/);
    assert.match(system, /<project_instructions path=".*\/AGENTS\.md">\nAlways answer briefly\./);
    assert.equal(await loadProjectInstructions(resolve(dir, "missing")), "");
});

test("formats concise TUI tool events", () => {
    assert.equal(formatToolEvent({ phase: "start", name: "read", args: { path: "README.md" } }), "◆ read README.md");
    assert.equal(
        formatToolEvent({ phase: "start", name: "write", args: { path: "a.txt", content: "hello" } }),
        "◆ write a.txt (5 chars)",
    );
    assert.equal(formatToolEvent({ phase: "end", name: "read", args: {}, result: "hello" }), "  └ 5 chars");
    assert.equal(
        formatToolEvent({ phase: "end", name: "write", args: {}, result: "Successfully wrote 5 bytes to a.txt." }),
        "  └ 36 chars",
    );
});

test("creates versioned UUIDv7 JSONL sessions", async () => {
    const now = new Date("2026-08-03T03:55:50.062Z"),
        session = await Session.create(dir, now);
    assert.match(session.path, /\.tiny-agent\/sessions\/2026-08-03T03-55-50-062Z_[0-9a-f-]+\.jsonl$/);
    assert.match(session.id, /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    await session.append({ type: "message", message: { role: "user", content: "hi" } });
    assert.equal((await Session.open(session.id, dir)).path, session.path);
    const lines = (await readFile(session.path, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
    assert.deepEqual(lines[0], {
        type: "session",
        version: 1,
        id: session.id,
        createdAt: now.toISOString(),
        cwd: dir,
        provider: "openrouter",
        model: MODEL,
        timestamp: lines[0].timestamp,
    });
    assert.equal(lines[1].message.content, "hi");
});

test("restores messages, compaction, and cumulative usage", async () => {
    const session = await Session.create(dir, new Date("2026-08-04T00:00:00Z"));
    await session.append({ type: "message", message: { role: "user", content: "old" } });
    await session.append({
        type: "message",
        message: { role: "assistant", content: "answer" },
        usage: { input: 80, output: 5, cacheRead: 20, cacheWrite: 0 },
    });
    await session.append({
        type: "compaction",
        summary: "summary",
        compactedMessages: 2,
        keptMessages: 0,
        usage: { input: 40, output: 4, cacheRead: 0, cacheWrite: 0 },
    });
    await session.append({ type: "message", message: { role: "user", content: "new" } });
    const agent = new Agent([], fetch, session);
    await agent.resumeSession();
    assert.deepEqual(agent.messages.slice(1), [
        { role: "user", content: "[Compacted history]\nsummary" },
        { role: "user", content: "new" },
    ]);
    assert.deepEqual(agent.usage, {
        input: 120,
        output: 9,
        cacheRead: 20,
        cacheWrite: 0,
        cacheHitRate: 14.285714285714285,
    });
});

test("Esc aborts a model request and persists an interruption", async () => {
    process.env.OPENROUTER_API_KEY = "test";
    const session = await Session.create(dir, new Date("2026-08-05T00:00:00Z"));
    const hangingFetch = async (_url: unknown, init: any) =>
        new Promise<Response>((_, reject) =>
            init.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))),
        );
    const agent = new Agent([], hangingFetch as typeof fetch, session),
        pending = agent.runAgentLoop("wait");
    while (!agent.busy) await new Promise((ok) => setImmediate(ok));
    assert.equal(agent.busy, true);
    agent.abort();
    assert.equal(await pending, "Operation aborted.");
    assert.equal(agent.busy, false);
    const records = await session.records();
    assert.equal(records.at(-1).type, "interruption");
    assert.equal(records.at(-1).phase, "model");
    assert.deepEqual(agent.messages.slice(1), [{ role: "user", content: "wait" }]);
});

test("Esc during a tool records legal results for every call", async () => {
    process.env.OPENROUTER_API_KEY = "test";
    const session = await Session.create(dir, new Date("2026-08-06T00:00:00Z"));
    const reply = {
        choices: [
            {
                message: {
                    role: "assistant",
                    content: null,
                    tool_calls: [
                        {
                            id: "slow",
                            type: "function",
                            function: { name: "bash", arguments: '{"command":"sleep 30"}' },
                        },
                        {
                            id: "later",
                            type: "function",
                            function: { name: "write", arguments: '{"path":"never.txt","content":"no"}' },
                        },
                    ],
                },
            },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 2 },
    };
    const agent = new Agent(
        [],
        (async () => new Response(JSON.stringify(reply), { status: 200 })) as typeof fetch,
        session,
    );
    const pending = agent.runAgentLoop("run");
    while (!agent.busy) await new Promise((ok) => setImmediate(ok));
    await new Promise((ok) => setTimeout(ok, 20));
    agent.abort();
    assert.equal(await pending, "Operation aborted.");
    const tools = agent.messages.filter((m) => m.role === "tool");
    assert.deepEqual(
        tools.map((m) => [m.tool_call_id, m.content]),
        [
            ["slow", "Operation aborted"],
            ["later", "Operation aborted before execution"],
        ],
    );
    const records = await session.records();
    assert.equal(records.at(-1).type, "interruption");
    assert.equal(records.at(-1).phase, "tool");
});

test("Esc aborts compaction without changing context", async () => {
    process.env.OPENROUTER_API_KEY = "test";
    const session = await Session.create(dir, new Date("2026-08-07T00:00:00Z"));
    const hangingFetch = async (_url: unknown, init: any) =>
        new Promise<Response>((_, reject) =>
            init.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))),
        );
    const agent = new Agent([], hangingFetch as typeof fetch, session);
    agent.messages.push(
        ...Array.from({ length: 8 }, (_, i) => ({ role: i % 2 ? "assistant" : "user", content: `${i}` }) as const),
    );
    const before = structuredClone(agent.messages),
        pending = agent.compact();
    while (!agent.busy) await new Promise((ok) => setImmediate(ok));
    agent.abort();
    assert.equal(await pending, "Compaction aborted.");
    assert.deepEqual(agent.messages, before);
    assert.equal((await session.records()).find((r) => r.type === "interruption")?.phase, "compact");
});

test("compact records the actual number retained at a user boundary", async () => {
    process.env.OPENROUTER_API_KEY = "test";
    const summary = { choices: [{ message: { role: "assistant", content: "summary" } }], usage: {} };
    const session = await Session.create(dir, new Date("2026-08-07T12:00:00Z"));
    const agent = new Agent(
        [],
        (async () => new Response(JSON.stringify(summary), { status: 200 })) as typeof fetch,
        session,
    );
    agent.messages.push(
        { role: "user", content: "old" },
        { role: "assistant", content: "old answer" },
        { role: "user", content: "keep" },
        ...Array.from({ length: 6 }, (_, i) => ({ role: "assistant", content: `${i}` }) as const),
    );
    assert.equal(await agent.compact(), "Compacted 2 messages (kept last 7).");
    const record = (await session.records()).at(-1);
    assert.equal(record.keptMessages, 7);
});

test("compact keeps assistant tool calls with their results", async () => {
    process.env.OPENROUTER_API_KEY = "test";
    const summary = { choices: [{ message: { role: "assistant", content: "summary" } }], usage: {} };
    const agent = new Agent([], (async () => new Response(JSON.stringify(summary), { status: 200 })) as typeof fetch);
    agent.messages.push(
        { role: "user", content: "old" },
        { role: "assistant", content: "old answer" },
        { role: "user", content: "run" },
        {
            role: "assistant",
            content: null,
            tool_calls: [{ id: "1", type: "function", function: { name: "read", arguments: '{"path":"a.txt"}' } }],
        },
        { role: "tool", tool_call_id: "1", content: "data" },
        { role: "assistant", content: "done" },
        { role: "user", content: "next" },
        { role: "assistant", content: "answer" },
    );
    assert.equal(await agent.compact(), "Compacted 2 messages (kept last 6).");
    assert.equal(agent.messages[2].content, "run");
    assert.deepEqual(
        agent.messages.slice(3, 5).map((m) => [m.role, m.tool_call_id]),
        [
            ["assistant", undefined],
            ["tool", "1"],
        ],
    );
});

test("formats pi-style token usage and cache ratio", () => {
    assert.equal(
        formatUsage({ input: 1200, output: 30, cacheRead: 500, cacheWrite: 100, cacheHitRate: 27.777 }),
        "↑1.2k ↓30 R500 W100 CH27.8%",
    );
    assert.equal(formatUsage({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }), "↑0 ↓0");
});

test("uses the default OpenRouter model", () =>
    assert.equal(MODEL, process.env.TINY_MODEL || "deepseek/deepseek-v4-flash-0731"));

test("read paginates complete UTF-8 lines with actionable errors", async () => {
    await writeFile("read.txt", "one\ntwo\nthree\nfour\n");
    assert.equal(
        await executeTool("read", { path: "read.txt", limit: 2 }),
        "one\ntwo\n\n[Showing lines 1-2 of 4. Use offset=3 to continue.]",
    );
    assert.equal(
        await executeTool("read", { path: "read.txt", offset: 2, limit: 2 }),
        "two\nthree\n\n[Showing lines 2-3 of 4. Use offset=4 to continue.]",
    );
    await assert.rejects(() => executeTool("read", { path: "read.txt", offset: 5 }), /beyond end.*4 lines/);
    await writeFile("wide.txt", "你".repeat(30_000) + "\nnext\n");
    assert.match(await executeTool("read", { path: "wide.txt" }), /Line 1 exceeds 50KB.*byte-oriented/);
    await writeFile("many.txt", Array.from({ length: 2_001 }, (_, i) => `${i + 1}`).join("\n"));
    const many = await executeTool("read", { path: "many.txt" });
    assert.match(many, /\[Showing lines 1-2000 of 2001\. Use offset=2001 to continue\.\]$/);
});

test("write reports UTF-8 bytes and edit applies atomic exact replacements", async () => {
    assert.equal(
        await executeTool("write", { path: "a.txt", content: "你好" }),
        "Successfully wrote 6 bytes to a.txt.",
    );
    await writeFile("edit.txt", "alpha\nbeta\ngamma\n");
    assert.equal(
        await executeTool("edit", {
            path: "edit.txt",
            edits: [
                { oldText: "alpha", newText: "one" },
                { oldText: "gamma", newText: "three" },
            ],
        }),
        "Successfully replaced 2 block(s) in edit.txt.",
    );
    assert.equal(await readFile("edit.txt", "utf8"), "one\nbeta\nthree\n");

    for (const edits of [
        [{ oldText: "", newText: "x" }],
        [{ oldText: "missing", newText: "x" }],
        [{ oldText: "e", newText: "x" }],
        [
            { oldText: "one\nbeta", newText: "x" },
            { oldText: "beta\nthree", newText: "y" },
        ],
    ]) {
        const before = await readFile("edit.txt", "utf8");
        await assert.rejects(
            () => executeTool("edit", { path: "edit.txt", edits }),
            /must not be empty|not found|more than once|overlap/,
        );
        assert.equal(await readFile("edit.txt", "utf8"), before);
    }

    await writeFile("windows.txt", "\uFEFFfirst\r\nsecond\r\n");
    await executeTool("edit", {
        path: "windows.txt",
        edits: [{ oldText: "first\nsecond", newText: "third\nfourth" }],
    });
    assert.equal(await readFile("windows.txt", "utf8"), "\uFEFFthird\r\nfourth\r\n");
    await writeFile("mixed.txt", "first\r\nkeep\nlast\r\n");
    await executeTool("edit", {
        path: "mixed.txt",
        edits: [{ oldText: "first\nkeep", newText: "changed\nkeep" }],
    });
    assert.equal(await readFile("mixed.txt", "utf8"), "changed\r\nkeep\nlast\r\n");
    await assert.rejects(() => executeTool("read", { path: "../secret" }), /inside cwd/);
});

test("bash preserves failures, validates timeout, and stores truncated output", async () => {
    const failed = await executeTool("bash", { command: "printf 'stdout'; printf 'stderr' >&2; exit 7" });
    assert.match(failed, /stdoutstderr\n\nCommand exited with code 7$/);
    await assert.rejects(() => executeTool("bash", { command: "true", timeout: 0 }), /positive number/);
    assert.match(await executeTool("bash", { command: "sleep 1", timeout: 0.01 }), /timed out after 0.01 seconds/);

    const result = await executeTool("bash", {
        command: "printf 'begin\\n'; yes x | head -n 3000; printf 'end\\n'",
    });
    assert.match(
        result,
        /\[Showing lines \d+-3002 of 3002\. Full output: (.*\.tiny-agent\/tool-output\/[0-9a-f-]+\.log)\]$/,
    );
    const path = result.match(/Full output: (.*)\]/)![1],
        full = await readFile(path, "utf8");
    assert.match(full, /^begin\n/);
    assert.match(full, /end\n$/);
    assert.ok(result.split("\n").length <= 2_002);
    assert.ok(Buffer.byteLength(result) < Buffer.byteLength(full));
    const longLine = await executeTool("bash", { command: `printf '${"x".repeat(60_000)}\\ndone\\n'` });
    assert.ok(Buffer.byteLength(longLine) > 40_000);
    assert.match(longLine, /done\n/);
    assert.match(await executeTool("read", { path, limit: 2 }), /Use offset=3 to continue/);
});

test("handles provider stop reasons and rejects empty final responses", async () => {
    const responses = [
        {
            choices: [
                {
                    finish_reason: "length",
                    message: {
                        role: "assistant",
                        content: null,
                        tool_calls: [
                            {
                                id: "truncated",
                                type: "function",
                                function: { name: "write", arguments: '{"path":"never.txt"' },
                            },
                        ],
                    },
                },
            ],
            usage: {},
        },
        { choices: [{ finish_reason: "stop", message: { role: "assistant", content: "done" } }], usage: {} },
    ];
    const agent = new Agent([], async () => new Response(JSON.stringify(responses.shift()), { status: 200 }));
    assert.equal(await agent.runAgentLoop("work"), "done");
    await assert.rejects(() => readFile("never.txt"), /ENOENT/);
    assert.match(agent.messages.at(-2)?.content ?? "", /truncated by the model token limit/);

    const empty = new Agent(
        [],
        async () =>
            new Response(
                JSON.stringify({
                    choices: [{ finish_reason: "stop", message: { role: "assistant", content: "\n\n" } }],
                    usage: {},
                }),
                { status: 200 },
            ),
    );
    await assert.rejects(() => empty.runAgentLoop("work"), /empty response.*finish_reason: stop/);

    for (const finish_reason of ["content_filter", "network_error", "mystery"]) {
        const rejected = new Agent(
            [],
            async () =>
                new Response(
                    JSON.stringify({
                        choices: [{ finish_reason, message: { role: "assistant", content: "" } }],
                        usage: {},
                    }),
                    { status: 200 },
                ),
        );
        await assert.rejects(() => rejected.runAgentLoop("work"), /Provider finish_reason|Unknown provider/);
    }
});

test("discovers skills and fills system prompt", async () => {
    await mkdir(".tiny-agent/skills/teach", { recursive: true });
    await writeFile(
        ".tiny-agent/skills/teach/SKILL.md",
        "---\nname: teach\ndescription: Teaches tiny agents.\n---\nSECRET INSTRUCTIONS",
    );
    await mkdir(".pi/skills/demo", { recursive: true });
    await writeFile(".pi/skills/demo/SKILL.md", "---\nname: demo\ndescription: Must not load.\n---\n# Demo");
    const skills = await loadSkills();
    assert.deepEqual(
        skills.map(({ name, description }) => ({ name, description })),
        [{ name: "teach", description: "Teaches tiny agents." }],
    );
    const system = new Agent(skills).messages[0].content!;
    assert.match(system, /^You are tiny-agent, a concise coding agent/);
    assert.match(system, /<name>teach<\/name>/);
    assert.match(system, /<description>Teaches tiny agents\.<\/description>/);
    assert.match(system, /\.tiny-agent\/skills\/teach\/SKILL\.md/);
    assert.doesNotMatch(system, /SECRET INSTRUCTIONS/);
});

test("counts cache from DeepSeek-style prompt_cache_hit_tokens", async () => {
    process.env.OPENROUTER_API_KEY = "test";
    const fakeFetch = async () =>
        new Response(
            JSON.stringify({
                choices: [{ message: { role: "assistant", content: "ok" } }],
                usage: {
                    prompt_tokens: 200,
                    completion_tokens: 10,
                    prompt_cache_hit_tokens: 80,
                    prompt_cache_miss_tokens: 120,
                },
            }),
            { status: 200 },
        );
    const agent = new Agent([], fakeFetch as typeof fetch);
    assert.equal(await agent.runAgentLoop("hi"), "ok");
    assert.deepEqual(agent.usage, {
        input: 120,
        output: 10,
        cacheRead: 80,
        cacheWrite: 0,
        cacheHitRate: 40,
    });
});

test("runs tool calls and compacts through mocked OpenRouter", async () => {
    process.env.OPENROUTER_API_KEY = "test";
    const replies = [
        {
            choices: [
                {
                    message: {
                        role: "assistant",
                        content: null,
                        tool_calls: [
                            {
                                id: "1",
                                type: "function",
                                function: { name: "write", arguments: '{"path":"made.txt","content":"yes"}' },
                            },
                        ],
                    },
                },
            ],
            usage: {
                prompt_tokens: 100,
                completion_tokens: 10,
                prompt_tokens_details: { cached_tokens: 25 },
            },
        },
        {
            choices: [{ message: { role: "assistant", content: "done" } }],
            usage: {
                prompt_tokens: 120,
                completion_tokens: 5,
                prompt_tokens_details: { cached_tokens: 60 },
            },
        },
        {
            choices: [{ message: { role: "assistant", content: "summary" } }],
            usage: {
                prompt_tokens: 80,
                completion_tokens: 8,
                prompt_tokens_details: { cached_tokens: 20 },
            },
        },
    ];
    const requests: any[] = [],
        session = await Session.create(dir, new Date("2026-08-08T00:00:00Z"));
    const fakeFetch = async (_url: unknown, init: any) => {
        requests.push(JSON.parse(init.body));
        return new Response(JSON.stringify(replies.shift()), { status: 200 });
    };
    const events: any[] = [],
        runEvents: any[] = [],
        agent = new Agent(
            [],
            fakeFetch as typeof fetch,
            session,
            (event) => events.push(event),
            "",
            (event) => runEvents.push(event),
        );
    assert.equal(await agent.runAgentLoop("make it"), "done");
    assert.deepEqual(
        runEvents.map(({ type, tool, toolCallId, ok, usage }) => ({ type, tool, toolCallId, ok, usage })),
        [
            {
                type: "model.completed",
                tool: undefined,
                toolCallId: undefined,
                ok: undefined,
                usage: { input: 75, output: 10, cacheRead: 25, cacheWrite: 0, cacheHitRate: 25 },
            },
            {
                type: "tool.started",
                tool: "write",
                toolCallId: "1",
                ok: undefined,
                usage: undefined,
            },
            {
                type: "tool.completed",
                tool: "write",
                toolCallId: "1",
                ok: true,
                usage: undefined,
            },
            {
                type: "model.completed",
                tool: undefined,
                toolCallId: undefined,
                ok: undefined,
                usage: { input: 60, output: 5, cacheRead: 60, cacheWrite: 0, cacheHitRate: 50 },
            },
        ],
    );
    assert.deepEqual(
        events.map(({ phase, name, result }) => ({ phase, name, result })),
        [
            { phase: "start", name: "write", result: undefined },
            { phase: "end", name: "write", result: "Successfully wrote 3 bytes to made.txt." },
        ],
    );
    assert.deepEqual(agent.usage, {
        input: 135,
        output: 15,
        cacheRead: 85,
        cacheWrite: 0,
        cacheHitRate: 38.63636363636363,
    });
    assert.equal(await executeTool("read", { path: "made.txt" }), "yes");
    const persisted = await session.records();
    assert.equal(
        persisted.some((r) => r.type === "tool_log" || ("phase" in r && ["start", "end"].includes(r.phase))),
        false,
    );
    assert.equal(persisted.filter((r) => r.type === "message" && r.message.role === "tool").length, 1);
    const recent = [
        { role: "user", content: "one" },
        { role: "assistant", content: "two" },
        { role: "user", content: "three" },
        { role: "assistant", content: "four" },
        { role: "user", content: "five" },
        { role: "assistant", content: "six" },
        { role: "user", content: "seven" },
        { role: "assistant", content: "eight" },
    ] as const;
    agent.messages.push(...recent);
    for (const message of recent) await session.append({ type: "message", message });
    const beforeLength = agent.messages.length;
    assert.equal(await agent.compact(), "Compacted 6 messages (kept last 6).");
    assert.equal(agent.messages.length, beforeLength - 5);
    assert.deepEqual(agent.messages.slice(1), [
        { role: "user", content: "[Compacted history]\nsummary" },
        ...recent.slice(-6),
    ]);
    assert.deepEqual(agent.usage, {
        input: 195,
        output: 23,
        cacheRead: 105,
        cacheWrite: 0,
        cacheHitRate: 35,
    });
    const compact = (await session.records()).find((r) => r.type === "compaction");
    assert.deepEqual(
        {
            summary: compact.summary,
            compactedMessages: compact.compactedMessages,
            keptMessages: compact.keptMessages,
        },
        { summary: "summary", compactedMessages: 6, keptMessages: 6 },
    );
    const restored = new Agent([], fetch, session);
    await restored.resumeSession();
    assert.deepEqual(restored.messages, agent.messages);
    assert.equal(requests[0].model, MODEL);
    const definitions = Object.fromEntries(requests[0].tools.map((tool: any) => [tool.function.name, tool.function]));
    assert.match(definitions.bash.description, /last 2,000 lines or 50KB/);
    assert.match(definitions.bash.parameters.properties.timeout.description, /Defaults to 120/);
    assert.deepEqual(definitions.bash.parameters.required, ["command"]);
    assert.match(definitions.read.description, /UTF-8.*cat or sed.*2,000 complete lines or 50KB/);
    assert.equal(definitions.read.parameters.properties.offset.minimum, 1);
    assert.equal(definitions.read.parameters.properties.limit.minimum, 1);
    assert.deepEqual(definitions.read.parameters.required, ["path"]);
    assert.match(definitions.write.description, /completely rewrite.*Parent directories.*edit for partial/);
    assert.match(definitions.edit.description, /exactly once.*must not overlap.*validated before writing/);
    assert.equal(definitions.edit.parameters.properties.edits.minItems, 1);
    assert.equal(definitions.edit.parameters.properties.edits.items.properties.oldText.minLength, 1);
    assert.deepEqual(definitions.edit.parameters.required, ["path", "edits"]);
    assert.equal(requests[2].tools, undefined);
});
