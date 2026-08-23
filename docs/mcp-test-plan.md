# MCP client test plan

**Target UX:**

```bash
tiny-ts --mcp sentry --plugin read "investigate an issue"
```

**Scope:** a narrow TypeScript adapter using `@modelcontextprotocol/client` v2, Streamable HTTP, and only `tools/list` plus `tools/call`.

## Test ownership

| Owner | Must test |
|---|---|
| Official SDK | JSON-RPC framing, JSON/SSE parsing, cursor aggregation, protocol-era classification, header mirroring |
| tiny-agent adapter | trusted alias lookup, tool mapping, result normalization, bounded output, lifecycle, CLI/session/events |
| Deployment gateway | tenant authorization, upstream credentials, SSRF/DNS/redirect controls, rate/cost policy, audit |
| Execution capsule | tenant/process/filesystem/resource isolation |

Tiny-agent tests must not duplicate the SDK's wire parser or imply that MCP provides tenant isolation.

## Test layers

```text
make test           deterministic local tests; no public network
make test-mcp       focused deterministic MCP tests
make test-mcp-live  optional, non-gating hosted compatibility smoke
```

Use Node's built-in test runner and dedicated `mcp*.test.ts` files. Do not require Vitest or a new eval framework.

## Deterministic confidence set

### 1. Trusted alias and job authorization seam

- A known alias resolves through an injected, host-owned catalog.
- An unknown alias fails before session creation or network access.
- Model arguments cannot choose an alias, URL, credential, tenant, or arbitrary header.
- Production entries use HTTPS.
- In multi-tenant production, trusted job context must authorize the alias before tiny-agent starts. This is a deployment gate, not a catalog-name check.
- Production points at a trusted gateway and uses a short-lived tenant/job-scoped capability. Upstream MCP URLs and reusable credentials remain outside the execution capsule.

Local tests may inject loopback entries through an in-process catalog seam; do not add an environment variable that overrides production URLs.

### 2. Provider-safe tool names

- Map remote names to deterministic bounded names such as `mcp__sentry__<opaque-suffix>`.
- Preserve the exact remote name in an adapter-owned lookup map; model-facing names need not be reversible.
- Reject collisions across local and MCP tools.
- Test empty, overlong, case-distinct, dot, hyphen, underscore, and non-ASCII remote names.
- Pin the accepted OpenRouter tool-name alphabet and maximum length before implementation.

### 3. Tool-list behavior

Call SDK `listTools()` once and consume its aggregate result; do not implement a cursor loop.

Test:

- A two-page fixture is returned as one aggregate list by the SDK.
- Empty tool list.
- Empty `allowedTools`.
- Configured allowlisted name missing from the server fails startup.
- Duplicate remote names fail startup.
- Tool-count, serialized-schema-byte, and nesting-depth limits fail closed.
- Unsupported top-level schema shape fails clearly.

Do not build a general JSON Schema validator or `$ref` resolver.

### 4. Official SDK negotiation fixtures

Use the official SDK's in-process modern server handler when possible, plus a minimal stateful 2025 fixture.

Verify:

- TypeScript `{ versionNegotiation: { mode: "auto" } }` selects `2026-07-28` for a modern server.
- TypeScript falls back to the 2025 `initialize → notifications/initialized` lifecycle only when the SDK classifies the peer as legacy.
- Legacy `Mcp-Session-Id` stays inside the adapter connection and `close()` terminates the SDK-managed session; it is never persisted in tiny-agent Session.
- `tools/list` and `tools/call` succeed in both eras through the same tiny-agent Tool interface.
- JSON, request-scoped SSE, `structuredContent`, diagnostics, and the exact modern `-32022` corrective retry remain covered.
- Python and Rust continue to reject legacy-only peers until their hand-written transports are replaced by official SDK adapters that preserve the existing response-bound, cancellation, and cleanup contracts.

### 5. Auth adapters

Verify both closed catalog forms:

- `tokenEnv` sends `Authorization: Bearer`.
- `auth: { type: "metabaseApiKey", tokenEnv }` sends `X-API-Key` in TypeScript.

Reject unknown auth types, unknown auth fields, invalid or missing environment names, and entries containing both `tokenEnv` and `auth`. Never accept a literal credential or arbitrary header name/value.

### 6. No-retry outcomes

The SDK owns era classification and fallback. Assert that `401`, `403`, `5xx`, transport failure, and HTTP timeout remain connection failures rather than legacy fallback triggers. Do not reimplement the SDK classifier. Keep the exact modern `-32022` corrective retry coverage.

### 7. Result normalization

Use one deterministic model-facing format:

1. Preserve text blocks in remote order.
2. If `structuredContent !== undefined`, append one labeled canonical JSON serialization.
3. Do not attempt semantic duplicate suppression.
4. Apply one final UTF-8 byte limit with a visible truncation marker; never split a code point.

Test object, array, string, number, boolean, null, and absent structured content.

MCP `isError: true` is a completed domain-level tool result. For the initial string-valued Tool contract, return bounded corrective text and keep execution monitoring `ok: true`; do not infer failure from result text. Introduce a typed ToolResult only if monitoring must distinguish domain errors.

`input_required` returns a clear unsupported result. Do not register elicitation, sampling, or roots handlers.

### 8. Adapter failure propagation and bounds

Use an injected client/fetch seam rather than a hand-written malformed protocol server.

Test:

- Sanitized connect/list/call errors.
- Connect/list/call timeouts stop the next phase.
- Abort reaches the SDK and settles promptly.
- Oversized tool count, schema, SSE/result bytes, and normalized output fail closed.
- SDK output-schema validation failure is distinct from MCP `isError`.

Do not test wrong JSON-RPC IDs, duplicate finals, cursor loops, malformed SSE framing, or parser EOF details; those belong to the SDK.

### 9. Agent integration

Reuse the existing injected-tool coverage. Add one MCP-specific test proving:

- Exact mapped tool schema reaches the model.
- The exact remote name is called once.
- Result enters the transcript and session once.
- Session stores the prefixed tool name.
- `tool.started` and `tool.completed` use the prefixed name.
- Resume never replays a historical MCP call.

### 10. CLI assembly and lifecycle

Use in-process CLI assembly with an injected catalog/client factory for networked tests. Keep subprocess coverage for parsing and early rejection.

Test:

- `--plugin read --mcp sentry` combines local and remote tools.
- Repeated `--mcp` is stable and deduplicated or rejected by a documented rule.
- Unknown alias creates no session.
- Known alias with connect/list failure emits one structured startup failure; model fetch is not called.
- Connect/list occurs once per CLI run; interactive turns reuse the source.
- One-shot completion, model failure, cancellation, setup partial failure, and CLI exit await reverse-order idempotent cleanup.
- Every successfully opened client closes exactly once.

Do not persist MCP connections or session IDs. Resume reconnects and lists current tools.

### 11. Secret-surface checks

Use a sentinel capability token and verify tiny-agent itself never serializes it into:

- tool definitions
- stdout/stderr
- monitoring events
- session JSONL
- sanitized adapter errors

The adapter cannot guarantee that a malicious upstream never echoes data it receives. Production upstream credentials are injected and scrubbed by the trusted gateway outside the capsule. End-to-end canary tracking belongs to deployment tests.

## Deployment gates, not adapter tests

Before multi-tenant production, test the real gateway and capsule for:

- Tenant/job authorization of each MCP alias and operation.
- Short-lived capability scope, budget, expiry, and revocation.
- SSRF, DNS rebinding, redirects, metadata, localhost, private/link-local IPv4/IPv6, and direct-egress denial.
- Cross-tenant identifiers and confused-deputy attempts.
- Prompt injection cannot change trusted routing or grant authority.
- Audit, retention, and credential canary handling.
- State-changing calls use idempotency/receipts and can become `uncertain`; the MCP MVP should expose only read-only or proven-idempotent tools.

Passing loopback adapter tests does not satisfy these gates.

## Hosted compatibility smoke tests

Public mocks are optional and non-gating. Their uptime and exact content are not controlled by tiny-agent.

GitHub's hosted MCP is the reference authenticated smoke. It verifies modern negotiation, static Bearer authentication, tool discovery, a real `get_file_contents` call, and embedded text-resource normalization without invoking a model:

```bash
TINY_GITHUB_MCP_TOKEN="$(gh auth token)" make test-mcp-live
```

The token stays in the process environment; the test does not write it to the catalog, Session, output, or repository. Use a least-privilege token in CI or shared environments.

Observed on 2026-08-23:

| Endpoint | Observed behavior |
|---|---|
| `https://api.githubcopilot.com/mcp/` | Bearer authentication succeeds; negotiates `2026-07-28`; `get_file_contents` returns text plus embedded `resource` content |

Observed public fixtures on 2026-08-22:

| Endpoint | Observed behavior |
|---|---|
| `/mcp-complex-server` | HTTP 200 request-scoped SSE; four tools; invalid args return `isError: true` |
| `/mcp-error-server` | HTTP 200 SSE; domain errors return `isError: true`; delayed call triggers client timeout |
| `/mcp-auth-server` | Missing/invalid token returns 401 with `WWW-Authenticate`; temporary token returns 200 SSE |
| `/mcp-stateless-server?rev=2026-07-28` | Bare request without modern metadata returns `-32022`; test through SDK negotiation |
| `/mcp-echo-server` | HTTP 503; advertised as temporarily offline |

Initial live suite:

- Complex: negotiation, at least one listed tool, one known call or documented domain error.
- Error: one domain error and one timeout.
- Auth: unauthenticated 401 challenge only by default. Authenticated smoke is separate and explicit; never print the token.
- Stateless: SDK-negotiated era and `input_required` behavior.

Do not gate release on exact tool counts/content, Echo availability, MCP Apps, or public auth token minting.

Classify live failures as client incompatibility, third-party behavior drift, or third-party availability/auth infrastructure failure.

## Completion gates

MCP adapter implementation is complete when:

1. Trusted alias and provider-safe name tests pass.
2. Modern and legacy TypeScript negotiation fixtures pass; other languages retain their documented modern-only contract.
3. SDK-owned negotiation, corrective retry, and legacy session cleanup contracts pass.
4. Normalization, bounds, cancellation, and cleanup pass.
5. Agent and CLI assembly/session/event contracts pass.
6. Adapter secret-surface checks pass.

Hosted smoke results are reported separately and never replace deterministic fixtures.
