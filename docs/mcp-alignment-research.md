# Python and Rust MCP alignment research

**Research cutoff:** 2026-09-01. **Scope:** official MCP specifications, official Python and Rust SDK documentation/source, Metabase's first-party API documentation, and the current tiny-agent adapters. External source links are pinned where repository source is the authority.

| Source line | Researched version |
|---|---|
| MCP protocol | `2026-07-28` modern behavior and `2025-03-26` handshake/Streamable HTTP behavior |
| Python SDK | `mcp` v2.1.1, commit [`d2290ca`](https://github.com/modelcontextprotocol/python-sdk/tree/d2290ca3434731b68ea3e2270bc06a6e6575931b) |
| Rust SDK | `rmcp` v3.2.0, commit [`51ccb42`](https://github.com/modelcontextprotocol/rust-sdk/tree/51ccb42993d6eb5075399672ce7a0c21a0e55eea) |
| Metabase | first-party API-key documentation, commit [`8d618a8`](https://github.com/metabase/metabase/tree/8d618a8620b65f9d56b9182547f440066f6c3cd6) |

## Executive conclusion

Python and Rust can match the TypeScript MCP behavior without extending tiny-agent's MCP surface. Replace only their hand-written MCP wire clients with the current official SDK clients:

- Python: official `mcp` v2, using high-level `Client(..., mode="auto")` and Streamable HTTP.
- Rust: official `rmcp` 3.2, using `ClientLifecycleMode::Auto` explicitly rather than ordinary `serve()`.

Keep the existing tiny-agent adapter contract around those SDKs: trusted named catalog entries; stable-deduplicated aliases; only `tools/list` and `tools/call`; collision-safe model names; allowlists; tool/schema/description/result bounds; object-only call arguments; result normalization; per-call/startup timeouts; all-or-nothing sequential setup; reverse-order best-effort cleanup; and the existing JSON/session behavior.

The SDK, not tiny-agent, should own protocol negotiation, wire metadata, the legacy `initialize → notifications/initialized` lifecycle, `Mcp-Session-Id`, response parsing, and transport shutdown. Modern `2026-07-28` connections have no protocol session. Any session created for a 2025-era peer belongs only to the live SDK transport and must never enter tiny-agent's append-only Session; resume constructs a new connection.

The fixed `auth: { "type": "metabaseApiKey", "tokenEnv": "..." }` catalog form remains an application adapter, not a new MCP authorization scheme. Resolve the environment variable once at the trusted catalog boundary and configure exactly `X-API-Key`; do not add generic headers, literal secrets, or model/CLI-supplied credentials.

## Reference behavior to preserve

The TypeScript reference already:

- constructs the official client with automatic negotiation, lists tools through the SDK, forwards startup/call cancellation and timeouts, and closes partial startup on error ([`typescript/src/mcp.ts` L25-L105](../typescript/src/mcp.ts#L25-L105));
- terminates a legacy session before client close while modern connections remain stateless ([`typescript/src/mcp.ts` L29-L36](../typescript/src/mcp.ts#L29-L36));
- accepts only the closed Bearer or `metabaseApiKey` catalog shapes and maps the latter to `X-API-Key` ([`typescript/src/mcp-config.ts` L6-L19, L37-L52, L57-L97](../typescript/src/mcp-config.ts#L6-L97)); and
- closes all successfully connected servers in reverse order, attempts every close, and does not replace the run result with cleanup failure ([`typescript/src/cli.ts` L270-L278](../typescript/src/cli.ts#L270-L278)).

Python and Rust already preserve most adapter-level limits, mapping, normalization, monitoring, and cleanup ordering, but their current transports are hand-written and modern-only. Python manually sends `server/discover` and modern metadata ([`python/tiny_agent/mcp.py` L150-L268](../python/tiny_agent/mcp.py#L150-L268)); Rust does the same through blocking worker threads ([`rust/src/mcp.rs` L160-L321](../rust/src/mcp.rs#L160-L321)). This is the seam to replace. Runtime code outside the adapter does not need a second agent loop, protocol registry, or compatibility layer.

## Protocol eras and negotiation

### Modern `2026-07-28`

The modern lifecycle starts with `server/discover`; subsequent requests carry protocol version, client information, and capabilities in `_meta`. Streamable HTTP is stateless: there is no `initialize`, `notifications/initialized`, or `Mcp-Session-Id`; each JSON-RPC request is an independent POST returning JSON or request-scoped SSE. These are protocol properties, not heuristics tiny-agent should reproduce ([official versioning specification](https://modelcontextprotocol.io/specification/2026-07-28/basic/versioning), [official Streamable HTTP specification](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http)).

Automatic negotiation must not interpret arbitrary network, authentication, timeout, or server failures as proof that a peer is old. It should fall back only when the SDK classifies the response/no-response as legacy evidence. The Python SDK's probe policy explicitly separates legacy RPC evidence from transport/network/cancellation failures ([Python `_probe.py` L1-L24](https://github.com/modelcontextprotocol/python-sdk/blob/d2290ca3434731b68ea3e2270bc06a6e6575931b/src/mcp/client/_probe.py#L1-L24), [L52-L113](https://github.com/modelcontextprotocol/python-sdk/blob/d2290ca3434731b68ea3e2270bc06a6e6575931b/src/mcp/client/_probe.py#L52-L113)). The Rust SDK implements the equivalent discovery, corrective-version retry, and bounded fallback logic in its client lifecycle ([Rust `client.rs` L765-L830](https://github.com/modelcontextprotocol/rust-sdk/blob/51ccb42993d6eb5075399672ce7a0c21a0e55eea/crates/rmcp/src/service/client.rs#L765-L830), [L929-L1010](https://github.com/modelcontextprotocol/rust-sdk/blob/51ccb42993d6eb5075399672ce7a0c21a0e55eea/crates/rmcp/src/service/client.rs#L929-L1010)).

### 2025-era servers

A `2025-03-26` Streamable HTTP server uses the handshake lifecycle: the client sends `initialize`, adopts the negotiated version/capabilities, then sends `notifications/initialized`. A server may issue `Mcp-Session-Id`; the client must repeat it on later HTTP requests and may end that session with HTTP DELETE. This state belongs to the transport connection ([official 2025-03-26 lifecycle](https://modelcontextprotocol.io/specification/2025-03-26/basic/lifecycle), [official 2025-03-26 transport specification](https://modelcontextprotocol.io/specification/2025-03-26/basic/transports)).

For tiny-agent, the practical compatibility target is the already observed pair documented in this repository: modern GitHub at `2026-07-28` and Metabase at `2025-03-26` ([`docs/mcp-version-evaluation.md` L5-L16](mcp-version-evaluation.md#L5-L16)). Rust should offer the newest handshake-era revision as `legacy_version: Some(ProtocolVersion::V_2025_11_25)` and allow a server such as Metabase to counter-select its supported `2025-03-26` revision. The official auto example uses `V_2025_11_25`, and the SDK deliberately defines that revision as `LATEST` for the initialize path ([Rust README L114-L125](https://github.com/modelcontextprotocol/rust-sdk/blob/51ccb42993d6eb5075399672ce7a0c21a0e55eea/README.md#L114-L125), [`model.rs` L169-L186](https://github.com/modelcontextprotocol/rust-sdk/blob/51ccb42993d6eb5075399672ce7a0c21a0e55eea/crates/rmcp/src/model.rs#L169-L186)). The 2025 lifecycle permits the server to select another version it supports when it does not support the client's requested revision ([official 2025-03-26 lifecycle](https://modelcontextprotocol.io/specification/2025-03-26/basic/lifecycle)). Python's `auto` mode likewise adopts the revision selected through the SDK-owned legacy handshake.

## Python migration path

### SDK and connection shape

The official Python SDK v2 states that it supports the `2026-07-28` specification and every earlier revision; passing a URL selects Streamable HTTP ([Python README L16-L19](https://github.com/modelcontextprotocol/python-sdk/blob/d2290ca3434731b68ea3e2270bc06a6e6575931b/README.md#L16-L19), [L87-L112](https://github.com/modelcontextprotocol/python-sdk/blob/d2290ca3434731b68ea3e2270bc06a6e6575931b/README.md#L87-L112)). Its high-level `Client` defaults to `mode="auto"`: it probes `server/discover`, falls back to the initialize lifecycle for a legacy peer, permits `mode="legacy"` when forced, and permits a modern revision pin when discovery is already known ([Python `client.py` L335-L346](https://github.com/modelcontextprotocol/python-sdk/blob/d2290ca3434731b68ea3e2270bc06a6e6575931b/src/mcp/client/client.py#L335-L346), [L452-L475](https://github.com/modelcontextprotocol/python-sdk/blob/d2290ca3434731b68ea3e2270bc06a6e6575931b/src/mcp/client/client.py#L452-L475)).

Use one SDK `Client` per configured alias. Enter it during sequential MCP setup, list tools once, retain the live client in `LoadedMcpTools`, and exit it during reverse-order cleanup. Do not expose the general SDK client through the model-facing tool interface.

### Ownership and failure cleanup

Own the client with `async with` or an adapter `AsyncExitStack`. The SDK constructs the session and transport inside a local exit stack; if negotiation fails, that stack unwinds before the partially built session is published. Normal context exit unwinds the entered session/transport ([Python `client.py` L452-L481](https://github.com/modelcontextprotocol/python-sdk/blob/d2290ca3434731b68ea3e2270bc06a6e6575931b/src/mcp/client/client.py#L452-L481)).

`ClientSession.__aexit__` cancels the dispatcher and in-flight callback tasks and closes its queues; request timeout is a first-class session/per-call option ([Python `session.py` L480-L526](https://github.com/modelcontextprotocol/python-sdk/blob/d2290ca3434731b68ea3e2270bc06a6e6575931b/src/mcp/client/session.py#L480-L526), [L547-L608](https://github.com/modelcontextprotocol/python-sdk/blob/d2290ca3434731b68ea3e2270bc06a6e6575931b/src/mcp/client/session.py#L547-L608)). Streamable HTTP defaults to `terminate_on_close=True`, sends DELETE only when the transport owns a legacy session ID, and then cancels its task group ([Python `streamable_http.py` L622-L645](https://github.com/modelcontextprotocol/python-sdk/blob/d2290ca3434731b68ea3e2270bc06a6e6575931b/src/mcp/client/streamable_http.py#L622-L645), [L675-L709](https://github.com/modelcontextprotocol/python-sdk/blob/d2290ca3434731b68ea3e2270bc06a6e6575931b/src/mcp/client/streamable_http.py#L675-L709)).

This satisfies tiny-agent's partial-startup and normal cleanup requirements if the adapter still owns the outer policy: track only fully connected clients, unwind them in reverse order, catch each cleanup error independently, attempt the rest, and preserve the original run outcome.

### Cancellation and timeouts

Keep tiny-agent's `asyncio.Event`/operation cancellation semantics at the adapter boundary, but translate them into cancellation of the actual awaited SDK request rather than maintaining a second transport task registry. Retain separate bounded startup and tool-call deadlines. On outer task cancellation, allow `CancelledError` to propagate through the SDK context so its task groups unwind; convert it to tiny-agent's established operation-aborted result only at the existing agent/tool boundary.

The important behavior to test is not an internal SDK task shape. It is that startup cancellation closes a partial client, call cancellation stops the awaited HTTP request promptly, call timeout remains distinguishable from authentication/protocol failure, and later reverse-order cleanup is still attempted.

### HTTP authentication

A plain URL makes the SDK create its own HTTP client. Custom headers require a caller-owned `httpx2.AsyncClient`, passed to `streamable_http_client`; the SDK intentionally does not close an HTTP client it did not create ([official Python transport docs L44-L55](https://github.com/modelcontextprotocol/python-sdk/blob/d2290ca3434731b68ea3e2270bc06a6e6575931b/docs/client/transports.md#L44-L55)). Therefore the adapter should:

1. resolve the trusted catalog credential;
2. create `httpx2.AsyncClient(headers={...})` with either `Authorization: Bearer …` or `X-API-Key: …`;
3. enter that HTTP client in the same adapter exit stack as the MCP client; and
4. pass `streamable_http_client(url, http_client=http_client)` to `Client`.

Do not use an obsolete `headers=` argument on `streamable_http_client`, and do not let the token appear in a cache identity, diagnostic, tool definition, or Session.

## Rust migration path

### SDK and lifecycle configuration

The official Rust SDK is Tokio-based and states that `rmcp` implements `2026-07-28` while remaining compatible with `2025-11-25` and earlier versions ([Rust README L7-L22](https://github.com/modelcontextprotocol/rust-sdk/blob/51ccb42993d6eb5075399672ce7a0c21a0e55eea/README.md#L7-L22)). Unlike Python, ordinary `serve()` uses the legacy initialize lifecycle. tiny-rs must explicitly call `serve_with_lifecycle` with:

```rust
ClientLifecycleMode::Auto {
    preferred_versions: vec![ProtocolVersion::V_2026_07_28],
    legacy_version: Some(ProtocolVersion::V_2025_11_25),
}
```

The official README documents the distinction and the auto-probe behavior ([Rust README L94-L130](https://github.com/modelcontextprotocol/rust-sdk/blob/51ccb42993d6eb5075399672ce7a0c21a0e55eea/README.md#L94-L130)); the lifecycle types and startup implementation are SDK-owned ([Rust `client.rs` L623-L643](https://github.com/modelcontextprotocol/rust-sdk/blob/51ccb42993d6eb5075399672ce7a0c21a0e55eea/crates/rmcp/src/service/client.rs#L623-L643), [L765-L830](https://github.com/modelcontextprotocol/rust-sdk/blob/51ccb42993d6eb5075399672ce7a0c21a0e55eea/crates/rmcp/src/service/client.rs#L765-L830)).

Keep tiny-rs's public MCP adapter narrow. The implementation will need Tokio to drive `rmcp`, but that is an adapter/runtime integration detail, not permission to make the rest of the synchronous teaching loop async or add a second orchestration framework. The adapter should return the same conceptual `LoadedMcp { tools, protocol_version, close }` it returns today.

### Session ownership

The Rust Streamable HTTP transport explicitly uses no session ID for a modern lifecycle, records cleanup state only when a legacy peer issues a session, sends `notifications/initialized` only for legacy initialization, and DELETEs the owned legacy session during bounded cleanup ([Rust `streamable_http_client.rs` L1090-L1159](https://github.com/modelcontextprotocol/rust-sdk/blob/51ccb42993d6eb5075399672ce7a0c21a0e55eea/crates/rmcp/src/transport/streamable_http_client.rs#L1090-L1159), [L1763-L1814](https://github.com/modelcontextprotocol/rust-sdk/blob/51ccb42993d6eb5075399672ce7a0c21a0e55eea/crates/rmcp/src/transport/streamable_http_client.rs#L1763-L1814)).

Consequently:

- `LoadedMcp` owns the running SDK service and transport for one process run.
- `McpTool` closures/handles borrow or clone only the SDK's safe live handle.
- tiny-agent Session stores neither the service, negotiated connection, nor `Mcp-Session-Id`.
- resume performs new catalog resolution, negotiation, and tool discovery.

### Cancellation and deterministic shutdown

The current Rust client polls an `AtomicBool` while a detached blocking HTTP worker can continue until its transport timeout. `rmcp`'s high-level tool call does not accept tiny-agent's cancellation token directly, so the adapter should race/select the SDK request future against operation cancellation. When cancellation wins, dropping the pending request handle closes its responder; the Streamable HTTP transport selects on that closure and stops queued or active POST work ([Rust `RequestHandle` L529-L579](https://github.com/modelcontextprotocol/rust-sdk/blob/51ccb42993d6eb5075399672ce7a0c21a0e55eea/crates/rmcp/src/service.rs#L529-L579), [`streamable_http_client.rs` L590-L624](https://github.com/modelcontextprotocol/rust-sdk/blob/51ccb42993d6eb5075399672ce7a0c21a0e55eea/crates/rmcp/src/transport/streamable_http_client.rs#L590-L624)).

Use explicit service shutdown. `RunningService.close()` cancels the service and awaits its transport loop/cleanup. `close_with_timeout` bounds how long the caller waits but may return before cleanup completes when the bound expires ([Rust `service.rs` L1100-L1155](https://github.com/modelcontextprotocol/rust-sdk/blob/51ccb42993d6eb5075399672ce7a0c21a0e55eea/crates/rmcp/src/service.rs#L1100-L1155)). Dropping alone only schedules asynchronous cancellation and therefore does not guarantee that cleanup completed before process exit ([Rust `service.rs` L1169-L1179](https://github.com/modelcontextprotocol/rust-sdk/blob/51ccb42993d6eb5075399672ce7a0c21a0e55eea/crates/rmcp/src/service.rs#L1169-L1179)). Preserve `ActiveMcp`'s reverse ordering, use explicit close on the normal path, bound the overall cleanup wait without claiming completion after a timeout, attempt every close, and keep cleanup errors secondary to the run result.

### HTTP authentication

`StreamableHttpClientTransportConfig.custom_headers` is the intended caller seam for fixed HTTP authentication headers; protocol and session headers remain transport-owned ([Rust `streamable_http_client.rs` L1997-L2022](https://github.com/modelcontextprotocol/rust-sdk/blob/51ccb42993d6eb5075399672ce7a0c21a0e55eea/crates/rmcp/src/transport/streamable_http_client.rs#L1997-L2022), [L2073-L2103](https://github.com/modelcontextprotocol/rust-sdk/blob/51ccb42993d6eb5075399672ce7a0c21a0e55eea/crates/rmcp/src/transport/streamable_http_client.rs#L2073-L2103)). Populate that map with exactly one catalog-derived authentication header. Do not manually add `MCP-Protocol-Version`, routing headers, or `Mcp-Session-Id`.

## Closed `metabaseApiKey` form

Metabase's first-party documentation instructs API clients to authenticate with `X-API-Key: YOUR_API_KEY` and demonstrates reading that value from an environment variable ([Metabase API key docs L70-L103](https://github.com/metabase/metabase/blob/8d618a8620b65f9d56b9182547f440066f6c3cd6/docs/people-and-groups/api-keys.md#L70-L103)). This justifies the one closed adapter form already present in TypeScript and Go; it does not justify generic catalog headers.

Python and Rust should match these validation and handling rules:

- server fields remain exactly `{ url, tokenEnv?, auth?, allowedTools?, callTimeoutMs? }`;
- `auth`, when present, must be exactly `{ type: "metabaseApiKey", tokenEnv }`;
- reject unknown `auth` fields and unknown auth types;
- reject setting both top-level `tokenEnv` and `auth`;
- validate `tokenEnv` as an environment-variable name and require a nonempty resolved value;
- top-level `tokenEnv` sends `Authorization: Bearer <token>`;
- `metabaseApiKey` sends `X-API-Key: <token>`;
- resolve once before connection, never persist/log the token, and sanitize errors so server bodies or credentials do not leak;
- accept no URL, token, tenant, auth object, or arbitrary header from model tool arguments or CLI flags.

This remains transport authentication. Tenant authorization, upstream credential custody, redirect/SSRF controls, and short-lived job capability issuance remain deployment/gateway responsibilities.

## Verification plan before switching implementations

Use deterministic local fixtures in normal CI and keep public servers optional smoke tests. Add parity assertions before removing the hand-written clients:

| Area | Required assertion in both Python and Rust |
|---|---|
| Modern negotiation | Auto selects `2026-07-28`, performs discovery/corrective retry through the SDK, sends no initialize notification, and exposes the negotiated version diagnostically. |
| Legacy negotiation | A stateful `2025-03-26` fixture receives `initialize → notifications/initialized`; Rust offers `2025-11-25`, the fixture counter-selects `2025-03-26`, and tools list/call work through the same tiny-agent tool interface. |
| Session ownership | Legacy `Mcp-Session-Id` is repeated and DELETE-terminated by the SDK, never written to tiny-agent Session; resume gets a fresh server session. |
| Failure classification | 401/403, 5xx, ordinary transport failure, outer tiny-agent startup/call timeout, and cancellation are not silently reclassified as legacy evidence. Separately assert the Rust SDK's documented internal 10-second discovery no-response fallback policy ([Rust `client.rs` L789-L826](https://github.com/modelcontextprotocol/rust-sdk/blob/51ccb42993d6eb5075399672ce7a0c21a0e55eea/crates/rmcp/src/service/client.rs#L789-L826)). |
| Cancellation | Startup and tool-call cancellation stop the actual SDK request and preserve tiny-agent's operation-aborted semantics. |
| Cleanup | Partial startup closes immediately; normal exit closes in reverse order; one close failure does not skip later clients or replace the original result. |
| Authentication | Bearer and `X-API-Key` appear on every relevant HTTP request; the closed-form validators reject conflicts, unknown types/fields, and missing env values without leaking secrets. |
| Adapter parity | Pagination/aggregate listing, allowlists, name mapping/collision rejection, size/depth/tool-count bounds, structured content, text resources, unsupported content, `isError`, and call timeouts continue to match TypeScript. |
| Session/monitoring | MCP setup remains before model execution; JSON events remain `run.started → mcp.connected|mcp.failed → run.completed`; duration includes startup; historical MCP calls are never replayed. |

The official SDK should own wire conformance tests. tiny-agent tests should exercise the adapter contract and two protocol eras, not copy the SDK's JSON-RPC parser.

## Explicit non-goals

Do not add stdio, deprecated HTTP+SSE, OAuth UI, arbitrary headers, resources, prompts, sampling, tasks, subscriptions, elicitation, dynamic package loading, a second registry, persisted protocol sessions, or a second agent loop. The migration is complete when Python and Rust use official SDK-owned negotiation/lifecycle/cancellation/cleanup while preserving the current narrow tiny-agent behavior.
