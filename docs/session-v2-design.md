# Session v2 design

Status: design only. No implementation or schema migration is approved by this document.

This design was drafted from first principles, then revised after reading Pi Harness v2 and Pi's evolving JSONL implementation at commit `c77ab55ecfc96291d2b81f05bb23856f68644556`.

## Goal

Make every append-only JSONL prefix explainable after a crash while preserving tiny-agent's teaching model:

```text
accepted prompt → model attempt → assistant message
→ tool intent → external effect → tool result → run outcome
```

Session v2 adds durable operation facts around the existing model transcript. It does not add lanes, branches, hooks, leases, SQLite, deferred providers, or multi-process ownership.

## What changes

Version 1 stores only:

```text
session | message | compaction | interruption
```

That is enough to resume an idle conversation, but not enough to answer:

- Was a prompt accepted before the process crashed?
- Was a model request attempted?
- Did a tool start, and may its external effect already have happened?
- May the tool be replayed safely?
- Did the run finish, abort, or fail?

Version 2 separates two kinds of durable facts in one portable JSONL file:

1. **Entries** — model-visible conversation state.
2. **Records** — execution and recovery state; never sent to the model.

## File framing

The first line is a header:

```json
{
    "kind": "header",
    "version": 2,
    "id": "<uuid-v7>",
    "createdAt": 1787371200000,
    "cwd": "/workspace",
    "provider": "openrouter",
    "model": "deepseek/deepseek-v4-flash-0731"
}
```

Each later line is one transaction: either one fact or a non-empty array of facts that become visible atomically to the reducer.

Byte-level framing is normative:

- The file is strict UTF-8.
- A committed line is a non-empty JSON value terminated by byte `0x0A` (LF).
- CRLF and blank lines are invalid.
- Every byte after the final LF is an uncommitted torn tail, even if those bytes parse as JSON.
- Open repairs a torn tail before opening the append handle: truncate or temp-replace to the final LF, reopen, then validate and reduce.
- Missing complete header, repair failure, malformed complete UTF-8/JSON, empty transaction, or invalid fact is corruption.

```json
{"kind":"entry","seq":1,"id":"...","timestamp":1787371200010,"entry":{"type":"message","message":{"role":"user","content":"hello"}}}
```

```json
[
    {"kind":"record","seq":7,"id":"...","timestamp":1787371201000,"record":{"type":"operationFinished","operationId":"...","operationKind":"run","outcome":"completed"}},
    {"kind":"usage","seq":8,"id":"...","timestamp":1787371201000,"operationId":"...","usage":{"input":100,"output":20,"cacheRead":0,"cacheWrite":0}}
]
```

Invariants:

- `seq` starts at 1 and increases by exactly 1 across facts, including facts inside a transaction.
- IDs are unique UUIDv7 values.
- A transaction is validated completely before any fact in it is applied in memory.
- Unknown `kind`, record type, duplicate ID, skipped sequence, or invalid reference is corruption.
- A final incomplete line is an uncommitted torn append and is repaired according to the byte-level framing rules above.
- An invalid complete line is corruption and is never skipped.

## Entry types

### Message

Keep provider-compatible messages, but give every entry an identity. A settled assistant entry records the step it closes and the provider stop reason:

```json
{
    "type": "message",
    "stepId": "<step-id>",
    "attemptId": "<physical-attempt-id>",
    "stopReason": "toolUse",
    "message": {
        "role": "assistant",
        "content": null,
        "tool_calls": [
            {
                "id": "call_1",
                "type": "function",
                "function": {
                    "name": "read",
                    "arguments": "{\"path\":\"README.md\"}"
                }
            }
        ]
    }
}
```

Allowed settled assistant stop reasons are `stop`, `toolUse`, and `length`. A `length` response with tool calls is never executable: recovery appends synthetic truncation results for every call without writing `toolStarted`. No pending/streaming assistant message is persisted.

A tool result remains a message entry:

```json
{
    "type": "message",
    "message": {
        "role": "tool",
        "tool_call_id": "call_1",
        "content": "file contents"
    },
    "toolName": "read",
    "isError": false
}
```

`isError` is durable execution truth. Do not infer it later by inspecting content text.

### Compaction

```json
{
    "type": "compaction",
    "operationId": "<compaction-operation-id>",
    "summary": "Earlier work summary...",
    "compactedThroughEntryId": "<message-entry-id>",
    "retainedTail": [
        {"sourceEntryId":"<entry-id>","message":{"role":"user","content":"latest prompt"}},
        {"sourceEntryId":"<entry-id>","message":{"role":"assistant","content":"latest response"}}
    ]
}
```

`retainedTail` materializes messages and preserves their source entry IDs. The reducer verifies that the IDs are ordered message entries after `compactedThroughEntryId`, and that the resulting provider transcript is legal. This makes context construction bounded while keeping the checkpoint auditable. Counts may remain optional diagnostics, not recovery inputs. Usage is recorded only as independent usage facts; the compaction entry is not an accounting source.

## Operation records

### Run accepted

Persist the user message entry and `runStarted` in one transaction:

```json
[
    {
        "kind": "entry",
        "seq": 1,
        "id": "<user-entry-id>",
        "timestamp": 1787371200010,
        "entry": {
            "type": "message",
            "message": {"role":"user","content":"inspect the failure"}
        }
    },
    {
        "kind": "record",
        "seq": 2,
        "id": "<record-id>",
        "timestamp": 1787371200010,
        "record": {
            "type": "runStarted",
            "operationId": "<run-id>",
            "operationKind": "run",
            "inputEntryId": "<user-entry-id>"
        }
    }
]
```

The caller is told that work was accepted only after this transaction is durable.

### Model attempt

Every physical provider request gets a new immutable `stepAttempt`; an attempt record is never reused for a retry:

```json
{
    "type": "stepAttempt",
    "operationId": "<run-or-compaction-id>",
    "stepId": "<logical-step-id>",
    "attemptId": "<physical-attempt-id>",
    "stepKind": "assistant",
    "attempt": 1,
    "contextThroughEntryId": "<entry-id>",
    "configurationSnapshot": {
        "model": "deepseek/deepseek-v4-flash-0731",
        "systemPromptDigest": "sha256:<hex>",
        "tools": [
            {"name":"read","schemaDigest":"sha256:<hex>","replay":"safe","replayKey":"builtin:read:v1"}
        ],
        "environmentIdentity": "<stable-host-provided-value>"
    },
    "configurationDigest": "sha256:<jcs-encoded-snapshot>"
}
```

The digest is SHA-256 over RFC 8785 JSON Canonicalization Scheme (JCS) bytes of `configurationSnapshot`. Cross-language golden fixtures contain the canonical bytes and expected digest; native object insertion order is never the digest definition. Credentials, tokens, cwd, timestamps, and volatile connection state are excluded.

The configuration snapshot intentionally has a smaller canonical domain than arbitrary JSON. Its closed shape permits only objects, arrays, and Unicode scalar strings; numbers, booleans, and `null` are not valid snapshot values. Canonical bytes are UTF-8 encoded from recursively sorted object keys, preserved array order, and JSON string escaping with lone surrogates rejected. This is the exact cross-language subset required by the closed schema; native serializer insertion order is never used.

A settled assistant entry records `stepId` and `attemptId`, closing that physical attempt. It also records `stopReason`; no pending/streaming assistant message is persisted.

Only a process crash with an open attempt is retryable. Recovery may append one new `stepAttempt` with `attempt: 2` when the current configuration digest matches. Attempt 2 is terminal: another unknown crash state blocks recovery. Live provider errors, rate limits, and timeouts are recorded as `stepFailed` and are not automatically retried.

A provider error that produced no settled assistant entry is itself durable:

```json
{
    "type": "stepFailed",
    "operationId": "<run-or-compaction-id>",
    "stepId": "<step-id>",
    "attemptId": "<physical-attempt-id>",
    "error": {"code":"model_error","message":"provider request failed"}
}
```

`stepFailed` closes the attempt but not the operation. Live execution or recovery then appends the matching failed terminal record; it never infers failure or success from the absence of messages.

### Tool intent

A tool cannot execute until this record is durable:

```json
{
    "type": "toolStarted",
    "operationId": "<run-id>",
    "stepId": "<step-id>",
    "assistantEntryId": "<assistant-entry-id>",
    "toolIndex": 0,
    "toolCallId": "call_1",
    "toolName": "read",
    "arguments": {"path":"README.md"},
    "replay": "safe",
    "replayKey": "builtin:read:v1",
    "resultEntryId": "<provisioned-entry-id>"
}
```

Rules:

- Store parsed, validated, effective arguments, not only provider JSON text.
- `assistantEntryId` and `toolIndex` must identify the exact call whose ID/name match this record.
- `resultEntryId` is chosen before execution.
- `replayKey` identifies the exact trusted implementation and effect semantics, for example `builtin:read:v1`; changing implementation, authorization scope, or semantics requires a new key.
- Replay defaults to `never`.
- Recovery replays only when persisted and current declarations both say `safe`, their `replayKey` values match exactly, and the current configuration digest matches.
- A declaration or configuration mismatch blocks recovery without executing an effect or appending a terminal outcome. Restoring matching configuration or explicitly aborting are the only next actions.
- Built-in `read` may declare `safe`.
- `bash`, `write`, `edit`, and MCP tools default to `never`.
- MCP tools may become `safe` only through trusted host metadata; model text cannot choose replay policy.

The result transaction contains the provisioned entry and optional tool usage:

```json
[
    {
        "kind":"entry",
        "seq":9,
        "id":"<provisioned-entry-id>",
        "timestamp":1787371200300,
        "stepId":"<step-id>",
        "entry":{
            "type":"message",
            "message":{"role":"tool","tool_call_id":"call_1","content":"..."},
            "toolName":"read",
            "toolStartedId":"<tool-started-record-id>",
            "isError":false
        }
    },
    {
        "kind":"usage",
        "seq":10,
        "id":"<usage-id>",
        "timestamp":1787371200300,
        "operationId":"<run-id>",
        "toolStartedId":"<tool-started-record-id>",
        "usage":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0}
    }
]
```

### Manual compaction

Manual `/compact` is its own durable operation:

```json
{
    "type": "compactionStarted",
    "operationId": "<compaction-operation-id>",
    "operationKind": "compaction",
    "inputThroughEntryId": "<entry-id>",
    "resultEntryId": "<provisioned-compaction-entry-id>"
}
```

```text
compactionStarted → stepAttempt(stepKind=compaction)
→ compaction entry → operationFinished(completed)
```

`compactionStarted` provisions the compaction entry ID and records its input boundary. Abort uses `abortRequested` with that operation ID. Recovery may create at most one additional physical summary attempt, under the same digest and attempt-cap rules as assistant steps. A committed compaction entry followed by a missing terminal record only needs `operationFinished`. Threshold/overflow compaction may reuse this procedure later, but is deferred from the first writer.

### Interruption and terminal outcome

Replace the v1 standalone `interruption` event with operation records:

```json
{
    "type":"abortRequested",
    "operationId":"<operation-id>",
    "operationKind":"run",
    "phase":"tool",
    "toolCallId":"call_1",
    "reason":"escape"
}
```

Every operation ends with at most one terminal record; exactly one exists only after it finishes:

```json
{
    "type":"operationFinished",
    "operationId":"<operation-id>",
    "operationKind":"run",
    "outcome":"completed",
    "finalEntryId":"<assistant-entry-id>"
}
```

```json
{
    "type":"operationFinished",
    "operationId":"<operation-id>",
    "operationKind":"run",
    "outcome":"failed",
    "error":{"code":"model_error","message":"provider request failed"}
}
```

Allowed terminal outcomes:

```text
completed | aborted | failed
```

A configuration, replay declaration, or attempt-cap mismatch is not terminal. `planRecovery` returns `RecoveryBlocked(configuration_changed | replay_declaration_changed | attempts_exhausted)`; open/load remains effect-free, and explicit `resume` returns the blocked result without appending facts. Explicit abort remains available and performs durable reconciliation.

`suspended` is therefore recovery state, not a persisted terminal outcome. Deferred-work transport remains out of scope.

## Usage ledger

Usage is an independent additive fact:

```json
{
    "kind":"usage",
    "seq":11,
    "id":"<usage-id>",
    "timestamp":1787371200400,
    "operationId":"<operation-id>",
    "attemptId":"<physical-attempt-id>",
    "usage":{"input":100,"output":20,"cacheRead":10,"cacheWrite":0}
}
```

Do not use the latest message's usage as session totals. Model usage references the exact physical `attemptId`; nested tool usage references the exact `toolStartedId`. In both cases the referenced owner must belong to the same `operationId`. Reduction sums usage facts exactly once by unique ID.

## Pure reducer and recovery planner

Durable reduction is effect-free and independent of the current runtime:

```text
header + complete transactions
→ validate framing and references
→ apply facts in sequence
→ SessionState
```

Runtime recovery is a separate pure function:

```text
planRecovery(SessionState, CurrentConfiguration)
→ RecoveryAction | RecoveryBlocked
```

`reduce` never receives current tools or configuration and never emits `configuration_changed`. Milestone 1 golden fixtures cover only `reduce`. Separate planner fixtures provide the current configuration and assert replay/block/abort decisions.

Minimal state:

```ts
type SessionState = {
    transcript: Message[];
    activeContext: Message[];
    usage: Usage;
    operation:
        | { kind: "idle" }
        | {
              kind: "run";
              runId: string;
              inputEntryId: string;
              step?: StepState;
              toolCalls: ToolCallState[];
              abortRequested: boolean;
          }
        | {
              kind: "compaction";
              operationId: string;
              inputThroughEntryId: string;
              step?: StepState;
              resultEntryId: string;
              abortRequested: boolean;
          };
};
```

Reducer invariants:

- At most one unfinished operation (`run` or `compaction`) exists.
- `runStarted.inputEntryId` references the user entry committed in the same or an earlier transaction.
- One run has at most one open assistant step.
- A settled assistant entry references its step and has a non-pending `stopReason`.
- `toolStarted.assistantEntryId` and `toolIndex` identify a matching call in that settled assistant entry.
- No `toolStarted` may exist for an assistant entry whose `stopReason` is `length`.
- Exactly one `toolStarted` exists per `assistantEntryId` / `toolIndex` pair; provider `toolCallId` need not be globally unique.
- A tool result ID equals its provisioned `resultEntryId` and references the `toolStarted` record ID.
- Tool usage references the `toolStarted` record ID.
- Every assistant tool call has exactly one result before another model step starts or the run closes.
- At most one terminal outcome exists per operation; exactly one exists only when that operation is finished.
- Compaction boundaries and retained messages form a valid provider transcript.

The same golden JSONL prefixes must reduce to equivalent state in TypeScript, Go, Python, and Rust.

## Recovery table

| durable prefix | recovery |
|---|---|
| user entry + `runStarted`; no `stepAttempt` | start assistant attempt 1 |
| open `stepAttempt(attempt=1)`; no assistant entry or `stepFailed` | if digest matches, append attempt 2; otherwise block recovery |
| open `stepAttempt(attempt=2)`; no assistant entry or `stepFailed` | block recovery as `attempts_exhausted` |
| assistant entry with `stopReason=length` and tool calls | append synthetic truncation results; never execute |
| assistant entry with `stopReason=toolUse`; no `toolStarted` for next call | persist intent, then execute |
| `toolStarted`; persisted/current replay policy, replayKey, and configuration all match safe; no result | replay with persisted effective arguments |
| `toolStarted`; declaration/configuration mismatch; no result | block recovery without executing or appending a terminal outcome |
| `toolStarted(replay=never)`; no result | append synthetic interrupted tool result |
| abort requested; missing tool results | append synthetic results, then aborted closure |
| terminal assistant entry (`stopReason=stop`, non-empty final content, no unresolved calls); no terminal record | append completed terminal record without repeating effects |
| `stepFailed`; no terminal record | append failed terminal record |
| `compactionStarted`; no `stepAttempt` | start compaction attempt 1 |
| compaction attempt 1 open; no compaction entry or `stepFailed` | retry only when digest matches; otherwise block recovery |
| compaction attempt 2 open; no compaction entry or `stepFailed` | block recovery as `attempts_exhausted` |
| compaction entry exists; no terminal record | append completed operation terminal record |
| terminal record | idle; no recovery work |

Recovery must be idempotent: reopening after any recovery append produces the same next action or idle state.

## Storage module

Keep a deep, small interface:

```ts
interface SessionStore {
    commit(facts: NewFact[]): Promise<CommittedFact[]>;
    load(): Promise<SessionState>;
    close(): Promise<void>;
}

function planRecovery(state: SessionState, current: CurrentConfiguration): RecoveryPlan;
```

`commit` owns:

- IDs, sequence numbers, and timestamps are assigned before serialization;
- complete-transaction validation;
- one in-process FIFO commit queue;
- append of one newline-terminated JSON value;
- process-crash acceptance: append one LF-terminated transaction and wait for the write operation before resolving;
- application to in-memory reduced state only after the append succeeds.

`load` owns:

- header validation;
- torn-tail byte repair before append admission;
- complete-line transaction parsing;
- pure reduction and invariant validation.

Version 2 remains single-writer. Cross-process leases are explicitly deferred.

## Format cutover

Session v2 is a clean break:

- New writers emit only v2.
- Readers accept only v2.
- Existing v1 session files are unsupported after the cutover.
- There is no migration, import, compatibility projection, dual reader, or `--resume-as-v2` path.
- Development sessions may be deleted before installing the new version.

This removes legacy normalization from the implementation and keeps all four languages on one schema from the first v2 commit.

## Lessons adopted from Pi JSONL

At Pi commit `c77ab55ecfc96291d2b81f05bb23856f68644556`:

- One JSONL line is a transaction and may contain several committed writes.
- Sequence numbers provide deterministic replay and detect missing/reordered writes.
- Storage validates the full transaction before mutating in-memory state.
- Commits are serialized with a FIFO promise queue.
- Pi detects a non-newline-terminated tail and repairs the complete prefix through temp-file replacement.
- Legacy data is normalized in memory and only rewritten atomically on the first new write.
- Entries, mutable values, lists, and usage are separate storage concepts.
- Compaction stores a materialized retained tail to bound context construction.

## Deliberate differences from Pi

Tiny-agent does **not** initially copy Pi's generic entry/value/list storage engine because tiny-agent has no real second adapter or query workload that needs it. Encoding operation state as typed records keeps the teaching interface smaller.

Also deferred:

- conversation trees and parent IDs;
- named lanes and per-lane mutation lines;
- global values and lists;
- forks and snapshots;
- storage repositories and SQLite adapters;
- leases and multi-process takeover;
- deferred provider operations;
- hooks and custom entries;
- OpenTelemetry schema machinery.

If tiny-agent later adds branches, multiple lanes, or a SQLite backend, the storage seam should be reconsidered rather than layering those features over this linear schema.

## Durability contract

Version 2 initially promises **process-crash durability**: once acceptance resolves, a complete newline-terminated transaction has been handed to the operating system; on reopen, a torn final append is discarded and the complete prefix is repaired. It does not promise survival across power loss or storage-controller failure.

A future power-loss durable mode requires file sync after each accepted transaction and directory sync for temp-file replacement, implemented and tested consistently in all four languages. Until then, the document uses “accepted” or “process-crash durable,” not unqualified “durable.”

## Decisions before implementation

1. Format cutover is immediate; v1 is unsupported and has no migration path.
2. Only built-in `read` is replay-safe initially; `bash`, `write`, `edit`, and all MCP calls are `never`.
3. The effective-configuration digest contains model ID, system prompt, enabled model-facing tool definitions, replay declarations, and stable environment identity; credentials and volatile connection state are excluded.
4. A configuration mismatch suspends recovery without appending a terminal failure or executing effects.
5. V2 writers remain disabled until TypeScript, Go, Python, and Rust reducers pass the same golden fixtures.

## Implementation order

1. Add shared golden JSONL prefix fixtures and expected reduced states.
2. Implement read-only v2 reducer in all four languages.
3. Add transaction writers and `runStarted` / `stepAttempt` / terminal records without automatic recovery.
4. Add `toolStarted`, `replayKey`, replay declarations, and crash-prefix recovery.
5. Move compaction to an operation with identity boundary plus materialized retained tail.
6. Delete v1 reader/writer code and enable v2 writers only after cross-language conformance passes.
