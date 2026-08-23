<p align="center">
  <img src="assets/hero.png" alt="A tiny robot agent looking toward a wide blue sky" width="100%">
</p>

<h1 align="center">tiny-agent</h1>

<p align="center"><a href="https://tiny-agent.geminixiang.com">閱讀繁體中文教學書</a></p>

用最少概念實作可用的 AI coding agent。這個教學專案會分別用 TypeScript、Python、Rust、Go 完成 POC；目前四種語言版本皆已完成。

## 架構

```mermaid
flowchart TD
    User["User prompt"] --> CLI["tiny-ts / tiny-go / tiny-py / tiny-rs"]
    Host["Trusted host / deployment"] --> Catalog["Trusted MCP catalog + tokenEnv"]
    Catalog --> CLI
    CLI --> Context["AGENTS.md + skills + session"]
    Context --> Loop["Agent loop"]
    Loop --> Model["OpenRouter / LLM"]
    Model --> Decision{"tool calls?"}
    Decision -- no --> Answer["Final answer"]
    Decision -- yes --> Dispatch["Tool dispatch"]
    Dispatch --> Local["Local tools\nbash / read / write / edit"]
    Dispatch --> MCP["MCP tools\ntrusted named servers"]
    Local --> Results["Tool results"]
    MCP --> Results
    Results --> Loop
    Loop --> Session["Durable operation facts\ncanonical transactional JSONL"]
    Loop -. "tiny-ts --json" .-> Events["Structured run events"]
```

Agent loop 的核心保持不變；MCP不改變tool-call/result語意。TypeScript、Go與Python將MCP tools適配到通用Tool seam；Rust目前仍使用獨立的`McpTool` dispatch，後續再收斂到相同seam：

```text
messages → model → tool calls → tool results → model
```

## 功能

四種語言共同支援：

- OpenRouter與可覆寫的 `TINY_MODEL`
- Agent loop與 `bash`、`read`、`write`、`edit`
- Local `--plugin` capability allowlist
- `AGENTS.md`、skills、durable compaction與canonical JSONL session
- Cancellation、token與prompt-cache usage
- Trusted named Streamable HTTP MCP servers
- MCP discovery、calling、timeouts、bounds與cleanup

TypeScript另外提供programmatic injectable `Tool[]` seam與`--json` structured monitoring。

核心實作：[`typescript/src/index.ts`](typescript/src/index.ts)、[`typescript/src/tools.ts`](typescript/src/tools.ts)、[`typescript/src/mcp.ts`](typescript/src/mcp.ts)、[`typescript/src/cli.ts`](typescript/src/cli.ts)、[`go/cmd/tiny-go/main.go`](go/cmd/tiny-go/main.go)、[`python/tiny_agent/agent.py`](python/tiny_agent/agent.py)、[`python/tiny_agent/cli.py`](python/tiny_agent/cli.py)、[`rust/src/lib.rs`](rust/src/lib.rs)、[`rust/src/terminal.rs`](rust/src/terminal.rs)。共用的 skills、session schema與文件留在repo root。

## 安裝

本專案的安裝與開發前置需求為 Node.js 22+、Go 1.24+、Python 3.12+（由 [uv](https://docs.astral.sh/uv/) 管理）、Rust 1.85+（edition 2024，需 `cargo`），以及 [OpenRouter API key](https://openrouter.ai/settings/keys)：

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

### MCP

四個CLI都能從trusted catalog載入MCP tools。使用`--mcp`時必須明確設定`TINY_MCP_CONFIG`指向catalog路徑，沒有預設位置也沒有home目錄fallback；未設定時會直接報錯。

```json
{
    "servers": {
        "sentry": {
            "url": "https://mcp.internal.example/sentry",
            "tokenEnv": "TINY_MCP_TOKEN_SENTRY",
            "allowedTools": ["search_issues", "get_issue"],
            "callTimeoutMs": 30000
        }
    }
}
```

執行任一版本：

```bash
export TINY_MCP_CONFIG=/trusted/path/mcp.json
export TINY_MCP_TOKEN_SENTRY=...
tiny-ts --mcp sentry --plugin read "調查 issue"
tiny-go --mcp sentry --plugin read "調查 issue"
tiny-py --mcp sentry --plugin read "調查 issue"
tiny-rs --mcp sentry --plugin read "調查 issue"
```

`--mcp`可重複或用逗號分隔。啟動後會顯示實際能力：

```text
MCP sentry: connected (2026-07-28, 2 tools)
tools: read, mcp:sentry/search_issues, mcp:sentry/get_issue
mcp: sentry
```

Catalog只保存token的環境變數名稱；runtime不會驗證credential是否短效。`TINY_MCP_CONFIG`是唯一的catalog來源，不會讀取repository config，也不接受CLI傳入URL、header或token。正式多租戶部署應由trusted gateway注入短效、tenant/job-scoped credential；這是部署建議，不是tiny-agent runtime保證。

只支援modern MCP protocol（`2026-07-28`）、`tools/list`與`tools/call`；不協商、不降級到任何舊版protocol，連線到只講舊版protocol的server會直接失敗並回報清楚錯誤。多租戶部署應連到trusted gateway；MCP不是sandbox或authorization boundary。

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
/compact       摘要舊對話，保留至少最近 6 則 message，並將切點移到 user boundary
/skill:i-have-adhd   明確載入 i-have-adhd skill
/exit          結束並顯示 session 恢復指令
Esc            中斷目前的 model、tool 或 compact operation
Ctrl+C         退出並顯示 session 恢復指令
```

`Esc`是對目前active phase發出的控制訊號，不是agent loop中的下一個步驟。Agent會先將`abortRequested`寫入Session，再通知當前的model、tool或compact operation，最後補齊durable result與operation outcome；model與tool取消不是依序執行的兩個階段。

`Ctrl+C`在有active operation時先走同一條abort路徑，再結束CLI。CLI退出時會關閉MCP clients與Session writer並恢復terminal；正常`/exit`也會做這些lifecycle cleanup，但不需要取消operation。

Tool 執行時只在終端顯示精簡 log：

```text
◆ read README.md
  └ 1.4k chars
```

TUI log不寫入session；模型transcript所需的tool call/result會保存。Bash output超過50KB時會截短送入模型；若該語言實作已完整捕獲輸出，完整內容會另存於`.tiny-agent/tool-output/`並留下回查path。各實作另有約10MB的capture safety limit；超限時不保證完整輸出，可能回傳capped-output標記或tool error。確切cap與stdout/stderr合併方式屬於語言實作限制。

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

Session使用canonical transactional JSONL：第一行是session header，其後每一行是一個完整transaction。它保存accepted prompt、model attempt、assistant message，以及即將執行外部effect的tool intent；invalid、unknown或truncated tool calls則保存未執行的synthetic result。Session也保存tool results、abort requests、operation outcomes、compaction checkpoints與獨立usage ledger。正式格式與recovery invariants見[`schemas/session.schema.json`](schemas/session.schema.json)及[`docs/session-design.md`](docs/session-design.md)。

Process crash 後，`--session` 會先由 durable facts 重建狀態，再執行 recovery plan：不確定的 model request 最多重試一次；只有完全相同的內建 `read` 可安全 replay；`bash`、`write`、`edit`、plugin與MCP tool一律不自動重播。Configuration或environment identity不符時，resume會停止且不執行 effect。

Session只承諾process-crash durability，不承諾power-loss durability。格式採single-writer contract；runtime只在同一process內阻止重複writer，跨process互斥必須由外層job runner保證。

## Skills 與專案指令

預設掃描：

```text
.tiny-agent/skills/**/SKILL.md
```

啟動時只把skill的`name`、`description`、`location`放進system prompt；模型需要時再用`read`載入全文。Repo內附有[`i-have-adhd` skill](.tiny-agent/skills/i-have-adhd/SKILL.md)，可把後續回答調整成更容易開始與持續執行的格式：

```text
/skill:i-have-adhd 幫我把這個功能拆成可以直接執行的步驟
```

Skill載入後會持續套用到本次session，例如首行直接給下一步、將工作編號、重述目前狀態並使用具體時間估計。要停用時輸入：

```text
stop adhd mode
```

若目前目錄存在 `AGENTS.md`，其全文也會加入 system prompt。

## Compact

`/compact`是獨立的durable operation。它先從reducer materialized active context選擇切點：保留至少最近6則message，再向前移到user boundary，避免拆散完整turn。Session另外記錄截至`inputThroughEntryId`的durable source message-entry partition、digest與materialized retained tail；重複compact時，prior summary會參與摘要輸入，但本身不是source message entry。成功後active context改為：

```text
system prompt + compacted summary + retained message tail
```

原始 JSONL records 不刪除，因此 session 仍可 audit 與 resume。主流 coding agent 的做法比較見 [`docs/compaction-comparison.md`](docs/compaction-comparison.md)。

## 開發

所有開發指令都從 repo root 執行：

```bash
make test
make test-mcp     # TypeScript reference MCP fixture；其他語言由各自test suite覆蓋
make check
make format
make build
make book-build
make book-test
```

教學書原始內容位於 [`book/`](book/README.md)，靜態產物可直接部署至 Cloudflare Pages。

個別實作也可使用 `make test-ts`、`make test-go`、`make test-py`、`make test-rs` 等對應target。普通測試使用mock OpenRouter，不消耗API額度；公開MCP endpoints只作optional compatibility smoke。

## 四語言狀態

| CLI       | Agent / session / skills | MCP | Structured monitoring |
| --------- | -----------------------: | --: | --------------------: |
| `tiny-ts` |                        ✓ |   ✓ |              `--json` |
| `tiny-go` |                        ✓ |   ✓ |                     — |
| `tiny-py` |                        ✓ |   ✓ |                     — |
| `tiny-rs` |                        ✓ |   ✓ |                     — |

四種實作以相同observable CLI、catalog、tool-result與cleanup contract為目標。Canonical Session reducer與recovery planner由shared fixtures直接驗證；MCP、CLI與tool lifecycle目前由各語言測試分別覆蓋，因此仍可能存在語言限制與observable差異。

Rust 版使用 `ureq`（blocking HTTP）、`libc` + `unicode-width`（raw terminal 與 CJK 顯示寬度）、`serde`（session/JSON）。model request 設有 connect/read/write timeout；按 Esc 會立即停止前景等待，但 `ureq` 的 blocking transport thread 可能在 timeout 前繼續完成。Bash 工具則會清除整個 process group。

## 致謝

Tiny-agent的許多設計思考受到[Pi](https://github.com/earendil-works/pi)啟發，特別是精簡的agent loop、Tool模型、skills漸進載入、compaction，以及如何讓coding agent保持可理解與可操作。感謝Pi及其貢獻者公開實作與文件，讓這個專案能站在扎實的工程經驗上繼續拆解、實驗與教學。

Tiny-agent不是Pi的fork或移植；它是獨立的四語言教學實作，並針對transactional Session、crash recovery與跨語言conformance發展自己的contract。書中提到相關設計時，會盡量區分「源自Pi的啟發」、「通用agent原理」與「tiny-agent自己的取捨」。

## License

[MIT](LICENSE) © 2026 Ying Xiang
