import { canonicalDigest } from "./canonical-json.js";

export type SessionMessage =
    | { role: "user"; content: string }
    | { role: "assistant"; content: string | null; tool_calls?: ToolCall[] }
    | { role: "tool"; content: string; tool_call_id: string };

export type ToolCall = { id: string; type: "function"; function: { name: string; arguments: string } };
export type SessionUsage = { input: number; output: number; cacheRead: number; cacheWrite: number };
export type ConfigurationTool = {
    name: string;
    definitionDigest: string;
};
export type ConfigurationSnapshot = {
    model: string;
    systemPromptDigest: string;
    tools: ConfigurationTool[];
    adapterIdentity: string;
    routingIdentity: string;
    outputOptionsDigest: string;
};
export type StepState = {
    operationId: string;
    stepId: string;
    attemptId: string;
    attempt: number;
    stepKind: "assistant" | "compaction";
    status: "attempting" | "settled" | "failed";
    contextThroughEntryId: string;
    configurationSnapshot: ConfigurationSnapshot;
    configurationDigest: string;
    settledEntryId?: string;
    stopReason?: "stop" | "toolUse" | "length";
};
export type ToolCallState = {
    toolStartedId: string;
    stepId: string;
    assistantEntryId: string;
    toolIndex: number;
    toolCallId: string;
    toolName: string;
    arguments: Record<string, unknown>;
    replay: "safe" | "never";
    replayKey: string;
    environmentIdentity: string;
    resultEntryId: string;
    status: "pending" | "completed";
};
export type SessionState = {
    header: {
        id: string;
        createdAt: number;
        cwd: string;
        provider: string;
        model: string;
        environmentIdentity: string;
    };
    transcript: SessionMessage[];
    activeContext: SessionMessage[];
    usage: SessionUsage;
    operation:
        | { kind: "idle" }
        | {
              kind: "run";
              operationId: string;
              inputEntryId: string;
              step?: StepState;
              toolCalls: ToolCallState[];
              abortRequested: boolean;
          }
        | {
              kind: "compaction";
              operationId: string;
              inputThroughEntryId: string;
              resultEntryId: string;
              step?: StepState;
              abortRequested: boolean;
          };
    repairedLength: number;
};

export type SessionCorruptionCode =
    | "INVALID_UTF8"
    | "MISSING_HEADER"
    | "INVALID_HEADER"
    | "UNSUPPORTED_VERSION"
    | "BLANK_LINE"
    | "CRLF_NOT_ALLOWED"
    | "MALFORMED_JSON"
    | "EMPTY_TRANSACTION"
    | "INVALID_FACT"
    | "SEQ_MISMATCH"
    | "DUPLICATE_ID"
    | "INVALID_REFERENCE"
    | "INVALID_TRANSITION"
    | "INVALID_TRANSCRIPT";

export class SessionCorruption extends Error {
    constructor(
        public code: SessionCorruptionCode,
        public line: number,
        public seq?: number,
        message: string = code,
    ) {
        super(message);
        this.name = "SessionCorruption";
    }
}

type JsonObject = Record<string, unknown>;
type Fact = JsonObject & { kind: "entry" | "record" | "usage"; seq: number; id: string; timestamp: number };
type EntryInfo = { entry: JsonObject; operationId?: string; stepId?: string; attemptId?: string };
type AttemptInfo = {
    operationId: string;
    stepId: string;
    attemptId: string;
    attempt: number;
    kind: "assistant" | "compaction";
    contextThroughEntryId: string;
    closed: boolean;
    failed: boolean;
    settledEntryId?: string;
    configurationSnapshot: ConfigurationSnapshot;
    configurationDigest: string;
};
type OperationInfo = {
    kind: "run" | "compaction";
    finished: boolean;
    inputThroughEntryId: string;
    resultEntryId?: string;
    latestStepId?: string;
};
type InternalState = SessionState & {
    nextSeq: number;
    ids: Set<string>;
    reservedIds: Map<string, "identity" | "toolResult" | "compactionResult">;
    entries: Map<string, EntryInfo>;
    records: Map<string, JsonObject>;
    operations: Map<string, OperationInfo>;
    attempts: Map<string, AttemptInfo>;
    steps: Map<string, AttemptInfo[]>;
    tools: Map<string, ToolCallState & { operationId: string }>;
    toolPairs: Set<string>;
    activeContextThroughEntryId?: string;
    compactedThrough?: string;
};

const UUID7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const encoder = new TextEncoder();

function fail(code: SessionCorruptionCode, line: number, seq?: number, message?: string): never {
    throw new SessionCorruption(code, line, seq, message);
}

function object(value: unknown, code: SessionCorruptionCode, line: number, seq?: number): JsonObject {
    if (value === null || typeof value !== "object" || Array.isArray(value)) fail(code, line, seq);
    return value as JsonObject;
}

function exact(value: JsonObject, keys: string[], code: SessionCorruptionCode, line: number, seq?: number) {
    if (Object.keys(value).some((key) => !keys.includes(key))) fail(code, line, seq);
}

function string(value: unknown, code: SessionCorruptionCode, line: number, seq?: number) {
    if (typeof value !== "string" || !value.length) fail(code, line, seq);
    return value;
}

function safeInteger(value: unknown, code: SessionCorruptionCode, line: number, seq?: number, minimum = 0) {
    if (!Number.isSafeInteger(value) || (value as number) < minimum) fail(code, line, seq);
    return value as number;
}

function id(value: unknown, code: SessionCorruptionCode, line: number, seq?: number) {
    const result = string(value, code, line, seq);
    if (!UUID7.test(result)) fail(code, line, seq);
    return result;
}

function parseMessage(value: unknown, line: number, seq: number): SessionMessage {
    const message = object(value, "INVALID_FACT", line, seq);
    const role = message.role;
    if (role === "user") {
        exact(message, ["role", "content"], "INVALID_FACT", line, seq);
        return { role, content: string(message.content, "INVALID_FACT", line, seq) };
    }
    if (role === "tool") {
        exact(message, ["role", "content", "tool_call_id"], "INVALID_FACT", line, seq);
        return {
            role,
            content: typeof message.content === "string" ? message.content : fail("INVALID_FACT", line, seq),
            tool_call_id: string(message.tool_call_id, "INVALID_FACT", line, seq),
        };
    }
    if (role !== "assistant") fail("INVALID_FACT", line, seq);
    exact(message, ["role", "content", "tool_calls"], "INVALID_FACT", line, seq);
    if (message.content !== null && typeof message.content !== "string") fail("INVALID_FACT", line, seq);
    if (message.tool_calls === undefined) return { role, content: message.content as string | null };
    if (!Array.isArray(message.tool_calls) || !message.tool_calls.length) fail("INVALID_FACT", line, seq);
    const calls = message.tool_calls.map((raw) => {
        const call = object(raw, "INVALID_FACT", line, seq);
        exact(call, ["id", "type", "function"], "INVALID_FACT", line, seq);
        if (call.type !== "function") fail("INVALID_FACT", line, seq);
        const fn = object(call.function, "INVALID_FACT", line, seq);
        exact(fn, ["name", "arguments"], "INVALID_FACT", line, seq);
        return {
            id: string(call.id, "INVALID_FACT", line, seq),
            type: "function" as const,
            function: {
                name: string(fn.name, "INVALID_FACT", line, seq),
                arguments: typeof fn.arguments === "string" ? fn.arguments : fail("INVALID_FACT", line, seq),
            },
        };
    });
    if (new Set(calls.map((call) => call.id)).size !== calls.length) fail("INVALID_TRANSCRIPT", line, seq);
    return { role, content: message.content as string | null, tool_calls: calls };
}

function clone(state: InternalState): InternalState {
    return structuredClone(state);
}

function reserve(
    state: InternalState,
    value: unknown,
    line: number,
    seq: number,
    kind: "identity" | "toolResult" | "compactionResult" = "identity",
) {
    const key = id(value, "INVALID_FACT", line, seq);
    if (state.ids.has(key) || state.reservedIds.has(key)) fail("DUPLICATE_ID", line, seq);
    state.reservedIds.set(key, kind);
    return key;
}

function configuration(value: unknown, line: number, seq: number): ConfigurationSnapshot {
    const snapshot = object(value, "INVALID_FACT", line, seq);
    exact(
        snapshot,
        ["model", "systemPromptDigest", "tools", "adapterIdentity", "routingIdentity", "outputOptionsDigest"],
        "INVALID_FACT",
        line,
        seq,
    );
    const model = string(snapshot.model, "INVALID_FACT", line, seq);
    const systemPromptDigest = String(snapshot.systemPromptDigest);
    const outputOptionsDigest = String(snapshot.outputOptionsDigest);
    if (!DIGEST.test(systemPromptDigest) || !DIGEST.test(outputOptionsDigest)) fail("INVALID_FACT", line, seq);
    if (!Array.isArray(snapshot.tools)) fail("INVALID_FACT", line, seq);
    const names = new Set<string>();
    const tools = snapshot.tools.map((raw) => {
        const tool = object(raw, "INVALID_FACT", line, seq);
        exact(tool, ["name", "definitionDigest"], "INVALID_FACT", line, seq);
        const name = string(tool.name, "INVALID_FACT", line, seq);
        if (names.has(name)) fail("INVALID_FACT", line, seq);
        names.add(name);
        const definitionDigest = String(tool.definitionDigest);
        if (!DIGEST.test(definitionDigest)) fail("INVALID_FACT", line, seq);
        return { name, definitionDigest };
    });
    return {
        model,
        systemPromptDigest,
        tools,
        adapterIdentity: string(snapshot.adapterIdentity, "INVALID_FACT", line, seq),
        routingIdentity: string(snapshot.routingIdentity, "INVALID_FACT", line, seq),
        outputOptionsDigest,
    };
}

function configurationDigest(snapshot: ConfigurationSnapshot) {
    return canonicalDigest(snapshot);
}

function structurallyEqual(left: unknown, right: unknown): boolean {
    if (left === right) return true;
    if (Array.isArray(left) || Array.isArray(right))
        return (
            Array.isArray(left) &&
            Array.isArray(right) &&
            left.length === right.length &&
            left.every((item, index) => structurallyEqual(item, right[index]))
        );
    if (!left || !right || typeof left !== "object" || typeof right !== "object") return false;
    const leftObject = left as JsonObject;
    const rightObject = right as JsonObject;
    const keys = Object.keys(leftObject);
    return (
        keys.length === Object.keys(rightObject).length &&
        keys.every((key) => Object.hasOwn(rightObject, key) && structurallyEqual(leftObject[key], rightObject[key]))
    );
}

function scanJson(source: string, line: number) {
    let index = 0;
    const whitespace = () => {
        while ([" ", "\t", "\n", "\r"].includes(source[index] ?? "")) index++;
    };
    const jsonString = () => {
        if (source[index++] !== '"') fail("MALFORMED_JSON", line);
        let decoded = "";
        while (index < source.length && source[index] !== '"') {
            const character = source[index++];
            if (character === "\\") {
                const escape = source[index++];
                if (escape === "u") {
                    const hex = source.slice(index, index + 4);
                    if (!/^[0-9a-fA-F]{4}$/.test(hex)) fail("MALFORMED_JSON", line);
                    index += 4;
                    const code = Number.parseInt(hex, 16);
                    if (code >= 0xd800 && code <= 0xdbff) {
                        if (source.slice(index, index + 2) !== "\\u") fail("MALFORMED_JSON", line);
                        const lowHex = source.slice(index + 2, index + 6);
                        if (!/^[dD][c-fC-F][0-9a-fA-F]{2}$/.test(lowHex)) fail("MALFORMED_JSON", line);
                        index += 6;
                        decoded += String.fromCodePoint(
                            0x10000 + ((code - 0xd800) << 10) + (Number.parseInt(lowHex, 16) - 0xdc00),
                        );
                    } else {
                        if (code >= 0xdc00 && code <= 0xdfff) fail("MALFORMED_JSON", line);
                        decoded += String.fromCharCode(code);
                    }
                    continue;
                }
                const escapes: Record<string, string> = {
                    '"': '"',
                    "\\": "\\",
                    "/": "/",
                    b: "\b",
                    f: "\f",
                    n: "\n",
                    r: "\r",
                    t: "\t",
                };
                if (!Object.hasOwn(escapes, escape)) fail("MALFORMED_JSON", line);
                decoded += escapes[escape];
                continue;
            }
            const code = character.charCodeAt(0);
            if (code < 0x20 || (code >= 0xdc00 && code <= 0xdfff)) fail("MALFORMED_JSON", line);
            if (code >= 0xd800 && code <= 0xdbff) {
                const low = source[index++];
                if (!low || low.charCodeAt(0) < 0xdc00 || low.charCodeAt(0) > 0xdfff) fail("MALFORMED_JSON", line);
                decoded += character + low;
            } else decoded += character;
        }
        if (source[index++] !== '"') fail("MALFORMED_JSON", line);
        return decoded;
    };
    const value = (): void => {
        whitespace();
        if (source[index] === "{") {
            index++;
            whitespace();
            const keys = new Set<string>();
            if (source[index] === "}") {
                index++;
                return;
            }
            for (;;) {
                whitespace();
                const key = jsonString();
                if (keys.has(key)) fail("MALFORMED_JSON", line);
                keys.add(key);
                whitespace();
                if (source[index++] !== ":") fail("MALFORMED_JSON", line);
                value();
                whitespace();
                if (source[index] === "}") {
                    index++;
                    return;
                }
                if (source[index++] !== ",") fail("MALFORMED_JSON", line);
            }
        }
        if (source[index] === "[") {
            index++;
            whitespace();
            if (source[index] === "]") {
                index++;
                return;
            }
            for (;;) {
                value();
                whitespace();
                if (source[index] === "]") {
                    index++;
                    return;
                }
                if (source[index++] !== ",") fail("MALFORMED_JSON", line);
            }
        }
        if (source[index] === '"') {
            jsonString();
            return;
        }
        const token = source
            .slice(index)
            .match(/^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/)?.[0];
        if (!token) fail("MALFORMED_JSON", line);
        index += token.length;
    };
    value();
    whitespace();
    if (index !== source.length) fail("MALFORMED_JSON", line);
}

function operation(state: InternalState, operationId: unknown, line: number, seq: number) {
    const key = id(operationId, "INVALID_FACT", line, seq);
    const found = state.operations.get(key);
    if (!found) fail("INVALID_REFERENCE", line, seq);
    if (found.finished) fail("INVALID_TRANSITION", line, seq);
    return { key, found };
}

export const SYNTHETIC_CONTENT = {
    invalidArguments: "Error: Tool arguments were invalid; the tool was not executed.",
    unknownTool: "Error: Unknown tool; the tool was not executed.",
    truncated: "Error: Tool call arguments were truncated by the model token limit; the tool was not executed.",
    aborted: "Operation aborted before execution.",
    interrupted: "Operation interrupted after execution status became unknown; the tool was not replayed.",
} as const;
export type SyntheticReason = keyof typeof SYNTHETIC_CONTENT;

function sourceDigest(entries: Map<string, EntryInfo>, inputThroughEntryId: string) {
    const source = [];
    for (const [sourceEntryId, info] of entries) {
        if (info.entry.type === "message") source.push({ sourceEntryId, message: info.entry.message });
        if (sourceEntryId === inputThroughEntryId) break;
    }
    return canonicalDigest(source);
}

function validateSyntheticContent(reason: SyntheticReason, content: string, line: number, seq: number) {
    if (content !== SYNTHETIC_CONTENT[reason]) fail("INVALID_TRANSCRIPT", line, seq);
}

function applyEntry(state: InternalState, fact: Fact, line: number) {
    exact(fact, ["kind", "seq", "id", "timestamp", "entry"], "INVALID_FACT", line, fact.seq);
    const entry = object(fact.entry, "INVALID_FACT", line, fact.seq);
    const type = entry.type;
    if (type === "message") {
        const message = parseMessage(entry.message, line, fact.seq);
        if (message.role === "user") {
            if (state.reservedIds.has(fact.id)) fail("DUPLICATE_ID", line, fact.seq);
            exact(entry, ["type", "message"], "INVALID_FACT", line, fact.seq);
        } else if (message.role === "assistant") {
            if (state.reservedIds.has(fact.id)) fail("DUPLICATE_ID", line, fact.seq);
            exact(entry, ["type", "stepId", "attemptId", "stopReason", "message"], "INVALID_FACT", line, fact.seq);
            const stepId = id(entry.stepId, "INVALID_FACT", line, fact.seq);
            const attemptId = id(entry.attemptId, "INVALID_FACT", line, fact.seq);
            const stopReason = entry.stopReason;
            if (!["stop", "toolUse", "length"].includes(stopReason as string)) fail("INVALID_FACT", line, fact.seq);
            const attempt = state.attempts.get(attemptId);
            if (!attempt || attempt.stepId !== stepId || attempt.closed || attempt.kind !== "assistant")
                fail("INVALID_REFERENCE", line, fact.seq);
            if (state.operation.kind !== "run" || state.operation.operationId !== attempt.operationId)
                fail("INVALID_TRANSITION", line, fact.seq);
            if (stopReason === "toolUse" && !message.tool_calls?.length) fail("INVALID_TRANSCRIPT", line, fact.seq);
            if (stopReason === "stop" && message.tool_calls?.length) fail("INVALID_TRANSCRIPT", line, fact.seq);
            attempt.closed = true;
            attempt.settledEntryId = fact.id;
            if (state.operation.kind === "run" && state.operation.step?.attemptId === attemptId) {
                state.operation.step.status = "settled";
                state.operation.step.settledEntryId = fact.id;
                state.operation.step.stopReason = stopReason as "stop" | "toolUse" | "length";
            }
        } else {
            const preExecution = entry.assistantEntryId !== undefined || entry.toolIndex !== undefined;
            const preKeys = ["type", "stepId", "assistantEntryId", "toolIndex", "message", "toolName", "result"];
            const startedKeys = ["type", "stepId", "message", "toolName", "toolStartedId", "result"];
            exact(entry, preExecution ? preKeys : startedKeys, "INVALID_FACT", line, fact.seq);
            const result = object(entry.result, "INVALID_FACT", line, fact.seq);
            exact(result, ["type", "reason"], "INVALID_FACT", line, fact.seq);
            const stepId = id(entry.stepId, "INVALID_FACT", line, fact.seq);
            const toolName = string(entry.toolName, "INVALID_FACT", line, fact.seq);
            if (preExecution) {
                if (result.type !== "synthetic") fail("INVALID_FACT", line, fact.seq);
                const reason = String(result.reason) as SyntheticReason;
                if (!["invalidArguments", "unknownTool", "truncated", "aborted"].includes(reason))
                    fail("INVALID_FACT", line, fact.seq);
                const assistantEntryId = id(entry.assistantEntryId, "INVALID_FACT", line, fact.seq);
                const toolIndex = safeInteger(entry.toolIndex, "INVALID_FACT", line, fact.seq);
                const assistantInfo = state.entries.get(assistantEntryId);
                const assistant = assistantInfo?.entry;
                if (
                    assistant?.type !== "message" ||
                    assistantInfo?.stepId !== stepId ||
                    assistantInfo.operationId !==
                        (state.operation.kind === "run" ? state.operation.operationId : undefined)
                )
                    fail("INVALID_REFERENCE", line, fact.seq);
                const assistantMessage = parseMessage(assistant.message, line, fact.seq);
                const call =
                    assistantMessage.role === "assistant" ? assistantMessage.tool_calls?.[toolIndex] : undefined;
                if (!call || call.id !== message.tool_call_id || call.function.name !== toolName)
                    fail("INVALID_REFERENCE", line, fact.seq);
                const pair = `${assistantEntryId}:${toolIndex}`;
                if (state.toolPairs.has(pair)) fail("INVALID_TRANSITION", line, fact.seq);
                validateSyntheticContent(reason, message.content, line, fact.seq);
                state.toolPairs.add(pair);
                state.entries.set(fact.id, {
                    entry,
                    operationId: assistantInfo.operationId,
                    stepId,
                });
            } else {
                if (state.reservedIds.get(fact.id) !== "toolResult") fail("INVALID_REFERENCE", line, fact.seq);
                if (!["success", "error", "synthetic"].includes(String(result.type)))
                    fail("INVALID_FACT", line, fact.seq);
                if (result.type === "synthetic") {
                    if (result.reason !== "interrupted") fail("INVALID_FACT", line, fact.seq);
                    validateSyntheticContent("interrupted", message.content, line, fact.seq);
                } else if (result.reason !== undefined) fail("INVALID_FACT", line, fact.seq);
                const startedId = id(entry.toolStartedId, "INVALID_FACT", line, fact.seq);
                const started = state.tools.get(startedId);
                if (
                    !started ||
                    started.stepId !== stepId ||
                    started.resultEntryId !== fact.id ||
                    started.toolCallId !== message.tool_call_id ||
                    started.toolName !== toolName ||
                    started.status !== "pending"
                )
                    fail("INVALID_REFERENCE", line, fact.seq);
                started.status = "completed";
                state.reservedIds.delete(fact.id);
                state.entries.set(fact.id, {
                    entry,
                    operationId: started.operationId,
                    stepId: started.stepId,
                });
            }
        }
        state.transcript.push(message);
        state.activeContext.push(message);
        state.activeContextThroughEntryId = fact.id;
        if (message.role === "user") state.entries.set(fact.id, { entry });
        else if (message.role === "assistant") {
            const attempt = state.attempts.get(String(entry.attemptId))!;
            state.entries.set(fact.id, {
                entry,
                operationId: attempt.operationId,
                stepId: attempt.stepId,
                attemptId: attempt.attemptId,
            });
        } else if (message.role === "tool" && entry.toolStartedId !== undefined) {
            const started = state.tools.get(String(entry.toolStartedId))!;
            state.entries.set(fact.id, {
                entry,
                operationId: started.operationId,
                stepId: started.stepId,
            });
        }
        return;
    }
    if (type !== "compaction") fail("INVALID_FACT", line, fact.seq);
    if (state.reservedIds.get(fact.id) !== "compactionResult") fail("INVALID_REFERENCE", line, fact.seq);
    exact(
        entry,
        ["type", "operationId", "summary", "compactedThroughEntryId", "retainedTail"],
        "INVALID_FACT",
        line,
        fact.seq,
    );
    const { key, found } = operation(state, entry.operationId, line, fact.seq);
    if (found.kind !== "compaction" || state.operation.kind !== "compaction" || state.operation.operationId !== key)
        fail("INVALID_TRANSITION", line, fact.seq);
    if (state.operation.resultEntryId !== fact.id) fail("INVALID_REFERENCE", line, fact.seq);
    const through = id(entry.compactedThroughEntryId, "INVALID_FACT", line, fact.seq);
    if (!state.entries.has(through)) fail("INVALID_REFERENCE", line, fact.seq);
    const summary = typeof entry.summary === "string" ? entry.summary : fail("INVALID_FACT", line, fact.seq);
    if (!Array.isArray(entry.retainedTail)) fail("INVALID_FACT", line, fact.seq);
    const sourceThrough = state.entries.get(state.operation.inputThroughEntryId);
    if (!sourceThrough) fail("INVALID_REFERENCE", line, fact.seq);
    const entryIds = [...state.entries.keys()];
    const boundary = entryIds.indexOf(through);
    const inputBoundary = entryIds.indexOf(state.operation.inputThroughEntryId);
    if (boundary < 0 || inputBoundary < boundary) fail("INVALID_REFERENCE", line, fact.seq);
    const expectedIds = entryIds
        .slice(boundary + 1, inputBoundary + 1)
        .filter((sourceId) => state.entries.get(sourceId)?.entry.type === "message");
    const retained = entry.retainedTail.map((raw: unknown, retainedIndex: number) => {
        const item = object(raw, "INVALID_FACT", line, fact.seq);
        exact(item, ["sourceEntryId", "message"], "INVALID_FACT", line, fact.seq);
        const sourceId = id(item.sourceEntryId, "INVALID_FACT", line, fact.seq);
        const source = state.entries.get(sourceId)?.entry;
        const message = parseMessage(item.message, line, fact.seq);
        if (sourceId !== expectedIds[retainedIndex] || source?.type !== "message")
            fail("INVALID_REFERENCE", line, fact.seq);
        if (!structurallyEqual(parseMessage(source.message, line, fact.seq), message))
            fail("INVALID_REFERENCE", line, fact.seq);
        return message;
    });
    if (entry.retainedTail.length !== expectedIds.length) fail("INVALID_REFERENCE", line, fact.seq);
    validateTranscript(retained, line, fact.seq);
    state.activeContext = [{ role: "user", content: `[Compacted history]\n${summary}` }, ...retained];
    state.activeContextThroughEntryId = state.operation.inputThroughEntryId;
    state.compactedThrough = through;
    const currentAttempt = state.operation.step && state.attempts.get(state.operation.step.attemptId);
    if (!currentAttempt || currentAttempt.closed || currentAttempt.kind !== "compaction")
        fail("INVALID_TRANSITION", line, fact.seq);
    currentAttempt.closed = true;
    currentAttempt.settledEntryId = fact.id;
    state.reservedIds.delete(fact.id);
    state.operation.step!.status = "settled";
    state.operation.step!.settledEntryId = fact.id;
    state.entries.set(fact.id, {
        entry,
        operationId: key,
        stepId: currentAttempt.stepId,
        attemptId: currentAttempt.attemptId,
    });
}

function applyRecord(state: InternalState, fact: Fact, line: number) {
    exact(fact, ["kind", "seq", "id", "timestamp", "record"], "INVALID_FACT", line, fact.seq);
    const record = object(fact.record, "INVALID_FACT", line, fact.seq);
    const type = record.type;
    if (type === "runStarted") {
        exact(record, ["type", "operationId", "operationKind", "inputEntryId"], "INVALID_FACT", line, fact.seq);
        if (record.operationKind !== "run" || state.operation.kind !== "idle")
            fail("INVALID_TRANSITION", line, fact.seq);
        const operationId = reserve(state, record.operationId, line, fact.seq);
        const inputEntryId = id(record.inputEntryId, "INVALID_FACT", line, fact.seq);
        const input = state.entries.get(inputEntryId)?.entry;
        if (input?.type !== "message" || object(input.message, "INVALID_REFERENCE", line, fact.seq).role !== "user")
            fail("INVALID_REFERENCE", line, fact.seq);
        state.operations.set(operationId, {
            kind: "run",
            finished: false,
            inputThroughEntryId: inputEntryId,
        });
        state.operation = { kind: "run", operationId, inputEntryId, toolCalls: [], abortRequested: false };
        state.records.set(fact.id, record);
        return;
    }
    if (type === "compactionStarted") {
        exact(
            record,
            [
                "type",
                "operationId",
                "operationKind",
                "inputThroughEntryId",
                "resultEntryId",
                "compactedEntryIds",
                "retainedEntryIds",
                "sourceDigest",
            ],
            "INVALID_FACT",
            line,
            fact.seq,
        );
        if (record.operationKind !== "compaction" || state.operation.kind !== "idle")
            fail("INVALID_TRANSITION", line, fact.seq);
        const operationId = reserve(state, record.operationId, line, fact.seq);
        const inputThroughEntryId = id(record.inputThroughEntryId, "INVALID_FACT", line, fact.seq);
        const resultEntryId = reserve(state, record.resultEntryId, line, fact.seq, "compactionResult");
        if (!state.entries.has(inputThroughEntryId)) fail("INVALID_REFERENCE", line, fact.seq);
        if (
            !Array.isArray(record.compactedEntryIds) ||
            !record.compactedEntryIds.length ||
            !Array.isArray(record.retainedEntryIds)
        )
            fail("INVALID_FACT", line, fact.seq);
        const partition = [...record.compactedEntryIds, ...record.retainedEntryIds].map((value) =>
            id(value, "INVALID_FACT", line, fact.seq),
        );
        const sourceIds = [...state.entries.keys()].filter(
            (entryId) => state.entries.get(entryId)?.entry.type === "message",
        );
        const inputIndex = sourceIds.indexOf(inputThroughEntryId);
        if (inputIndex < 0 || !structurallyEqual(partition, sourceIds.slice(0, inputIndex + 1)))
            fail("INVALID_REFERENCE", line, fact.seq);
        const sourceDigestValue = String(record.sourceDigest);
        if (!DIGEST.test(sourceDigestValue)) fail("INVALID_FACT", line, fact.seq);
        if (sourceDigest(state.entries, inputThroughEntryId) !== sourceDigestValue)
            fail("INVALID_REFERENCE", line, fact.seq);
        state.operations.set(operationId, {
            kind: "compaction",
            finished: false,
            inputThroughEntryId,
            resultEntryId,
        });
        state.operation = {
            kind: "compaction",
            operationId,
            inputThroughEntryId,
            resultEntryId,
            abortRequested: false,
        };
        state.records.set(fact.id, record);
        return;
    }
    if (type === "stepAttempt") {
        exact(
            record,
            [
                "type",
                "operationId",
                "stepId",
                "attemptId",
                "stepKind",
                "attempt",
                "contextThroughEntryId",
                "configurationSnapshot",
                "configurationDigest",
            ],
            "INVALID_FACT",
            line,
            fact.seq,
        );
        const { key, found } = operation(state, record.operationId, line, fact.seq);
        const attempt = safeInteger(record.attempt, "INVALID_FACT", line, fact.seq, 1);
        const stepId =
            attempt === 1
                ? reserve(state, record.stepId, line, fact.seq)
                : id(record.stepId, "INVALID_FACT", line, fact.seq);
        const attemptId = reserve(state, record.attemptId, line, fact.seq);
        if (attempt > 2 || (record.stepKind !== "assistant" && record.stepKind !== "compaction"))
            fail("INVALID_FACT", line, fact.seq);
        if (record.stepKind !== found.kind.replace("run", "assistant")) fail("INVALID_TRANSITION", line, fact.seq);
        const contextId = id(record.contextThroughEntryId, "INVALID_FACT", line, fact.seq);
        if (!state.entries.has(contextId)) fail("INVALID_REFERENCE", line, fact.seq);
        if (attempt === 1 && contextId !== state.activeContextThroughEntryId)
            fail("INVALID_TRANSITION", line, fact.seq);
        const snapshot = configuration(record.configurationSnapshot, line, fact.seq);
        const digest = String(record.configurationDigest);
        if (!DIGEST.test(digest) || configurationDigest(snapshot) !== digest) fail("INVALID_FACT", line, fact.seq);
        const prior = state.steps.get(stepId) ?? [];
        const activeStep = state.operation.kind === "idle" ? undefined : state.operation.step;
        if (attempt === 1) {
            if (prior.length || (activeStep && activeStep.status !== "settled"))
                fail("INVALID_TRANSITION", line, fact.seq);
            if (activeStep) {
                const priorAttempt = state.attempts.get(activeStep.attemptId);
                const settled = priorAttempt?.settledEntryId
                    ? state.entries.get(priorAttempt.settledEntryId)?.entry
                    : undefined;
                if (
                    found.kind !== "run" ||
                    settled?.stopReason !== "toolUse" ||
                    state.operation.kind !== "run" ||
                    state.operation.toolCalls.some((tool) => tool.status === "pending")
                )
                    fail("INVALID_TRANSITION", line, fact.seq);
            }
        } else {
            const first = prior[0];
            if (
                prior.length !== 1 ||
                first.attempt !== 1 ||
                first.closed ||
                first.failed ||
                first.kind !== record.stepKind ||
                first.operationId !== key ||
                first.contextThroughEntryId !== contextId ||
                first.configurationDigest !== digest
            )
                fail("INVALID_TRANSITION", line, fact.seq);
            first.closed = true;
        }
        const attemptInfo: AttemptInfo = {
            operationId: key,
            stepId,
            attemptId,
            attempt,
            kind: record.stepKind as "assistant" | "compaction",
            contextThroughEntryId: contextId,
            closed: false,
            failed: false,
            configurationSnapshot: snapshot,
            configurationDigest: digest,
        };
        state.attempts.set(attemptId, attemptInfo);
        state.steps.set(stepId, [...prior, attemptInfo]);
        found.latestStepId = stepId;
        const step: StepState = {
            operationId: key,
            stepId,
            attemptId,
            attempt,
            stepKind: record.stepKind as "assistant" | "compaction",
            status: "attempting",
            contextThroughEntryId: contextId,
            configurationSnapshot: snapshot,
            configurationDigest: digest,
        };
        if (state.operation.kind !== "idle") state.operation.step = step;
        state.records.set(fact.id, record);
        return;
    }
    if (type === "stepFailed") {
        exact(record, ["type", "operationId", "stepId", "attemptId", "error"], "INVALID_FACT", line, fact.seq);
        const { key } = operation(state, record.operationId, line, fact.seq);
        const attemptId = id(record.attemptId, "INVALID_FACT", line, fact.seq);
        const attempt = state.attempts.get(attemptId);
        const error = object(record.error, "INVALID_FACT", line, fact.seq);
        exact(error, ["code", "message"], "INVALID_FACT", line, fact.seq);
        string(error.code, "INVALID_FACT", line, fact.seq);
        string(error.message, "INVALID_FACT", line, fact.seq);
        if (!attempt || attempt.operationId !== key || attempt.stepId !== record.stepId || attempt.closed)
            fail("INVALID_REFERENCE", line, fact.seq);
        attempt.closed = true;
        attempt.failed = true;
        if (state.operation.kind !== "idle" && state.operation.step?.attemptId === attemptId)
            state.operation.step.status = "failed";
        state.records.set(fact.id, record);
        return;
    }
    if (type === "toolStarted") {
        exact(
            record,
            [
                "type",
                "operationId",
                "stepId",
                "assistantEntryId",
                "toolIndex",
                "toolCallId",
                "toolName",
                "arguments",
                "replay",
                "replayKey",
                "environmentIdentity",
                "resultEntryId",
            ],
            "INVALID_FACT",
            line,
            fact.seq,
        );
        const { key, found } = operation(state, record.operationId, line, fact.seq);
        if (found.kind !== "run" || state.operation.kind !== "run" || state.operation.operationId !== key)
            fail("INVALID_TRANSITION", line, fact.seq);
        const assistantEntryId = id(record.assistantEntryId, "INVALID_FACT", line, fact.seq);
        const assistantInfo = state.entries.get(assistantEntryId);
        const assistant = assistantInfo?.entry;
        if (assistant?.type !== "message" || assistant.stopReason !== "toolUse" || assistantInfo?.operationId !== key)
            fail("INVALID_REFERENCE", line, fact.seq);
        const message = parseMessage(assistant.message, line, fact.seq);
        const toolIndex = safeInteger(record.toolIndex, "INVALID_FACT", line, fact.seq);
        const call = message.role === "assistant" ? message.tool_calls?.[toolIndex] : undefined;
        const toolCallId = string(record.toolCallId, "INVALID_FACT", line, fact.seq);
        const toolName = string(record.toolName, "INVALID_FACT", line, fact.seq);
        if (!call || call.id !== toolCallId || call.function.name !== toolName || assistant.stepId !== record.stepId)
            fail("INVALID_REFERENCE", line, fact.seq);
        const pair = `${assistantEntryId}:${toolIndex}`;
        if (state.toolPairs.has(pair)) fail("INVALID_TRANSITION", line, fact.seq);
        const args = object(record.arguments, "INVALID_FACT", line, fact.seq);
        if (record.replay !== "safe" && record.replay !== "never") fail("INVALID_FACT", line, fact.seq);
        const attempt = assistantInfo?.attemptId ? state.attempts.get(assistantInfo.attemptId) : undefined;
        const declaration = attempt?.configurationSnapshot.tools.find((item) => item.name === toolName);
        const replayKey = string(record.replayKey, "INVALID_FACT", line, fact.seq);
        const environmentIdentity = string(record.environmentIdentity, "INVALID_FACT", line, fact.seq);
        if (!declaration) fail("INVALID_TRANSITION", line, fact.seq);
        const resultEntryId = reserve(state, record.resultEntryId, line, fact.seq, "toolResult");
        const tool: ToolCallState & { operationId: string } = {
            operationId: key,
            toolStartedId: fact.id,
            stepId: id(record.stepId, "INVALID_FACT", line, fact.seq),
            assistantEntryId,
            toolIndex,
            toolCallId,
            toolName,
            arguments: args,
            replay: record.replay as "safe" | "never",
            replayKey,
            environmentIdentity,
            resultEntryId,
            status: "pending",
        };
        state.tools.set(fact.id, tool);
        state.toolPairs.add(pair);
        state.operation.toolCalls.push(tool);
        state.records.set(fact.id, record);
        return;
    }
    if (type === "abortRequested") {
        exact(
            record,
            ["type", "operationId", "operationKind", "phase", "toolCallId", "reason"],
            "INVALID_FACT",
            line,
            fact.seq,
        );
        const { key, found } = operation(state, record.operationId, line, fact.seq);
        if (record.operationKind !== found.kind || record.reason !== "escape")
            fail("INVALID_TRANSITION", line, fact.seq);
        if (!["model", "tool", "compact"].includes(record.phase as string)) fail("INVALID_FACT", line, fact.seq);
        if ((record.phase === "tool") !== (typeof record.toolCallId === "string")) fail("INVALID_FACT", line, fact.seq);
        if (state.operation.kind === "idle" || state.operation.operationId !== key || state.operation.abortRequested)
            fail("INVALID_TRANSITION", line, fact.seq);
        state.operation.abortRequested = true;
        state.records.set(fact.id, record);
        return;
    }
    if (type !== "operationFinished") fail("INVALID_FACT", line, fact.seq);
    exact(
        record,
        ["type", "operationId", "operationKind", "outcome", "completion", "finalEntryId", "error"],
        "INVALID_FACT",
        line,
        fact.seq,
    );
    const { key, found } = operation(state, record.operationId, line, fact.seq);
    if (record.operationKind !== found.kind || !["completed", "aborted", "failed"].includes(record.outcome as string))
        fail("INVALID_TRANSITION", line, fact.seq);
    if (state.operation.kind === "idle" || state.operation.operationId !== key)
        fail("INVALID_TRANSITION", line, fact.seq);
    if (record.outcome === "completed") {
        if (found.kind === "run" && record.completion !== "normal" && record.completion !== "truncated")
            fail("INVALID_FACT", line, fact.seq);
        if (found.kind === "compaction" && record.completion !== undefined) fail("INVALID_FACT", line, fact.seq);
        const finalId = id(record.finalEntryId, "INVALID_FACT", line, fact.seq);
        if (found.kind === "run") {
            const info = state.entries.get(finalId);
            if (info?.operationId !== key || info.entry.type !== "message") fail("INVALID_REFERENCE", line, fact.seq);
            if (
                (record.completion === "normal" && info.entry.stopReason !== "stop") ||
                (record.completion === "truncated" && info.entry.stopReason !== "length")
            )
                fail("INVALID_REFERENCE", line, fact.seq);
            const attempt = info.attemptId && state.attempts.get(info.attemptId);
            if (
                !attempt ||
                !attempt.closed ||
                attempt.failed ||
                attempt.stepId !== found.latestStepId ||
                attempt.settledEntryId !== finalId
            )
                fail("INVALID_REFERENCE", line, fact.seq);
            const message = parseMessage(info.entry.message, line, fact.seq);
            if (
                message.role !== "assistant" ||
                (record.completion === "normal" && !message.content?.trim()) ||
                (record.completion === "truncated" && !message.tool_calls?.length)
            )
                fail("INVALID_TRANSCRIPT", line, fact.seq);
            if (state.operation.kind === "run" && state.operation.toolCalls.some((tool) => tool.status === "pending"))
                fail("INVALID_TRANSCRIPT", line, fact.seq);
        } else {
            const info = state.entries.get(finalId);
            if (info?.operationId !== key || info.entry.type !== "compaction" || found.resultEntryId !== finalId)
                fail("INVALID_REFERENCE", line, fact.seq);
            const attempt = info.attemptId && state.attempts.get(info.attemptId);
            if (!attempt || attempt.stepId !== found.latestStepId || attempt.settledEntryId !== finalId)
                fail("INVALID_REFERENCE", line, fact.seq);
        }
    } else if (record.outcome === "aborted") {
        const pendingTools =
            state.operation.kind === "run" && state.operation.toolCalls.some((tool) => tool.status === "pending");
        const openAttempt = state.operation.step?.status === "attempting";
        if (record.finalEntryId !== undefined || !state.operation.abortRequested || pendingTools || openAttempt)
            fail("INVALID_TRANSITION", line, fact.seq);
    } else if (record.finalEntryId !== undefined) fail("INVALID_FACT", line, fact.seq);
    if (record.outcome !== "completed" && record.completion !== undefined) fail("INVALID_FACT", line, fact.seq);
    if (record.outcome === "failed") {
        const error = object(record.error, "INVALID_FACT", line, fact.seq);
        exact(error, ["code", "message"], "INVALID_FACT", line, fact.seq);
        string(error.code, "INVALID_FACT", line, fact.seq);
        string(error.message, "INVALID_FACT", line, fact.seq);
    } else if (record.error !== undefined) fail("INVALID_FACT", line, fact.seq);
    found.finished = true;
    state.operation = { kind: "idle" };
    state.records.set(fact.id, record);
}

function applyUsage(state: InternalState, fact: Fact, line: number) {
    exact(
        fact,
        ["kind", "seq", "id", "timestamp", "operationId", "attemptId", "toolStartedId", "usage"],
        "INVALID_FACT",
        line,
        fact.seq,
    );
    const operationId = id(fact.operationId, "INVALID_FACT", line, fact.seq);
    if (!state.operations.has(operationId)) fail("INVALID_REFERENCE", line, fact.seq);
    const hasAttempt = fact.attemptId !== undefined;
    const hasTool = fact.toolStartedId !== undefined;
    if (hasAttempt === hasTool) fail("INVALID_FACT", line, fact.seq);
    if (hasAttempt) {
        const attemptId = id(fact.attemptId, "INVALID_FACT", line, fact.seq);
        const attempt = state.attempts.get(attemptId);
        if (!attempt || attempt.operationId !== operationId) fail("INVALID_REFERENCE", line, fact.seq);
    }
    if (hasTool) {
        const toolId = id(fact.toolStartedId, "INVALID_FACT", line, fact.seq);
        const tool = state.tools.get(toolId);
        if (!tool || tool.operationId !== operationId) fail("INVALID_REFERENCE", line, fact.seq);
    }
    const usage = object(fact.usage, "INVALID_FACT", line, fact.seq);
    exact(usage, ["input", "output", "cacheRead", "cacheWrite"], "INVALID_FACT", line, fact.seq);
    for (const key of ["input", "output", "cacheRead", "cacheWrite"] as const) {
        const amount = safeInteger(usage[key], "INVALID_FACT", line, fact.seq);
        if (state.usage[key] > Number.MAX_SAFE_INTEGER - amount) fail("INVALID_FACT", line, fact.seq);
        state.usage[key] += amount;
    }
}

function applyFact(state: InternalState, value: unknown, line: number) {
    const fact = object(value, "INVALID_FACT", line) as Fact;
    const seq = safeInteger(fact.seq, "INVALID_FACT", line, undefined, 1);
    if (seq !== state.nextSeq) fail("SEQ_MISMATCH", line, seq);
    const factId = id(fact.id, "INVALID_FACT", line, seq);
    safeInteger(fact.timestamp, "INVALID_FACT", line, seq);
    if (state.ids.has(factId)) fail("DUPLICATE_ID", line, seq);
    if (fact.kind === "entry") applyEntry(state, fact, line);
    else if (fact.kind === "record") applyRecord(state, fact, line);
    else if (fact.kind === "usage") applyUsage(state, fact, line);
    else fail("INVALID_FACT", line, seq);
    if (state.reservedIds.has(factId)) fail("DUPLICATE_ID", line, seq);
    state.ids.add(factId);
    state.nextSeq++;
}

function validateTranscript(messages: SessionMessage[], line: number, seq?: number) {
    const pending = new Set<string>();
    for (const message of messages) {
        if (message.role === "assistant") {
            if (pending.size) fail("INVALID_TRANSCRIPT", line, seq);
            for (const call of message.tool_calls ?? []) pending.add(call.id);
            continue;
        }
        if (message.role === "tool") {
            if (!pending.delete(message.tool_call_id)) fail("INVALID_TRANSCRIPT", line, seq);
            continue;
        }
        if (pending.size) fail("INVALID_TRANSCRIPT", line, seq);
    }
}

function validateHeader(value: unknown, line: number) {
    const header = object(value, "INVALID_HEADER", line);
    exact(
        header,
        ["kind", "version", "id", "createdAt", "cwd", "provider", "model", "environmentIdentity"],
        "INVALID_HEADER",
        line,
    );
    if (header.kind !== "header") fail("INVALID_HEADER", line);
    if (header.version !== 2) fail("UNSUPPORTED_VERSION", line);
    return {
        id: id(header.id, "INVALID_HEADER", line),
        createdAt: safeInteger(header.createdAt, "INVALID_HEADER", line),
        cwd: string(header.cwd, "INVALID_HEADER", line),
        provider: string(header.provider, "INVALID_HEADER", line),
        model: string(header.model, "INVALID_HEADER", line),
        environmentIdentity: string(header.environmentIdentity, "INVALID_HEADER", line),
    };
}

export function reduceSession(bytes: Uint8Array): SessionState {
    let lastLf = -1;
    for (let index = bytes.length - 1; index >= 0; index--) {
        if (bytes[index] === 0x0a) {
            lastLf = index;
            break;
        }
    }
    if (lastLf < 0) fail("MISSING_HEADER", 1);
    const committed = bytes.subarray(0, lastLf + 1);
    let rawLine = 1;
    for (let index = 0; index + 2 < committed.length; index++) {
        if (committed[index] === 0x0a) rawLine++;
        if (
            committed[index] === 0xed &&
            committed[index + 1] >= 0xa0 &&
            committed[index + 1] <= 0xbf &&
            (committed[index + 2] & 0xc0) === 0x80
        )
            fail("MALFORMED_JSON", rawLine);
    }
    let text: string;
    try {
        text = new TextDecoder("utf-8", { fatal: true }).decode(committed);
    } catch {
        fail("INVALID_UTF8", 1);
    }
    const lines = text.slice(0, -1).split("\n");
    if (!lines.length || !lines[0]) fail("MISSING_HEADER", 1);
    const parse = (source: string, line: number) => {
        if (!source) fail("BLANK_LINE", line);
        if (source.endsWith("\r")) fail("CRLF_NOT_ALLOWED", line);
        scanJson(source, line);
        try {
            return JSON.parse(source) as unknown;
        } catch {
            fail("MALFORMED_JSON", line);
        }
    };
    const header = validateHeader(parse(lines[0], 1), 1);
    let state: InternalState = {
        header,
        transcript: [],
        activeContext: [],
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        operation: { kind: "idle" },
        repairedLength: lastLf + 1,
        nextSeq: 1,
        ids: new Set(),
        reservedIds: new Map(),
        entries: new Map(),
        records: new Map(),
        operations: new Map(),
        attempts: new Map(),
        steps: new Map(),
        tools: new Map(),
        toolPairs: new Set(),
        activeContextThroughEntryId: undefined,
    };
    for (let index = 1; index < lines.length; index++) {
        const line = index + 1;
        const value = parse(lines[index], line);
        const transaction = Array.isArray(value) ? value : [value];
        if (!transaction.length) fail("EMPTY_TRANSACTION", line);
        const next = clone(state);
        for (const fact of transaction) applyFact(next, fact, line);
        validateTranscript(next.transcript, line, next.nextSeq - 1);
        state = next;
    }
    return {
        header: state.header,
        transcript: state.transcript,
        activeContext: state.activeContext,
        usage: state.usage,
        operation: state.operation,
        repairedLength: state.repairedLength,
    };
}

export function encodeSession(value: string) {
    return encoder.encode(value);
}
