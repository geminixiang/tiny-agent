# tiny-agent

用最少概念做出可用的 AI coding agent。這個教學 repo 最終會用 TypeScript、Python、Rust、Go 各實作一次；目前先完成 **TypeScript POC**。

## 已有功能

- OpenRouter（固定 `deepseek/deepseek-v4-flash-0731`）
- agent/tool loop
- `bash`、`read`、`write`、`edit`
- Agent Skills 漸進載入
- `/compact` 壓縮歷史
- session 以版本化 JSONL 落在 `.tiny-agent/sessions/`
- 啟動時將目前專案的 `./AGENTS.md` 放入 system prompt
- `Esc` 可中斷模型、tool 與 compaction，且保持 session 可恢復
- TUI 顯示 tool 呼叫與精簡結果
- 每回合顯示 input/output token、cached token 與 cache ratio
- 零 TUI framework 的基本互動 CLI

核心刻意集中在 [`src/index.ts`](src/index.ts)，方便從上到下閱讀；production agent 還需要權限確認、串流與更完整的 session resume UX 等。

## 執行

需要 Node.js 22+：

```bash
npm install
export OPENROUTER_API_KEY=sk-or-...
npm run dev
```

也可安裝成真正的 CLI：

```bash
npm link
tiny-agent
```

互動模式：

```text
› 幫我讀 README 並提出改善建議
› /compact
› /skill:demo optional arguments
› /exit
```

互動過程中的 tool call 會顯示精簡狀態，不會把完整 write content 或 tool output 塞滿畫面：

```text
◆ read README.md
  └ 1.4k chars
◆ write notes.txt (120 chars)
  └ ok
◆ bash npm test
  └ 842 chars
```

Tool 執行失敗時，結束行會顯示錯誤訊息的字元數；完整錯誤仍會送回模型，讓 agent 可以自行修正。`◆ ...`、`└ ...` 這些 TUI tool logs 只輸出到終端，不寫入 session；JSONL 只保留模型 transcript 必須存在的 assistant `tool_calls` 與 tool result。

Bash output 超過 50KB 時，tool result 與 session 只保留最後 50KB，並附上回查路徑：

```text
[Output truncated. Full output: /project/.tiny-agent/tool-output/<uuid>.log]
```

完整 stdout/stderr 寫入 `.tiny-agent/tool-output/`；agent 可再用 `read` 讀取該 path。這個目錄不進 Git。

## Esc 中斷語意

互動或 one-shot 執行期間按 `Esc` 會透過同一個 `AbortController` 中斷目前 operation：

- **等待模型時**：取消 HTTP request；user message 保留，追加 `interruption { phase: "model" }`，不偽造 assistant message。下一個 prompt 會接在該 user message後。
- **tool 執行時**：取消目前 tool。已經完成的 tool results 保留；目前 call 寫入 `Operation aborted`；同一 assistant message 尚未執行的 calls 寫入 `Operation aborted before execution`。如此每個 `tool_call_id` 都有 result，後續 OpenRouter transcript 仍合法。
- **compaction 時**：取消摘要 request，舊 messages 完全不變，只追加 `interruption { phase: "compact" }`。
- **空閒時**：`Esc` 不做任何事。

每次中斷都 append-only 寫入 session：

```json
{"type":"interruption","phase":"tool","toolCallId":"call_123","reason":"escape","timestamp":"..."}
```

Resume 時 `interruption` 是 audit event，不會成為模型 message；實際可續跑的 context 由已持久化的 user/assistant/tool messages 重建。

usage 會像 pi-coding-agent 的 footer 一樣累計整個 session（包含同一 prompt 觸發的多輪 tool calls）：

```text
↑1.2k ↓30 R500 W100 CH27.8%
```

- `↑`：非 cache 的 input tokens
- `↓`：output tokens
- `R`：cache-read tokens
- `W`：cache-write tokens
- `CH`：最新一般模型 request 的 cache hit rate，即 `cacheRead / (input + cacheRead + cacheWrite)`

`input` 會先從 OpenRouter 的 `prompt_tokens` 扣掉 cache read/write，避免重複計算。若 upstream 沒有回傳 cache 資訊，就不顯示 `R`、`W`、`CH`。

## Project instructions

啟動及 resume 時只讀取目前工作目錄的：

```text
./AGENTS.md
```

若存在，全文會仿照 pi-coding-agent 的格式加入 system prompt：

```xml
<project_context>

Project-specific instructions and guidelines:

<project_instructions path="/project/AGENTS.md">
...AGENTS.md 全文...
</project_instructions>

</project_context>
```

為保持教學版精簡，不搜尋祖先目錄，也不支援 `AGENTS.override.md` 或 `CLAUDE.md`；檔案不存在時安靜略過。

## Session schema

每次 CLI 啟動會顯示 provider、model、session ID 與檔案路徑：

```text
tiny-agent
provider: openrouter
model: deepseek/deepseek-v4-flash-0731
session: 019fc5c3-79ae-7298-b7f3-182d602638c7
path: /project/.tiny-agent/sessions/2026-08-03T03-55-50-062Z_019fc5c3-79ae-7298-b7f3-182d602638c7.jsonl
```

結束時會提供恢復指令：

```bash
npm run dev -- --session 019fc5c3-79ae-7298-b7f3-182d602638c7
```

也可以恢復後直接送出新 prompt：

```bash
npm run dev -- --session 019fc5c3-79ae-7298-b7f3-182d602638c7 "繼續剛才的工作"
```

恢復會 replay message records；遇到 compaction record 時，會用 summary 與當時保留的最近訊息重建有效 context。Usage 則從全部歷史 records 累計。

每次新 session 的檔名為：

```text
.tiny-agent/sessions/2026-08-03T03-55-50-062Z_019fc5c3-79ae-7298-b7f3-182d602638c7.jsonl
```

檔名前半是 UTC ISO timestamp（把 `:`、`.` 換成 `-`），後半是依建立時間產生的 UUIDv7。`.tiny-agent/` 預設不提交 Git。

正式 schema 位於 [`schemas/session.schema.json`](schemas/session.schema.json)，使用 JSON Schema Draft 2020-12。JSONL 規則：

1. 每一行都是獨立 JSON object。
2. 第一行必須是 `type: "session"` header，包含 schema version、session ID、cwd、provider、model。
3. 後續依時間追加 `message` 或 `compaction` record。
4. assistant message 的 `usage` 是該次 API request 用量，不是 session 累計值。
5. tool result 記錄 `toolName` 與對應的 `tool_call_id`。
6. compaction 保留 summary、壓縮/保留訊息數與摘要 request 的 usage。

範例：

```jsonl
{"type":"session","version":1,"id":"019fc5c3-79ae-7298-b7f3-182d602638c7","createdAt":"2026-08-03T03:55:50.062Z","cwd":"/project","provider":"openrouter","model":"deepseek/deepseek-v4-flash-0731","timestamp":"2026-08-03T03:55:50.062Z"}
{"type":"message","message":{"role":"user","content":"只回答 ok"},"timestamp":"2026-08-03T03:55:51.000Z"}
{"type":"message","message":{"role":"assistant","content":"ok"},"usage":{"input":20,"output":1,"cacheRead":0,"cacheWrite":0},"timestamp":"2026-08-03T03:55:51.500Z"}
```

這個格式同時支援持久化與 `--session <UUIDv7>` resume。

單次模式：

```bash
npm run dev -- "列出目前目錄並解釋專案"
```

指定額外 skill：

```bash
npm run dev -- --skill ./some-skill/SKILL.md
```

預設只遞迴掃描：

```text
.tiny-agent/skills/**/SKILL.md
```

啟動時會解析 frontmatter，將每個 skill 的 `name`、`description` 與絕對 `location` 以 `<available_skills>` XML 填入 system prompt，但不會預先放入完整 instructions。模型判斷任務符合時，會使用 `read` 載入該 `SKILL.md`，維持 progressive disclosure；`/skill:name` 則會明確載入全文。

Repo 內附有可進版控的測試 skill：

```bash
npm run dev -- "say hello"
# 或進入互動模式後：/skill:hello
```

預期回答：

```text
Hello from tiny-agent-ts! Skill loaded successfully.
```

只有 `.tiny-agent/sessions/` 會被 Git 忽略，`.tiny-agent/skills/` 會正常進版控。

## Compact 的教學版語意

`/compact` 保留 system prompt 與至少最近 6 則訊息，並將切點向前移到 `user` message，避免拆散 assistant tool call 與 tool result。較舊內容交給同一模型摘要，再以 `[Compacted history]` 放回對話。這是刻意簡化的版本：不做 tokenizer 計算或自動觸發。

## 測試

測試 mock OpenRouter，不花 API 額度，但會確認 request 使用指定模型：

```bash
npm test
npm run check
```

若要 smoke test 真實 API：

```bash
OPENROUTER_API_KEY=... npm run dev -- "只回答 ok"
```

## 四語言路線

各版本維持相同協定與功能，避免被 framework 差異模糊重點：

1. TypeScript：先建立最容易閱讀的基準版（本目錄）
2. Python：標準函式庫 + HTTP client
3. Rust：serde/reqwest + readline
4. Go：標準函式庫優先

參考 pi-coding-agent 的核心觀念（tool loop、skills progressive disclosure、compaction），但不依賴它，讓讀者能看見機制本身。
