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

## 2026-08-29T13:50:39.147Z

Commit: `762d8f3c696d` · Platform: `darwin-arm64` · Node: `v24.14.1`

### Summary

| Agent | Model | Passed | Pass rate | Median time | Median tokens | Median tools |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| tiny-ts | deepseek/deepseek-v4-flash-0731 | 6/6 | 100.0% | 10.7s | 5420 | 5 |
| tiny-go | deepseek/deepseek-v4-flash-0731 | 5/6 | 83.3% | 6.8s | 4917 | 6 |
| tiny-py | deepseek/deepseek-v4-flash-0731 | 6/6 | 100.0% | 14.8s | 6001 | 6 |
| tiny-rs | deepseek/deepseek-v4-flash-0731 | 6/6 | 100.0% | 11.0s | 5891 | 4.5 |

### Tasks

| Task | Spec | Agent | Model | Result | Time | Input | Output | Cache read | Cache write | Tools | Detail |
| --- | --- | --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| add-feature | `e93464a71b8a` | tiny-ts | deepseek/deepseek-v4-flash-0731 | PASS | 8.4s | 5027 | 429 | 2304 | 0 | 4 |  |
| add-feature | `e93464a71b8a` | tiny-go | deepseek/deepseek-v4-flash-0731 | PASS | 4.6s | 2152 | 462 | 3072 | 0 | 4 |  |
| add-feature | `e93464a71b8a` | tiny-py | deepseek/deepseek-v4-flash-0731 | PASS | 23.3s | 4091 | 553 | 2048 | 0 | 5 |  |
| add-feature | `e93464a71b8a` | tiny-rs | deepseek/deepseek-v4-flash-0731 | PASS | 8.9s | 2332 | 517 | 5120 | 0 | 4 |  |
| async-cache | `db7ca3acc745` | tiny-ts | deepseek/deepseek-v4-flash-0731 | PASS | 19.6s | 7549 | 2992 | 19712 | 0 | 10 |  |
| async-cache | `db7ca3acc745` | tiny-go | deepseek/deepseek-v4-flash-0731 | FAIL | 120.0s | 6716 | 2001 | 6144 | 0 | 7 | agent timeout |
| async-cache | `db7ca3acc745` | tiny-py | deepseek/deepseek-v4-flash-0731 | PASS | 20.0s | 7843 | 2178 | 9472 | 0 | 7 |  |
| async-cache | `db7ca3acc745` | tiny-rs | deepseek/deepseek-v4-flash-0731 | PASS | 10.2s | 6607 | 1582 | 4352 | 0 | 5 |  |
| config-loader | `b11eefa2367a` | tiny-ts | deepseek/deepseek-v4-flash-0731 | PASS | 7.7s | 4421 | 1137 | 7424 | 0 | 5 |  |
| config-loader | `b11eefa2367a` | tiny-go | deepseek/deepseek-v4-flash-0731 | PASS | 9.6s | 4089 | 1513 | 7936 | 0 | 6 |  |
| config-loader | `b11eefa2367a` | tiny-py | deepseek/deepseek-v4-flash-0731 | PASS | 18.8s | 8437 | 1268 | 2816 | 0 | 5 |  |
| config-loader | `b11eefa2367a` | tiny-rs | deepseek/deepseek-v4-flash-0731 | PASS | 12.9s | 4610 | 2139 | 7168 | 0 | 4 |  |
| fix-bug | `14237efa45fb` | tiny-ts | deepseek/deepseek-v4-flash-0731 | PASS | 6.5s | 4806 | 578 | 5376 | 0 | 6 |  |
| fix-bug | `14237efa45fb` | tiny-go | deepseek/deepseek-v4-flash-0731 | PASS | 7.1s | 4116 | 592 | 2816 | 0 | 6 |  |
| fix-bug | `14237efa45fb` | tiny-py | deepseek/deepseek-v4-flash-0731 | PASS | 7.7s | 3419 | 651 | 3328 | 0 | 6 |  |
| fix-bug | `14237efa45fb` | tiny-rs | deepseek/deepseek-v4-flash-0731 | PASS | 11.7s | 4218 | 814 | 5632 | 0 | 4 |  |
| follow-instructions | `ee47fd37cb69` | tiny-ts | deepseek/deepseek-v4-flash-0731 | PASS | 18.4s | 3139 | 791 | 6656 | 0 | 5 |  |
| follow-instructions | `ee47fd37cb69` | tiny-go | deepseek/deepseek-v4-flash-0731 | PASS | 5.4s | 2925 | 642 | 5376 | 0 | 5 |  |
| follow-instructions | `ee47fd37cb69` | tiny-py | deepseek/deepseek-v4-flash-0731 | PASS | 7.0s | 4291 | 776 | 5888 | 0 | 6 |  |
| follow-instructions | `ee47fd37cb69` | tiny-rs | deepseek/deepseek-v4-flash-0731 | PASS | 31.1s | 3051 | 659 | 7424 | 0 | 5 |  |
| session-summary | `71a3943910cd` | tiny-ts | deepseek/deepseek-v4-flash-0731 | PASS | 12.9s | 3394 | 884 | 7936 | 0 | 4 |  |
| session-summary | `71a3943910cd` | tiny-go | deepseek/deepseek-v4-flash-0731 | PASS | 6.5s | 4240 | 886 | 6656 | 0 | 7 |  |
| session-summary | `71a3943910cd` | tiny-py | deepseek/deepseek-v4-flash-0731 | PASS | 10.7s | 5568 | 1367 | 6400 | 0 | 6 |  |
| session-summary | `71a3943910cd` | tiny-rs | deepseek/deepseek-v4-flash-0731 | PASS | 10.0s | 8242 | 1217 | 12800 | 0 | 8 |  |

## 2026-08-24T20:00:30.927Z

Commit: `e3ffeff54906` · Platform: `darwin-arm64` · Node: `v24.14.1`

### Summary

| Agent | Model | Passed | Pass rate | Median time | Median tokens | Median tools |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| tiny-ts | deepseek/deepseek-v4-flash-0731 | 6/6 | 100.0% | 24.6s | 5467 | 5.5 |
| tiny-go | deepseek/deepseek-v4-flash-0731 | 6/6 | 100.0% | 28.0s | 4335 | 5.5 |
| tiny-py | deepseek/deepseek-v4-flash-0731 | 6/6 | 100.0% | 24.3s | 3577 | 5 |
| tiny-rs | deepseek/deepseek-v4-flash-0731 | 6/6 | 100.0% | 33.7s | 4492 | 5.5 |

### Tasks

| Task | Spec | Agent | Model | Result | Time | Input | Output | Cache read | Cache write | Tools | Detail |
| --- | --- | --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| add-feature | `e93464a71b8a` | tiny-ts | deepseek/deepseek-v4-flash-0731 | PASS | 16.0s | 2102 | 527 | 4352 | 0 | 4 |  |
| add-feature | `e93464a71b8a` | tiny-go | deepseek/deepseek-v4-flash-0731 | PASS | 10.3s | 1257 | 437 | 2816 | 0 | 3 |  |
| add-feature | `e93464a71b8a` | tiny-py | deepseek/deepseek-v4-flash-0731 | PASS | 23.4s | 2504 | 918 | 5120 | 0 | 5 |  |
| add-feature | `e93464a71b8a` | tiny-rs | deepseek/deepseek-v4-flash-0731 | PASS | 15.9s | 1834 | 599 | 4096 | 0 | 3 |  |
| async-cache | `db7ca3acc745` | tiny-ts | deepseek/deepseek-v4-flash-0731 | PASS | 21.9s | 3057 | 895 | 9216 | 0 | 7 |  |
| async-cache | `db7ca3acc745` | tiny-go | deepseek/deepseek-v4-flash-0731 | PASS | 65.4s | 5951 | 2770 | 37632 | 0 | 15 |  |
| async-cache | `db7ca3acc745` | tiny-py | deepseek/deepseek-v4-flash-0731 | PASS | 56.8s | 3052 | 2402 | 9728 | 0 | 6 |  |
| async-cache | `db7ca3acc745` | tiny-rs | deepseek/deepseek-v4-flash-0731 | PASS | 88.2s | 8725 | 4576 | 41984 | 0 | 12 |  |
| config-loader | `b11eefa2367a` | tiny-ts | deepseek/deepseek-v4-flash-0731 | PASS | 36.3s | 3747 | 2012 | 10496 | 0 | 5 |  |
| config-loader | `b11eefa2367a` | tiny-go | deepseek/deepseek-v4-flash-0731 | PASS | 33.5s | 3957 | 1469 | 18432 | 0 | 9 |  |
| config-loader | `b11eefa2367a` | tiny-py | deepseek/deepseek-v4-flash-0731 | PASS | 25.5s | 2568 | 1163 | 6144 | 0 | 5 |  |
| config-loader | `b11eefa2367a` | tiny-rs | deepseek/deepseek-v4-flash-0731 | PASS | 48.4s | 7130 | 2053 | 22272 | 0 | 10 |  |
| fix-bug | `14237efa45fb` | tiny-ts | deepseek/deepseek-v4-flash-0731 | PASS | 27.3s | 4638 | 537 | 5120 | 0 | 5 |  |
| fix-bug | `14237efa45fb` | tiny-go | deepseek/deepseek-v4-flash-0731 | PASS | 29.1s | 2379 | 864 | 5888 | 0 | 6 |  |
| fix-bug | `14237efa45fb` | tiny-py | deepseek/deepseek-v4-flash-0731 | PASS | 19.2s | 2141 | 787 | 4352 | 0 | 5 |  |
| fix-bug | `14237efa45fb` | tiny-rs | deepseek/deepseek-v4-flash-0731 | PASS | 19.0s | 3528 | 716 | 5120 | 0 | 5 |  |
| follow-instructions | `ee47fd37cb69` | tiny-ts | deepseek/deepseek-v4-flash-0731 | PASS | 14.0s | 5303 | 716 | 6144 | 0 | 6 |  |
| follow-instructions | `ee47fd37cb69` | tiny-go | deepseek/deepseek-v4-flash-0731 | PASS | 17.7s | 1861 | 649 | 5632 | 0 | 5 |  |
| follow-instructions | `ee47fd37cb69` | tiny-py | deepseek/deepseek-v4-flash-0731 | PASS | 10.1s | 1427 | 572 | 3840 | 0 | 4 |  |
| follow-instructions | `ee47fd37cb69` | tiny-rs | deepseek/deepseek-v4-flash-0731 | PASS | 13.0s | 2150 | 605 | 6912 | 0 | 6 |  |
| session-summary | `71a3943910cd` | tiny-ts | deepseek/deepseek-v4-flash-0731 | PASS | 34.9s | 5486 | 1349 | 8960 | 0 | 8 |  |
| session-summary | `71a3943910cd` | tiny-go | deepseek/deepseek-v4-flash-0731 | PASS | 26.9s | 6049 | 819 | 1280 | 0 | 5 |  |
| session-summary | `71a3943910cd` | tiny-py | deepseek/deepseek-v4-flash-0731 | PASS | 25.2s | 3183 | 784 | 4096 | 0 | 6 |  |
| session-summary | `71a3943910cd` | tiny-rs | deepseek/deepseek-v4-flash-0731 | PASS | 49.2s | 3618 | 1121 | 9216 | 0 | 5 |  |

## 2026-08-24T19:46:51.628Z

Commit: `6d43341ee0f9` · Platform: `darwin-arm64` · Node: `v24.14.1`

### Summary

| Agent | Model | Passed | Pass rate | Median time | Median tokens | Median tools |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| tiny-ts | deepseek/deepseek-v4-flash-0731 | 5/6 | 83.3% | 34.1s | 7275 | 7 |
| tiny-go | deepseek/deepseek-v4-flash-0731 | 6/6 | 100.0% | 22.9s | 4498 | 7.5 |
| tiny-py | deepseek/deepseek-v4-flash-0731 | 5/6 | 83.3% | 23.5s | 3470 | 6 |
| tiny-rs | deepseek/deepseek-v4-flash-0731 | 4/6 | 66.7% | 22.2s | 3798 | 6 |

### Tasks

| Task | Spec | Agent | Model | Result | Time | Input | Output | Cache read | Cache write | Tools | Detail |
| --- | --- | --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| add-feature | `433103f49f27` | tiny-ts | deepseek/deepseek-v4-flash-0731 | PASS | 38.7s | 4792 | 1358 | 8448 | 0 | 7 |  |
| add-feature | `433103f49f27` | tiny-go | deepseek/deepseek-v4-flash-0731 | PASS | 18.0s | 2419 | 858 | 6912 | 0 | 7 |  |
| add-feature | `433103f49f27` | tiny-py | deepseek/deepseek-v4-flash-0731 | PASS | 25.0s | 2465 | 1092 | 6912 | 0 | 7 |  |
| add-feature | `433103f49f27` | tiny-rs | deepseek/deepseek-v4-flash-0731 | FAIL | 21.6s | 2630 | 936 | 7936 | 0 | 5 | node:internal/modules/run_main:107     triggerUncaughtException(     ^  AssertionError [ERR_ASSERTION]: Values have same structure but are not reference-equal:  {   completed: false,   id: 'a',   title: 'Alpha' }      at file:///Users/geminixiang/github/tiny-agent/eval/tasks/add-feature/verify.mjs:18:8 {   generatedMessage: true,   code: 'ERR_ASSERTION',   actual: { id: 'a', title: 'Alpha', completed: false },   expected: { id: 'a', title: 'Alpha', completed: false },   operator: 'strictEqual',   diff: 'simple' }  Node.js v24.14.1 |
| async-cache | `e8a6ec21d892` | tiny-ts | deepseek/deepseek-v4-flash-0731 | FAIL | 120.0s | 5674 | 5489 | 24832 | 0 | 11 | agent timeout |
| async-cache | `e8a6ec21d892` | tiny-go | deepseek/deepseek-v4-flash-0731 | PASS | 42.5s | 3795 | 2112 | 12288 | 0 | 8 |  |
| async-cache | `e8a6ec21d892` | tiny-py | deepseek/deepseek-v4-flash-0731 | FAIL | 31.5s | 2452 | 1213 | 7936 | 0 | 8 | node:internal/modules/run_main:107     triggerUncaughtException(     ^  AssertionError [ERR_ASSERTION]: Expected values to be strictly equal: + actual - expected  + undefined - 'value:same:1'      at file:///Users/geminixiang/github/tiny-agent/eval/tasks/async-cache/verify.mjs:25:8 {   generatedMessage: true,   code: 'ERR_ASSERTION',   actual: undefined,   expected: 'value:same:1',   operator: 'strictEqual',   diff: 'simple' }  Node.js v24.14.1 |
| async-cache | `e8a6ec21d892` | tiny-rs | deepseek/deepseek-v4-flash-0731 | PASS | 51.0s | 3168 | 1879 | 10240 | 0 | 6 |  |
| config-loader | `abc0206f5793` | tiny-ts | deepseek/deepseek-v4-flash-0731 | PASS | 47.3s | 7974 | 2096 | 18176 | 0 | 7 |  |
| config-loader | `abc0206f5793` | tiny-go | deepseek/deepseek-v4-flash-0731 | PASS | 21.6s | 2793 | 1054 | 5888 | 0 | 4 |  |
| config-loader | `abc0206f5793` | tiny-py | deepseek/deepseek-v4-flash-0731 | PASS | 39.2s | 3172 | 2182 | 9984 | 0 | 9 |  |
| config-loader | `abc0206f5793` | tiny-rs | deepseek/deepseek-v4-flash-0731 | FAIL | 59.7s | 10842 | 3122 | 21760 | 0 | 11 | node:internal/modules/run_main:107     triggerUncaughtException(     ^  AssertionError [ERR_ASSERTION]: Missing expected rejection.     at async file:///Users/geminixiang/github/tiny-agent/eval/tasks/config-loader/verify.mjs:36:1 {   generatedMessage: false,   code: 'ERR_ASSERTION',   actual: undefined,   expected: /features/i,   operator: 'rejects',   diff: 'simple' }  Node.js v24.14.1 |
| fix-bug | `14237efa45fb` | tiny-ts | deepseek/deepseek-v4-flash-0731 | PASS | 18.9s | 3764 | 600 | 4352 | 0 | 6 |  |
| fix-bug | `14237efa45fb` | tiny-go | deepseek/deepseek-v4-flash-0731 | PASS | 23.0s | 3966 | 1183 | 12544 | 0 | 8 |  |
| fix-bug | `14237efa45fb` | tiny-py | deepseek/deepseek-v4-flash-0731 | PASS | 18.7s | 2414 | 857 | 4096 | 0 | 5 |  |
| fix-bug | `14237efa45fb` | tiny-rs | deepseek/deepseek-v4-flash-0731 | PASS | 16.2s | 3369 | 660 | 8192 | 0 | 6 |  |
| follow-instructions | `ee47fd37cb69` | tiny-ts | deepseek/deepseek-v4-flash-0731 | PASS | 15.3s | 2623 | 662 | 6656 | 0 | 5 |  |
| follow-instructions | `ee47fd37cb69` | tiny-go | deepseek/deepseek-v4-flash-0731 | PASS | 22.8s | 2382 | 881 | 6656 | 0 | 7 |  |
| follow-instructions | `ee47fd37cb69` | tiny-py | deepseek/deepseek-v4-flash-0731 | PASS | 17.0s | 2036 | 699 | 4608 | 0 | 5 |  |
| follow-instructions | `ee47fd37cb69` | tiny-rs | deepseek/deepseek-v4-flash-0731 | PASS | 22.9s | 2551 | 662 | 6656 | 0 | 5 |  |
| session-summary | `71a3943910cd` | tiny-ts | deepseek/deepseek-v4-flash-0731 | PASS | 29.4s | 6880 | 1520 | 5888 | 0 | 7 |  |
| session-summary | `71a3943910cd` | tiny-go | deepseek/deepseek-v4-flash-0731 | PASS | 34.7s | 4145 | 1304 | 10752 | 0 | 10 |  |
| session-summary | `71a3943910cd` | tiny-py | deepseek/deepseek-v4-flash-0731 | PASS | 22.0s | 2498 | 884 | 4864 | 0 | 4 |  |
| session-summary | `71a3943910cd` | tiny-rs | deepseek/deepseek-v4-flash-0731 | PASS | 18.0s | 2763 | 771 | 6912 | 0 | 6 |  |

## 2026-08-24T19:31:32.854Z

Commit: `186337fa1963` · Platform: `darwin-arm64` · Node: `v24.14.1`

### Summary

| Agent | Model | Passed | Pass rate | Median time | Median tokens | Median tools |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| tiny-ts | deepseek/deepseek-v4-flash-0731 | 6/6 | 100.0% | 23.6s | 3789 | 6 |
| tiny-go | deepseek/deepseek-v4-flash-0731 | 6/6 | 100.0% | 19.3s | 3571 | 5.5 |
| tiny-py | deepseek/deepseek-v4-flash-0731 | 5/6 | 83.3% | 23.0s | 3126 | 5 |
| tiny-rs | deepseek/deepseek-v4-flash-0731 | 6/6 | 100.0% | 17.2s | 3528 | 5 |

### Tasks

| Task | Spec | Agent | Model | Result | Time | Input | Output | Cache read | Cache write | Tools | Detail |
| --- | --- | --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| add-feature | `433103f49f27` | tiny-ts | deepseek/deepseek-v4-flash-0731 | PASS | 18.9s | 2709 | 893 | 10240 | 0 | 7 |  |
| add-feature | `433103f49f27` | tiny-go | deepseek/deepseek-v4-flash-0731 | PASS | 17.8s | 1815 | 771 | 5888 | 0 | 6 |  |
| add-feature | `433103f49f27` | tiny-py | deepseek/deepseek-v4-flash-0731 | PASS | 24.6s | 1888 | 1003 | 6144 | 0 | 6 |  |
| add-feature | `433103f49f27` | tiny-rs | deepseek/deepseek-v4-flash-0731 | PASS | 10.4s | 1951 | 517 | 4352 | 0 | 4 |  |
| async-cache | `e8a6ec21d892` | tiny-ts | deepseek/deepseek-v4-flash-0731 | PASS | 114.8s | 7885 | 5460 | 33280 | 0 | 12 |  |
| async-cache | `e8a6ec21d892` | tiny-go | deepseek/deepseek-v4-flash-0731 | PASS | 31.8s | 4398 | 1244 | 11776 | 0 | 6 |  |
| async-cache | `e8a6ec21d892` | tiny-py | deepseek/deepseek-v4-flash-0731 | FAIL | 24.6s | 5533 | 759 | 768 | 0 | 4 | node:internal/modules/run_main:107     triggerUncaughtException(     ^  AssertionError [ERR_ASSERTION]: Expected values to be strictly equal: + actual - expected  + undefined - 'value:same:1'      at file:///private/tmp/tiny-agent-eval-robust/eval/tasks/async-cache/verify.mjs:25:8 {   generatedMessage: true,   code: 'ERR_ASSERTION',   actual: undefined,   expected: 'value:same:1',   operator: 'strictEqual',   diff: 'simple' }  Node.js v24.14.1 |
| async-cache | `e8a6ec21d892` | tiny-rs | deepseek/deepseek-v4-flash-0731 | PASS | 37.1s | 3223 | 1817 | 13568 | 0 | 9 |  |
| config-loader | `abc0206f5793` | tiny-ts | deepseek/deepseek-v4-flash-0731 | PASS | 29.6s | 4756 | 1638 | 17920 | 0 | 8 |  |
| config-loader | `abc0206f5793` | tiny-go | deepseek/deepseek-v4-flash-0731 | PASS | 20.3s | 2693 | 1037 | 5888 | 0 | 4 |  |
| config-loader | `abc0206f5793` | tiny-py | deepseek/deepseek-v4-flash-0731 | PASS | 21.5s | 2890 | 984 | 5888 | 0 | 5 |  |
| config-loader | `abc0206f5793` | tiny-rs | deepseek/deepseek-v4-flash-0731 | PASS | 22.4s | 3248 | 1144 | 7680 | 0 | 5 |  |
| fix-bug | `14237efa45fb` | tiny-ts | deepseek/deepseek-v4-flash-0731 | PASS | 10.4s | 2211 | 543 | 5120 | 0 | 5 |  |
| fix-bug | `14237efa45fb` | tiny-go | deepseek/deepseek-v4-flash-0731 | PASS | 20.8s | 2345 | 718 | 4352 | 0 | 5 |  |
| fix-bug | `14237efa45fb` | tiny-py | deepseek/deepseek-v4-flash-0731 | PASS | 27.0s | 2192 | 819 | 4864 | 0 | 5 |  |
| fix-bug | `14237efa45fb` | tiny-rs | deepseek/deepseek-v4-flash-0731 | PASS | 14.9s | 2130 | 496 | 5120 | 0 | 5 |  |
| follow-instructions | `ee47fd37cb69` | tiny-ts | deepseek/deepseek-v4-flash-0731 | PASS | 15.8s | 2176 | 650 | 5888 | 0 | 5 |  |
| follow-instructions | `ee47fd37cb69` | tiny-go | deepseek/deepseek-v4-flash-0731 | PASS | 18.2s | 2690 | 721 | 3584 | 0 | 6 |  |
| follow-instructions | `ee47fd37cb69` | tiny-py | deepseek/deepseek-v4-flash-0731 | PASS | 14.4s | 1863 | 605 | 4352 | 0 | 4 |  |
| follow-instructions | `ee47fd37cb69` | tiny-rs | deepseek/deepseek-v4-flash-0731 | PASS | 8.9s | 2278 | 385 | 4096 | 0 | 5 |  |
| session-summary | `71a3943910cd` | tiny-ts | deepseek/deepseek-v4-flash-0731 | PASS | 28.2s | 3062 | 914 | 6912 | 0 | 4 |  |
| session-summary | `71a3943910cd` | tiny-go | deepseek/deepseek-v4-flash-0731 | PASS | 18.2s | 2846 | 1081 | 5632 | 0 | 5 |  |
| session-summary | `71a3943910cd` | tiny-py | deepseek/deepseek-v4-flash-0731 | PASS | 21.4s | 2185 | 1056 | 7680 | 0 | 7 |  |
| session-summary | `71a3943910cd` | tiny-rs | deepseek/deepseek-v4-flash-0731 | PASS | 19.5s | 3650 | 996 | 8704 | 0 | 5 |  |

## 2026-08-24T19:19:48.867Z

Commit: `4a71bcf6df31` · Platform: `darwin-arm64` · Node: `v24.14.1`

### Summary

| Agent | Model | Passed | Pass rate | Median time | Median tokens | Median tools |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| tiny-ts | deepseek/deepseek-v4-flash-0731 | 5/6 | 83.3% | 22.5s | 4590 | 6 |
| tiny-go | deepseek/deepseek-v4-flash-0731 | 6/6 | 100.0% | 22.0s | 3693 | 6 |
| tiny-py | deepseek/deepseek-v4-flash-0731 | 5/6 | 83.3% | 19.2s | 3498 | 5.5 |
| tiny-rs | deepseek/deepseek-v4-flash-0731 | 5/6 | 83.3% | 19.1s | 4480 | 6 |

### Tasks

| Task | Spec | Agent | Model | Result | Time | Input | Output | Cache read | Cache write | Tools | Detail |
| --- | --- | --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| add-feature | `433103f49f27` | tiny-ts | deepseek/deepseek-v4-flash-0731 | PASS | 19.4s | 3307 | 1039 | 9216 | 0 | 6 |  |
| add-feature | `433103f49f27` | tiny-go | deepseek/deepseek-v4-flash-0731 | PASS | 38.9s | 2769 | 1071 | 5888 | 0 | 6 |  |
| add-feature | `433103f49f27` | tiny-py | deepseek/deepseek-v4-flash-0731 | PASS | 16.6s | 1829 | 741 | 3328 | 0 | 4 |  |
| add-feature | `433103f49f27` | tiny-rs | deepseek/deepseek-v4-flash-0731 | PASS | 21.3s | 4207 | 1193 | 9728 | 0 | 7 |  |
| async-cache | `e8a6ec21d892` | tiny-ts | deepseek/deepseek-v4-flash-0731 | FAIL | 66.7s | 3101 | 3410 | 9472 | 0 | 7 | node:internal/modules/run_main:107     triggerUncaughtException(     ^  AssertionError [ERR_ASSERTION]: Expected values to be strictly equal: + actual - expected  + undefined - 'value:same:1'      at file:///private/tmp/tiny-agent-eval-prompt/eval/tasks/async-cache/verify.mjs:25:8 {   generatedMessage: true,   code: 'ERR_ASSERTION',   actual: undefined,   expected: 'value:same:1',   operator: 'strictEqual',   diff: 'simple' }  Node.js v24.14.1 |
| async-cache | `e8a6ec21d892` | tiny-go | deepseek/deepseek-v4-flash-0731 | PASS | 34.1s | 2795 | 1826 | 5376 | 0 | 6 |  |
| async-cache | `e8a6ec21d892` | tiny-py | deepseek/deepseek-v4-flash-0731 | PASS | 61.2s | 4732 | 3091 | 24832 | 0 | 12 |  |
| async-cache | `e8a6ec21d892` | tiny-rs | deepseek/deepseek-v4-flash-0731 | FAIL | 33.6s | 5636 | 1110 | 5888 | 0 | 6 | node:internal/modules/run_main:107     triggerUncaughtException(     ^  AssertionError [ERR_ASSERTION]: Expected values to be strictly equal: + actual - expected  + undefined - 'value:same:1'      at file:///private/tmp/tiny-agent-eval-prompt/eval/tasks/async-cache/verify.mjs:25:8 {   generatedMessage: true,   code: 'ERR_ASSERTION',   actual: undefined,   expected: 'value:same:1',   operator: 'strictEqual',   diff: 'simple' }  Node.js v24.14.1 |
| config-loader | `abc0206f5793` | tiny-ts | deepseek/deepseek-v4-flash-0731 | PASS | 22.2s | 3467 | 1269 | 8960 | 0 | 5 |  |
| config-loader | `abc0206f5793` | tiny-go | deepseek/deepseek-v4-flash-0731 | PASS | 21.3s | 2428 | 1117 | 5632 | 0 | 4 |  |
| config-loader | `abc0206f5793` | tiny-py | deepseek/deepseek-v4-flash-0731 | FAIL | 14.0s | 2903 | 892 | 5632 | 0 | 6 | file:///private/var/folders/k9/v53bw9ds11ndmj3xt69knvn40000gn/T/tiny-eval-config-loader-tiny-py-s05pmT/src/config.js:18     throw new Error(`${field}: ${message}`);           ^  Error: port: must be an integer between 1 and 65535, got "4321"     at fail (file:///private/var/folders/k9/v53bw9ds11ndmj3xt69knvn40000gn/T/tiny-eval-config-loader-tiny-py-s05pmT/src/config.js:18:11)     at loadConfig (file:///private/var/folders/k9/v53bw9ds11ndmj3xt69knvn40000gn/T/tiny-eval-config-loader-tiny-py-s05pmT/src/config.js:34:9)     at async file:///private/tmp/tiny-agent-eval-prompt/eval/tasks/config-loader/verify.mjs:17:16  Node.js v24.14.1 |
| config-loader | `abc0206f5793` | tiny-rs | deepseek/deepseek-v4-flash-0731 | PASS | 17.4s | 3009 | 1248 | 6656 | 0 | 6 |  |
| fix-bug | `14237efa45fb` | tiny-ts | deepseek/deepseek-v4-flash-0731 | PASS | 22.8s | 3560 | 884 | 5888 | 0 | 6 |  |
| fix-bug | `14237efa45fb` | tiny-go | deepseek/deepseek-v4-flash-0731 | PASS | 18.9s | 1575 | 832 | 5120 | 0 | 6 |  |
| fix-bug | `14237efa45fb` | tiny-py | deepseek/deepseek-v4-flash-0731 | PASS | 21.5s | 2410 | 791 | 5120 | 0 | 5 |  |
| fix-bug | `14237efa45fb` | tiny-rs | deepseek/deepseek-v4-flash-0731 | PASS | 18.0s | 3379 | 650 | 4608 | 0 | 5 |  |
| follow-instructions | `ee47fd37cb69` | tiny-ts | deepseek/deepseek-v4-flash-0731 | PASS | 16.1s | 1802 | 526 | 4096 | 0 | 4 |  |
| follow-instructions | `ee47fd37cb69` | tiny-go | deepseek/deepseek-v4-flash-0731 | PASS | 12.2s | 1306 | 589 | 4096 | 0 | 4 |  |
| follow-instructions | `ee47fd37cb69` | tiny-py | deepseek/deepseek-v4-flash-0731 | PASS | 16.9s | 1788 | 724 | 4864 | 0 | 5 |  |
| follow-instructions | `ee47fd37cb69` | tiny-rs | deepseek/deepseek-v4-flash-0731 | PASS | 13.0s | 2377 | 715 | 6400 | 0 | 5 |  |
| session-summary | `71a3943910cd` | tiny-ts | deepseek/deepseek-v4-flash-0731 | PASS | 25.7s | 4106 | 1554 | 16640 | 0 | 10 |  |
| session-summary | `71a3943910cd` | tiny-go | deepseek/deepseek-v4-flash-0731 | PASS | 22.7s | 4439 | 1213 | 6912 | 0 | 8 |  |
| session-summary | `71a3943910cd` | tiny-py | deepseek/deepseek-v4-flash-0731 | PASS | 24.2s | 5332 | 1252 | 7424 | 0 | 7 |  |
| session-summary | `71a3943910cd` | tiny-rs | deepseek/deepseek-v4-flash-0731 | PASS | 20.2s | 3456 | 1247 | 11520 | 0 | 7 |  |

## 2026-08-24T18:48:02.159Z

Commit: `36306c4cde10` · Platform: `darwin-arm64` · Node: `v24.14.1`

### Summary

| Agent | Model | Passed | Pass rate | Median time | Median tokens | Median tools |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| tiny-ts | deepseek/deepseek-v4-flash-0731 | 6/6 | 100.0% | 23.4s | 4151 | 7 |
| tiny-go | deepseek/deepseek-v4-flash-0731 | 6/6 | 100.0% | 19.0s | 3402 | 6 |
| tiny-py | deepseek/deepseek-v4-flash-0731 | 6/6 | 100.0% | 22.1s | 3308 | 5 |
| tiny-rs | deepseek/deepseek-v4-flash-0731 | 6/6 | 100.0% | 24.9s | 4362 | 6 |

### Tasks

| Task | Spec | Agent | Model | Result | Time | Input | Output | Cache read | Cache write | Tools | Detail |
| --- | --- | --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| add-feature | `433103f49f27` | tiny-ts | deepseek/deepseek-v4-flash-0731 | PASS | 20.0s | 2187 | 540 | 6656 | 0 | 5 |  |
| add-feature | `433103f49f27` | tiny-go | deepseek/deepseek-v4-flash-0731 | PASS | 10.3s | 1212 | 460 | 2560 | 0 | 4 |  |
| add-feature | `433103f49f27` | tiny-py | deepseek/deepseek-v4-flash-0731 | PASS | 24.7s | 1831 | 1014 | 4864 | 0 | 6 |  |
| add-feature | `433103f49f27` | tiny-rs | deepseek/deepseek-v4-flash-0731 | PASS | 43.0s | 7188 | 1801 | 12544 | 0 | 8 |  |
| async-cache | `e8a6ec21d892` | tiny-ts | deepseek/deepseek-v4-flash-0731 | PASS | 99.4s | 7308 | 5547 | 40192 | 0 | 18 |  |
| async-cache | `e8a6ec21d892` | tiny-go | deepseek/deepseek-v4-flash-0731 | PASS | 68.2s | 3149 | 2692 | 8192 | 0 | 7 |  |
| async-cache | `e8a6ec21d892` | tiny-py | deepseek/deepseek-v4-flash-0731 | PASS | 26.5s | 3525 | 1433 | 6144 | 0 | 5 |  |
| async-cache | `e8a6ec21d892` | tiny-rs | deepseek/deepseek-v4-flash-0731 | PASS | 27.8s | 2584 | 761 | 5632 | 0 | 5 |  |
| config-loader | `abc0206f5793` | tiny-ts | deepseek/deepseek-v4-flash-0731 | PASS | 44.9s | 10832 | 2215 | 26368 | 0 | 9 |  |
| config-loader | `abc0206f5793` | tiny-go | deepseek/deepseek-v4-flash-0731 | PASS | 26.1s | 3047 | 1380 | 7936 | 0 | 5 |  |
| config-loader | `abc0206f5793` | tiny-py | deepseek/deepseek-v4-flash-0731 | PASS | 25.3s | 2881 | 1173 | 6656 | 0 | 5 |  |
| config-loader | `abc0206f5793` | tiny-rs | deepseek/deepseek-v4-flash-0731 | PASS | 22.1s | 3988 | 1391 | 11520 | 0 | 6 |  |
| fix-bug | `14237efa45fb` | tiny-ts | deepseek/deepseek-v4-flash-0731 | PASS | 17.6s | 2448 | 828 | 7424 | 0 | 6 |  |
| fix-bug | `14237efa45fb` | tiny-go | deepseek/deepseek-v4-flash-0731 | PASS | 14.7s | 1987 | 608 | 4096 | 0 | 6 |  |
| fix-bug | `14237efa45fb` | tiny-py | deepseek/deepseek-v4-flash-0731 | PASS | 19.5s | 2169 | 822 | 5632 | 0 | 5 |  |
| fix-bug | `14237efa45fb` | tiny-rs | deepseek/deepseek-v4-flash-0731 | PASS | 15.4s | 2190 | 603 | 5632 | 0 | 6 |  |
| follow-instructions | `ee47fd37cb69` | tiny-ts | deepseek/deepseek-v4-flash-0731 | PASS | 13.6s | 2352 | 755 | 5888 | 0 | 5 |  |
| follow-instructions | `ee47fd37cb69` | tiny-go | deepseek/deepseek-v4-flash-0731 | PASS | 18.3s | 2254 | 793 | 5120 | 0 | 6 |  |
| follow-instructions | `ee47fd37cb69` | tiny-py | deepseek/deepseek-v4-flash-0731 | PASS | 13.9s | 2163 | 629 | 3840 | 0 | 5 |  |
| follow-instructions | `ee47fd37cb69` | tiny-rs | deepseek/deepseek-v4-flash-0731 | PASS | 11.0s | 2206 | 573 | 5376 | 0 | 4 |  |
| session-summary | `71a3943910cd` | tiny-ts | deepseek/deepseek-v4-flash-0731 | PASS | 26.9s | 3341 | 1685 | 11264 | 0 | 8 |  |
| session-summary | `71a3943910cd` | tiny-go | deepseek/deepseek-v4-flash-0731 | PASS | 19.6s | 2684 | 1073 | 7168 | 0 | 6 |  |
| session-summary | `71a3943910cd` | tiny-py | deepseek/deepseek-v4-flash-0731 | PASS | 16.7s | 2581 | 1044 | 5632 | 0 | 5 |  |
| session-summary | `71a3943910cd` | tiny-rs | deepseek/deepseek-v4-flash-0731 | PASS | 45.4s | 4707 | 2445 | 20224 | 0 | 10 |  |

## 2026-08-24T18:21:57.200Z

Commit: `3d9640753e9b` · Platform: `darwin-arm64` · Node: `v24.14.1`

### Summary

| Agent | Model | Passed | Pass rate | Median time | Median tokens | Median tools |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| tiny-ts | deepseek/deepseek-v4-flash-0731 | 4/6 | 66.7% | 28.9s | 4349 | 6.5 |
| tiny-go | deepseek/deepseek-v4-flash-0731 | 6/6 | 100.0% | 15.5s | 3632 | 5.5 |
| tiny-py | deepseek/deepseek-v4-flash-0731 | 6/6 | 100.0% | 22.7s | 3521 | 6 |
| tiny-rs | deepseek/deepseek-v4-flash-0731 | 5/6 | 83.3% | 18.8s | 3307 | 5 |

### Tasks

| Task | Spec | Agent | Model | Result | Time | Input | Output | Cache read | Cache write | Tools | Detail |
| --- | --- | --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| add-feature | `0f8d6aacf51b` | tiny-ts | deepseek/deepseek-v4-flash-0731 | FAIL | 61.0s | 5088 | 2191 | 27136 | 0 | 10 | ✔ returns only active tasks (0.495042ms) ✔ completeTask marks task completed without mutation (0.09ms) ✔ completeTask throws on unknown id (0.139375ms) ℹ tests 3 ℹ suites 0 ℹ pass 3 ℹ fail 0 ℹ cancelled 0 ℹ skipped 0 ℹ todo 0 ℹ duration_ms 34.54725 diff --git a/test/tasks.test.js b/test/tasks.test.js index 81c7616..590ed19 100644 --- a/test/tasks.test.js +++ b/test/tasks.test.js @@ -1,6 +1,6 @@  import test from "node:test";  import assert from "node:assert/strict"; -import { activeTasks } from "../src/tasks.js"; +import { activeTasks, completeTask } from "../src/tasks.js";    test("returns only active tasks", () => {      const tasks = [ @@ -9,3 +9,21 @@ test("returns only active tasks", () => {      ];      assert.deepEqual(activeTasks(tasks), [tasks[0]]);  }); + +test("completeTask marks task completed without mutation", () => { +    const tasks = [ +        { id: "a", title: "Alpha", completed: false }, +        { id: "b", title: "Beta", completed: false }, +    ]; +    const original = tasks.map((t) => ({ ...t })); +    const result = completeTask(tasks, "a"); +    assert.equal(result[0].completed, true); +    assert.deepEqual(tasks, original); +    assert.equal(result[1], tasks[1]); +    assert.notEqual(result[0], original[0]); +}); + +test("completeTask throws on unknown id", () => { +    const tasks = [{ id: "a", title: "Alpha", completed: false }]; +    assert.throws(() => completeTask(tasks, "zzz"), /Unknown task: zzz/); +}); |
| add-feature | `0f8d6aacf51b` | tiny-go | deepseek/deepseek-v4-flash-0731 | PASS | 6.9s | 6736 | 706 | 1024 | 0 | 5 |  |
| add-feature | `0f8d6aacf51b` | tiny-py | deepseek/deepseek-v4-flash-0731 | PASS | 24.2s | 5507 | 1181 | 4864 | 0 | 7 |  |
| add-feature | `0f8d6aacf51b` | tiny-rs | deepseek/deepseek-v4-flash-0731 | PASS | 20.7s | 1778 | 760 | 7936 | 0 | 6 |  |
| async-cache | `e8a6ec21d892` | tiny-ts | deepseek/deepseek-v4-flash-0731 | PASS | 27.9s | 3115 | 1186 | 8704 | 0 | 7 |  |
| async-cache | `e8a6ec21d892` | tiny-go | deepseek/deepseek-v4-flash-0731 | PASS | 13.2s | 10825 | 2017 | 5376 | 0 | 8 |  |
| async-cache | `e8a6ec21d892` | tiny-py | deepseek/deepseek-v4-flash-0731 | PASS | 48.8s | 8364 | 1791 | 16896 | 0 | 13 |  |
| async-cache | `e8a6ec21d892` | tiny-rs | deepseek/deepseek-v4-flash-0731 | PASS | 53.6s | 4618 | 2216 | 20480 | 0 | 9 |  |
| config-loader | `abc0206f5793` | tiny-ts | deepseek/deepseek-v4-flash-0731 | PASS | 51.1s | 8854 | 2233 | 11264 | 0 | 6 |  |
| config-loader | `abc0206f5793` | tiny-go | deepseek/deepseek-v4-flash-0731 | PASS | 22.6s | 2176 | 1220 | 5376 | 0 | 6 |  |
| config-loader | `abc0206f5793` | tiny-py | deepseek/deepseek-v4-flash-0731 | PASS | 16.7s | 2605 | 936 | 5120 | 0 | 5 |  |
| config-loader | `abc0206f5793` | tiny-rs | deepseek/deepseek-v4-flash-0731 | PASS | 13.9s | 3110 | 830 | 6656 | 0 | 4 |  |
| fix-bug | `14237efa45fb` | tiny-ts | deepseek/deepseek-v4-flash-0731 | PASS | 22.9s | 2322 | 819 | 7168 | 0 | 5 |  |
| fix-bug | `14237efa45fb` | tiny-go | deepseek/deepseek-v4-flash-0731 | PASS | 16.5s | 1978 | 897 | 4352 | 0 | 5 |  |
| fix-bug | `14237efa45fb` | tiny-py | deepseek/deepseek-v4-flash-0731 | PASS | 15.0s | 1852 | 641 | 3584 | 0 | 5 |  |
| fix-bug | `14237efa45fb` | tiny-rs | deepseek/deepseek-v4-flash-0731 | PASS | 17.0s | 2383 | 724 | 5632 | 0 | 5 |  |
| follow-instructions | `ee47fd37cb69` | tiny-ts | deepseek/deepseek-v4-flash-0731 | PASS | 22.1s | 3666 | 672 | 4864 | 0 | 4 |  |
| follow-instructions | `ee47fd37cb69` | tiny-go | deepseek/deepseek-v4-flash-0731 | PASS | 18.5s | 2034 | 881 | 6912 | 0 | 8 |  |
| follow-instructions | `ee47fd37cb69` | tiny-py | deepseek/deepseek-v4-flash-0731 | PASS | 21.1s | 2920 | 563 | 2304 | 0 | 4 |  |
| follow-instructions | `ee47fd37cb69` | tiny-rs | deepseek/deepseek-v4-flash-0731 | PASS | 13.6s | 1920 | 505 | 3840 | 0 | 3 |  |
| session-summary | `9921736b1f76` | tiny-ts | deepseek/deepseek-v4-flash-0731 | FAIL | 30.0s | 3305 | 1054 | 12032 | 0 | 8 | node:internal/modules/run_main:107     triggerUncaughtException(     ^  AssertionError [ERR_ASSERTION]: Expected values to be strictly deep-equal: + actual - expected    {     byType: {       message: 1,       started: 1,       tool: 3     },     durationMs: 160, +   lastError: { +     at: 250, +     error: 'second failure', +     ok: false, +     type: 'tool' +   }, -   lastError: 'second failure',     toolFailures: 2,     total: 5   }      at file:///Users/geminixiang/github/tiny-agent/eval/tasks/session-summary/verify.mjs:25:8 {   generatedMessage: true,   code: 'ERR_ASSERTION',   actual: {     total: 5,     byType: { started: 1, tool: 3, message: 1 },     durationMs: 160,     toolFailures: 2,     lastError: { type: 'tool', at: 250, ok: false, error: 'second failure' }   },   expected: {     total: 5,     byType: { started: 1, tool: 3, message: 1 },     durationMs: 160,     toolFailures: 2,     lastError: 'second failure'   },   operator: 'deepStrictEqual',   diff: 'simple' }  Node.js v24.14.1 |
| session-summary | `9921736b1f76` | tiny-go | deepseek/deepseek-v4-flash-0731 | PASS | 14.5s | 2902 | 965 | 7168 | 0 | 5 |  |
| session-summary | `9921736b1f76` | tiny-py | deepseek/deepseek-v4-flash-0731 | PASS | 24.2s | 2389 | 1111 | 7680 | 0 | 7 |  |
| session-summary | `9921736b1f76` | tiny-rs | deepseek/deepseek-v4-flash-0731 | FAIL | 25.4s | 2581 | 926 | 6656 | 0 | 5 | node:internal/modules/run_main:107     triggerUncaughtException(     ^  AssertionError [ERR_ASSERTION]: Expected values to be strictly deep-equal: + actual - expected    {     byType: {       message: 1,       started: 1,       tool: 3     },     durationMs: 160, +   lastError: { +     at: 250, +     error: 'second failure', +     ok: false, +     type: 'tool' +   }, -   lastError: 'second failure',     toolFailures: 2,     total: 5   }      at file:///Users/geminixiang/github/tiny-agent/eval/tasks/session-summary/verify.mjs:25:8 {   generatedMessage: true,   code: 'ERR_ASSERTION',   actual: {     total: 5,     byType: { started: 1, tool: 3, message: 1 },     durationMs: 160,     toolFailures: 2,     lastError: { type: 'tool', at: 250, ok: false, error: 'second failure' }   },   expected: {     total: 5,     byType: { started: 1, tool: 3, message: 1 },     durationMs: 160,     toolFailures: 2,     lastError: 'second failure'   },   operator: 'deepStrictEqual',   diff: 'simple' }  Node.js v24.14.1 |

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

