<p align="center">
  <img src="assets/hero.png" alt="A tiny robot agent looking toward a wide blue sky" width="100%">
</p>

<h1 align="center">tiny-agent</h1>

用最少概念實作可用的 AI coding agent。這個教學專案會分別用 TypeScript、Python、Rust、Go 完成 POC；目前四種語言版本皆已完成。

## 架構

```mermaid
flowchart TD
    CLI["tiny-ts / tiny-go / tiny-py / tiny-rs CLI"] --> Context["載入 AGENTS.md、skills、session"]
    Context --> User["User prompt"]
    User --> Model["OpenRouter / LLM"]
    Model --> Decision{"有 tool calls?"}
    Decision -- 否 --> Answer["顯示回答並寫入 session"]
    Decision -- 是 --> Tools["bash / read / write / edit"]
    Tools --> Result["Tool result 寫入 session"]
    Result --> Model
    CLI -- Esc --> Abort["AbortController"]
    Abort --> Model
    Abort --> Tools
```

Agent loop 的核心：

```text
user prompt → model → tool calls → tool results → model → final answer
```

## 功能

- OpenRouter；預設 `deepseek/deepseek-v4-flash-0731`
- Agent loop 與 `bash`、`read`、`write`、`edit`
- `.tiny-agent/skills/**/SKILL.md` 漸進載入
- 啟動時讀取 `./AGENTS.md`
- `/compact` 壓縮舊對話
- JSONL session 與 `--session` 恢復
- `Esc` 中斷 model、tool、compaction
- Token、cache usage 與精簡 tool log

核心實作：[`typescript/src/index.ts`](typescript/src/index.ts)、[`typescript/src/cli.ts`](typescript/src/cli.ts)、[`go/cmd/tiny-go/main.go`](go/cmd/tiny-go/main.go)、[`python/tiny_agent/agent.py`](python/tiny_agent/agent.py)、[`python/tiny_agent/cli.py`](python/tiny_agent/cli.py)、[`rust/src/lib.rs`](rust/src/lib.rs)、[`rust/src/terminal.rs`](rust/src/terminal.rs)。共用的 skill、session schema 與文件留在 repo root。

## 安裝

需要 Node.js 22+、Go 1.24+、Rust 1.85+（`cargo`）、[uv](https://docs.astral.sh/uv/) 與 [OpenRouter API key](https://openrouter.ai/settings/keys)：

```bash
git clone https://github.com/geminixiang/tiny-agent.git
cd tiny-agent
make install
export OPENROUTER_API_KEY=sk-or-...
```

這會從 repo root 安裝四個 CLI，且用法一致：

```bash
tiny-ts
tiny-go
tiny-py
tiny-rs
```

使用 `nvm` 切換 Node.js 版本後需再次執行 `make install-ts`。若 shell 找不到 `tiny-go`，請將 `$(go env GOPATH)/bin` 加入 `PATH`。

指定其他 OpenRouter model：

```bash
TINY_MODEL=anthropic/claude-sonnet-4.5 tiny-ts
```

單次執行：

```bash
tiny-ts "讀取 README 並摘要"
```

Go、Python、Rust 與 TypeScript 版共用 `TINY_MODEL`、`--skill`、`--session` 與 one-shot prompt：

```bash
tiny-go "讀取 README 並摘要"
tiny-py "讀取 README 並摘要"
tiny-rs "讀取 README 並摘要"
```

## 使用

互動指令：

```text
/compact       摘要舊對話，保留至少最近 6 則完整 turn
/skill:hello   明確載入 hello skill
/exit          結束並顯示 session 恢復指令
Esc            中斷目前的 model、tool 或 compact operation
Ctrl+C         退出並顯示 session 恢復指令
```

Tool 執行時只在終端顯示精簡 log：

```text
◆ read README.md
  └ 1.4k chars
```

TUI log 不寫入 session；模型 transcript 所需的 tool call/result 會保存。Bash output 超過 50KB 時，完整內容另存於 `.tiny-agent/tool-output/`，session 只保留尾端與回查 path。

## Session

每次執行都寫入：

```text
.tiny-agent/sessions/<timestamp>_<uuid-v7>.jsonl
```

結束時會顯示：

```bash
tiny-ts --session <session-id>
```

也可恢復後直接送出 prompt：

```bash
tiny-ts --session <session-id> "繼續剛才的工作"
```

Session 採 append-only records，保存 message、tool result、compaction、interruption 與 usage。正式格式見 [`schemas/session.schema.json`](schemas/session.schema.json)。

## Skills 與專案指令

預設掃描：

```text
.tiny-agent/skills/**/SKILL.md
```

啟動時只把 skill 的 `name`、`description`、`location` 放進 system prompt；模型需要時再用 `read` 載入全文。Repo 內附有 [`hello` skill](.tiny-agent/skills/hello/SKILL.md)：

```bash
tiny-ts "say hello"
```

若目前目錄存在 `AGENTS.md`，其全文也會加入 system prompt。

## Compact

`/compact` 將較舊對話送給目前模型摘要，active context 改為：

```text
system prompt + compacted summary + 最近至少 6 則完整 turn
```

原始 JSONL records 不刪除，因此 session 仍可 audit 與 resume。主流 coding agent 的做法比較見 [`docs/compaction-comparison.md`](docs/compaction-comparison.md)。

## 開發

所有開發指令都從 repo root 執行：

```bash
make test
make check
make format
make build
```

個別實作也可使用 `make test-ts`、`make test-go`、`make test-py`、`make test-rs` 等對應 target。測試使用 mock OpenRouter，不消耗 API 額度。

## 四語言路線

1. TypeScript：目前版本
2. Go：目前版本
3. Python：目前版本
4. Rust：目前版本

Rust 版使用 `ureq`（blocking HTTP）、`libc` + `unicode-width`（raw terminal 與 CJK 顯示寬度）、`serde`（session/JSON）。model request 設有 connect/read/write timeout；按 Esc 會立即停止前景等待，但 `ureq` 的 blocking transport thread 可能在 timeout 前繼續完成。Bash 工具則會清除整個 process group。

## License

[MIT](LICENSE) © 2026 Ying Xiang
