# MCP “second version” evaluation for tiny-agent

**Research cutoff:** 2026-08-22. **Scope:** official MCP specification/docs and official MCP/TypeScript SDK repositories only.

## 2026-08-23 decision update

A real Metabase `0.63.14.2` server proved that the official TypeScript SDK can auto-negotiate both eras through the same tiny-agent Tool adapter:

```text
GitHub     → modern 2026-07-28
Metabase   → legacy 2025-03-26
```

TypeScript therefore uses `versionNegotiation: { mode: "auto" }`. The SDK—not tiny-agent—owns the legacy initialize handshake, protocol session, and wire codec. tiny-agent persists neither the negotiated connection nor `Mcp-Session-Id`; resume creates a new adapter connection. Go, Python, and Rust remain modern-only until their hand-written transports are replaced by official SDK adapters.

The catalog keeps a closed authentication interface: ordinary `tokenEnv` sends Bearer; TypeScript additionally accepts `auth: { type: "metabaseApiKey", tokenEnv }` for `X-API-Key`. Literal credentials, arbitrary headers, private hostnames in the public example catalog, and interactive OAuth remain out of scope.

## Bottom line

The claim is directionally correct but conflates two version systems. The current stable **protocol revision is `2026-07-28`**, released 2026-07-28; MCP protocol revisions are date strings, not “v2.” The official **TypeScript SDK v2** (`@modelcontextprotocol/client@2.0.0`) became stable on 2026-07-27 and was released alongside that specification. This SDK generation—not a protocol named “MCP v2”—is the most likely referent. Both are stable, although the SDK README says v2 is still “settling”; v1 receives bug/security fixes for at least six months after v2’s release. [Protocol release](https://github.com/modelcontextprotocol/modelcontextprotocol/releases/tag/2026-07-28) · [SDK client release](https://github.com/modelcontextprotocol/typescript-sdk/releases/tag/%40modelcontextprotocol%2Fclient%402.0.0) · [SDK status](https://github.com/modelcontextprotocol/typescript-sdk#readme)

For tiny-agent, this is not a reason to implement the whole protocol. Use the stable v2 client package behind a narrow adapter and expose only `tools/list` and `tools/call`. TypeScript uses SDK-owned automatic era negotiation; the other three implementations remain pinned to the modern revision while their wire transports are still hand-written.

## What changed, and what matters here

The 2026 revision is a substantial wire-era change from `2025-11-25`:

- The protocol is stateless: `initialize`/`notifications/initialized` are removed for modern peers. Every request carries protocol version and client capabilities in `_meta`; HTTP also carries required mirrored headers. A new mandatory server method, `server/discover`, advertises versions/capabilities. Unsupported versions return a typed protocol error. [Versioning](https://modelcontextprotocol.io/specification/2026-07-28/basic/versioning) · [Changelog](https://modelcontextprotocol.io/specification/2026-07-28/changelog)
- Streamable HTTP no longer has protocol sessions or `Mcp-Session-Id`, and no longer uses a general GET stream. Each JSON-RPC request is an independent POST returning JSON or request-scoped SSE. Long-lived notifications moved to `subscriptions/listen`. [Streamable HTTP](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http)
- `tools/list` is connection-independent and remains paginated. Modern list results add `resultType: "complete"`, `ttlMs`, and `cacheScope`; tool results can be `complete` or `input_required`. [Tools](https://modelcontextprotocol.io/specification/2026-07-28/server/tools)
- Tool `outputSchema`/`structuredContent` remain useful. A minimal client should preserve structured output even if tiny-agent ultimately serializes it for its string-valued tool interface, and should expose MCP `isError` as actionable tool output rather than misclassifying it as a transport failure. [Tools](https://modelcontextprotocol.io/specification/2026-07-28/server/tools)
- Tools may declare `x-mcp-header`; on modern Streamable HTTP the SDK mirrors designated arguments into `Mcp-Param-*` and validates standard headers. Hand-rolling the wire risks missing this. [SDK 2026 migration](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/migration/support-2026-07-28.md#mcp-param--and-standard-headers-sep-2243)
- Experimental core tasks moved to an optional official extension. Elicitation/sampling/roots became multi-round-trip `input_required` flows; logging and some notifications changed. None is needed for a client that deliberately supports only ordinary, immediately completed tool calls. [Changelog](https://modelcontextprotocol.io/specification/2026-07-28/changelog)

## SDK v2 is separate from protocol 2026

SDK v2 split `@modelcontextprotocol/sdk` into `@modelcontextprotocol/core`, `@modelcontextprotocol/client`, and `@modelcontextprotocol/server`; requires Node 20+; is ESM-first with CommonJS builds; and includes a codemod for existing SDK users. tiny-agent has no MCP dependency today, so it has no v1 migration burden—start directly with `@modelcontextprotocol/client` v2. [v1→v2 guide](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/migration/upgrade-to-v2.md)

A critical subtlety: v2 does **not** send 2026 wire semantics by default. TypeScript explicitly enables automatic negotiation:

```ts
new Client(clientInfo, { versionNegotiation: { mode: "auto" } })
```

The SDK first probes the modern era and falls back only when it classifies the peer as legacy. Record the negotiated version for diagnostics and never infer fallback from arbitrary failures. [SDK protocol support](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/migration/support-2026-07-28.md#client-side-versionnegotiation)

## Transport, auth, and state

**Streamable HTTP should be the first implementation.** It matches hosted integrations such as the planned trusted `sentry` configuration, avoids launching local code, and is the active remote transport. Do not implement deprecated HTTP+SSE fallback initially. Correctly support JSON and request-scoped SSE responses, cancellation/timeouts, redirects conservatively, and the SDK’s negotiation/header behavior. [Streamable HTTP](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http)

**Defer stdio**, but keep the adapter transport-neutral. Stdio is still active and is often convenient for local servers, but it means spawning trusted executables, newline-framed JSON-RPC, stderr handling, and lifecycle/kill escalation. Adding it now increases configuration and process-security surface without helping the Sentry-first UX. [stdio](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/stdio) · [SDK negotiation](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/migration/support-2026-07-28.md#client-side-versionnegotiation)

**Auth is transport authentication, not tiny-agent tool authorization.** MCP authorization is optional; HTTP implementations that support it should follow MCP’s OAuth-based flow, while stdio should obtain credentials from the environment instead. For the first trusted-server integration, tiny-agent receives only a short-lived tenant/job-scoped capability for a trusted gateway. The gateway—not the job capsule—owns reusable upstream URLs, credentials, tenant enforcement, redirect/SSRF policy, rate limits, and audit. Never put literal secrets in session logs, prompts, tool definitions, or persisted config. Defer interactive OAuth discovery/registration and step-up UI until a selected server requires it; do not silently fall back on 401/403. [Authorization](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization)

Modern MCP has no protocol session. For a legacy peer, keep the SDK-managed protocol session strictly inside the adapter connection; never persist `Mcp-Session-Id` in tiny-agent Session.

## Smallest version-tolerant design

Keep one narrow implementation seam instead of defining a general external-tool-source framework:

```ts
async function loadMcpTools(config: TrustedMcpConfig, signal: AbortSignal): Promise<{
  tools: Tool[];
  close(): Promise<void>;
}>;
```

Implement it with `@modelcontextprotocol/client` v2 and `StreamableHTTPClientTransport`:

1. Resolve aliases from a host-injected, immutable catalog. In multi-tenant production, trusted job context authorizes each alias before the process starts. Repository files, model arguments, and ordinary environment variables cannot add servers or override URLs. Production aliases point to a trusted gateway and carry only short-lived tenant/job-scoped capabilities; local tests may inject loopback fixtures.
2. Connect with SDK-owned automatic negotiation; impose connect/list/call timeouts and forward abort. Surface the negotiated version and typed auth/protocol/transport errors diagnostically. Do not branch tiny-agent tool behavior on the negotiated era.
3. Fetch the aggregate tool list with SDK `listTools()`; the SDK handles pagination. Retain the remote name, input schema, optional output schema, and full definition for `callTool` (needed by SDK header mirroring/validation). A single run may use this startup snapshot; the protocol does not guarantee that tool lists remain immutable across runs. Ignore list-change subscriptions and TTL refresh initially.
4. Map each remote tool to a deterministic model-facing name such as `mcp__${encode(alias)}__${encode(remoteName)}`. Use a reversible restricted-character encoding (not lossy replacement), reject duplicate mapped names, and run the existing global duplicate-name check. Keep the exact remote name only in the closure; never let model input select a server or method.
5. Validate that call arguments are a JSON object. Let the SDK perform protocol/schema behavior; normalize successful `content` plus `structuredContent` into bounded text/JSON for tiny-agent. Preserve `isError` as model-visible corrective output. Treat `input_required` as a clear unsupported-result error—do not attempt elicitation implicitly.
6. Close the client/transport on exit. Never expose resources, prompts, sampling, roots, subscriptions, logging, or arbitrary JSON-RPC through the adapter.

For UX option A, `tiny-ts --mcp sentry --plugin read` should mean: load built-in `read` **and** tools from the trusted MCP entry, prefixed as above. `--plugin` remains local capability selection; `--mcp` is a separate trusted tool source. MCP is explicitly **not an authorization boundary**: server selection, secret access, network policy, local plugin policy, user confirmation, and sandboxing remain host responsibilities. MCP tool descriptions and results are untrusted model input even when the server configuration is trusted. [Spec security principles](https://modelcontextprotocol.io/specification/2026-07-28)

## Implement now / defer

**Implement now:** TypeScript SDK v2 client only; Streamable HTTP; SDK-owned automatic era negotiation; trusted named configuration authorized by deployment; Bearer plus the fixed `metabaseApiKey` adapter; aggregate tool discovery; calls with cancellation/timeouts; collision-safe prefixing; structured/error normalization; cleanup; deterministic modern and stateful legacy fixtures.

**Defer:** stdio and process policy; deprecated HTTP+SSE; interactive OAuth/client registration; persisted protocol sessions; subscriptions/list-change refresh; elicitation/MRTR; tasks extension; sampling/roots; resources/prompts; cache-policy optimization; generic custom headers supplied by the model; arbitrary server URLs/commands; and using MCP as permission enforcement.

This keeps the integration small while delegating the unstable, era-specific wire details to the official client and preserving a narrow replacement seam if SDK behavior changes.
