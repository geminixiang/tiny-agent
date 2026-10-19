import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { MODEL } from "../src/env.js";
import * as fact from "../src/session/facts.js";
import { SessionStore, environmentIdentity } from "../src/session/index.js";
import { buildConfiguration, runFacts } from "../src/session/runtime.js";
import { builtInTools, durableToolReplay } from "../src/tools.js";

const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 };

test("fact builders produce a run the reducer accepts end to end", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "tiny-session-facts-"));
    const session = await SessionStore.create(cwd, MODEL);
    const configuration = buildConfiguration("system", builtInTools);
    const tool = builtInTools[0];

    const accepted = runFacts(session, "inspect");
    const { operationId } = accepted;
    await session.append(accepted.facts);

    const stepId = session.allocateId();
    const attemptId = session.allocateId();
    const assistantEntryId = session.allocateId();
    const toolStartedId = session.allocateId();
    const resultEntryId = session.allocateId();
    const call = { id: "call_1", type: "function" as const, function: { name: tool.name, arguments: "{}" } };
    await session.append(
        fact.stepAttempt({
            operationId,
            stepId,
            attemptId,
            stepKind: "assistant",
            attempt: 1,
            contextThroughEntryId: accepted.inputEntryId,
            configuration,
        }),
    );
    await session.append([
        fact.assistantMessage(assistantEntryId, stepId, attemptId, "toolUse", {
            role: "assistant",
            content: null,
            tool_calls: [call],
        }),
        fact.usageFact(operationId, attemptId, usage),
    ]);
    await session.append(
        fact.toolStarted({
            id: toolStartedId,
            operationId,
            stepId,
            assistantEntryId,
            toolIndex: 0,
            toolCallId: call.id,
            toolName: tool.name,
            arguments: {},
            replay: durableToolReplay(tool),
            environmentIdentity: await environmentIdentity(cwd),
            resultEntryId,
        }),
    );
    await session.append(
        fact.toolResult({
            id: resultEntryId,
            stepId,
            toolStartedId,
            toolName: tool.name,
            message: { role: "tool", tool_call_id: call.id, content: "ok" },
            outcome: "success",
        }),
    );

    const finalStepId = session.allocateId();
    const finalAttemptId = session.allocateId();
    const answerId = session.allocateId();
    await session.append(
        fact.stepAttempt({
            operationId,
            stepId: finalStepId,
            attemptId: finalAttemptId,
            stepKind: "assistant",
            attempt: 1,
            contextThroughEntryId: resultEntryId,
            configuration,
        }),
    );
    await session.append([
        fact.assistantMessage(answerId, finalStepId, finalAttemptId, "stop", { role: "assistant", content: "done" }),
        fact.usageFact(operationId, finalAttemptId, usage),
    ]);
    await session.append(
        fact.operationFinished(operationId, "run", "completed", { completion: "normal", finalEntryId: answerId }),
    );

    const state = await session.load();
    assert.equal(state.operation.kind, "idle");
    assert.deepEqual(
        state.transcript.map((message) => message.role),
        ["user", "assistant", "tool", "assistant"],
    );
    await session.close();
});
