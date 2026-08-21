# Coding Guidelines

- Prefer early returns and early continues. Keep the main path at the lowest indentation level.
- Group related code together so the file reads in a clear top-to-bottom order.
- Avoid meaningless `try/catch`. Catch only when converting an error, handling cancellation, or applying an intentional fallback.
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
