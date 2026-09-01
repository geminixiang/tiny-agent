# 四語言 Bash Output 行為矩陣

範圍：`bash` tool 的 timeout、失敗結果、輸出截斷、落盤與 10 MB safety cap。

TypeScript 是 Reference Behavior。Go、Python、Rust 現在由共享 contract `schemas/tools/bash-contract.json` 鎖定相同的可觀察結果。

## 對照表

| 行為 | TypeScript | Go | Python | Rust |
| --- | --- | --- | --- | --- |
| 預設 timeout | 120 秒 | 120 秒 | 120 秒 | 120 秒 |
| 自訂 timeout | `timeout > 0` | 同左 | 同左 | 同左 |
| 無輸出成功 | `(no output)` | 同左 | 同左 | 同左 |
| 非零 exit | 回傳 output 加 `Command exited with code N`，不是 tool exception | 同左 | 同左 | 同左 |
| timeout | 回傳 output 加 `Command timed out after N seconds.` | 同左 | 同左 | 同左 |
| 一般截斷 | 超過 2,000 行或 50 KB 時回傳 UTF-8-safe tail | 同左 | 同左 | 同左 |
| 一般截斷落盤 | `.tiny-agent/tool-output/<id>.log`，標示 `Full output` | 同左 | 同左 | 同左 |
| capture safety cap | stdout 或 stderr 超過 10,000,000 bytes 時終止 process group | 同左 | 同左 | 同左 |
| cap 結果 | 非錯誤結果，加入 `Bash output exceeded the 10MB safety cap; complete output was not captured.` | 同左 | 同左 | 同左 |
| cap 落盤標籤 | `Captured output; command exceeded the 10MB safety cap` | 同左 | 同左 | 同左 |
| cancellation | 終止 process group，回報 operation aborted | 同左 | 同左 | 同左 |

## Executable contract

`schemas/tools/bash-contract.json` 由四個 runtime 的測試共同執行，涵蓋：

- 無輸出成功
- 帶輸出的失敗
- 無輸出的失敗
- 帶部分輸出的 timeout
- 超過 2,000 行時的 tail、行號提示與完整輸出落盤

各語言仍保留平台必要的 process API 差異，但 model、TUI、session 與 JSON monitoring 可觀察到的 Bash result contract 以 tiny-ts 為準。

## MCP 對齊狀態

| 行為 | TypeScript | Go | Python | Rust |
| --- | --- | --- | --- | --- |
| Client implementation | 官方 MCP SDK v2 | 官方 Go SDK v1.7 | 官方 `mcp` v2.1.1 | 官方 `rmcp` v3.2 |
| Lifecycle mode | auto | auto | `Client(..., mode="auto")` | `ClientLifecycleMode::Auto` |
| Modern protocol | `2026-07-28` | 同左 | 同左 | 同左 |
| Legacy initialize | SDK-owned，支援 2025-era server | 同左 | 同左；fixture 驗證 `2025-03-26` | 同左；提供 `2025-11-25` 並驗證 server counter-select `2025-03-26` |
| Bearer auth | `tokenEnv` | 同左 | 同左 | 同左 |
| Metabase API key | `auth: { type: "metabaseApiKey", tokenEnv }` → `X-API-Key` | 同左 | 同左 | 同左 |
| Session ID / initialized / DELETE | SDK-owned，不寫入 tiny-agent Session | 同左 | 同左 | 同左 |
| Tool list/call、allowlist、bounds、normalization | tiny-agent adapter contract | 同左 | 同左 | 同左 |

Python 與 Rust 已移除 runtime 中手寫的 modern-only MCP wire lifecycle；protocol negotiation、legacy initialize notification、transport parsing、session ID 與 shutdown 由官方 SDK 管理。tiny-agent 仍只保留 trusted catalog、allowlist、名稱映射、schema/result bounds、timeouts、normalization 與 cleanup policy。

### 已知 SDK 限制

Rust `rmcp` 3.2 的 `x-mcp-header` transport promotion 僅接受 top-level `properties`；nested property annotation 會由 SDK 在 tool listing 階段拒絕。TypeScript、Go 與 Python 可接受 pure `properties` chain 的 nested annotation。這是目前唯一保留的 MCP adapter 可觀察差異；Rust 測試明確鎖定 top-level 行為，不以手寫 wire fallback 繞過官方 SDK。
