# `book/` 內容校驗報告

> **修正狀態：已處理。** 本報告記錄的是修正前的校驗基線；其中「需修正」與「過度概括」項目已於同日更新至 `book/src/chapters/00–08`、`book/src/chapters.js` 與首頁內容，並重新產生 `book/dist`。CI 也已加入 `npm --prefix book test`。實際驗證包括 book build/check、TypeScript recovery/abort/compaction 43 項測試、Go filesystem contract，以及 Rust 2 項明確啟用的 crash-recovery 測試，全部通過。

校驗日期：2026-08-29  
校驗範圍：`book/README.md`、`book/src/chapters.js`、`book/src/chapters/00–08`、靜態建置，以及教材直接引用的 TypeScript reference implementation、跨語言 contracts/tests、eval runner、威脅模型與第一方外部文件。

## 結論摘要

教材的**核心架構主線大致正確**：canonical agent loop、provider normalization、intent-before-effect、append-only session、pure reducer/planner、durable cancellation、compaction partition、離線contract tests及外層multi-tenant capsule，均能在repo找到實作或設計文件支持。但目前不宜直接以「已精確對應實作／production-ready」方式發布，原因是多處把**設計目標寫成既有保證**，並有數項與程式碼直接矛盾。

優先修正順序：

1. **安全邊界：** tiny-agent file/bash tools沒有cwd containment或OS sandbox；Execution Capsule是deployment責任，不是repo既有功能。
2. **不可篡改／durability：** JSONL與`sourceDigest`提供framing和一致性檢查，不是防惡意寫入的tamper-proof audit log；沒有fsync也不承諾power-loss durability。
3. **Provider與tool protocol：** API不全是無狀態；tool call未必strict structured output；finish reason與recovery分支需按actual code重寫。
4. **取消與process cleanup：** durable abort ordering正確，但Esc不會自動清理所有已啟動background process，也沒有通用foreground process-tree TERM→KILL supervisor。
5. **Recovery教材與labs：** actual plan union不只四類，`attempts_exhausted` runtime行為與表格衝突；兩個hands-on test pattern沒有執行宣稱的cases。
6. **Observability與CI：** structured events正確，但不是自動接上OTel/Prometheus，也不能宣稱payload已完全脫敏；現有GitHub workflow沒有跑book。
7. **文字級阻斷錯誤：** `chapters.js`寫成「runtime 驗證必須別做」，應立即改為「仍必須做」。

## 判定標準與方法

- **正確：** 可由當前source/tests/schema或第一方規格直接支持。
- **需修正：** 與實作、測試結果或第一方規格衝突，或範例會誤導讀者。
- **過度概括／缺乏依據：** 方向可能合理，但用了「永遠、唯一、完全、不可篡改、保證」等超出證據的措辭，或沒有指定provider/model/platform/threat model。
- 以`book/src`為內容source of truth；`book/dist`視為generated output，只驗證能否一致重建。

## 實際執行的驗證

- `npm --prefix book test`：通過，建置10 pages / 21 assets。
- `npm --prefix book run check`：通過，建置10 pages / 21 assets。
- 第02章兩個normalization test patterns：通過（2 tests、1 test）。
- 第07章 `node --import tsx --test --test-name-pattern="abort|compaction" tests/index.test.ts`：14/14通過。
- 第06章 `--test-name-pattern="planner"`：只命中metadata schema test，未命中主要recovery decision fixtures。
- 第06章 `cargo test --test crash_recovery`：0 passed、2 ignored；預設命令沒有執行kill -9 tests。
- 教材引用的eval verifier與docs檔案均存在。
- 未把`make test && make check`的整套結果冒充成本次證據；本次只記錄實際執行或由現有CI/source可追溯的項目。

## 執行驗證

- `cd book && npm test`：通過，建置 10 pages / 21 assets。
- 第 02 章列出的兩個測試指令均通過：
  - `--test-name-pattern="normalizes provider-only"`：2 tests passed。
  - `--test-name-pattern="rejects malformed provider assistant"`：1 test passed。

## 第 00 章 `00-foundations.html`

### 正確／有實作或第一方文件支持

1. **Context window 包含輸入、輸出（部分模型另含 reasoning tokens），tool definitions 與 tool results 也占用 context**（00:145–150）。OpenAI 將 context window 定義為單次 request 可用的最大 token 數，含 input/output/reasoning；Anthropic明列 system prompt、messages（含 tool results/images/documents）、tool definitions 與生成輸出皆計入。[OpenAI conversation state](https://platform.openai.com/docs/guides/conversation-state#managing-the-context-window)、[Anthropic context windows](https://docs.anthropic.com/en/docs/build-with-claude/context-windows)
2. **Prompt caching 不擴大 context window**（00:212、230）。Anthropic明列 `input_tokens`、`cache_read_input_tokens`、`cache_creation_input_tokens` 三者全都計入 window；因此 cache hit 只改變成本/延遲，不釋放容量。[Anthropic context windows](https://docs.anthropic.com/en/docs/build-with-claude/context-windows)、[Anthropic prompt caching](https://docs.anthropic.com/en/docs/build-with-claude/prompt-caching)
3. **需在 Host 端解析與驗證工具參數**（00:211、222–231）。本 repo `parseToolArgs` 拒絕非 JSON object，builtin tools逐欄驗證型別（`typescript/src/index.ts:244–249, 852–860`; `typescript/src/tools.ts:16–38,129–165,191–197,232–240`），測試亦驗證 malformed args 不執行（`typescript/tests/index.test.ts:2080–2115`）。OpenAI Chat Completions function calling 非 strict 預設是 best effort；官方建議 `strict: true` 才可靠遵循 schema。[OpenAI function calling — Strict mode](https://platform.openai.com/docs/guides/function-calling#strict-mode)
4. **Compaction/selection/bounding 是合理的 context 管理手法**（00:156–165）。Anthropic亦指出 context 越長 recall/accuracy 會退化（context rot）且 server-side compaction 是長時 workflow 的主要策略。[Anthropic context windows](https://docs.anthropic.com/en/docs/build-with-claude/context-windows)

### 需修正

1. **「Model 永遠只看本次 Request 明確送入的資料／延續完全靠 Host 重送」應限縮到本 repo 的 OpenRouter Chat Completions adapter**（00:28–31，且影響 01、02 的同類敘述）。現代 API 可由 provider 保存/串接狀態：OpenAI Responses API 的 `previous_response_id` 可共享先前 response context，WebSocket mode 還有 connection-local cache。底層模型仍可作無狀態抽象，但 API 層不宜寫成普遍、絕對事實。[OpenAI conversation state — previous_response_id](https://platform.openai.com/docs/guides/conversation-state#openai-apis-for-conversation-state)；本 repo 確實每次 POST `{model,messages,tools}`：`typescript/src/index.ts:678–690`。
2. **Tool Call 並非一概是「Constrained Structured Output」**（00:168–170）。本 repo 的 `toolDefinitions()` 沒送 `strict: true`（`typescript/src/tools.ts:556–560`），而 OpenAI 明載 Chat Completions 預設仍是 non-strict/best-effort。建議改為「結構化的工具呼叫提議；若 provider/model 支援且啟用 strict mode，才有 schema adherence 保證；Host 仍須驗證」。[OpenAI function calling — Strict mode](https://platform.openai.com/docs/guides/function-calling#strict-mode)
3. **「Host 驗證路徑合法性、安全邊界」與目前實作不符**（00:173–183）。TS `resolvePath` 接受 absolute path 且只做 `resolve`，測試明確要求可操作 cwd 外路徑及 symlink（`typescript/src/tools.ts:89–91`; `typescript/tests/index.test.ts:1887…`）；沒有 cwd sandbox/path containment。應改為「驗證參數型別與 plugin allowlist；目前 filesystem tools 未限制在 cwd」。此點亦影響 01:145、173、192。
4. **狀態表把 Transcript 固定描述為 heap 且 process 結束消失，與本 repo durable design 混淆**（00:197、232）。Transcript 是訊息序列概念，可存在 heap，也可由 JSONL facts 重建；本 repo `restoreState` 用 `state.activeContext` 重建 `messages`（`typescript/src/index.ts:556–559`）。建議把「in-memory transcript view」與「durable fact log/session」分開，而不是把 Transcript 的儲存媒介定死。
5. **「Tool result 是真實返回值／唯一憑證」與「exit 0 + stdout/stderr 是唯一客觀證據」過強**（00:99、213、233）。Tool output 只表示 adapter 回傳的 observation，可能含不可信遠端內容、程式自行偽造文字、partial test selection；exit 0 只證明該 command 依自身契約成功退出，不能單獨證明「所有測試」皆執行或結果真實。建議改為「比模型自述更強的可稽核證據，仍須核對命令、exit status、實際涵蓋範圍與輸出來源」。

### 過度概括／缺乏依據

1. **「無狀態純函式」應標成工程抽象**（00:7、16）。若輸出指實際 sampled reply，temperature、seed、provider routing/implementation 都可能使相同輸入得到不同輸出；若輸出指固定 weights 下的 probability distribution 才較接近數學函式。另 API 可有 server-managed state（見上）。
2. **「中文字可能 1–3 tokens」「Base64/JSON 標點劇烈消耗」「token 數直接決定網路延遲」**（00:56–64）沒有指定 tokenizer/model 或量測。前兩者方向合理但數字與程度依 tokenizer；延遲還受排隊、模型、硬體、網路、cache 等影響，應改為「影響」而非「直接決定」。
3. **「預留 4k–8k、Provider 內部保留緩衝區」**（00:63–65）不是跨 provider 通則。權威文件支持 context 包含輸入/輸出/reasoning，但固定 4k–8k 與「內部保留」需逐模型/endpoint 引用；否則應標示為示例性 operational policy。
4. **Active Context「request 結束即釋放」**（00:196）只適合作邏輯生命週期簡化；provider 可使用 KV/prompt cache，Responses/WebSocket 亦可保存 chain/connection state。建議說「不應假設 application 可在下次 request 直接取用；是否暫存由 provider 管理」。
5. **Memory Service 僅列 Vector DB / SQLite**（00:199）過窄；可為 relational/document/key-value store、files 或 provider service。宜改成例子而非定義。

## 第 01 章 `01-first-principles.html`

### 正確／有實作支持

1. 核心 loop「追加 user → call model → 保存 assistant → 執行 calls → 追加 tool results → 再呼叫」與 TS reference implementation一致（`typescript/src/index.ts:722–943`）。
2. `read/write/edit/bash` 都是實際 builtin plugins（`typescript/src/tools.ts:111–321,551–560`），bash 有 timeout 與 output bounding（`:93–165`），edit 要求 exact-once/non-overlap（`:244–321`）。
3. Agent 真實可用能力來自 Host 注入的 tool definitions/selected plugins，而非 prompt 自述；CLI `--plugin` 是 allowlist，未知 plugin 會失敗（`typescript/src/cli.ts:29–49,79–88`）。

### 需修正

1. **OODA 名稱/順序錯誤**（01:2）：OODA 是 **Observe → Orient → Decide → Act**；此處把 Orient 翻成「決定行動」、遺漏 Decide，再加入非 OODA 階段的 Loop。若只是自訂 agent cycle，不應冠以 OODA。第一方原典可引 John Boyd, *A Discourse on Winning and Losing*（Air University Press）：[官方 PDF](https://www.airuniversity.af.edu/Portals/10/AUPress/Books/B_0151_BOYD_DISCOURSE_WINNING_LOSING.PDF)。
2. **Agent 終止條件不只「模型判斷足夠資訊並 final answer」**（01:28、46–49）。本 repo 另有 cancellation、provider/model errors、empty response failure、`length` truncated completion（`typescript/src/index.ts:792–819, 848–942`）；生產 loop 常另有 step/time/cost caps。應列為「正常終止」而非唯一終止條件。
3. **「messages 唯一延續狀態／每次讀整個陣列，沒有別的記憶」不符合實作全貌**（01:75、103）。本 repo 還有 system prompt、tool definitions、Session facts/configuration/environment identity、usage、operation state；模型 request 的對話部分是 `messages`，但 runtime continuation state 不只它（`typescript/src/index.ts:113–146, 263…`; session reducer/recovery）。
4. **四個工具「構成最小 Coding Agent」是產品設計選擇，不是可證明的最小集合**（01:135–138）。單一 shell tool 已可完成讀寫/編譯，read+bash 也可能足夠；反之可靠 coding agent 可能還需 search/VCS。建議改「tiny-agent 選用的四個基本內建能力」。
5. **工具安全描述高於實際保障**（01:145–148）：
   - `read` 對 cwd 外絕對路徑/ symlink 無 containment，且先整檔 `readFile` 再截取回傳，不能防止「讀取大檔造成記憶體壓力」，只防止回傳撐爆 context。
   - `write` 直接 `writeFile` 覆寫且可寫 cwd 外，沒有「避免無預警破壞」guard。
   - `bash` 實作是 Node `exec(command, {shell…})`（`tools.ts:8,138–143`），把它寫成直接 `execve()` 不精確。
6. **CLI/Host「配置沙盒邊界」目前沒有實作**（01:191–193）；它配置 plugin allowlist 與 cwd，但 filesystem/bash 沒有 sandbox。可改成應然責任，明示 tiny-agent 本身不提供 OS sandbox。
7. **Lab 對模型行為作確定性承諾**（01:207–211）：只有 edit 時，模型「應明確拒絕」無法由 runtime 保證；模型也可能直接答覆、嘗試 edit（edit 自己會讀目標檔）或 hallucinate。此 lab 能驗證的是「request 沒有 read schema，runtime 不會派發 read」，不是保證自然語言反應。

### 過度概括／缺乏依據

1. 「抽掉任何一步系統便無法運轉」（01:34）太絕對：assistant final response未必需要存回 transcript 才能完成一次 request；multiple calls 可平行而非循序；持久化/錯誤處理可採不同分層。應說這是「教學用最小 canonical loop」。
2. 「Runtime 嚴禁寫死特定商業邏輯」（01:176–179）是架構偏好，不是第一性原理；domain agents 合理地在 orchestrator/workflow 中放 domain policy。可標成 tiny-agent 的設計取捨。
3. 01:218 說 messages 只在 heap、kill -9 後蕩然無存，若指上面的偽碼可成立；若指 tiny-agent reference implementation則錯，因 `runAgentLoop` 強制 Session 並在每步 append JSONL（`index.ts:723–726, 740–805, 865–929`）。需明確區分「示意偽碼」和「repo 實作」。

## 第 02 章 `02-messages-provider.html`

### 正確／有實作與第一方來源支持

1. **Type assertion 在 runtime 不會驗證或剔除欄位**（02:93–99）正確。TS normalizer明確 whitelist重建 assistant/tool call（`typescript/src/index.ts:191–221`），tests驗證 provider-only fields不進 durable log（`typescript/tests/index.test.ts:245–369`）。
2. **Reducer 嚴格驗證 canonical keys、tool call ID/name/reference 與 transcript完整性**（02:61–89）：`typescript/src/session-reducer.ts:196–200, 483–539, 1048–1059`。
3. **`length` 時不執行殘缺 tool call而寫 synthetic truncated**與實作一致（02:162；`typescript/src/index.ts:848–850, 940–942`）；若 length 沒有 calls，則整個 model step失敗而非寫 synthetic（`:236–241`; tests `470–516`），報告應補這個分支。
4. **Usage 拆成 ordinary input / cache read / cache write**符合目前 TS internal ledger（`index.ts:53–59, 693–705`）。OpenAI官方 prompt caching範例也用 `ordinaryInputTokens = inputTokens - cachedTokens - cacheWriteTokens`；Anthropic則直接回三個分離欄位並以相加得 total。[OpenAI prompt caching](https://platform.openai.com/docs/guides/prompt-caching)、[Anthropic prompt caching](https://docs.anthropic.com/en/docs/build-with-claude/prompt-caching)
5. 章末兩個精確測試命令實跑通過。

### 需修正

1. **「每次都必須從頭到尾重播 Transcript」只適用此 Chat Completions adapter，非現代 provider API通則**（02:2–10）。OpenAI Responses可用 `previous_response_id`、Conversations API保存 state；即便如此先前 tokens仍計費並受 context window管理。[OpenAI conversation state](https://platform.openai.com/docs/guides/conversation-state)
2. **「孤立 Tool Call 一定 400、工作永久中斷、恢復一定補 synthetic interrupted」不精確**（02:87）：
   - provider錯誤型態/訊息應依 provider，不宜統稱永久中斷；host可修復 transcript。
   - tiny-agent 若尚未開始 tool，recovery可正常 start；已開始且宣告 safe/replay key吻合（builtin read）會 replay；只有不能安全 replay的 pending effect才補 interrupted synthetic（`typescript/src/session-recovery.ts:204–282`）。
3. **「Provider adapter 必須正規化」是本專案正確 seam，但不是唯一架構**（02:93）。可在 ingestion時 schema-parse/whitelist，或保存 raw event並另建 canonical projection；真正 invariant是「不可信 wire shape不得未驗證地進 canonical transcript/reducer」。
4. **書中 normalizer 程式碼與實作不完全一致**（02:101–121）：實作先拒絕非 object；`content` 只允許 `null|string`，其他型別 throw，不是示例中的「非 string 一律轉 null」；`tool_calls: []` 也會 throw（`index.ts:191–221`）。教學碼若為簡化版應明示，否則會教出較寬鬆、與 reference不一致的行為。
5. **「判斷 tool 不能只看 tool_calls，必須嚴格檢查 finish_reason」與 actual code衝突**（02:150–153）。`stopReason()` 在 `finish_reason` 缺失或為 `stop` 時，只要 message含 calls仍回 `toolUse`（`index.ts:224–233`）。實際規則是交叉驗證：tool finish reason必須有 calls；`length`特殊處置；其他合法/缺省理由仍可由 calls決定。需按實作重寫。
6. **`toolUse` 不是 OpenAI/OpenRouter wire finish reason**（02:161），是 tiny-agent internal canonical `StopReason`（`index.ts:189`）。若同欄並列應標示「internal normalized reason」。Anthropic wire值是 `tool_use`（底線），不可寫成 `toolUse`。
7. **`content_filter / error` 列成 finish reason混淆 transport error**（02:163）。OpenAI `finish_reason` 包含 `content_filter`，但網路中斷通常根本沒有 completion/finish_reason；本 repo HTTP/network exception走 catch failure，`network_error`只是在 `stopReason` 額外接受的一個字串（`index.ts:230–231,681–713,765–790`）。應拆成「wire finish reason」與「transport/provider error」。
8. **「精確計量」應說明是 provider-reported accounting normalization，不是本機獨立精確 tokenizer量測**（02:167–187）。OpenRouter明載 token counts用被路由模型的 native tokenizer，details是 optional；本實作缺欄位就以 0，且用 `Math.max(0, …)`掩蓋不一致資料（`index.ts:693–705`）。[OpenRouter API overview — Usage accounting](https://openrouter.ai/docs/api-reference/overview#response-body)

### 過度概括／缺乏依據

1. 02:87–89 對所有「主流 Provider」宣稱固定 400/拒絕/注意力破壞，未逐 provider 引證。宜改為「可能被 API schema/protocol拒絕，且一定破壞本 repo transcript invariant」，再分別引用 OpenAI/Anthropic協定。
2. 02:98「多餘欄位會導致 Strict Reducer 解析崩潰」方向符合 reducer exact-key policy，但「崩潰」宜改成「以 SessionCorruption/INVALID_FACT 拒絕載入」，避免暗示未捕獲 process crash。
3. 02:187 說單次 cache hit rate能「精準抓出哪輪導致 cache破功」過強；0 hit可能來自未達最低長度、TTL失效、routing/provider不支援、prefix變化等。它是診斷訊號，不是單獨的根因證明。OpenAI/Anthropic官方都列出 cache eligibility/TTL/threshold等條件。

## 第 00–02 章小結

1. 把「所有 LLM/API 都完全無狀態」限縮為本 repo Chat Completions adapter的工程模型，補充 server-managed conversation state例外。
2. 更正 OODA 四階段。
3. 明說 tiny-agent filesystem/bash **沒有 OS sandbox/path containment**；現有書稿多處把應然安全責任寫成既有保障。
4. Tool call 不等於 guaranteed constrained output；本 repo未啟用 `strict:true`，Host runtime validation不可省。
5. 依 actual `stopReason()` 與 recovery planner重寫 02 的 finish reason、truncation與 crash recovery敘述。
6. 降低「唯一證據、永久中斷、精確抓根因、不可再刪」等絕對措辭。

## 第 03 章 `03-tools.html`

### 正確／有實作支持

1. Tool 將 `name`、description/schema 與 `execute` 放在同一物件，plugin bundle 再負責選擇性注入，與 `typescript/src/tools.ts:54–62,551–560` 相符。
2. built-in `read` 是目前唯一宣告可安全 replay 的工具；MCP 維持既有 agent loop 的 adapter 角色，而不是第二套 runtime（`typescript/src/tools.ts:541–548`; `typescript/src/mcp.ts:60–98`）。
3. `bg` 確實提供 start/list/logs/status/stop，並用 PID start-time metadata 降低 PID reuse 誤殺風險（`typescript/src/tools.ts:330–543`）。
4. 章中誠實指出 file tools 不做 cwd containment；測試也明確要求 absolute path、cwd 外 sibling 與 symlink escape 可用（`typescript/tests/index.test.ts:1887–1910`）。

### 需修正

1. **錯誤處理契約與實作矛盾。** 章中 validation/dispatch 表把 tool failure 寫成一律 `throw`、runtime 統一轉為結構化失敗；但 built-in `bash` 對 non-zero、timeout、maxBuffer 會捕獲並**回傳字串**（`typescript/src/tools.ts:137–165`），Agent 因 Promise resolved 將 event 標成 `ok: true`（`typescript/src/index.ts:895–913`; 對應 test `typescript/tests/index.test.ts:2156`）。應描述現況，或先修改實作再宣稱統一 failure contract。
2. **背景程序跨平台敘述過強。** `bg` 依賴 POSIX `ps`、signals、process groups 與 negative PID（`tools.ts:370–429`），不能泛稱所有平台「完整／完美支援」，尤其 Windows 語意不同。`stop` 還會在 SIGTERM 後等待再 SIGKILL，不只是「安全發 SIGTERM」。
3. **外層 execution capsule 是部署要求，不是 repo 已提供能力。** tiny-agent CLI 沒有建立 Docker/gVisor/namespaces/cgroups；應在本章第一次談 sandbox 時明說「本 repo 不提供 OS sandbox」。這也與 `docs/multi-tenant-threat-model.md` 的 Scope of tiny-agent 一致。
4. `read` 可稱 replay-safe/idempotent policy，但不是 pure function，也不能保證同一 arguments 每次回同結果：檔案內容可能在兩次讀取間改變。

### 過度概括／缺乏依據

1. 「schema + runtime validation」方向正確，但不是現有所有 adapter 都會以 JSON Schema 執行資料驗證：MCP adapter只驗證 server schema本身的 bounds，呼叫時僅確認 args 是 object，未對 args 套用 remote inputSchema（`typescript/src/mcp.ts:64,74–89`）。應區分 built-in逐欄 guard、provider strict mode與 MCP server端 validation。
2. 教材若把 PID start-time 說成「杜絕」誤殺仍過強；它是降低 PID reuse race 的檢查，不是 cryptographic process identity。

## 第 04 章 `04-context-skills.html`

### 正確／有實作支持

1. 掃描範圍確為 `.tiny-agent/skills/**/SKILL.md` 加 CLI `--skill`，frontmatter只抽 `name`/`description`/path；AGENTS全文與 skill metadata組入 system prompt（`typescript/src/index.ts:155–185,279–298`; `typescript/src/cli.ts:250–257`）。
2. `/skill:name` 是 host 直接讀 skill全文後注入 user message；autonomous route 則必須靠模型能呼叫的 read/tool能力，這個區分正確。
3. read/bash 回傳有 context bounding，方向與實作相符。

### 需修正

1. **「四個嚴格優先級層次」不符合 wire shape。** Project rules 與 skill metadata只是同一則 `system` message內不同來源的文字；conversation也不是協定上的「最低優先級」。應改稱「四種 context 來源／組裝層」，不要暗示 provider會執行四級 priority arbitration。
2. **bridge 明顯錯誤。** 章末稱 message/state 全在記憶體、kill -9 全失；實際 CLI 啟動即建立/開啟 Session，`runAgentLoop` 每步 append JSONL（`typescript/src/cli.ts:93–96`; `typescript/src/index.ts:723–805,865–929`）。
3. **Hands-on 自我矛盾。** 示範啟用 `--plugin read`，卻宣稱 slash route「不需要 read 權限」；slash route確實由 host讀檔，但命令應改用其他 plugin或明說 read只是恰好啟用。
4. 原始碼 permalink 行號已漂移（例如 findSkillFiles 現在約在 `index.ts:155`），外部 skill連結也應在發布前由 build/link checker驗證。

### 過度概括／缺乏依據

1. 固定 `~200 tokens`、每 skill `~50 tokens`、初始「永遠數十 tokens」沒有 tokenizer/model/skill數量量測；metadata成本會隨 skill數與description長度線性增加。應標示示意值並附量測方法。
2. XML-like tags只提供語意分隔，不建立信任或安全隔離；AGENTS.md與skill內容仍是 prompt文字，仍可能含 prompt injection。
3. 「沒有 read 模型必須誠實拒絕」只是 instruction期望，runtime不能保證自然語言誠實或特定回覆。

## 第 05 章 `05-durable-session.html`

### 正確／有實作支持

1. intent-before-effect：`toolStarted` append成功後才執行 tool（`typescript/src/index.ts:862–896`）。
2. append會先以 reducer驗證 candidate，寫入成功後才更新 in-memory bytes/state（`typescript/src/session.ts:115–134`）。
3. 沒有 `fsync`，因此只主張 process-crash、不是 power-loss durability，方向誠實。
4. torn-tail以最後 LF 為 framing/recovery boundary，符合 session loader/reducer與 fixtures。

### 需修正

1. **介面名稱錯誤。** 章中核心介面寫 `commit(facts)`，TypeScript public method實際是 `append(input)` 且回 committed facts（`typescript/src/session.ts:115`）。若是偽碼必須明示。
2. **「crash 一律 interrupted且絕不 replay」不成立。** recovery planner會 replay符合 declaration/replay key的 built-in read；尚未effect的 tool可正常 start；只有未知且不安全 replay的 pending effect補 synthetic interrupted（`typescript/src/session-recovery.ts:204–282`）。
3. **「一行 JSONL 是原子交易」應改為「atomic recovery unit」。** 單次 filesystem write不是跨OS/filesystem保證原子；本設計容忍最後一行 torn並捨棄它，而非保證該行永遠全有或全無。
4. **UUIDv7範圍需限縮。** tiny-agent自己配置的 fact/operation/entry ID可為UUIDv7，但 provider `tool_call_id` 是外部protocol ID，不是UUID。
5. header範例的具體 model與目前預設不同；教科書應用 `<provider-model-id>` placeholder，避免把漂移值寫成contract。
6. torn-tail lab前兩步只展示 LF framing；其手工header/fact不符合完整 reducer schema，不能當成 SessionStore contract fixture。應把 framing demo與真正 store test分開。

### 過度概括／缺乏依據

1. 「成功 append = 完美重建」須加前提：不涵蓋未fsync的power loss、filesystem corruption、storage I/O error或惡意重寫。
2. append-only JSONL 提供可追溯 transcript，但本身不是不可竄改的合規audit log；repo自己的 threat model也明確如此描述（`docs/multi-tenant-threat-model.md`, Tenant state and audit store）。

## 第 06 章 `06-recovery.html`

### 正確／有實作支持

1. **Reducer / Planner 分離**與實作一致：`reduceSession(bytes)` 只由 WAL bytes 決定 state；`planRecovery(state,current)` 回傳 discriminated recovery plan，不直接做 I/O 或配置 UUID（`typescript/src/session-reducer.ts`; `typescript/src/session-recovery.ts:27–56,111–283`）。真正寫 WAL、呼叫 model/tool 是 `Agent.resumeSession()` 外層 executor（`typescript/src/index.ts:404–485`）。
2. **Attempt 1 open → Attempt 2；Attempt 2 open → exhausted**符合 planner（`session-recovery.ts:163–171`）。
3. **Safe builtin read replay、never tool synthetic interrupted、length tool calls synthetic truncated**符合 `session-recovery.ts:177–198,263–282`。
4. **Configuration digest內容**確實含 model、system prompt digest、tool name+definition digest、adapter/routing/output identities（`typescript/src/index.ts:113–130`）；planner在自動復原前比對 configuration/environment（`session-recovery.ts:152–156,263–269`）。
5. **模型已完成但缺 operationFinished時補終局**：planner `finish` 後 executor append `operationFinished`（`session-recovery.ts:201–202`; `index.ts:445–458`）。

### 需修正

1. **「四種復原結局 Retry、Replay、Blocked、Failed」不是 `RecoveryPlan` 的精確分類**。實際 union是 `finish | startStep | startTool | appendSynthetic | closeAttempt | blocked`；Retry/Replay是 `startStep`/`startTool` 的語意，Failed是 `finish.outcome`之一（`session-recovery.ts:27–56`）。若章節要教 exact state machine，應採實際型別；若只做概念分類，應明示簡化且還有 Aborted/Completed/Synthetic。
2. **`attempts_exhausted` 的處理與表格「Blocked不寫終局、人工介入」衝突**。Planner確實回 `blocked:attempts_exhausted`，但 `resumeSession()` 對 normal run特判並寫 `operationFinished outcome:"failed"`，只有 config/env/replay declaration等 blocked才 throw且不寫終局（`index.ts:430–443`）。表格與決策樹應拆開。
3. **把 config/environment change說成「竄改」過度且可能誤導**（06 configuration section）。正常升級 model、prompt、tool schema或移動/重新掛載 workspace也會 change；這是 compatibility/safety mismatch，不是 tamper detection或安全雜湊驗證（沒有 MAC/signature）。建議用「不一致」而非「被竄改／偷偷修改」。
4. **Environment identity 說成「Session檔案移到其他目錄便 environment_changed」不精確**。identity是建立時 cwd的 realpath/override（`session.ts:16–18,41–56`），resume用 `environmentIdentity(state.header.cwd)`（`index.ts:417–426`）；單純搬 JSONL 的具體結果還受 session lookup/header cwd/原路徑存在與否影響，並非檔案位置直接進 digest。應說「記錄的工作環境 identity 與復原時計算值不一致」。
5. **Replay-key閘門「防自訂工具覆寫 builtin read名稱」敘述不完整**。Agent先拒絕同一 tool list中的 duplicate names（`index.ts:275–278`）；`durableToolReplay` 又只用物件 identity把真正 builtin `readTool`標 safe，自訂同名 read會記為 never（`tools.ts:541–548`）。`replayKey`主要防 safe declaration/implementation identity跨重啟漂移，不應把全部保障歸因於 key。
6. **Failed情境寫「Provider 5xx 已收到」不精確**。5xx在 `callModel` 會 throw，runtime把它轉成 durable `stepFailed`/`operationFinished failed`；Planner看到 durable `step.status === failed`後只根據記錄finish，並不解析HTTP status（`index.ts:691,765–790`; `session-recovery.ts:157–162`）。
7. **Hands-on TS命令沒有實際跑 planner fixture decisions**。`--test-name-pattern="planner"`只命中 `planner fixture metadata matches its JSON schemas`；真正決策 tests名為 `session recovery plan: ...`（`typescript/tests/session-reducer.test.ts:139–160`）。應改 pattern為 `"planner fixture|session recovery plan"` 或直接跑整檔。
8. **Hands-on Rust命令看似執行 kill -9整合測試，實際兩個 tests都是 `ignored`**。實跑 `cargo test --test crash_recovery`結果為 `0 passed; 2 ignored`；測試輸出也註明需明確、隔離執行。章節應提供 `cargo test --test crash_recovery -- --ignored --test-threads=1`（仍需確認平台前提），或誠實註明 default命令只編譯、不執行真實 fork/SIGKILL fixtures。

### 過度概括／缺乏依據

1. 「狀態計算與I/O徹底分離是保證可預測性的黃金法則」屬設計建議，不是充分保證；determinism仍依 canonical parsing、時間/隨機源隔離、完整 invariants與 executor正確性。
2. Retry「相同 Context 再次發送」在 recorded `contextThroughEntryId`與 configuration一致層面正確，但不能暗示 provider輸出/計費/路由結果相同；模型請求通常非 exactly-once。
3. 「三道身分雜湊安全閘門」實際 environment identity是 realpath字串比較，不是三者全為 digest；replay declaration則比較 declaration/digest/key組合。標題應改為「三道 identity/compatibility checks」。
4. 圖說「四種結局」同時又列 red Failed/Aborted，正文表只有Failed沒有Aborted，分類不一致；應依 actual plan/outcome統一術語。

## 第 07 章 `07-cancel-compact.html`

### 正確／有實作與測試支持

1. **先持久化 abort intent，再觸發 signal**完全符合 TS：`abort()` 先 await `recordAbort()`，之後才 `controller.abort()`（`typescript/src/index.ts:303–311`）。
2. race settlement由 `active.aborting` 序列化；若 abort append已開始，settlement會等待並讓abort勝出（`index.ts:327–331`）。對應 race tests與章末 `abort|compaction` pattern本次實跑 **14/14 passed**。
3. tool abort後，已started call寫 synthetic `interrupted`，尚未started calls依序寫 synthetic `aborted`，最後結束 operation（`index.ts:901–938`）。
4. compaction保留最近至少6則並向前找user boundary；記錄 compacted/retained IDs與sourceDigest，原始message facts不刪除（`index.ts:945–975`; `session-reducer.ts:662–703`）。
5. sourceDigest與partition會由reducer重新核對，錯誤digest fixture會被拒絕；它確實提供資料一致性檢查。

### 需修正

1. **取消流程宣稱會「終止背景 Process Tree」不符目前 Agent abort。** Esc只signal當下 active model/tool/compaction；已由 `bg start` 啟動且已回傳的背景程序不再是 active operation，session close也不會自動stop它。章07:36應刪除或標為部署supervisor的額外責任。
2. **Tool Phase 的 `SIGTERM/SIGKILL 終止 Process Tree`混合了兩條不同路徑。** foreground `bash`把AbortSignal交給 Node `exec`，本處沒有明確兩階段process-tree supervisor；`bg stop`才另有TERM→等待→KILL邏輯。表格07:45應分開描述，不能保證foreground descendants徹底清除。
3. **`sourceDigest`不能「確保歷史不可篡改」。** 它是未加密SHA-256一致性digest；能偵測未同步更新的內容改動，但能寫檔的攻擊者可同時重算digest，沒有MAC、signature、trusted timestamp或外部anchor。07:130與全書「不可篡改WAL」應改為「可驗證內部一致性／可偵測非協調變更」。
4. 章中用 `commit(...)`，實際介面是 `session.append(...)`；如為概念圖需加「pseudocode」標記。
5. 「正常推進下一步」只適用abort抵達時該settlement已完全結束、active已清掉；若abort append已開始，即使provider/tool response已在memory返回，`settleOperation`仍讓abort勝。建議以「durable append／serialized settlement boundary」而非模糊的同一毫秒說明。

### 過度概括／缺乏依據

1. 「雙切點（Two-Cut）」是本專案很有用的教學名稱，但不應暗示是有外部標準定義的普遍術語；可標「本文稱之為」。
2. 「原始紀錄永存」只在目前沒有retention/rotation/deletion且儲存媒體正常的範圍成立；repo threat model本身要求production retention/deletion policy。
3. bridge稱已能在「無限上下文」穩定運行過度；compaction摘要是有損、模型請求會失敗、context仍有provider上限。應改為「長時session可透過有損摘要控制active context」。

## 第 08 章 `08-test-observe-secure.html`

### 正確／有實作與第一方來源支持

1. unit/contract、integration/conformance、real-model eval分層是合理測試策略；repo確有四語言offline tests、本機MCP fixture與real-agent eval runner（`Makefile`; `.github/workflows/unittest.yml`; `eval/run.ts`）。OpenAI官方eval guidance也主張task-specific eval、log everything、automate scoring，而不是依賴模型自述：[OpenAI Evals guide](https://platform.openai.com/docs/guides/evals)。
2. eval runner將fixture複製到temp workspace，agent結束後由外部 `test.sh` verifier判斷，且pass條件包含未timeout、agent exit 0、verifier exit 0（`eval/run.ts:167–211`）。Duration/tokens/tools只作報表欄位，沒有補償錯誤結果。
3. TypeScript JSON mode確有 `run.started`、MCP、model/tool與`run.completed`事件，含duration、usage與cache hit rate（`typescript/src/cli.ts:97–148,200–225`; `typescript/src/index.ts:375–383,886–914`）。這種機器可讀事件可再轉接OpenTelemetry Logs；但需要adapter/exporter，不是自動整合。[OpenTelemetry Logs data model/spec](https://opentelemetry.io/docs/specs/otel/logs/)
4. MCP與`--plugin`不是tenant ACL/sandbox、多租戶需外層per-job capsule，與repo的正式威脅模型一致（`docs/multi-tenant-threat-model.md`）。阻擋link-local metadata與private/internal destinations亦是合理SSRF要求；AWS EC2文件確認IMDS位於link-local `169.254.169.254`：[AWS instance metadata](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/instancedata-data-retrieval.html)。

### 需修正

1. **測試不能「證明架構正確無誤」或保證100% deterministic。** 測試只能提高在已覆蓋範圍內的信心，仍受coverage、OS、timing與fixture oracle限制。08:2、24、32–33應改為「驗證已定義contract／提供可重現信心」。
2. **四語言「完全同構」過強。** CI是四個獨立language jobs，沒有一個通用CLI transcript runner逐事件比較所有語言；MCP loopback目前主要集中TypeScript。可說「以共享schema/fixtures與各語言tests追求equivalence」，不要宣稱已證明完全同構。
3. **GitHub CI目前沒有跑book build/test。** job雖命名 `TypeScript and book`，steps只有TypeScript tests與eval unit test（`.github/workflows/unittest.yml:12–24`）。`Makefile test/check`包含book，但PR workflow未呼叫它；若教材稱book是release gate，應先修workflow。
4. **eval PASS並非只看單一Exit Code。** actual condition是 agent未timeout、agent exit 0、verifier exit 0三者都成立（`eval/run.ts:200–211`）；流程圖08:49需說清楚。
5. **事件範例不是完整wire record。** actual events有必填timestamp；`run.started`另含endpoint/plugins/mcp，`run.completed`另含duration/sessionId/usage。範例可保留，但應標「欄位節錄」，model ID也應用placeholder。
6. **「events不含prompt/tool result，因此避免複製客戶機密」結論過強。** tool payload/result確未進tool events，但`run.completed.result.answer`會包含final answer，failed `message`也可能含敏感上下文；endpoint/server alias等metadata也需分類。應說「降低payload量」，並要求redaction、access control與retention。
7. **`cacheHitRate`從90%掉到0不等於必然是動態prefix。** 也可能是TTL、最低cache長度、provider/model routing、cache eligibility或計量欄位缺失。它是告警訊號，不是根因證明（同第02章）。
8. **「Schema + Runtime Guard雙重校驗所有模型JSON」不符MCP現況。** MCP execute只確認args是object，沒有在host依remote inputSchema逐欄validate（`typescript/src/mcp.ts:64,74–89`）；MCP規格要求server驗證tool inputs並回tool error，因此教材應明確分配host/server責任：[MCP Tools specification](https://modelcontextprotocol.io/specification/2025-06-18/server/tools)。
9. **cgroups不能單獨限制磁碟inode上限。** Linux cgroup v2 controllers涵蓋CPU、memory、I/O、PIDs等；inode/容量通常需filesystem/project quota、bounded volume或overlay配額。08:119應把「磁碟bytes/inodes」移到storage quota，不要列為cgroups功能。[Linux cgroup v2 docs](https://docs.kernel.org/admin-guide/cgroup-v2.html)、[Docker resource constraints](https://docs.docker.com/engine/containers/resource_constraints/)。
10. **TERM→grace→KILL不保證清空process tree。** production方案應以job cgroup為ownership boundary，停止新權限、撤銷credentials、TERM、grace、cgroup kill並驗證empty；repo自己的 threat model已有更精確文字。08:121的「確保徹底」應降級。
11. **Execution Capsule是設計要求，不是tiny-agent已實作。** 書中應醒目註明四語言CLI仍是普通host process；沒有container/gVisor/cgroup/egress controller。Kernel isolation與resource/network policy由deployment擁有。

### 過度概括／缺乏依據

1. 將Agent core標Trusted是threat-model假設，不是因「TypeScript/Go/Python/Rust最嚴謹」而自動可信；可信度來自pinned artifact、review、tests、supply-chain controls與deployment boundary。
2. 「外部repo嚴禁在host裸跑」作為多租戶/敵對code準則正確，但不是tiny-agent runtime enforcement；應清楚標示normative deployment rule。
3. 章末「誠實且不可篡改的WAL」「已完全掌握現代Agent」均屬宣傳性絕對措辭。JSONL可被有寫權者修改，摘要有損，測試與威脅模型也仍有deliberately deferred項目；應改成可稽核、內部一致、範圍明確的承諾。

## `book/src/chapters.js`、README 與建置內容

### 正確

1. `chapters.js`確是章節metadata source of truth，builder成功產生10 pages / 21 assets；本次 `npm --prefix book run check`通過。
2. README稱build script使用標準庫、`dist`為generated artifact、Cloudflare憑證不入repo，與目前檔案結構相符。
3. takeaways中「file tools不做cwd containment」「MCP/plugin不是ACL」「tiny-agent本身不提供tenant isolation」是全書最準確且應提升到正文醒目位置的邊界聲明。

### 需修正

1. **明顯文字錯誤：** `chapters.js` 第03章 takeaway寫「JSON Schema只是介面說明，不是安全檢查；runtime 驗證必須別做」，依上下文應為「runtime 驗證仍必須做」。目前生成首頁/導覽會把反義句發布出去。
2. metadata重複了正文已識別的過強說法：LLM單次呼叫完全無狀態、四步「不可再刪」、四tool為可證明最小集合、finish_reason必然比calls更重要、CI必須完全deterministic、WAL不可篡改。修正文時必須同步更新`chapters.js`，否則首頁/search index仍傳播舊結論。
3. `.github/workflows/unittest.yml`的job名稱含book但未安裝/執行book commands；README/章08若把它當PR gate需修正workflow。

## 主要外部權威來源

- [OpenAI — Conversation state / managing context](https://platform.openai.com/docs/guides/conversation-state)
- [OpenAI — Function calling, strict mode](https://platform.openai.com/docs/guides/function-calling#strict-mode)
- [OpenAI — Prompt caching](https://platform.openai.com/docs/guides/prompt-caching)
- [OpenAI — Evals](https://platform.openai.com/docs/guides/evals)
- [Anthropic — Context windows](https://docs.anthropic.com/en/docs/build-with-claude/context-windows)
- [Anthropic — Prompt caching](https://docs.anthropic.com/en/docs/build-with-claude/prompt-caching)
- [OpenRouter — Usage accounting](https://openrouter.ai/docs/api-reference/overview#response-body)
- [MCP specification — Tools](https://modelcontextprotocol.io/specification/2025-06-18/server/tools)
- [Linux kernel — cgroup v2](https://docs.kernel.org/admin-guide/cgroup-v2.html)
- [Docker — Resource constraints](https://docs.docker.com/engine/containers/resource_constraints/)
- [OpenTelemetry — Logs specification](https://opentelemetry.io/docs/specs/otel/logs/)
- [AWS EC2 — Instance metadata](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/instancedata-data-retrieval.html)
- [John Boyd / Air University Press — A Discourse on Winning and Losing](https://www.airuniversity.af.edu/Portals/10/AUPress/Books/B_0151_BOYD_DISCOURSE_WINNING_LOSING.PDF)

## 建議驗收條件

1. 先修所有「需修正」項，並同步更新chapter fragment、`chapters.js` takeaways、圖說與generated `dist`。
2. 新增book link/claim checks：至少檢查repo permalink存在、hands-on pattern實際命中非零預期tests、首頁takeaway不與正文矛盾。
3. 在PR workflow實際執行`npm --prefix book test`；若要宣稱四語言conformance，再新增共享CLI/event oracle，而不只四個獨立test jobs。
4. 全書搜尋並審核：`永遠|唯一|完全|完美|不可篡改|保證|絕對|精確`。除非旁邊有明確scope與可執行contract，否則改為可驗證的有限承諾。
