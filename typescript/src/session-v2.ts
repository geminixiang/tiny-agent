import { createHash } from "node:crypto";

export type SessionMessage =
    | { role: "user"; content: string }
    | { role: "assistant"; content: string | null; tool_calls?: ToolCall[] }
    | { role: "tool"; content: string; tool_call_id: string };

type ToolCall = { id: string; type: "function"; function: { name: string; arguments: string } };
export type SessionUsage = { input: number; output: number; cacheRead: number; cacheWrite: number };
type ConfigurationTool = {
    name: string;
    schemaDigest: string;
    replay: "safe" | "never";
    replayKey: string;
};
type ConfigurationSnapshot = {
    model: string;
    systemPromptDigest: string;
    tools: ConfigurationTool[];
    environmentIdentity: string;
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
    resultEntryId: string;
    status: "pending" | "completed";
};
export type SessionV2State = {
    header: { id: string; createdAt: number; cwd: string; provider: string; model: string };
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

export type SessionV2CorruptionCode =
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

export class SessionV2Corruption extends Error {
    constructor(
        public code: SessionV2CorruptionCode,
        public line: number,
        public seq?: number,
        message: string = code,
    ) {
        super(message);
        this.name = "SessionV2Corruption";
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
type InternalState = SessionV2State & {
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

function fail(code: SessionV2CorruptionCode, line: number, seq?: number, message?: string): never {
    throw new SessionV2Corruption(code, line, seq, message);
}

function object(value: unknown, code: SessionV2CorruptionCode, line: number, seq?: number): JsonObject {
    if (value === null || typeof value !== "object" || Array.isArray(value)) fail(code, line, seq);
    return value as JsonObject;
}

function exact(value: JsonObject, keys: string[], code: SessionV2CorruptionCode, line: number, seq?: number) {
    if (Object.keys(value).some((key) => !keys.includes(key))) fail(code, line, seq);
}

function string(value: unknown, code: SessionV2CorruptionCode, line: number, seq?: number) {
    if (typeof value !== "string" || !value.length) fail(code, line, seq);
    return value;
}

function safeInteger(value: unknown, code: SessionV2CorruptionCode, line: number, seq?: number, minimum = 0) {
    if (!Number.isSafeInteger(value) || (value as number) < minimum) fail(code, line, seq);
    return value as number;
}

function id(value: unknown, code: SessionV2CorruptionCode, line: number, seq?: number) {
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

function canonicalString(value: string) {
    for (let index = 0; index < value.length; index++) {
        const code = value.charCodeAt(index);
        if (code >= 0xd800 && code <= 0xdbff) {
            const next = value.charCodeAt(++index);
            if (next < 0xdc00 || next > 0xdfff) throw new Error("invalid Unicode scalar string");
        } else if (code >= 0xdc00 && code <= 0xdfff) throw new Error("invalid Unicode scalar string");
    }
    return `"${[...value]
        .map((character) => {
            if (character === "\\") return "\\\\";
            if (character === '"') return '\\"';
            const escapes: Record<string, string> = { "\b": "\\b", "\t": "\\t", "\n": "\\n", "\f": "\\f", "\r": "\\r" };
            const code = character.codePointAt(0)!;
            return code < 0x20 ? (escapes[character] ?? `\\u${code.toString(16).padStart(4, "0")}`) : character;
        })
        .join("")}"`;
}

function canonicalConfiguration(value: unknown): string {
    if (typeof value === "string") return canonicalString(value);
    if (Array.isArray(value)) return `[${value.map(canonicalConfiguration).join(",")}]`;
    if (!value || typeof value !== "object")
        throw new Error("configuration supports strings, arrays, and objects only");
    const objectValue = value as JsonObject;
    return `{${Object.keys(objectValue)
        .sort()
        .map((key) => `${canonicalString(key)}:${canonicalConfiguration(objectValue[key])}`)
        .join(",")}}`;
}

function configuration(value: unknown, line: number, seq: number): ConfigurationSnapshot {
    const snapshot = object(value, "INVALID_FACT", line, seq);
    exact(snapshot, ["model", "systemPromptDigest", "tools", "environmentIdentity"], "INVALID_FACT", line, seq);
    const model = string(snapshot.model, "INVALID_FACT", line, seq);
    const systemPromptDigest = String(snapshot.systemPromptDigest);
    if (!DIGEST.test(systemPromptDigest)) fail("INVALID_FACT", line, seq);
    const environmentIdentity = string(snapshot.environmentIdentity, "INVALID_FACT", line, seq);
    if (!Array.isArray(snapshot.tools)) fail("INVALID_FACT", line, seq);
    const names = new Set<string>();
    const tools = snapshot.tools.map((raw) => {
        const tool = object(raw, "INVALID_FACT", line, seq);
        exact(tool, ["name", "schemaDigest", "replay", "replayKey"], "INVALID_FACT", line, seq);
        const name = string(tool.name, "INVALID_FACT", line, seq);
        if (names.has(name)) fail("INVALID_FACT", line, seq);
        names.add(name);
        const schemaDigest = String(tool.schemaDigest);
        if (!DIGEST.test(schemaDigest)) fail("INVALID_FACT", line, seq);
        const replay = tool.replay;
        if (replay !== "safe" && replay !== "never") fail("INVALID_FACT", line, seq);
        const declaration: ConfigurationTool = {
            name,
            schemaDigest,
            replay,
            replayKey: string(tool.replayKey, "INVALID_FACT", line, seq),
        };
        return declaration;
    });
    return { model, systemPromptDigest, tools, environmentIdentity };
}

function configurationDigest(snapshot: ConfigurationSnapshot) {
    return `sha256:${createHash("sha256").update(canonicalConfiguration(snapshot)).digest("hex")}`;
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
            if (state.operation.kind === "run" && state.operation.step?.attemptId === attemptId)
                state.operation.step.status = "settled";
        } else {
            if (state.reservedIds.get(fact.id) !== "toolResult") fail("INVALID_REFERENCE", line, fact.seq);
            exact(
                entry,
                ["type", "stepId", "message", "toolName", "toolStartedId", "isError"],
                "INVALID_FACT",
                line,
                fact.seq,
            );
            const stepId = id(entry.stepId, "INVALID_FACT", line, fact.seq);
            const startedId = id(entry.toolStartedId, "INVALID_FACT", line, fact.seq);
            if (typeof entry.isError !== "boolean") fail("INVALID_FACT", line, fact.seq);
            const started = state.tools.get(startedId);
            if (
                !started ||
                started.stepId !== stepId ||
                started.resultEntryId !== fact.id ||
                started.toolCallId !== message.tool_call_id ||
                started.toolName !== entry.toolName ||
                started.status !== "pending"
            )
                fail("INVALID_REFERENCE", line, fact.seq);
            started.status = "completed";
            state.reservedIds.delete(fact.id);
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
        } else {
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
            ["type", "operationId", "operationKind", "inputThroughEntryId", "resultEntryId"],
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
        if (!declaration || declaration.replay !== record.replay || declaration.replayKey !== replayKey)
            fail("INVALID_TRANSITION", line, fact.seq);
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
        ["type", "operationId", "operationKind", "outcome", "finalEntryId", "error"],
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
        const finalId = id(record.finalEntryId, "INVALID_FACT", line, fact.seq);
        if (found.kind === "run") {
            const info = state.entries.get(finalId);
            if (info?.operationId !== key || info.entry.type !== "message" || info.entry.stopReason !== "stop")
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
            if (message.role !== "assistant" || !message.content?.trim()) fail("INVALID_TRANSCRIPT", line, fact.seq);
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
    exact(header, ["kind", "version", "id", "createdAt", "cwd", "provider", "model"], "INVALID_HEADER", line);
    if (header.kind !== "header") fail("INVALID_HEADER", line);
    if (header.version !== 2) fail("UNSUPPORTED_VERSION", line);
    return {
        id: id(header.id, "INVALID_HEADER", line),
        createdAt: safeInteger(header.createdAt, "INVALID_HEADER", line),
        cwd: string(header.cwd, "INVALID_HEADER", line),
        provider: string(header.provider, "INVALID_HEADER", line),
        model: string(header.model, "INVALID_HEADER", line),
    };
}

export function reduceSessionV2(bytes: Uint8Array): SessionV2State {
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

export function encodeSessionV2(value: string) {
    return encoder.encode(value);
}
