import assert from "node:assert/strict";
import test from "node:test";
import { ExecutionLifecycleProjector, callbackSink, type LifecycleEvent } from "../src/lifecycle.js";

function recorder() {
    const events: LifecycleEvent[] = [];
    const lifecycle = new ExecutionLifecycleProjector([callbackSink((event) => events.push(event))]);
    lifecycle.observe({
        type: "session.attached",
        timestamp: "2026-01-01T00:00:00.000Z",
        sessionId: "session-1",
        resumed: false,
    });
    return { events, lifecycle };
}

test("projects durable tool admission separately from its physical attempt", async () => {
    const { events, lifecycle } = recorder();
    lifecycle.committed([
        {
            kind: "record",
            id: "tool-started-1",
            timestamp: Date.parse("2026-01-01T00:00:00.010Z"),
            record: {
                type: "toolStarted",
                operationId: "operation-1",
                stepId: "step-1",
                toolCallId: "call-1",
                toolName: "read",
                replay: "safe",
            },
        },
    ]);
    lifecycle.observe({
        type: "tool.started",
        timestamp: "2026-01-01T00:00:00.020Z",
        operationId: "operation-1",
        stepId: "step-1",
        attemptId: "physical-1",
        parentAttemptId: "model-1",
        toolStartedId: "tool-started-1",
        toolCallId: "call-1",
        tool: "read",
        recovery: false,
    });

    assert.deepEqual(
        events.filter((event) => event.type.startsWith("tool.")).map((event) => event.type),
        ["tool.admitted", "tool.started"],
    );
    await lifecycle.close();
    assert.equal(events.at(-1)?.type, "tool.completed");
    assert.equal((events.at(-1) as Extract<LifecycleEvent, { type: "tool.completed" }>).outcome, "effect_unknown");
});

test("publishes recovery reconciliation without inventing a cross-process model span", async () => {
    const { events, lifecycle } = recorder();
    lifecycle.observe({
        type: "recovery.attached",
        timestamp: "2026-01-01T00:00:00.010Z",
        operationId: "operation-1",
        operationKind: "run",
    });
    lifecycle.committed([
        {
            kind: "record",
            id: "step-failed-1",
            timestamp: Date.parse("2026-01-01T00:00:00.020Z"),
            record: {
                type: "stepFailed",
                operationId: "operation-1",
                stepId: "step-1",
                attemptId: "attempt-from-old-process",
                error: { code: "aborted", message: "Operation aborted" },
            },
        },
    ]);

    const reconciled = events.find((event) => event.type === "model.reconciled");
    assert.ok(reconciled);
    assert.equal(reconciled.outcome, "cancelled");
    assert.equal(reconciled.recovery, true);
    assert.equal(
        events.some((event) => event.type === "model.completed"),
        false,
    );
    await lifecycle.close();
});
