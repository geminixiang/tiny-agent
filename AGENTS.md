# Coding Guidelines

- Prefer early returns and early continues. Keep the main path at the lowest indentation level.
- Group related code together so the file reads in a clear top-to-bottom order.
- Prefer LBYL (look before you leap) for expected conditions: check existence, types, bounds, protocol tags, and readiness before acting instead of using exceptions for normal control flow.
- Avoid meaningless `try/catch`. Catch only when converting an error, handling cancellation, cleaning up a partially-created resource, or applying an intentional fallback. Do not catch broad errors just to continue.
- Keep this a teaching project: prefer direct code, few files, few dependencies, and the smallest implementation that preserves behavior. Use a small mature dependency when reimplementing the capability would distract from the agent loop.
- Do not add speculative abstractions, framework layers, or defensive code for unlikely cases.
- Use clear domain names such as `runAgentLoop`, `callModel`, `executeTool`, and `resumeSession`.
- Keep non-core formatting helpers on one line when that reduces visual noise; keep agent, session, tool, and cancellation flows expanded for teaching.
- Use four spaces, never tabs. Run the language formatter instead of hand-aligning code.
- Preserve valid model transcripts, append-only sessions, resumability, and cancellation semantics when simplifying.
- Keep TypeScript, Go, and Python behavior equivalent unless a language constraint is documented.
- Treat terminal input as structured key sequences, not independent bytes; consume complete ANSI escape sequences so arrow keys never leak as `[A`/`[D` or trigger a standalone `Esc` action.
- For hand-written line editing, keep the buffer and cursor in Unicode code points, but calculate rendering in terminal display cells: CJK/fullwidth characters use two cells and combining/format characters use zero.
- Redraw the complete prompt and line from a known origin after every edit, then reposition from the terminal width; do not patch the screen with one-column moves or cursor save/restore because wide characters and wrapped lines will drift.
- Keep prompt editing separate from active-operation controls: the editor owns arrows, insertion, and deletion; the busy loop owns standalone `Esc` cancellation and `Ctrl+C` exit.
- Reuse only the core algorithm learned from mature libraries. Check `x/term`, Node readline, or prompt-toolkit before hand-writing terminal behavior, but do not import history, completion, or framework features the project does not need.
- Test terminal behavior with Chinese text, combining marks, insertion/deletion in the middle, ANSI-colored prompts, and wrapping at a fixed narrow width; asserting only the final string is not enough—also assert display row and column.

## MCP Decisions

- Keep MCP as a tool adapter inside the existing agent loop. Do not add a second loop, registry framework, dynamic package loader, or authorization layer.
- Support trusted named Streamable HTTP servers. The CLI shape is `--mcp <alias>` alongside the independent local `--plugin` allowlist; repeated and comma-separated aliases are stable-deduplicated.
- Load the user/server catalog only from the trusted deployment path in `TINY_MCP_CONFIG`. There is no default home-directory location or fallback. Never auto-load repository MCP config and never accept a URL, header, token, tenant, or credential from model arguments or CLI flags.
- Catalog entries use `{ url, tokenEnv?, auth?, allowedTools?, callTimeoutMs? }`. `tokenEnv` resolves an environment variable and sends it as a Bearer token. TypeScript and Go additionally accept the closed form `auth: { type: "metabaseApiKey", tokenEnv }`, which sends `X-API-Key`; no catalog field accepts arbitrary headers. The catalog never stores the token. Public servers may omit authentication. Multi-tenant deployments must use a trusted gateway and short-lived tenant/job-scoped capabilities; reusable upstream credentials and tenant authorization stay outside tiny-agent.
- TypeScript uses the official MCP SDK v2 and Go uses the official Go SDK v1.7 in auto-negotiation mode: modern servers use `2026-07-28`, while 2025-era lifecycle and protocol sessions remain SDK-owned adapter state and are never persisted in tiny-agent Session. Python and Rust remain pinned to modern `2026-07-28` until their SDK migrations satisfy the existing bounds, cancellation, and cleanup contracts. The implementations support Streamable HTTP, `tools/list`, and `tools/call`; defer stdio, deprecated HTTP+SSE, OAuth UI, resources, prompts, tasks, sampling, elicitation, and arbitrary headers.
- Map remote names to reversible, collision-safe provider names internally. Show human-readable names such as `mcp:complex/analyze_data` only in the TUI; preserve encoded names in model calls, sessions, and JSONL events.
- Treat MCP `isError` as a thrown tool failure. Support text and `structuredContent`, fail closed on unsupported content, and bound tool count, schema/description size, schema depth, result bytes, startup time, and call time.
- MCP setup is all-or-nothing and sequential. Unknown aliases and invalid catalogs fail before session creation. In JSON mode, connection work uses `run.started → mcp.connected|mcp.failed → run.completed`, and run duration includes MCP startup.
- Close connected MCP clients in reverse order on every exit path. Cleanup is best-effort: attempt every close and do not let cleanup errors replace the original run result.
- Keep deterministic local MCP fixtures in normal CI. Public MCP servers are optional compatibility smoke tests, never the sole contract oracle or a release gate.
- TypeScript is the reference behavior. Go, Python, and Rust should match its CLI, catalog, monitoring, validation, cancellation, cleanup, and TUI behavior unless a language-specific constraint is documented.
