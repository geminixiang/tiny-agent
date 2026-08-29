<p align="center">
  <img src="assets/hero.png" alt="A tiny robot agent looking toward a wide blue sky" width="100%">
</p>

<h1 align="center">tiny-agent</h1>

<p align="center"><a href="https://tiny-agent.geminixiang.com">閱讀繁體中文教學書</a></p>

用 TypeScript、Go、Python、Rust 實作的四個 minimal AI coding agent：

```text
tiny-ts / tiny-go / tiny-py / tiny-rs
```

四個版本都能呼叫 OpenRouter、執行 `bash/read/write/edit`、讀取 `AGENTS.md` 與 skills，並支援 MCP、Session 恢復、compaction、usage/cache 與 cancellation。完整原理與實作解說請閱讀 [tiny-agent Book](https://tiny-agent.geminixiang.com)。

## 安裝

先 clone repository：

```bash
git clone https://github.com/geminixiang/tiny-agent.git
cd tiny-agent
```

安裝想使用的版本：

```bash
make install-ts   # Node.js 22+
make install-go   # Go 1.25+
make install-py   # Python 3.14+ 與 uv
make install-rs   # Rust 1.85+
```

也可以一次安裝四個版本：

```bash
make install
```

## 使用

設定 OpenRouter API key：

```bash
export OPENROUTER_API_KEY=sk-or-...
```

執行任一版本：

```bash
tiny-ts "讀取 README 並摘要"
tiny-go "讀取 README 並摘要"
tiny-py "讀取 README 並摘要"
tiny-rs "讀取 README 並摘要"
```

預設模型是 `deepseek/deepseek-v4-flash-0731`。使用 `TINY_MODEL` 選擇其他 OpenRouter 模型：

```bash
TINY_MODEL=anthropic/claude-sonnet-4.5 tiny-ts "修正測試"
```

預設使用目前 shell 的工作目錄。也可以用 `--cwd` 指定 workspace；AGENTS.md、skills、tools、sessions 與背景 process 都會以該目錄為準：

```bash
tiny-ts --cwd /path/to/project "讀取 README 並摘要"
```

Session 保存在 workspace 的 `.tiny-agent/sessions/`。使用 Session ID 繼續工作：

```bash
tiny-ts --session <session-id>
```

互動模式支援：

```text
/compact
/skill:<name>
/exit
Esc      中止目前操作
Ctrl+C   離開
```

## MCP

Repository 已提供 [`.tiny-agent/mcp.json`](.tiny-agent/mcp.json)，其中只記錄 GitHub endpoint、tool allowlist 與 credential 的環境變數名稱，不包含 token。

設定 catalog 路徑與 GitHub token：

```bash
export TINY_MCP_CONFIG="$PWD/.tiny-agent/mcp.json"
export GITHUB_MCP_TOKEN="$(gh auth token)"
tiny-ts --mcp github --plugin read "只使用 GitHub MCP 的 get_file_contents，讀取 geminixiang/tiny-agent 的 README"
```

`TINY_MCP_CONFIG` 是使用 MCP 時唯一的 catalog 來源。tiny-agent 不會自動讀取 repository 或 home directory 內的設定。

`tiny-ts` 另支援固定的 Metabase API key auth，不接受任意 header。私有 Server 請放在 deployment-owned catalog，不要提交 hostname 或 key：

```json
{
    "servers": {
        "analytics": {
            "url": "https://{your-metabase.example.com}/api/metabase-mcp",
            "auth": {
                "type": "metabaseApiKey",
                "tokenEnv": "METABASE_MCP_API_KEY"
            },
            "allowedTools": ["execute_question"],
            "callTimeoutMs": 30000
        }
    }
}
```

TypeScript 與 Go 使用官方 MCP SDK 自動協商 protocol；Python 與 Rust 目前仍只接受 `2026-07-28`。

## 致謝

Tiny-agent 受到 [Pi](https://github.com/earendil-works/pi) 對 agent loop、Tool、skills、compaction 與可理解工程設計的啟發。Tiny-agent 不是 Pi 的 fork 或移植。

## License

[MIT](LICENSE) © 2026 Ying Xiang
