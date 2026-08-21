# Multi-tenant threat model

## Decision

tiny-agent may run jobs submitted by different customers. Treat every job prompt, repository, instruction file, skill, dependency, model response, tool argument, and program started by a tool as untrusted.

The tenant boundary is a dedicated execution capsule per job, controlled by trusted deployment code. A hardened container can be the baseline for lower-risk workloads, but it shares the host kernel. Hostile native code, highly sensitive cross-tenant data, privileged devices, nested containers, broad syscall needs, or a host that cannot be patched quickly require a microVM or VM.

Fence is optional defense in depth for semi-trusted commands. It is not a tenant boundary, resource limiter, or hostile-code containment mechanism.

This is a deployment decision. The four teaching implementations remain ordinary CLI programs centered on:

```text
model → tool calls → tool results → model
```

## Trust model

Trusted:

- The job controller and deployment configuration.
- Pinned tiny-agent binaries and runtime images.
- Server-owned model and capability gateways.
- Server-owned tenant state and audit storage.

Untrusted:

- Customer input, repositories, dependencies, and artifacts.
- Repository `AGENTS.md`, skills, Git configuration, hooks, filters, and submodules.
- Model output and all content returned by web, internal, or peer-agent tools.
- Every process inside the execution capsule.

A model or document never establishes identity or grants authority. Tenant, actor, job, scope, budget, approval, and expiry come only from trusted server context.

## Minimal reference architecture

The deployment has five required primitives. Do not split them into more modules until a concrete implementation needs it.

### 1. Trusted job controller

The controller authenticates the tenant, validates an idempotent submission, assigns a job and attempt identity, provisions the capsule, and owns the job state machine:

```text
queued → running → stopping → succeeded | failed | cancelled | timed_out
```

Only one attempt may be active for a `(tenant, idempotency key)` pair. Attempts use leases and monotonically increasing fencing generations so a stale worker cannot write a terminal result.

Unknown external side effects are not safe to retry. If an action may have succeeded before its result was recorded, mark it `uncertain` and reconcile through the responsible connector.

### 2. Per-job execution capsule

Each attempt receives its own:

- Canonical workspace, state, home, temp, and cache directories.
- User, mount, PID, IPC, UTS, network, and cgroup isolation.
- Read-only image and explicitly bounded writable storage.
- Minimal `/proc` and `/dev`, with host `/sys`, `/run`, runtime sockets, metadata, and privileged devices hidden.

The capsule runs without host root, drops all capabilities, sets `no_new_privs`, and uses an enforced seccomp and LSM policy. Missing required isolation features fail closed.

Do not share writable package, compiler, Git, or build caches across tenants. Use an independent clone or snapshot rather than a linked worktree whose Git metadata escapes the job directory.

A container reduces attack surface but retains the host kernel in the trusted computing base. Use a microVM or VM when the workload crosses the risk threshold defined in the Decision section.

### 3. Resource and kill supervisor

The runner owns a cgroup v2 subtree that job code cannot modify. It limits:

- CPU and wall-clock time.
- Memory, swap, and group OOM behavior.
- Process count.
- Writable bytes and inodes, including temp, overlay, cache, and logs.
- Captured output and exported artifacts.

Cancellation first prevents new privileged requests and revokes job credentials, then sends TERM, waits a fixed grace period, uses cgroup kill, and verifies the cgroup is empty before cleanup. A terminal job cannot leave descendants, mounts, volumes, listeners, or credentials behind.

### 4. Egress and capability gateway

The capsule has deny-by-default network access and can connect only to a trusted gateway. Long-lived model, cloud, database, search, and internal-service credentials never enter the capsule.

The gateway issues or accepts only short-lived capabilities scoped to tenant, job, operation, budget, and expiry. Allowed destinations remain exfiltration channels, so gateway policies constrain method, path, request schema, size, rate, and cost—not just domain names.

The gateway rejects direct IP destinations, loopback, private, link-local, multicast, metadata, and service-discovery ranges for IPv4 and IPv6. It resolves and pins destinations itself; every redirect is revalidated and cross-host, cross-scheme, and cross-port redirects are denied by default. Jobs do not receive raw sockets, UDP/QUIC egress, arbitrary HTTP, or unrestricted Unix sockets.

Future privileged tools use narrow interfaces:

- Public search accepts a query, not an arbitrary URL fetch.
- Internal lookup derives tenant and ACL from trusted job context, not model arguments.
- State-changing actions use typed schemas, server authorization, idempotency keys, and durable receipts.
- High-impact actions use an approval bound to the exact tenant, actor, parameters, expiry, and one-time nonce.

Search and peer-agent results are untrusted data with provenance; their text never becomes system policy or authorization.

### 5. Tenant state and audit store

Sessions, compaction summaries, tool output, logs, artifacts, receipts, crash data, caches, indexes, and backups are all tenant data.

The trusted store binds each record to tenant, job, attempt, and operation. It enforces single-writer session ownership, size limits, encryption, access control, retention, legal hold, and deletion. Append-only JSONL is a transcript format, not a compliance audit or proof of correctness.

Audit records use stable event metadata and hashed identifiers where possible; sensitive content is stored separately with narrower access. Production jobs disable core dumps. A trusted artifact exporter accepts only bounded regular files inside the workspace and rejects symlinks, hardlinks, devices, FIFOs, path traversal, and archive expansion attacks.

Model-provider retention, training, residency, backups, and derived copies must be covered by the tenant's data policy. Deletion includes cache, object versions, backups, search indexes, and provider copies or uses cryptographic erasure where appropriate.

## Supply-chain baseline

Production jobs start from a signed image pinned by digest. Build and runtime stages are separate, provenance and an SBOM are retained, and high-risk vulnerabilities trigger rebuilds.

The runtime uses a minimal allowlisted environment and fixed absolute tool paths. It does not inherit host Git config, credential helpers, tool wrappers, or plugin variables. Dependencies install only inside the job boundary, with lockfiles or hashes and narrow registry egress; lifecycle scripts and compiler plugins are treated as hostile code. Secrets enter only at runtime through short-lived delivery and never through image layers, build arguments, workspace files, shared caches, or logs.

The root `Makefile` is for trusted development. It is not a production image recipe or a safe way to build an untrusted customer repository.

## Subagents and agent teams

Subagents remain inside the parent tenant job boundary. They are budget and authority amplifiers, not new trust boundaries.

A future team design must preserve these invariants:

- Child authority is the intersection of parent authority and the delegated scope.
- A root budget ledger atomically reserves token, time, tool, process, fanout, and depth budgets before spawning.
- Cancellation, deadline, and cleanup propagate through the whole descendant tree.
- Team and mailbox identifiers locate resources but never authorize access.
- Mailbox messages carry typed sender, audience, team, round, sequence, and generation metadata; message bodies remain untrusted.
- Shared workspaces require explicit conflict control; isolated overlays or workspaces are the default.
- Completion and reporter text do not prove correctness; results retain producer, inputs, tool evidence, and verification status.

Do not implement team runtime, nested sandboxing, mailbox security, or delegation protocols until a real subagent feature exists.

## Scope of tiny-agent

The tiny-agent repository owns:

- Agent-loop and model stop-reason behavior.
- Tool schemas and deterministic tool semantics.
- Sessions, compaction, cancellation, and usage reporting.
- A non-interactive one-shot CLI suitable for a trusted job controller.

The deployment owns authentication, authorization, capsules, quotas, network policy, credentials, gateways, connectors, audit, retention, and cleanup.

Do not add a job queue, worker protocol, broker, connector registry, policy engine, container orchestrator, or team runtime to the four teaching implementations before a concrete deployment requires it.

## Removed Fence prototype

The former TypeScript `--sandbox` option wrapped only Bash commands while leaving the agent process and `read`, `write`, and `edit` outside Fence. Its policy was over-broad, it did not control resources, and it existed in only one of four implementations.

The option and per-Bash wrapper were removed because they were not part of the multi-tenant architecture and overstated their safety boundary. Do not port that design to Go, Python, or Rust. Whole-process Fence may be evaluated later inside an execution capsule as defense in depth.

## Deployment gates

### G0 — CLI contract

- All four one-shot CLIs expose consistent structured outcome causes.
- Cancellation and timeout behavior are tested, including background descendants.
- No CLI option claims that per-tool Fence wrapping provides tenant isolation.

### G1 — Single hostile job

- The capsule denies host files, runtime sockets, metadata, devices, and direct egress.
- Fork, CPU, memory, swap, PID, disk, inode, output, and daemon attacks hit hard limits.
- Cancellation leaves an empty cgroup and no mount, process, listener, credential, or state leak.
- Malicious package scripts, Git configuration, PATH shadowing, and artifact links fail closed.

### G2 — Multi-tenant isolation

- Tenant A cannot observe or modify tenant B's files, state, processes, IPC, network services, cache, logs, or artifacts.
- Concurrent duplicate submissions create one job and at most one active attempt.
- Crash recovery fences stale workers and reconciles incomplete or uncertain operations.
- Noisy tenants cannot exceed their quota or materially starve another tenant.

### G3 — Model and lookup gateways

- Real and simulated SSRF, redirect, DNS rebinding, IPv6, metadata, localhost, and service-discovery attacks fail.
- Cross-tenant internal lookup is denied even when identifiers are valid.
- Job capabilities enforce scope, budget, expiry, revocation, and audit.
- Canary secrets and PII are tracked across model requests, logs, sessions, artifacts, and deletion.

### G4 — Actions and teams

- Prompt injection in web, internal, or peer content cannot authorize an action.
- Changed, replayed, expired, or cross-tenant approvals fail.
- Successful-but-timeout actions reconcile without duplicate side effects.
- Child agents cannot expand authority or exceed root fanout, depth, cost, or time budgets.
- Deep cancellation leaves no descendant or stale-round write.

## Deliberately deferred

Defer Fence hardening, eBPF monitoring, a general connector registry, a workflow or policy engine, shared writable caches, nested sandboxing, GPU access, team runtime, organization-wide SLSA infrastructure, and generic PII classification until a measured requirement makes one necessary.

Fence-specific findings and primary-source references are recorded in [`fence-server-evaluation.md`](fence-server-evaluation.md).
