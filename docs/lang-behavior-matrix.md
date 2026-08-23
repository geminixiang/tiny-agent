# 四語言 Bash Output 限制行為矩陣

範圍：`bash` tool 的輸出截斷、落盤、10MB safety cap 行為。書中07章刻意用概括寫法（「有的...有的...」），因為讀者需要建立的心智模型是「四語言tail語意不保證一致，這是刻意差異，不是bug」，不是背誦位元組數；本文件提供想深入的讀者具名的精確對照。

查核基準：HEAD `9599ba7e97a6643b47b0ecd3c0d0f11d871c0320`。

## 對照表

| 語言       | 50KB截斷觸發條件                                                        | 是否落盤原始輸出                                                               | 10MB上限行為                                                                                                                                                                                                  |
| ---------- | ----------------------------------------------------------------------- | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| TypeScript | `lines.length > 2000` **或** `byteLength(output) > 50*1024`（任一觸發） | 是：只要觸發截斷（含10MB分支），一律寫入 `.tiny-agent/tool-output/<uuid7>.log` | **非錯誤**：回傳成功字串，內含「Bash output exceeded the 10MB safety cap; complete output was not captured.」診斷句，再走一般截斷路徑並落盤（落盤內容本身已是被10MB cap過的內容，不是程序實際產生的完整輸出） |
| Go         | 純byte長度 `output.Len() > 50*1024`（無行數判斷）                       | 是，但僅限50KB截斷分支；10MB分支**不落盤**                                     | **視為錯誤**：`fmt.Errorf("bash output exceeded %dMB limit", ...)`，並對整個process group送`SIGKILL`                                                                                                          |
| Python     | 純byte長度 `len(output) > MAX_TOOL_OUTPUT`（無行數判斷）                | 是，但僅限50KB截斷分支；10MB分支**不落盤**                                     | **視為錯誤**：`raise RuntimeError("bash output exceeded 10MB limit")`，並對process group送`SIGKILL`                                                                                                           |
| Rust       | `lines.len() > 2000` **或** `output.len() > 50*1024`（與TS同語意）      | 是：只要觸發截斷（含10MB分支），一律寫入 `.tiny-agent/tool-output/<uuid7>.log` | **非錯誤**：回傳成功字串，內含「Bash output exceeded the 10MB safety cap; complete output was not captured.」，與TS用詞逐字相同，同樣落盤已被cap過的內容                                                      |

## 分兩組理解

- **capped-output（非錯誤，落盤capped內容）**：TypeScript、Rust。10MB超限時仍回傳一個可用的字串結果（帶診斷句），且會把這個已經被截斷的結果寫入`.tiny-agent/tool-output/`——注意落盤內容本身就是capped後的樣子，不是程序實際完整輸出的重建。
- **tool error（不落盤，kill process group）**：Go、Python。10MB超限時直接視為tool執行失敗，不產生任何`.tiny-agent/tool-output/`檔案。

兩組在「10MB超限」這件事上做出了不同設計選擇，都沒有錯——這是tiny-agent刻意保留的跨語言差異，不是待修復的不一致。

## 證據

| 語言       | 50KB判斷                         | 落盤（50KB分支）                                                    | 落盤（10MB分支）                                                                                                | 10MB行為                                   |
| ---------- | -------------------------------- | ------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| TypeScript | `typescript/src/tools.ts:131`    | `typescript/src/tools.ts:139-141`（`limitBashOutput`內`writeFile`） | 同一函式共用，見`typescript/src/tools.ts:185-188`呼叫`limitBashOutput(..., false)`後仍執行到`:141`的`writeFile` | `typescript/src/tools.ts:186`（診斷句）    |
| Go         | `go/cmd/tiny-go/main.go:425`     | `go/cmd/tiny-go/main.go:427-436`（`os.WriteFile`）                  | 無（提前於`:417`回傳`Errorf`，不進入落盤分支）                                                                  | `go/cmd/tiny-go/main.go:417`               |
| Python     | `python/tiny_agent/agent.py:113` | `python/tiny_agent/agent.py:114-115`（`path.write_bytes`）          | 無（`:100`、`:103`的`except`區塊直接`raise`，不落盤）                                                           | `python/tiny_agent/agent.py:100,103`       |
| Rust       | `rust/src/lib.rs:2302`           | `rust/src/lib.rs:2320-2322`（`std::fs::write`）                     | 同一函式`limit_output`共用，見`:2244`呼叫後仍執行到`:2322`的`std::fs::write`                                    | `rust/src/lib.rs:2210,2244,2326`（診斷句） |

## README對照

`README.md:163`：「Bash output超過50KB時會截短送入模型；若該語言實作已完整捕獲輸出，完整內容會另存於`.tiny-agent/tool-output/`並留下回查path。各實作另有約10MB的capture safety limit；超限時不保證完整輸出，可能回傳capped-output標記或tool error。」——此措辭與上表完全一致，用「可能」保留模糊度是恰當的，因為兩種行為在四語言中確實都存在，不需要二選一具名。
