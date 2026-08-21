# Coding Guidelines

- Prefer early returns and early continues. Keep the main path at the lowest indentation level.
- Group related code together so the file reads in a clear top-to-bottom order.
- Avoid meaningless `try/catch`. Catch only when converting an error, handling cancellation, or applying an intentional fallback.
- Keep this a teaching project: prefer direct code, few files, few dependencies, and the smallest implementation that preserves behavior.
- Do not add speculative abstractions, framework layers, or defensive code for unlikely cases.
- Use clear domain names such as `runAgentLoop`, `callModel`, `executeTool`, and `resumeSession`.
- Keep non-core formatting helpers on one line when that reduces visual noise; keep agent, session, tool, and cancellation flows expanded for teaching.
- Use four spaces, never tabs. Run the language formatter instead of hand-aligning code.
- Preserve valid model transcripts, append-only sessions, resumability, and cancellation semantics when simplifying.
- Keep TypeScript, Go, and Python behavior equivalent unless a language constraint is documented.
