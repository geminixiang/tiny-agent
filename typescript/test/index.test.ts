import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

const dir = await mkdtemp(join(tmpdir(), "tiny-agent-"));
process.chdir(dir);
const {
    Agent,
    MODEL,
    SessionStore,
    builtInTools,
    loadProjectInstructions,
    loadSkills,
    executeTool,
    formatToolEvent,
    formatUsage,
    buildConfiguration,
    runFacts,
    SYNTHETIC_CONTENT,
} = await import("../src/index.js");

async function openStore(now = new Date()) {
    return SessionStore.create(dir, MODEL, now);
}

async function facts(store: Awaited<ReturnType<typeof openStore>>) {
    const text = await readFile(store.path, "utf8");
    return text
        .trim()
        .split("\n")
        .slice(1)
        .flatMap((line) => {
            const value = JSON.parse(line);
            return Array.isArray(value) ? value : [value];
        });
}

async function appendSettledToolStep(
    session: Awaited<ReturnType<typeof openStore>>,
    agent: InstanceType<typeof Agent>,
    calls: { id: string; name: string; arguments: string }[],
) {
    const accepted = runFacts(session, "recover tools");
    const stepId = session.allocateId();
    const attemptId = session.allocateId();
    const assistantEntryId = session.allocateId();
    await session.append(accepted.facts);
    await session.append({
        kind: "record",
        record: {
            type: "stepAttempt",
            operationId: accepted.operationId,
            stepId,
            attemptId,
            stepKind: "assistant",
            attempt: 1,
            contextThroughEntryId: accepted.inputEntryId,
            ...buildConfiguration(agent.systemPrompt, agent.tools),
        },
    });
    await session.append({
        kind: "entry",
        id: assistantEntryId,
        entry: {
            type: "message",
            stepId,
            attemptId,
            stopReason: "toolUse",
            message: {
                role: "assistant",
                content: null,
                tool_calls: calls.map((call) => ({
                    id: call.id,
                    type: "function",
                    function: { name: call.name, arguments: call.arguments },
                })),
            },
        },
    });
    return { ...accepted, stepId, assistantEntryId };
}

test("loads cwd AGENTS.md into the system prompt", async () => {
    await writeFile("AGENTS.md", "Always answer briefly.\n");
    const instructions = await loadProjectInstructions();
    assert.equal(instructions, "Always answer briefly.\n");
    const system = new Agent([], fetch, undefined, () => {}, instructions).messages[0].content!;
    assert.match(system, /<project_context>/);
    assert.match(system, /inspect only what is needed, then make the changes and run focused tests/);
    assert.match(system, /Use the provided tool descriptions to choose the right capability/);
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
        formatToolEvent({ phase: "end", name: "bash", args: {}, result: "Error: unknown tool: bash" }),
        "  └ Error: unknown tool: bash",
    );
});

test("persists durable run/model lifecycle and restores an idle session", async () => {
    process.env.OPENROUTER_API_KEY = "test";
    const now = new Date("2026-08-03T03:55:50.062Z");
    const session = await openStore(now);
    const agent = new Agent(
        [],
        (async () =>
            new Response(
                JSON.stringify({
                    choices: [{ finish_reason: "stop", message: { role: "assistant", content: "ok" } }],
                    usage: { prompt_tokens: 10, completion_tokens: 2 },
                }),
                { status: 200 },
            )) as typeof fetch,
        session,
    );
    assert.equal(await agent.runAgentLoop("hello"), "ok");
    const records = await facts(session);
    assert.deepEqual(
        records.filter((fact) => fact.kind === "record").map((fact) => fact.record.type),
        ["runStarted", "stepAttempt", "operationFinished"],
    );
    assert.equal(
        records.find((fact) => fact.kind === "entry" && fact.entry.message.role === "assistant").entry.stopReason,
        "stop",
    );
    assert.deepEqual(records.find((fact) => fact.kind === "usage").usage, {
        input: 10,
        output: 2,
        cacheRead: 0,
        cacheWrite: 0,
    });
    await session.close();
    const reopened = await SessionStore.open(session.id, dir);
    const restored = new Agent([], fetch, reopened);
    await restored.resumeSession();
    assert.deepEqual(restored.messages.slice(1), [
        { role: "user", content: "hello" },
        { role: "assistant", content: "ok" },
    ]);
    assert.equal(restored.usage.input, 10);
    await reopened.close();
});

test("persists failed and truncated model outcomes", async () => {
    process.env.OPENROUTER_API_KEY = "test";
    const failedSession = await openStore(new Date("2026-08-04T00:00:00Z"));
    const failed = new Agent(
        [],
        (async () => {
            throw Error("provider down");
        }) as typeof fetch,
        failedSession,
    );
    await assert.rejects(() => failed.runAgentLoop("fail"), /provider down/);
    const failedRecords = await facts(failedSession);
    assert.deepEqual(
        failedRecords.filter((fact) => fact.kind === "record").map((fact) => fact.record.type),
        ["runStarted", "stepAttempt", "stepFailed", "operationFinished"],
    );
    assert.equal(failedRecords.at(-1).record.outcome, "failed");
    await failedSession.close();

    const truncatedSession = await openStore(new Date("2026-08-05T00:00:00Z"));
    const truncated = new Agent(
        [],
        (async () =>
            new Response(
                JSON.stringify({
                    choices: [
                        {
                            finish_reason: "length",
                            message: {
                                role: "assistant",
                                content: null,
                                tool_calls: [
                                    { id: "cut", type: "function", function: { name: "read", arguments: "{}" } },
                                ],
                            },
                        },
                    ],
                    usage: {},
                }),
                { status: 200 },
            )) as typeof fetch,
        truncatedSession,
    );
    assert.equal(await truncated.runAgentLoop("truncate"), "Model output was truncated.");
    const truncatedRecords = await facts(truncatedSession);
    assert.equal(
        truncatedRecords.find((fact) => fact.kind === "entry" && fact.entry.stopReason === "length").entry.stopReason,
        "length",
    );
    assert.deepEqual(truncatedRecords.at(-1).record, {
        type: "operationFinished",
        operationId: truncatedRecords[1].record.operationId,
        operationKind: "run",
        outcome: "completed",
        completion: "truncated",
        finalEntryId: truncatedRecords.find((fact) => fact.kind === "entry" && fact.entry.stopReason === "length").id,
    });
    await truncatedSession.close();
});

test("resumes an open model attempt once as attempt 2 and is idempotent", async () => {
    process.env.OPENROUTER_API_KEY = "test";
    const session = await openStore(new Date("2026-08-06T00:00:00Z"));
    const accepted = runFacts(session, "accepted");
    await session.append(accepted.facts);
    const configuration = buildConfiguration(new Agent().systemPrompt, builtInTools);
    await session.append({
        kind: "record",
        record: {
            type: "stepAttempt",
            operationId: accepted.operationId,
            stepId: session.allocateId(),
            attemptId: session.allocateId(),
            stepKind: "assistant",
            attempt: 1,
            contextThroughEntryId: accepted.inputEntryId,
            ...configuration,
        },
    });
    let requests = 0;
    const fetcher = (async () => {
        requests++;
        return new Response(
            JSON.stringify({
                choices: [{ finish_reason: "stop", message: { role: "assistant", content: "recovered" } }],
                usage: {},
            }),
            { status: 200 },
        );
    }) as typeof fetch;
    const restored = new Agent([], fetcher, session);
    await restored.resumeSession();
    await restored.resumeSession();
    assert.equal(requests, 1);
    assert.equal((await session.load()).operation.kind, "idle");
    assert.equal(restored.messages.at(-1)?.content, "recovered");
    const records = await facts(session);
    assert.deepEqual(
        records.filter((fact) => fact.kind === "record").map((fact) => fact.record.type),
        ["runStarted", "stepAttempt", "stepAttempt", "operationFinished"],
    );
    assert.equal(records.filter((fact) => fact.record?.type === "stepAttempt").at(-1).record.attempt, 2);
    await session.close();
});

test("an open attempt 2 exhausts into a canonical failed idle state without calling the provider", async () => {
    const session = await openStore(new Date("2026-08-06T00:30:00Z"));
    try {
        const accepted = runFacts(session, "accepted");
        await session.append(accepted.facts);
        const configuration = buildConfiguration(new Agent().systemPrompt, builtInTools);
        const stepId = session.allocateId();
        for (const attempt of [1, 2] as const) {
            await session.append({
                kind: "record",
                record: {
                    type: "stepAttempt",
                    operationId: accepted.operationId,
                    stepId,
                    attemptId: session.allocateId(),
                    stepKind: "assistant",
                    attempt,
                    contextThroughEntryId: accepted.inputEntryId,
                    ...configuration,
                },
            });
        }
        let requests = 0;
        const restored = new Agent(
            [],
            (async () => {
                requests++;
                throw Error("provider must not be called");
            }) as typeof fetch,
            session,
        );

        await restored.resumeSession();

        assert.equal(requests, 0);
        assert.deepEqual((await session.load()).operation, { kind: "idle" });
        const finished = (await facts(session)).at(-1).record;
        assert.deepEqual(finished, {
            type: "operationFinished",
            operationId: accepted.operationId,
            operationKind: "run",
            outcome: "failed",
            error: { code: "model_error", message: "provider request attempts exhausted" },
        });
    } finally {
        await session.close();
    }
});

test("blocks recovery after configuration changes without changing session bytes", async () => {
    const session = await openStore(new Date("2026-08-06T01:00:00Z"));
    const accepted = runFacts(session, "accepted");
    await session.append(accepted.facts);
    const configuration = buildConfiguration(new Agent().systemPrompt, builtInTools);
    await session.append({
        kind: "record",
        record: {
            type: "stepAttempt",
            operationId: accepted.operationId,
            stepId: session.allocateId(),
            attemptId: session.allocateId(),
            stepKind: "assistant",
            attempt: 1,
            contextThroughEntryId: accepted.inputEntryId,
            ...configuration,
        },
    });
    const before = await readFile(session.path);
    await assert.rejects(
        () => new Agent([], fetch, session, () => {}, "changed instructions").resumeSession(),
        /configuration_changed/,
    );
    assert.deepEqual(await readFile(session.path), before);
    await session.close();
});

test("blocks recovery after an environment change without changing session bytes", async () => {
    const session = await openStore(new Date("2026-08-06T01:30:00Z"));
    const previousIdentity = process.env.TINY_AGENT_ENVIRONMENT_IDENTITY;
    try {
        const accepted = runFacts(session, "accepted");
        await session.append(accepted.facts);
        const agent = new Agent([], fetch, session);
        await session.append({
            kind: "record",
            record: {
                type: "stepAttempt",
                operationId: accepted.operationId,
                stepId: session.allocateId(),
                attemptId: session.allocateId(),
                stepKind: "assistant",
                attempt: 1,
                contextThroughEntryId: accepted.inputEntryId,
                ...buildConfiguration(agent.systemPrompt, agent.tools),
            },
        });
        const before = await readFile(session.path);
        process.env.TINY_AGENT_ENVIRONMENT_IDENTITY = "different-environment";

        await assert.rejects(() => agent.resumeSession(), /environment_changed/);

        assert.deepEqual(await readFile(session.path), before);
    } finally {
        if (previousIdentity === undefined) delete process.env.TINY_AGENT_ENVIRONMENT_IDENTITY;
        else process.env.TINY_AGENT_ENVIRONMENT_IDENTITY = previousIdentity;
        await session.close();
    }
});

test("replays a pending safe tool exactly once and repeated resume is a no-op", async () => {
    process.env.OPENROUTER_API_KEY = "test";
    const session = await openStore(new Date("2026-08-06T02:00:00Z"));
    try {
        let executions = 0;
        let requests = 0;
        const tools = [
            {
                name: "read_once",
                description: "Read once.",
                parameters: { type: "object", properties: {} },
                replay: "safe" as const,
                replayKey: "test:read-once:v1",
                async execute() {
                    executions++;
                    return "replayed";
                },
            },
        ];
        const agent = new Agent(
            [],
            (async () => {
                requests++;
                throw Error("stop after replay");
            }) as typeof fetch,
            session,
            () => {},
            "",
            () => {},
            tools,
        );
        const settled = await appendSettledToolStep(session, agent, [
            { id: "safe-call", name: "read_once", arguments: "{}" },
        ]);
        const resultEntryId = session.allocateId();
        await session.append({
            kind: "record",
            id: session.allocateId(),
            record: {
                type: "toolStarted",
                operationId: settled.operationId,
                stepId: settled.stepId,
                assistantEntryId: settled.assistantEntryId,
                toolIndex: 0,
                toolCallId: "safe-call",
                toolName: "read_once",
                arguments: {},
                replay: "safe",
                replayKey: "test:read-once:v1",
                environmentIdentity: (await session.load()).header.environmentIdentity,
                resultEntryId,
            },
        });

        await assert.rejects(() => agent.resumeSession(), /stop after replay/);
        const afterFirstResume = await readFile(session.path);
        await agent.resumeSession();

        assert.equal(executions, 1);
        assert.equal(requests, 1);
        assert.deepEqual(await readFile(session.path), afterFirstResume);
        assert.equal((await session.load()).operation.kind, "idle");
        const replayed = (await facts(session)).find((fact) => fact.id === resultEntryId);
        assert.equal(replayed.entry.message.content, "replayed");
        assert.deepEqual(replayed.entry.result, { type: "success" });
    } finally {
        await session.close();
    }
});

test("does not execute a pending never-replay tool and synthesizes exact interrupted content", async () => {
    process.env.OPENROUTER_API_KEY = "test";
    const session = await openStore(new Date("2026-08-06T02:30:00Z"));
    try {
        let executions = 0;
        const tools = [
            {
                name: "unsafe_write",
                description: "Write once.",
                parameters: { type: "object", properties: {} },
                replay: "never" as const,
                replayKey: "test:unsafe-write:v1",
                async execute() {
                    executions++;
                    return "must not execute";
                },
            },
        ];
        const agent = new Agent(
            [],
            (async () => {
                throw Error("stop after interruption");
            }) as typeof fetch,
            session,
            () => {},
            "",
            () => {},
            tools,
        );
        const settled = await appendSettledToolStep(session, agent, [
            { id: "never-call", name: "unsafe_write", arguments: "{}" },
        ]);
        const resultEntryId = session.allocateId();
        await session.append({
            kind: "record",
            id: session.allocateId(),
            record: {
                type: "toolStarted",
                operationId: settled.operationId,
                stepId: settled.stepId,
                assistantEntryId: settled.assistantEntryId,
                toolIndex: 0,
                toolCallId: "never-call",
                toolName: "unsafe_write",
                arguments: {},
                replay: "never",
                replayKey: "test:unsafe-write:v1",
                environmentIdentity: (await session.load()).header.environmentIdentity,
                resultEntryId,
            },
        });

        await assert.rejects(() => agent.resumeSession(), /stop after interruption/);

        assert.equal(executions, 0);
        const interrupted = (await facts(session)).find((fact) => fact.id === resultEntryId);
        assert.equal(
            interrupted.entry.message.content,
            "Operation interrupted after execution status became unknown; the tool was not replayed.",
        );
        assert.equal(interrupted.entry.message.content, SYNTHETIC_CONTENT.interrupted);
        assert.deepEqual(interrupted.entry.result, { type: "synthetic", reason: "interrupted" });
    } finally {
        await session.close();
    }
});

test("reconciles an abort in tool order and repeated resume remains idle", async () => {
    const session = await openStore(new Date("2026-08-06T03:00:00Z"));
    try {
        let executions = 0;
        let requests = 0;
        const tools = [
            {
                name: "effect",
                description: "Perform an effect.",
                parameters: { type: "object", properties: {} },
                replay: "never" as const,
                replayKey: "test:effect:v1",
                async execute() {
                    executions++;
                    return "must not execute";
                },
            },
        ];
        const agent = new Agent(
            [],
            (async () => {
                requests++;
                throw Error("provider must not be called");
            }) as typeof fetch,
            session,
            () => {},
            "",
            () => {},
            tools,
        );
        const settled = await appendSettledToolStep(session, agent, [
            { id: "started-call", name: "effect", arguments: "{}" },
            { id: "untouched-call", name: "effect", arguments: "{}" },
        ]);
        const resultEntryId = session.allocateId();
        await session.append({
            kind: "record",
            id: session.allocateId(),
            record: {
                type: "toolStarted",
                operationId: settled.operationId,
                stepId: settled.stepId,
                assistantEntryId: settled.assistantEntryId,
                toolIndex: 0,
                toolCallId: "started-call",
                toolName: "effect",
                arguments: {},
                replay: "never",
                replayKey: "test:effect:v1",
                environmentIdentity: (await session.load()).header.environmentIdentity,
                resultEntryId,
            },
        });
        await session.append({
            kind: "record",
            record: {
                type: "abortRequested",
                operationId: settled.operationId,
                operationKind: "run",
                phase: "tool",
                toolCallId: "started-call",
                reason: "escape",
            },
        });

        await agent.resumeSession();
        const afterFirstResume = await readFile(session.path);
        await agent.resumeSession();

        assert.equal(executions, 0);
        assert.equal(requests, 0);
        assert.deepEqual(await readFile(session.path), afterFirstResume);
        assert.deepEqual((await session.load()).operation, { kind: "idle" });
        const records = await facts(session);
        const results = records.filter((fact) => fact.entry?.message?.role === "tool");
        assert.deepEqual(
            results.map((fact) => ({
                call: fact.entry.message.tool_call_id,
                content: fact.entry.message.content,
                result: fact.entry.result,
            })),
            [
                {
                    call: "started-call",
                    content: SYNTHETIC_CONTENT.interrupted,
                    result: { type: "synthetic", reason: "interrupted" },
                },
                {
                    call: "untouched-call",
                    content: SYNTHETIC_CONTENT.aborted,
                    result: { type: "synthetic", reason: "aborted" },
                },
            ],
        );
        assert.deepEqual(records.at(-1).record, {
            type: "operationFinished",
            operationId: settled.operationId,
            operationKind: "run",
            outcome: "aborted",
        });
    } finally {
        await session.close();
    }
});

test("compaction is disabled until durable Phase 2b integration", async () => {
    const session = await openStore(new Date("2026-08-07T00:00:00Z"));
    await assert.rejects(() => new Agent([], fetch, session).compact(), /Phase 2b/);
    await session.close();
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
    ];
    const session = await openStore();
    const agent = new Agent([], async () => new Response(JSON.stringify(responses.shift()), { status: 200 }), session);
    assert.equal(await agent.runAgentLoop("work"), "Model output was truncated.");
    await session.close();
    await assert.rejects(() => readFile("never.txt"), /ENOENT/);
    const truncatedResult = (await facts(session)).find(
        (fact) => fact.kind === "entry" && fact.entry?.result?.reason === "truncated",
    );
    assert.equal(
        truncatedResult.entry.message.content,
        "Error: Tool call arguments were truncated by the model token limit; the tool was not executed.",
    );

    const emptySession = await openStore();
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
        emptySession,
    );
    await assert.rejects(() => empty.runAgentLoop("work"), /empty response.*finish_reason: stop/);
    await emptySession.close();

    for (const finish_reason of ["content_filter", "network_error", "mystery"]) {
        const rejectedSession = await openStore();
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
            rejectedSession,
        );
        await assert.rejects(() => rejected.runAgentLoop("work"), /Provider finish_reason|Unknown provider/);
        await rejectedSession.close();
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
    const session = await openStore();
    const agent = new Agent([], fakeFetch as typeof fetch, session);
    assert.equal(await agent.runAgentLoop("hi"), "ok");
    await session.close();
    assert.deepEqual(agent.usage, {
        input: 120,
        output: 10,
        cacheRead: 80,
        cacheWrite: 0,
        cacheHitRate: 40,
    });
});

test("validates tool argument objects and built-in field types", async () => {
    process.env.OPENROUTER_API_KEY = "test";
    const responses = [
        {
            choices: [
                {
                    message: {
                        role: "assistant",
                        content: null,
                        tool_calls: [{ id: "bad", type: "function", function: { name: "read", arguments: "null" } }],
                    },
                },
            ],
            usage: {},
        },
        { choices: [{ message: { role: "assistant", content: "handled" } }], usage: {} },
    ];
    const session = await openStore();
    const agent = new Agent(
        [],
        (async () => new Response(JSON.stringify(responses.shift()), { status: 200 })) as typeof fetch,
        session,
    );
    assert.equal(await agent.runAgentLoop("read"), "handled");
    await session.close();
    assert.equal(agent.messages.at(-2)?.content, "Error: Tool arguments were invalid; the tool was not executed.");
    const invalid = (args: unknown) => args as Parameters<typeof executeTool>[1];
    await assert.rejects(() => executeTool("bash", invalid({ command: 42 })), /command must be a nonempty string/);
    await assert.rejects(() => executeTool("read", invalid({ path: 42 })), /path must be a nonempty string/);
    await assert.rejects(() => executeTool("read", invalid({ path: "x", offset: 1.5 })), /offset must be an integer/);
    await assert.rejects(() => executeTool("write", invalid({ path: "x", content: 42 })), /content must be a string/);
    await assert.rejects(
        () => executeTool("edit", invalid({ path: "x", edits: [{ oldText: "a", newText: 42 }] })),
        /newText must be a string/,
    );
});

test("tool monitoring uses execution status instead of result text", async () => {
    process.env.OPENROUTER_API_KEY = "test";
    const responses = [
        {
            choices: [
                {
                    message: {
                        role: "assistant",
                        content: null,
                        tool_calls: [{ id: "lookup", type: "function", function: { name: "lookup", arguments: "{}" } }],
                    },
                },
            ],
            usage: {},
        },
        { choices: [{ message: { role: "assistant", content: "done" } }], usage: {} },
    ];
    const events: any[] = [];
    const session = await openStore();
    const agent = new Agent(
        [],
        (async () => new Response(JSON.stringify(responses.shift()), { status: 200 })) as typeof fetch,
        session,
        () => {},
        "",
        (event) => events.push(event),
        [
            {
                name: "lookup",
                description: "Lookup logs.",
                parameters: { type: "object", properties: {} },
                async execute() {
                    return "Error: found in log";
                },
            },
        ],
    );
    assert.equal(await agent.runAgentLoop("lookup"), "done");
    await session.close();
    assert.equal(events.find((event) => event.type === "tool.completed")?.ok, true);
});

test("restricted tools do not advertise unavailable capabilities", () => {
    const edit = builtInTools.find((tool) => tool.name === "edit")!;
    const system = new Agent(
        [],
        fetch,
        undefined,
        () => {},
        "",
        () => {},
        [edit],
    ).messages[0].content!;
    assert.match(system, /Use only the tools provided in this request/);
    assert.match(system, /explain the missing capability/);
    assert.doesNotMatch(system, /Use read to inspect files|bash for discovery/);
});

test("rejects duplicate injected tool names", () => {
    assert.throws(
        () =>
            new Agent(
                [],
                fetch,
                undefined,
                () => {},
                "",
                () => {},
                [...builtInTools, builtInTools[0]],
            ),
        /duplicate tool name: bash/,
    );
});

test("runs an injected tool without changing the agent loop", async () => {
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
                                id: "lookup-1",
                                type: "function",
                                function: { name: "lookup", arguments: '{"query":"revenue"}' },
                            },
                        ],
                    },
                },
            ],
            usage: { prompt_tokens: 10, completion_tokens: 2 },
        },
        {
            choices: [{ message: { role: "assistant", content: "Revenue is 42." } }],
            usage: { prompt_tokens: 20, completion_tokens: 4 },
        },
    ];
    const requests: any[] = [],
        queries: unknown[] = [],
        events: any[] = [],
        session = await openStore(new Date("2026-08-09T00:00:00Z"));
    const agent = new Agent(
        [],
        (async (_url: unknown, init: any) => {
            requests.push(JSON.parse(init.body));
            return new Response(JSON.stringify(replies.shift()), { status: 200 });
        }) as typeof fetch,
        session,
        () => {},
        "",
        (event) => events.push(event),
        [
            {
                name: "lookup",
                description: "Look up internal facts.",
                parameters: {
                    type: "object",
                    properties: { query: { type: "string" } },
                    required: ["query"],
                },
                async execute(args) {
                    queries.push(args.query);
                    return "42";
                },
            },
        ],
    );

    assert.equal(await agent.runAgentLoop("check revenue"), "Revenue is 42.");
    assert.deepEqual(queries, ["revenue"]);
    assert.deepEqual(requests[0].tools, [
        {
            type: "function",
            function: {
                name: "lookup",
                description: "Look up internal facts.",
                parameters: {
                    type: "object",
                    properties: { query: { type: "string" } },
                    required: ["query"],
                },
            },
        },
    ]);
    assert.equal(requests[1].messages.at(-1).content, "42");
    assert.deepEqual(
        events.filter((event) => event.type.startsWith("tool.")).map(({ type, tool }) => ({ type, tool })),
        [
            { type: "tool.started", tool: "lookup" },
            { type: "tool.completed", tool: "lookup" },
        ],
    );
    const toolRecord = (await facts(session)).find((fact) => fact.record?.type === "toolStarted");
    assert.equal(toolRecord.record.toolName, "lookup");
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
        session = await openStore(new Date("2026-08-08T00:00:00Z"));
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
    const persisted = await facts(session);
    assert.equal(
        persisted.some((r) => r.type === "tool_log" || ("phase" in r && ["start", "end"].includes(r.phase))),
        false,
    );
    assert.equal(
        persisted.some((fact) => fact.kind === "entry" && fact.entry?.message?.role === "tool"),
        true,
    );
    await assert.rejects(() => agent.compact(), /Phase 2b durable integration/);
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
    assert.equal(requests.length, 2);
});
