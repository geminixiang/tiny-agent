import assert from "node:assert/strict";
import test from "node:test";
import { insertResultMarkdown, sessionStatsFromJsonl } from "./run.js";

test("counts canonical usage and assistant tool calls inside atomic transactions", () => {
    const jsonl = [
        JSON.stringify({ type: "session", version: 2, model: "example/model" }),
        JSON.stringify([
            {
                kind: "entry",
                seq: 1,
                id: "assistant-1",
                entry: {
                    type: "message",
                    message: {
                        role: "assistant",
                        content: null,
                        tool_calls: [
                            {
                                id: "call-1",
                                type: "function",
                                function: { name: "read", arguments: "{}" },
                            },
                            {
                                id: "call-2",
                                type: "function",
                                function: { name: "bash", arguments: "{}" },
                            },
                        ],
                    },
                },
            },
            {
                kind: "usage",
                seq: 2,
                operationId: "operation-1",
                attemptId: "attempt-1",
                usage: { input: 10, output: 3, cacheRead: 7, cacheWrite: 2 },
            },
        ]),
        JSON.stringify({
            kind: "usage",
            seq: 3,
            operationId: "operation-1",
            attemptId: "attempt-2",
            usage: { input: 5, output: 1, cacheRead: 0, cacheWrite: 0 },
        }),
        JSON.stringify({ usage: { input: 999, output: 999 }, message: { tool_calls: [{}, {}] } }),
    ].join("\n");

    assert.deepEqual(sessionStatsFromJsonl(jsonl), {
        model: "example/model",
        inputTokens: 15,
        outputTokens: 4,
        cacheReadTokens: 7,
        cacheWriteTokens: 2,
        toolCalls: 2,
    });
});

test("inserts new eval data above older runs while preserving the measurement contract", () => {
    const previous = `# Evaluation history\n\ncontract\n\n<!-- EVAL_RUNS -->\n\n## older\n`;
    const next = insertResultMarkdown(previous, "## newer\n\nresults\n");

    assert.equal(
        next,
        `# Evaluation history\n\ncontract\n\n<!-- EVAL_RUNS -->\n\n## newer\n\nresults\n\n## older\n`,
    );
});
