# Hard eval suite design

This document defines the next difficulty tier for tiny-agent evaluations. The existing tasks remain useful as fast smoke tests; the hard suite adds tasks that require state-machine reasoning, concurrency correctness, validation, and disciplined convergence within the existing 120-second contract.

## Goals

The hard suite should distinguish models by:

1. **Correctness** — the final workspace passes public and hidden verification.
2. **Speed** — the agent exits within 120 seconds without relying on a larger timeout.
3. **Efficiency** — token and tool usage remain bounded.
4. **Convergence** — the model stops after sufficient verification instead of repeatedly rewriting correct code.
5. **Stability** — repeated attempts converge reliably rather than succeeding only on a favorable sample.

Correctness remains the gate. Faster or cheaper failures do not outrank correct runs.

## Constraints

- Keep fixtures dependency-free and runnable with the Node.js standard library.
- Give all four tiny-agent runtimes the same JavaScript fixture and prompt.
- Avoid network access, wall-clock sleeps, random external state, and platform-specific behavior.
- Use deferred Promises, injected IO, and fixed generated cases instead of timing-sensitive tests.
- Keep each task solvable within 120 seconds by a capable model.
- Permit changes only to the named implementation file.
- Public tests should reveal the core API but not enumerate every hidden edge case.
- Hidden verification must independently check protected fixture files rather than trusting workspace Git history.

## Proposed tasks

| Order | Task | Main capability | Key hidden cases | Expected difficulty |
| ---: | --- | --- | --- | --- |
| 1 | `bounded-map` | Async state machine and cancellation | scheduling bound, failure drain, abort identity, listener cleanup | High |
| 2 | `journal-recovery` | Durable state and serialized IO | torn tail, corruption boundaries, concurrent append, failure recovery | High |
| 3 | `rebuild-plan` | Graph validation and deterministic ordering | disconnected cycles, reverse closure, stable topological order | Medium-high |

Implement one task at a time. A task joins the hard suite only after its verifier is deterministic and at least one capable model can complete it with meaningful margin below 120 seconds.

# Task 1: `bounded-map`

## API

The fixture exports:

```js
export async function mapConcurrent(items, limit, worker, options = {})
```

The worker receives:

```js
worker(item, index, signal)
```

## Contract

- `items` must be an array.
- `limit` must be a positive integer.
- `worker` must be a function.
- Validation finishes before any worker starts.
- Active workers never exceed `limit`.
- Each started index runs at most once.
- Successful results preserve input order, not completion order.
- Empty input resolves to an empty array without calling the worker.
- On the first worker throw or rejection:
  - no queued item starts afterward;
  - already-started workers are allowed to settle;
  - the returned Promise rejects after they settle;
  - the original error object is preserved.
- With `options.signal`:
  - a pre-aborted signal starts no workers;
  - a mid-run abort starts no further queued work;
  - already-started workers are allowed to settle;
  - the returned Promise rejects with `signal.reason` by identity;
  - the abort listener is removed after settlement.
- The implementation must not mutate `items`.

## Starter defect

The initial implementation should be plausible but fundamentally wrong, for example:

```js
export async function mapConcurrent(items, limit, worker, options = {}) {
    return Promise.all(items.map((item, index) => worker(item, index, options.signal)));
}
```

This passes a trivial ordering example while ignoring the concurrency bound, queued-work cancellation, and cleanup semantics.

## Public tests

Public tests should cover approximately 40% of the contract:

1. `limit = 2` starts only indices 0 and 1 initially.
2. Reverse completion still returns results in input order.
3. Empty input calls no worker.
4. Invalid limits reject before worker execution.
5. A worker rejection is propagated.

All scheduling tests use manually controlled deferred Promises. Do not use `setTimeout` as a correctness oracle.

## Hidden verifier

The external verifier should additionally check:

- lengths 1, 2, 7, and 31 with limits 1, 2, and 5;
- `maxActive <= limit` throughout execution;
- every started index executes exactly once;
- synchronous throws and asynchronous rejections;
- no queued work begins after failure becomes observable;
- failure waits for already-started workers to settle;
- pre-abort and mid-run abort;
- error and abort-reason object identity;
- abort listener add/remove balance;
- deep-frozen input arrays;
- no worker state continues changing after the returned Promise settles.

The verifier must compare `package.json`, public tests, and any task instructions against the original fixture. Only `src/bounded-map.js` may differ. Extra generated files are ignored only if explicitly allowed by the task; the initial task should allow none except `.tiny-agent/` and `.git/` runtime state.

## Why this is difficult

A correct solution needs one coherent scheduling state machine. A superficial `Promise.all`, worker-pool loop, or `Promise.race` patch commonly fails one of these boundaries:

- work is scheduled too early;
- results follow completion order;
- failure rejects before active workers drain;
- abort and worker failure race inconsistently;
- listeners leak;
- queued workers start after cancellation.

The task therefore measures reasoning quality without requiring a large codebase or external dependency.

# Task 2: `journal-recovery`

## API

```js
const journal = await openJournal(path);
journal.events;
await journal.append(event);
```

## Core contract

- Records are JSON Lines values shaped as `{ seq, event }`.
- Sequence numbers start at 1 and are strictly contiguous.
- Only an unterminated malformed fragment at the physical end of the file is recoverable as a torn write.
- Terminated malformed JSON, invalid records, gaps, and duplicates are corruption errors.
- Corruption errors identify the line number.
- Concurrent appends receive unique sequence numbers in call order and reach disk in the same order.
- A torn tail is repaired before the next successful append.
- Serialization or IO failure does not poison future appends and does not consume a sequence number.
- Input events are not mutated.

The hidden verifier should use injected deterministic IO failures rather than filesystem races.

# Task 3: `rebuild-plan`

## API

```js
planRebuild(packages, changed)
```

Each package has a unique name and a list of dependency names.

## Core contract

- Validate the entire catalog, including disconnected components.
- Reject duplicate names, unknown dependencies, invalid dependency arrays, and unknown changed names.
- Reject every cycle, including cycles unrelated to `changed`.
- Return changed packages and all transitive dependents.
- Dependencies appear before dependents.
- Nodes that are simultaneously ready retain their order from the original package array.
- Do not sort alphabetically or by the order of `changed`.
- Do not mutate inputs.
- Correctly handle names such as `__proto__`, `constructor`, and `toString`.

The hidden verifier should use fixed-seed generated DAGs and an independent stable-topological-sort oracle.

# Execution protocol

## Development

Use one attempt while building a task:

```bash
TASK=bounded-map AGENT=tiny-ts node --import tsx eval/run.ts
```

Run the verifier directly against known-good and intentionally broken implementations before involving a model.

## Candidate comparison

For a model decision:

- run every hard task against all four runtimes;
- use the same endpoint, model, prompt, fixture, and deadline;
- repeat each task/runtime cell at least three times during development and five times for a release decision;
- report provider failures separately, but include timeout and normal agent exits without a correct final workspace as model/agent failures;
- report successful median and range alongside overall pass rate so failed long-tail attempts are not hidden.

## Metrics

Keep the existing primary metrics:

- pass rate;
- agent wall time;
- input/output/cache tokens;
- tool calls;
- failure detail.

A later runner change may add snapshot-based `firstCorrectMs` and `correctToExitMs`, but the hard tasks do not depend on that infrastructure. Avoid redesigning the entire eval runner before the first hard task proves useful.

# Implementation order

1. Add `bounded-map` fixture, public tests, prompt, and hidden verifier.
2. Test the verifier against several deliberately wrong implementations.
3. Run a one-agent local-endpoint smoke evaluation.
4. Tune only ambiguous wording or nondeterministic verifier behavior; do not weaken valid edge cases to make a model pass.
5. Run all four runtimes once.
6. Add `journal-recovery` only after `bounded-map` is stable.
7. Add `rebuild-plan` after the durable-state task.
8. Consider runner-level convergence snapshots and stronger sandboxing only after the hard tasks produce useful model separation.
