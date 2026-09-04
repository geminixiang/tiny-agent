import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin, type UserConfig } from "vite";
import hljs from "highlight.js/lib/core";
import json from "highlight.js/lib/languages/json";
import shell from "highlight.js/lib/languages/shell";
import typescript from "highlight.js/lib/languages/typescript";
import xml from "highlight.js/lib/languages/xml";
import yaml from "highlight.js/lib/languages/yaml";
import { chapters, planned } from "./src/chapters.js";

hljs.registerLanguage("json", json);
hljs.registerLanguage("sh", shell);
hljs.registerLanguage("ts", typescript);
hljs.registerLanguage("xml", xml);
hljs.registerLanguage("yaml", yaml);

const bookRoot = dirname(fileURLToPath(import.meta.url));
const out = resolve(process.env.BOOK_OUT_DIR || join(bookRoot, "dist"));
const origin = "https://tiny-agent.geminixiang.com";
const repo = "https://github.com/geminixiang/tiny-agent";
const escape = (value: string): string =>
    String(value).replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
const cspHash = (content: string): string => `'sha256-${createHash("sha256").update(content).digest("base64")}'`;

function architectureCsp(html: string): { scripts: string; styles: string } {
    const scripts = [...html.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/g)]
        .filter((match) => !match[1].includes("type="))
        .map((match) => cspHash(match[2]));
    const styles = [...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map((match) => cspHash(match[1]));
    return { scripts: scripts.join(" "), styles: styles.join(" ") };
}

function chapterGroups(current) {
    let part = "";
    return chapters
        .map((chapter, index) => {
            const heading = chapter.part === part ? "" : `<li class="nav-part">${escape((part = chapter.part))}</li>`;
            return `${heading}<li><a href="/${chapter.slug}/"${chapter.slug === current ? ' aria-current="page"' : ""}><span class="chapter-number">${String(index).padStart(2, "0")}</span> <span>${escape(chapter.title)}</span></a></li>`;
        })
        .join("");
}

function layout({ title, description, path, current = "", body, assets, type = "article" }) {
    const canonical = `${origin}${path}`;
    return `<!doctype html>
<html lang="zh-Hant-TW">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>${escape(title)}｜tiny-agent Book</title>
<meta name="description" content="${escape(description)}">
<link rel="canonical" href="${canonical}">
<link rel="icon" type="image/png" sizes="64x64" href="/assets/${assets.favicon}">
<meta property="og:type" content="${type === "home" ? "website" : "article"}">
<meta property="og:title" content="${escape(title)}｜tiny-agent Book">
<meta property="og:description" content="${escape(description)}">
<meta property="og:url" content="${canonical}">
<script src="/assets/${assets.theme}"></script>
<link rel="stylesheet" href="/assets/${assets.css}">
<script src="/assets/${assets.js}" defer></script>
</head>
<body data-drawer="closed">
<a class="skip-link" href="#main">跳到主要內容</a>
<header class="topbar">
<button class="icon-button menu-button" type="button" data-menu-toggle aria-label="開啟章節目錄" aria-expanded="false">☰</button>
<a class="brand" href="/"><span>tiny-agent</span> <small>從第一性原理打造可靠 Agent</small></a>
<span class="topbar-spacer"></span>
<a class="icon-button" href="${repo}" aria-label="GitHub repository"><svg viewBox="0 0 16 16" width="18" height="18" fill="currentColor" aria-hidden="true"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8z"/></svg></a>
<button class="icon-button theme-button" type="button" data-theme-toggle aria-label="切換主題"><svg class="icon-sun" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="4.2"/><path d="M12 2.5v2.4M12 19.1v2.4M4.9 4.9l1.7 1.7M17.4 17.4l1.7 1.7M2.5 12h2.4M19.1 12h2.4M4.9 19.1l1.7-1.7M17.4 6.6l1.7-1.7"/></svg><svg class="icon-moon" viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true"><path d="M20.6 15.3a8.6 8.6 0 0 1-10.9-10.9 1 1 0 0 0-1.3-1.2A10.6 10.6 0 1 0 21.8 16.6a1 1 0 0 0-1.2-1.3z"/></svg></button>
<progress class="progress-line" data-reading-progress max="100" value="0" aria-label="閱讀進度"></progress>
</header>
<aside class="sidebar" data-sidebar aria-label="章節目錄">
<nav aria-label="全書章節"><ol class="chapter-nav">${chapterGroups(current)}</ol></nav>
</aside>
<button class="drawer-backdrop" data-drawer-backdrop aria-label="關閉章節目錄"></button>
<main id="main" class="shell"><div class="reader">${body}</div><footer class="footer">MIT © 2026 Ying Xiang · <a href="${repo}">Source on GitHub</a></footer></main>
</body>
</html>`;
}

function decodeCode(value) {
    return value
        .replaceAll("&lt;", "<")
        .replaceAll("&gt;", ">")
        .replaceAll("&quot;", '"')
        .replaceAll("&#39;", "'")
        .replaceAll("&amp;", "&");
}

function highlightCodeBlocks(content) {
    return content.replace(/<pre data-lang="([^"]+)"><code>([\s\S]*?)<\/code><\/pre>/g, (_, language, code) => {
        const source = decodeCode(code);
        const highlighted = language === "text" ? escape(source) : hljs.highlight(source, { language }).value;
        return `<pre data-lang="${language}"><code class="hljs language-${language}">${highlighted}</code></pre>`;
    });
}

function extractToc(content) {
    const headings = [...content.matchAll(/<h2 id="([^"]+)">([\s\S]*?)<\/h2>/g)];
    if (!headings.length) return "";
    const items = headings
        .map(([, id, html]) => `<a href="#${id}">${html.replace(/<[^>]+>/g, "")}</a>`)
        .join("");
    return `<nav class="chapter-toc" aria-label="本章節點"><p class="chapter-toc-label">本章節點</p>${items}</nav>`;
}

function takeawaysBox(takeaways) {
    if (!takeaways?.length) return "";
    const items = takeaways.map((item) => `<li>${escape(item)}</li>`).join("");
    return `<aside class="takeaways"><p class="takeaways-label">先看結論</p><ul>${items}</ul></aside>`;
}

function articlePage(chapter, index, content, assets) {
    const previous = chapters[index - 1];
    const next = chapters[index + 1];
    const navigation = `<nav class="chapter-footer" aria-label="章節前後導覽">
${previous ? `<a href="/${previous.slug}/"><small>上一章</small> ${escape(previous.title)}</a>` : `<a href="/"><small>回到目錄</small> 全書學習路徑</a>`}
${next ? `<a href="/${next.slug}/"><small>下一章</small> ${escape(next.title)}</a>` : `<a href="/"><small>完成第一版</small> 回到目錄</a>`}
</nav>`;
    return layout({
        title: chapter.title,
        description: chapter.description,
        path: `/${chapter.slug}/`,
        current: chapter.slug,
        assets,
        body: `<article class="article"><p class="eyebrow">${escape(chapter.part)} · 第 ${index} 章</p><h1>${escape(chapter.title)}</h1><p class="deck">${escape(chapter.description)}</p><div class="meta"><span>約 ${chapter.minutes} 分鐘</span> <span>${index + 1} / ${chapters.length}</span></div>${takeawaysBox(chapter.takeaways)}${extractToc(content)}${highlightCodeBlocks(content)}</article>${navigation}`,
    });
}

function homePage(assets) {
    const total = chapters.reduce((sum, chapter) => sum + chapter.minutes, 0);
    const cards = chapters
        .map(
            (chapter, index) =>
                `<a class="path-card" href="/${chapter.slug}/"><span class="index">${String(index).padStart(2, "0")}</span> <span><h2>${escape(chapter.title)}</h2><p>${escape(chapter.description)}</p></span> <time>${chapter.minutes} 分鐘</time></a>`,
        )
        .join("");
    return layout({
        title: "從第一性原理打造可靠 AI Agent",
        description:
            "給軟體工程師的繁體中文 AI Agent 工程教材：從最小迴圈、tools 與 context，一路走到 durable Session、recovery、測試與安全邊界。",
        path: "/",
        type: "home",
        assets,
        body: `<figure class="home-hero"><img src="/assets/${assets.hero}" alt="一隻背著小包的小型機器人站在青草山丘頂端，面對遠方海岸線與開闊天空" loading="eager" fetchpriority="high" width="1915" height="821"><figcaption class="home-hero-tag">tiny-agent · 一步一步走向可靠的 Agent</figcaption></figure><article class="article home-intro"><p class="eyebrow">繁體中文（臺灣）· 開源工程教材</p><h1>從第一性原理，打造能穩定執行的 AI Agent</h1><p class="deck">這不是功能清單，也不是 prompt 技巧合集。我們先建立 model、token、message 與 context 的共同語言，再從教學用的 model → tool → result canonical loop，逐步推導 durable intent、crash recovery 與 production 邊界。</p><div class="meta"><span>${chapters.length} 章</span> <span>約 ${total} 分鐘</span> <span>TypeScript / Go / Python / Rust</span></div><a href="/${chapters[0].slug}/">開始第零章 →</a><figure class="step-flow" id="fig-home-map" aria-labelledby="fig-home-map-caption"><ol><li><span class="step-label">第零部｜基礎知識</span><p>共同語言：模型實際看見什麼</p></li><li class="step-arrow" aria-hidden="true">→</li><li><span class="step-label">第一部｜最小閉環</span><p>控制流程：Agent 如何持續行動</p></li><li class="step-arrow" aria-hidden="true">→</li><li><span class="step-label">第二、三部｜能力與可靠性</span><p>從能做事走向能恢復</p></li></ol><figcaption id="fig-home-map-caption">圖 1：全書地圖（開場版）。第四部會進一步處理測試、observability 與安全邊界。</figcaption></figure><section class="path" aria-labelledby="path-title"><h2 id="path-title">學習路徑</h2>${cards}</section><aside class="acknowledgement"><h2>感謝 Pi 帶來的啟發</h2><p>這本書與 tiny-agent 的許多設計思考受到 <a href="https://github.com/earendil-works/pi">Pi</a> 啟發，尤其是精簡的 agent loop、Tool 模型、skills 漸進載入、compaction，以及讓 coding agent 保持可理解與可操作的工程取向。感謝 Pi 及其貢獻者公開實作與文件。</p><p>Tiny-agent 不是 Pi 的 fork 或移植。它是獨立的四語言教學實作，並針對 transactional Session、crash recovery 與跨語言 conformance 發展自己的 contract。</p></aside><p class="version-note">本書內容對照 repository 目前狀態。四語言能力差異等細節請以 repo 原始碼為準。</p><section class="planned"><h2 id="planned-title">接下來會寫</h2><p>以下是已規劃的 polyglot 與企業實戰篇。先顯示路線，不建立空白頁面。</p><ul>${planned.map((item) => `<li>${escape(item)}</li>`).join("")}</ul></section></article>`,
    });
}

function bookPlugin(): Plugin {
    const assetRefs = new Map();
    let assetCount = 0;

    return {
        name: "tiny-agent-book",
        enforce: "pre",
        resolveId(id) {
            if (id === "virtual:book") return "\0virtual:book";
        },
        load(id) {
            if (id === "\0virtual:book") return "export default {};";
        },
        async buildStart() {
            const assetsDir = join(bookRoot, "src/assets");
            for (const fileName of await readdir(assetsDir)) {
                const source = await readFile(join(assetsDir, fileName));
                assetRefs.set(fileName, this.emitFile({ type: "asset", name: fileName, source }));
            }
            assetCount = assetRefs.size;
        },
        async generateBundle(_, bundle) {
            for (const [fileName, item] of Object.entries(bundle)) {
                if (item.type === "chunk") delete bundle[fileName];
            }

            const assetMap = new Map([...assetRefs].map(([name, ref]) => [name, this.getFileName(ref)]));
            const assetName = (name) => assetMap.get(name)?.split("/").at(-1);
            const assets = {
                css: assetName("styles.css"),
                js: assetName("book.js"),
                theme: assetName("theme.js"),
                favicon: assetName("favicon.png"),
                hero: assetName("hero.png"),
            };
            const emit = (fileName, source) => this.emitFile({ type: "asset", fileName, source });

            emit("index.html", homePage(assets));
            for (const [index, chapter] of chapters.entries()) {
                let content = await readFile(join(bookRoot, "src/chapters", chapter.file), "utf8");
                content = content.replaceAll(/<!-- ASSET:([a-zA-Z0-9._-]+) -->/g, (_, rawName) => {
                    const hashed = assetMap.get(rawName);
                    if (!hashed) throw new Error(`Chapter ${chapter.file} references missing asset: ${rawName}`);
                    return `/${hashed}`;
                });
                emit(`${chapter.slug}/index.html`, articlePage(chapter, index, content, assets));
            }

            const architectureSource = await readFile(resolve(bookRoot, "../docs/tiny-ts-architecture.html"), "utf8");
            const architectureHtml = architectureSource
                .replace("      padding: 2rem;", "      padding: 1rem;")
                .replace("      max-width: var(--archify-reader-width, 1440px);", "      max-width: none;");
            const architectureHashes = architectureCsp(architectureHtml);
            emit("00-foundations/architecture/index.html", architectureHtml);

            const urls = ["/", ...chapters.map((chapter) => `/${chapter.slug}/`), "/00-foundations/architecture/"];
            emit(
                "sitemap.xml",
                `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.map((path) => `  <url><loc>${origin}${path}</loc></url>`).join("\n")}\n</urlset>\n`,
            );
            emit("robots.txt", `User-agent: *\nAllow: /\nSitemap: ${origin}/sitemap.xml\n`);
            emit(
                "404.html",
                layout({
                    title: "找不到頁面",
                    description: "這個頁面不存在。",
                    path: "/404.html",
                    assets,
                    body: `<article class="article"><p class="eyebrow">404</p><h1>這裡沒有章節</h1><p class="deck">連結可能已經改變，回到學習路徑繼續閱讀。</p><p><a href="/">返回全書目錄 →</a></p></article>`,
                }),
            );
            emit(
                "_headers",
                `/*\n  X-Content-Type-Options: nosniff\n  Referrer-Policy: strict-origin-when-cross-origin\n  Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=()\n  Content-Security-Policy: default-src 'self'; script-src 'self' https://static.cloudflareinsights.com ${architectureHashes.scripts}; style-src 'self' ${architectureHashes.styles}; img-src 'self' data: blob:; font-src 'self' data:; connect-src https://cloudflareinsights.com; frame-src 'self' https://www.youtube.com; object-src 'self'; frame-ancestors 'self'; base-uri 'self'; form-action 'self'\n\n/assets/*\n  Cache-Control: public, max-age=31536000, immutable\n`,
            );
            emit("_redirects", "/index.html / 301\n");
            emit(
                "search-index.json",
                JSON.stringify(chapters.map(({ slug, title, description, part }) => ({ slug, title, description, part })), null, 2),
            );
        },
        writeBundle() {
            console.log(`Built ${chapters.length + 1} pages with ${assetCount} assets in ${out}`);
        },
    };
}

const config: UserConfig = {
    build: {
        outDir: out,
        emptyOutDir: true,
        rollupOptions: {
            input: "virtual:book",
            output: { assetFileNames: "assets/[name].[hash][extname]" },
        },
    },
    plugins: [bookPlugin()],
};

export default defineConfig(config);
