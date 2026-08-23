# 主流 Coding Agent 長對話壓縮比較

> 外部實作查核日期：2026-08-20；tiny-agent 現況更新：2026-08-23。這裡的「壓縮」是縮小後續送給模型的 active context；session 原始紀錄是否保留，是另一件事。

## 先看結論

`tiny-agent`的`/compact`是**client-side、由目前設定的模型產生摘要**：它透過OpenRouter Chat Completions發出另一個LLM request，不是本機演算法壓縮，也沒有使用OpenRouter/OpenAI/Anthropic的provider-side compaction API。它先從reducer materialized active context選擇切點：保留至少最近6則message，再向前移到user boundary，避免拆散完整turn。成功後，active context變成`system + 摘要 + retained message tail`。Canonical transactional JSONL則另外記錄durable source message-entry prefix的partition、digest、materialized retained tail及operation facts，保留先前audit trail。[tiny-agent實作](../typescript/src/index.ts)

| 實作                                | 壓縮機制                                                                                                            | 觸發門檻                                                                                     | 保留近期內容                                                                                                | 持久化與 resume                                                                                                                                       |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| **tiny-agent（目前）**              | 將目前 active context 中較舊的 messages 送到目前設定的模型摘要                                                      | 只有手動 `/compact`；沒有 token threshold                                                    | 至少最近 **6 messages**，再向前對齊 user boundary，保留完整 turn                                           | transactional JSONL 保存 compaction intent、attempt、checkpoint、usage 與 outcome；resume 由 summary + materialized retained tail 重建 active context |
| **pi-coding-agent / pi-agent-core** | client-side LLM 結構化摘要；重複 compact 時把 previous summary 與新內容合併                                         | 自動：`contextTokens > contextWindow - reserveTokens`；也可 `/compact [instructions]`        | 預設約 **20k tokens**，按合法切點保留；不在 tool result 前斷開                                              | append-only `CompactionEntry` 保存 summary、`firstKeptEntryId`、usage；resume 由 summary + kept entries 重建 active context                           |
| **Claude Code**                     | 官方只公開為「summarizes older history」的 model summarization                                                      | 接近 auto-compact window；也可 `/compact [instructions]`                                     | **官方文件未公開**精確保留量或切點演算法                                                                    | 官方說 session 可 `/resume`；但未公開 compact record schema、原文是否完整保留、resume replay 細節                                                     |
| **OpenAI Codex CLI**                | 兩條路：client-side model summary；支援時也可呼叫 Responses compaction                                              | 自動 token limit（model/config 決定），也有手動 compact                                      | local 路徑重建為摘要，另最多帶入約 **20k tokens 的 user messages**；remote 路徑使用 opaque compaction items | compacted replacement history 會存成 checkpoint；live 與 persisted history 使用同一 replacement；精確 rollout/resume 細節以 source 為準               |
| **OpenAI Agents SDK**               | `OpenAIResponsesCompactionSession` 呼叫 Responses API `responses.compact`，不是自行要求一般 chat model 寫可讀摘要   | 預設每 turn 後依 `should_trigger_compaction` 判斷；可關閉並手動 `run_compaction(force=True)` | provider 回傳 opaque compacted items；SDK 文件未承諾固定 recent-message 數                                  | wrapper clear-and-rewrite underlying session；失敗/取消會嘗試恢復舊 history；可用 response-id chain 或 input mode                                     |
| **Gemini CLI**                      | client-side Gemini utility model 產生 `<state_snapshot>`，再做第二次 verification；另先本機截短過大的舊 tool output | 預設達模型 token limit 的 **50%**；可 force                                                  | 依字元估算保留最新約 **30% history**；近期 function responses 有 50k-token budget                           | 壓縮後以 summary + confirmation + kept suffix 重啟 chat，沿用 recording service；JSONL resume 的精確 compaction representation 未在查核來源中完整說明 |

## tiny-agent 現況

`Agent.compact()` 的 production 流程如下（TypeScript reference位於 [`typescript/src/index.ts`](../typescript/src/index.ts)，其他語言遵循相同observable contract）：

1. 從reducer materialized current active context開始，先取至少最近6則message，再將切點向前移到user boundary，避免拆散完整turn。
2. 先持久化`compactionStarted`與實體`stepAttempt`，再透過OpenRouter `/api/v1/chat/completions`呼叫目前設定的模型產生摘要；request不帶tools。
3. 成功後以一個durable compaction checkpoint保存summary、durable source message-entry prefix的partition/digest與materialized retained tail；usage寫入獨立ledger，最後寫入`operationFinished(completed)`。重複compact時，prior summary會參與摘要輸入，但本身不是source message entry。
4. Active context重建為：

    ```text
    system
    + user: [Compacted history]\n<model-generated summary>
    + retained message tail
    ```

5. 原始JSONL facts不刪除。Resume由durable facts重建checkpoint；中斷、open attempt或已寫checkpoint但缺terminal outcome等crash prefix依recovery plan補齊，且重複resume保持idempotent。

因此它同時包含兩種技術，但角色不同：

- **本機partition**：決定哪些active-context messages送去摘要、哪些完整turn原樣保留。
- **模型摘要**：真正把較舊內容濃縮；會花input/output tokens，也可能遺漏資訊。

目前沒有auto-compaction；若使用者不下`/compact`，context會持續成長直到provider/model拒絕請求。

## 各家作法與證據

### pi-coding-agent / pi-agent-core

Pi 的官方 repository 文件與 source 描述得最完整：

- 預設 `reserveTokens = 16384`、`keepRecentTokens = 20000`。
- 自動條件為 `contextTokens > contextWindow - reserveTokens`。
- 從最新訊息往回估 token，找約 20k tokens 的 kept suffix；切點可在 user/assistant 等訊息，但不切在 tool result。
- 被移除的部分交給 LLM 產生固定章節的結構化 checkpoint；已有 previous summary 時做增量更新。
- compaction 是 append-only session entry；舊 entries 沒從 session 檔案消失，只是不再放進 active LLM context。
- `pi-agent-core` 提供 agent lifecycle，而 coding-agent 層負責 session entries、cut point、summarization 與 resume context reconstruction；把整套行為只歸給 core 並不精確。

來源：

- Pi compaction 官方文件：<https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/compaction.md>
- Pi compaction source：<https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/core/compaction/compaction.ts>
- Pi session manager source：<https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/core/session-manager.ts>

### Claude Code

Anthropic 官方文件明確確認：

- 接近 context limit 時 auto-compaction 會摘要 conversation history。
- `/compact Focus on ...` 可手動摘要並提供保留重點。
- 根目錄 `CLAUDE.md` 可寫 compact instructions。
- compaction 本身要讀取待摘要的大 context，所以也是一個可能昂貴的 request；若不需要延續，`/clear` 不花摘要 token。
- session 可命名後清除，日後用 `/resume` 返回。

但第一方公開文件沒有說明：使用哪個 model、精確 threshold、保留多少 recent messages/tokens、session file 中是否 append compaction checkpoint。因此這些欄位不能從公開證據推定成 pi 的做法。

來源：

- Claude Code usage/costs（含 auto-compaction、`/compact`、`/resume`）：<https://code.claude.com/docs/en/costs>
- Claude Code model configuration（auto-compact window）：<https://code.claude.com/docs/en/model-config#set-the-auto-compact-window>

### OpenAI Codex CLI 與 Responses API

Codex CLI source 同時具有 local 與 remote compaction：

- Local 路徑把 history 送模型，以 `SUMMARIZATION_PROMPT` 產生 summary，再呼叫 `replace_compacted_history()`；它會保留 user messages，合計上限常數為 20,000 tokens，並把 summary 放在 replacement history 尾端。
- Remote 路徑標示 implementation 為 `ResponsesCompact`，由 OpenAI Responses compaction 回傳 compacted history/opaque item，再替換 session history。
- Source 註解明確要求 persisted checkpoint 與 live replacement history 一致。
- 自動門檻使用 `model_auto_compact_token_limit`；公開 source 顯示此值可由 model/config 提供，但沒有單一跨模型固定數字可安全列為 Codex 預設。

OpenAI Responses API 本身另提供兩種 provider-side 模式：在 `/responses` 設 `context_management.compact_threshold` 的 server-side auto compaction，或明確呼叫 `/responses/compact`。輸出是 encrypted、opaque compaction item，不是給人閱讀的摘要；stateless chaining 可丟棄最近 compaction item 之前的 items，`previous_response_id` chaining 則不應手動 prune。

來源：

- Codex local compaction：<https://github.com/openai/codex/blob/main/codex-rs/core/src/compact.rs>
- Codex remote Responses compaction：<https://github.com/openai/codex/blob/main/codex-rs/core/src/compact_remote.rs>
- Codex config：<https://github.com/openai/codex/blob/main/codex-rs/core/src/config/mod.rs>
- OpenAI Compaction guide：<https://platform.openai.com/docs/guides/compaction>

### OpenAI Agents SDK

Agents SDK 的 `OpenAIResponsesCompactionSession` 是 session wrapper：

- 每 turn 後可自動判斷並呼叫 Responses `responses.compact`。
- `compaction_mode="previous_response_id"` 使用 response chain；`"input"` 從 session items 重建 request；`"auto"` 選可用方式。
- Compaction 完成後 clear-and-rewrite session history；SDK 序列化 replacement，失敗或 cancellation 時嘗試 rollback。
- 這不同於 `SessionSettings(limit=N)`：後者只是本機只取最近 N items，沒有摘要，也沒有生成 compact item。

來源：

- Agents SDK Sessions 官方文件：<https://openai.github.io/openai-agents-python/sessions/#openai-responses-compaction-sessions>
- Agents SDK source：<https://github.com/openai/openai-agents-python/tree/main/src/agents/memory>

### Gemini CLI

Gemini CLI 的第一方 source 顯示混合策略：

- 預設 token threshold 為 model limit 的 0.5。
- 先把超過 50k-token function-response budget 的較舊巨大 tool outputs 截成末 30 行並存外部檔案。
- 以 split point 將約前 70% 交給 utility compressor，保留最新約 30%。
- 第一個 model call 產生 `<state_snapshot>`，第二個 call 要模型檢查是否遺漏技術細節並產生 final snapshot。
- 若壓縮後 token 反而更多，不採用結果；若非強制壓縮曾失敗，後續可只依賴 truncation，避免反覆付摘要成本。

來源：

- Gemini CLI chat compression source：<https://github.com/google-gemini/gemini-cli/blob/main/packages/core/src/context/chatCompressionService.ts>
- Gemini CLI client integration：<https://github.com/google-gemini/gemini-cli/blob/main/packages/core/src/core/client.ts>
- Gemini CLI recording/resume source：<https://github.com/google-gemini/gemini-cli/blob/main/packages/core/src/services/chatRecordingService.ts>

## 名詞對照

| 類型                          | 做法                                                                              | 代表                                                                                   |
| ----------------------------- | --------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| Local truncation              | 不呼叫模型，直接只取最近 N items，或截短舊 tool output                            | Agents SDK `SessionSettings(limit=N)`；Gemini CLI tool-output truncation               |
| Model-generated summarization | Client 組 prompt，呼叫一般模型產生可讀摘要                                        | tiny-agent、pi、Claude Code（官方描述）、Codex local、Gemini CLI                       |
| Provider-side compaction API  | Provider 產生 opaque compact item，保留模型狀態/推理，client 不解析為自然語言摘要 | OpenAI Responses server-side / standalone compaction；Codex remote；Agents SDK wrapper |

這三者可以混用。Gemini CLI 先 truncation 再 summarization；Codex 可按 provider capability 選 local summary 或 Responses compaction。`tiny-agent` 現在使用對齊user boundary的recent-message retention、model summary與durable compaction checkpoint。
