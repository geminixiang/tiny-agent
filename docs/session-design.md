# Session design

Status: implemented canonical production contract in TypeScript, Go, Python, and Rust.

The production writers, agent loops, resume/recovery paths, and manual compaction use this contract. Shared reducer and recovery-planner fixtures keep the four implementations aligned.

This design was drafted from first principles, then revised after reading Pi Harness v2 and Pi's evolving JSONL implementation at commit `c77ab55ecfc96291d2b81f05bb23856f68644556`.

## Goal

Make every append-only JSONL prefix explainable after a crash while preserving tiny-agent's teaching model:

```text
accepted prompt → model attempt → assistant message
→ tool intent → external effect → tool result → run outcome
```

Session adds durable operation facts around the existing model transcript. It does not add lanes, branches, hooks, leases, SQLite, deferred providers, or multi-process ownership.

## What changes

Before the clean cutover, the legacy format stored only:

```text
session | message | compaction | interruption
```

That is enough to resume an idle conversation, but not enough to answer:

- Was a prompt accepted before the process crashed?
- Was a model request attempted?
- Did a tool start, and may its external effect already have happened?
- May the tool be replayed safely?
- Did the run finish, abort, or fail?

The session format separates two kinds of durable facts in one portable JSONL file:

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
    "model": "deepseek/deepseek-v4-flash-0731",
    "environmentIdentity": "/workspace"
}
```

Each later line is one transaction: either one fact or a non-empty array of facts that become visible atomically to the reducer.

Byte-level framing is normative:

- The file is strict UTF-8.
- JSON object keys are unique at every nesting level; duplicate keys are malformed JSON even if a host parser would keep the last value.
- JSON strings contain only Unicode scalar values. Escaped or raw lone surrogates are malformed JSON and are rejected before materialization.
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
    "result": {"type":"success"}
}
```

`result` is a closed union: `{type:"success"}`, `{type:"error"}`, or `{type:"synthetic",reason}`. Synthetic reasons are `invalidArguments`, `unknownTool`, `truncated`, `aborted`, and `interrupted`; their exact model-facing contents are fixed below.

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
            {"name":"read","definitionDigest":"sha256:<hex>"}
        ],
        "adapterIdentity": "openrouter:chat-completions:v1",
        "routingIdentity": "openrouter:deepseek/deepseek-v4-flash-0731",
        "outputOptionsDigest": "sha256:<hex>"
    },
    "configurationDigest": "sha256:<jcs-encoded-snapshot>"
}
```

`contextThroughEntryId` is the durable source boundary represented by `activeContext` when the request is admitted. Before compaction, it is the latest model-visible message entry ID. After compaction, it is the `compactionStarted.inputThroughEntryId`: the latest source entry materialized by the compaction checkpoint, not the compaction entry ID itself. Attempt 1 must equal the reducer's current boundary. Attempt 2 must equal attempt 1's boundary and configuration digest; retrying against a newer or older context is corruption.

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
    "environmentIdentity": "/workspace",
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
            "result":{"type":"success"}
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
    "resultEntryId": "<provisioned-compaction-entry-id>",
    "compactedEntryIds": ["<entry-id>"],
    "retainedEntryIds": ["<entry-id>"],
    "sourceDigest": "sha256:<hex>"
}
```

```text
compactionStarted → stepAttempt(stepKind=compaction)
→ compaction entry → operationFinished(completed)
```

`compactionStarted` provisions the compaction entry ID and records its input boundary. Abort uses `abortRequested` with that operation ID. Recovery may create at most one additional physical summary attempt, under the same digest and attempt-cap rules as assistant steps. A committed compaction entry followed by a missing terminal record only needs `operationFinished`. Production currently uses this procedure for manual `/compact`; automatic threshold/overflow compaction remains deferred.

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

Abort closure is also reconciled durably. `operationFinished(outcome=aborted)` requires a prior `abortRequested`, no pending tool call, and no open attempting step. An open model attempt is first closed with `stepFailed(error.code=aborted)`. Pending never-replay tools first receive their provisioned synthetic interrupted tool results; only then may the aborted terminal record be appended. Directly appending an aborted terminal while either state remains open is corruption.

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

Do not use the latest message's usage as session totals. Model usage references the exact physical `attemptId`; nested tool usage references the exact `toolStartedId`. In both cases the referenced owner must belong to the same `operationId`. Reduction sums usage facts exactly once by unique ID. Every individual counter and every checked cumulative sum must remain within `0..9007199254740991`; overflow is corruption rather than rounded arithmetic.

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

`reduce` never receives current tools or configuration and never emits `configuration_changed`. Shared golden fixtures cover `reduce`; separate planner fixtures provide the current configuration and assert replay/block/abort decisions.

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
- A `stepAttempt(attempt=1)` records exactly the current active-context source boundary; attempt 2 repeats attempt 1's boundary and configuration.
- One run has at most one open assistant step.
- A settled assistant entry references its step and has a non-pending `stopReason`.
- `toolStarted.assistantEntryId` and `toolIndex` identify a matching call in that settled assistant entry.
- No `toolStarted` may exist for an assistant entry whose `stopReason` is `length`.
- Exactly one `toolStarted` exists per `assistantEntryId` / `toolIndex` pair; provider `toolCallId` need not be globally unique.
- A tool result ID equals its provisioned `resultEntryId` and references the `toolStarted` record ID.
- Tool usage references the `toolStarted` record ID.
- Every assistant tool call has exactly one result before another model step starts or the run closes.
- An aborted terminal requires prior `abortRequested`, no pending tool calls, and no open attempting step.
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
| abort requested; open model attempt | append `stepFailed(aborted)` before closure |
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

The session format follows a single-writer contract. Runtime ownership tracking prevents duplicate writers only within one process; an outer job runner must prevent concurrent writers across processes. Cross-process leases and takeover remain explicitly deferred.

Candidate transactions are reduced before append, and rejected candidates leave disk bytes, sequence, and in-memory state unchanged. Session lookup accepts only regular files under the canonical sessions directory; Unix implementations additionally open with `O_NOFOLLOW`. Platforms without no-follow support retain the canonical-parent and non-symlink checks as best-effort protection.

The current language file APIs do not expose a shared portable short-write injection seam. A test-only filesystem abstraction remains deferred; current storage tests cover invalid-candidate consistency, torn-tail repair, exclusive creation, symlink rejection, and process-local writer ownership.

## Format cutover

The production cutover is complete:

- Current writers emit only version 2.
- Current readers accept only version 2.
- Legacy session files are unsupported.
- There is no migration, import, compatibility projection, dual reader, or `--resume-as-v2` path.
- Development sessions created by older versions may be deleted.

This removes legacy normalization from production and keeps all four languages on one schema. The `version: 2` header remains the format version even though this is the only supported production format.

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

Tiny-agent does **not** copy Pi's generic entry/value/list storage engine because tiny-agent has no real second adapter or query workload that needs it. Encoding operation state as typed records keeps the teaching interface smaller.

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

The session format promises **process-crash durability**: once acceptance resolves, a complete newline-terminated transaction has been handed to the operating system; on reopen, a torn final append is discarded and the complete prefix is repaired. It does not promise survival across power loss or storage-controller failure.

A future power-loss durable mode requires file sync after each accepted transaction and directory sync for temp-file replacement, implemented and tested consistently in all four languages. Until then, the document uses “accepted” or “process-crash durable,” not unqualified “durable.”

## Implemented decisions

1. The format cutover is complete; v1 is unsupported and has no migration path.
2. Only the exact built-in `read` implementation is replay-safe; custom same-name tools, `bash`, `write`, `edit`, plugins, and all MCP calls are `never`.
3. The effective-configuration digest contains model ID, system prompt, ordered encoded model-facing tool definitions, adapter identity, routing identity, and output-options digest. Replay policy and environment identity are deliberately excluded: replay stays on `toolStarted`, while the header and each tool intent bind the effect environment. Credentials and volatile connection state are excluded.
4. A configuration mismatch suspends recovery without appending a terminal failure or executing effects.
5. Production writers were enabled only after TypeScript, Go, Python, and Rust reducers and recovery planners passed the shared golden fixtures.

## Completed implementation sequence

1. Added shared golden JSONL prefix fixtures and expected reduced states.
2. Implemented read-only session reducers in all four languages.
3. Added transaction writers and durable run/model-attempt/terminal records.
4. Added `toolStarted`, `replayKey`, replay declarations, abort reconciliation, and crash-prefix recovery.
5. Moved manual compaction to a durable operation with an identity boundary and materialized retained tail.
6. Deleted legacy reader/writer code and enabled the canonical production writers after cross-language conformance passed.

## Fixed synthetic tool results

Recovery uses these exact strings; writers must not localize or paraphrase them:

| reason | content |
|---|---|
| `invalidArguments` | `Error: Tool arguments were invalid; the tool was not executed.` |
| `unknownTool` | `Error: Unknown tool; the tool was not executed.` |
| `truncated` | `Error: Tool call arguments were truncated by the model token limit; the tool was not executed.` |
| `aborted` | `Operation aborted before execution.` |
| `interrupted` | `Operation interrupted after execution status became unknown; the tool was not replayed.` |

Synthetic results are ordered by assistant `toolIndex`. Abort planning has priority over retry, replay, and normal continuation. The planner returns descriptions of effects only; it never executes effects or allocates IDs.

## Environment identity

Production resolves `environmentIdentity` from `TINY_AGENT_ENVIRONMENT_IDENTITY` when non-empty, otherwise from the canonical realpath of the current working directory. Session files and recovery plans are portable data; external effects are not portable and may run only when the current environment identity matches the persisted tool intent.

## Compaction source digest

`/compact` first chooses its cut from the reducer's materialized active context. It separately records `compactedEntryIds + retainedEntryIds` as the exact ordered partition of all durable source message-entry IDs through `inputThroughEntryId`. `sourceDigest` is SHA-256 over the same closed canonical JSON form used by configuration digests, applied to the ordered array `[{sourceEntryId,message}, ...]` for that complete source prefix. This binds IDs, message values, order, and partition boundary. During repeated compaction, the prior summary participates in the summarization input but is not itself a durable source message entry.

## Tool-definition JSON Schema

`definitionDigest` records the model-facing `{name, description, parameters}` definition, and shared fixtures define its canonical representation. The four implementations do not yet uniformly enforce the full documented JSON Schema subset when admitting every configuration snapshot. Built-in tools validate the fields they execute; MCP calls require object arguments, while complete validation against each MCP `inputSchema` remains the remote server's responsibility. `planRecovery` receives preclassified current tool declarations.
