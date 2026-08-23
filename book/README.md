# tiny-agent Book

繁體中文（臺灣）的靜態教學書網站。內容從最小 agent loop 開始，逐步說明 Tool、Context、durable Session、recovery、cancellation、compaction、測試、observability 與安全邊界。

## 致謝

這本書與tiny-agent的許多設計思考受到[Pi](https://github.com/earendil-works/pi)啟發，尤其是精簡的agent loop、Tool模型、skills漸進載入、compaction，以及讓coding agent保持可理解與可操作的工程取向。感謝Pi及其貢獻者公開實作與文件。

Tiny-agent不是Pi的fork或移植；它是獨立的四語言教學實作，並針對transactional Session、crash recovery與跨語言conformance發展自己的contract。

## 本機開發

不需要安裝相依套件：

```bash
npm --prefix book run build
npm --prefix book test
```

產物位於：

```text
book/dist/
```

可用任何靜態檔案伺服器預覽，例如：

```bash
npx serve book/dist
```

`npx serve` 只是預覽選項，不是本專案的相依套件；也可使用既有的 HTTP 伺服器。

## 內容結構

- `src/chapters.js`：章節 metadata 的 single source of truth。
- `src/chapters/*.html`：受控 HTML fragments，不使用自製 Markdown parser。
- `src/assets/`：共用 CSS 與 enhancement-only JavaScript。
- `scripts/build.js`：使用 Node.js 22 標準函式庫的靜態產生器。
- `scripts/test.js`：零相依套件的 build、link、canonical、HTML、繁中與 header 測試。

產生的 `dist/` 是 build artifact，不應手動修改。Build 會依內容雜湊產生 CSS 與 JavaScript 檔名，供 Cloudflare Pages 安全地使用 immutable cache。

## Cloudflare Pages

使用 Cloudflare Dashboard 的 Git integration 連接此 repository。設定：

| 項目                   | 值                            |
| ---------------------- | ----------------------------- |
| Root directory         | repository root（留空）       |
| Build command          | `npm --prefix book run build` |
| Build output directory | `book/dist`                   |
| Node.js                | 22 或更新版本                 |

部署完成後，在 Pages project 的 **Custom domains** 綁定：

```text
tiny-agent.geminixiang.com
```

Canonical public origin 固定為：

```text
https://tiny-agent.geminixiang.com
```

此 repository 不會自動修改 DNS，也不會保存 Cloudflare 帳號、account ID、API token 或任何 credential。Cloudflare 帳號、Git 授權、DNS 與 custom domain 驗證應在 Dashboard 完成。
