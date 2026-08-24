# Evaluation history

This benchmark tracks whether tiny-agent changes improve task outcomes without hiding efficiency regressions. Results are append-only, and the newest run appears first below the marker.

## Measurement contract

### Primary metric

- **Pass rate**: passed verifier attempts divided by total attempts. A task passes only when the agent exits successfully, stays within the 120-second limit, and the task's public and hidden verifiers pass.

### Secondary metrics

- **Agent time**: wall-clock time spent running the agent, excluding fixture setup and verification. Treat small differences as noise across machines and provider conditions.
- **Input/output tokens**: canonical model usage recorded in the session. Their sum is used for the summary's median tokens.
- **Cache read/write tokens**: recorded separately because cache behavior can change cost and latency without changing task quality.
- **Tool calls**: assistant tool calls recorded in the durable transcript. This is an efficiency signal, not a quality score.
- **Failure detail**: timeout, agent exit, or verifier output used to diagnose regressions.

### Comparison identity

Each new run records:

- UTC timestamp;
- repository commit and whether tracked files were dirty;
- OS, CPU architecture, and Node version;
- agent implementation and model from the session header;
- a content digest (**Spec**) covering the task prompt, fixture, tests, and verifier.

Only compare results with the same task Spec. Prompt or verifier changes create a new benchmark version. Model, platform, and dirty-state differences must also be considered before attributing a change to tiny-agent code.

### Evaluation protocol

- Keep task fixtures and hidden verifiers deterministic and dependency-free.
- Never edit old run data; corrections are represented by a new task Spec and a newer run.
- Use complete-suite runs for release comparisons. A single-task run is useful for diagnosis but does not represent overall quality.
- One attempt is useful for smoke testing; repeated full-suite runs are preferred before drawing conclusions about stochastic model behavior.
- Pass rate is the outcome metric. Time, tokens, cache usage, and tools explain efficiency and behavior but must not compensate for a failure.

## Runs

<!-- EVAL_RUNS -->

### Legacy runs

Runs below predate the full measurement contract and do not contain commit, model, platform, or task Spec metadata.

## 2026-08-24T17:57:14.907Z

| Task | Agent | Result | Time | Tokens | Tools | Detail |
| --- | --- | --- | ---: | ---: | ---: | --- |
| session-summary | tiny-ts | PASS | 24.1s | 7670 | 8 |  |

## 2026-08-24T17:38:31.440Z

| Task | Agent | Result | Time | Tokens | Tools | Detail |
| --- | --- | --- | ---: | ---: | ---: | --- |
| add-feature | tiny-py | PASS | 18.9s | 2955 | 7 |  |
| async-cache | tiny-py | PASS | 30.9s | 3979 | 6 |  |
| config-loader | tiny-py | PASS | 19.4s | 6010 | 6 |  |
| fix-bug | tiny-py | PASS | 17.7s | 3542 | 6 |  |
| follow-instructions | tiny-py | PASS | 21.9s | 2674 | 6 |  |
| session-summary | tiny-py | PASS | 21.4s | 4431 | 6 |  |

## 2026-08-24T17:36:18.339Z

| Task | Agent | Result | Time | Tokens | Tools | Detail |
| --- | --- | --- | ---: | ---: | ---: | --- |
| add-feature | tiny-ts | PASS | 23.0s | 4370 | 8 |  |
| async-cache | tiny-ts | PASS | 21.2s | 3963 | 5 |  |
| config-loader | tiny-ts | PASS | 41.6s | 10806 | 8 |  |
| fix-bug | tiny-ts | PASS | 15.3s | 4957 | 6 |  |
| follow-instructions | tiny-ts | PASS | 17.8s | 7208 | 5 |  |
| session-summary | tiny-ts | PASS | 35.6s | 4569 | 8 |  |

## 2026-08-24T17:33:29.406Z

| Task | Agent | Result | Time | Tokens | Tools | Detail |
| --- | --- | --- | ---: | ---: | ---: | --- |
| add-feature | tiny-ts | PASS | 36.3s | 7656 | 10 |  |
| async-cache | tiny-ts | PASS | 45.3s | 6759 | 7 |  |
| config-loader | tiny-ts | PASS | 37.7s | 4325 | 7 |  |
| fix-bug | tiny-ts | PASS | 17.9s | 3152 | 5 |  |
| follow-instructions | tiny-ts | PASS | 16.9s | 3137 | 5 |  |
| session-summary | tiny-ts | FAIL | 28.9s | 4848 | 7 | node:internal/modules/run_main:107     triggerUncaughtException(     ^  AssertionError [ERR_ASSERTION]: Expected values to be strictly deep-equal: + actual - expected ... Skipped lines    {     byType: {       message: 1,       started: 1,       tool: 3 ...     toolFailures: 2, +   total: 7 -   total: 5   }      at file:///Users/geminixiang/github/tiny-agent/eval/tasks/session-summary/verify.mjs:25:8 {   generatedMessage: true,   code: 'ERR_ASSERTION',   actual: {     total: 7,     byType: { started: 1, tool: 3, message: 1 },     durationMs: 160,     toolFailures: 2,     lastError: 'second failure'   },   expected: {     total: 5,     byType: { started: 1, tool: 3, message: 1 },     durationMs: 160,     toolFailures: 2,     lastError: 'second failure'   },   operator: 'deepStrictEqual',   diff: 'simple' }  Node.js v24.14.1 |

