import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chapters, planned } from "../src/chapters.js";

const bookRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const out = resolve(process.env.BOOK_OUT_DIR || join(bookRoot, "dist"));
const origin = "https://tiny-agent.geminixiang.com";
const repo = "https://github.com/geminixiang/tiny-agent";
const escape = (value) =>
    String(value).replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
const hash = (content) => createHash("sha256").update(content).digest("hex").slice(0, 12);

function chapterGroups(current) {
    let part = "";
    return chapters
        .map((chapter, index) => {
            const heading = chapter.part === part ? "" : `<li class="nav-part">${escape((part = chapter.part))}</li>`;
            return `${heading}<li data-search-item><a href="/${chapter.slug}/"${chapter.slug === current ? ' aria-current="page"' : ""}><span class="chapter-number">${String(index + 1).padStart(2, "0")}</span> <span>${escape(chapter.title)}</span></a></li>`;
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
<a class="icon-button" href="${repo}" aria-label="GitHub repository">↗</a>
<button class="icon-button theme-button" type="button" data-theme-toggle aria-label="切換主題">☾</button>
<progress class="progress-line" data-reading-progress max="100" value="0" aria-label="閱讀進度"></progress>
</header>
<aside class="sidebar" data-sidebar aria-label="章節目錄">
<label for="chapter-search" class="nav-part">篩選章節</label>
<input id="chapter-search" class="search" type="search" placeholder="輸入關鍵字" data-nav-search>
<p class="search-note">沒有 JavaScript 時仍顯示完整目錄。</p>
<nav aria-label="全書章節"><ol class="chapter-nav">${chapterGroups(current)}</ol><p class="nav-empty" data-nav-empty hidden>沒有符合的章節。</p></nav>
</aside>
<button class="drawer-backdrop" data-drawer-backdrop aria-label="關閉章節目錄"></button>
<main id="main" class="shell"><div class="reader">${body}</div><footer class="footer">MIT © 2026 Ying Xiang · <a href="${repo}">Source on GitHub</a></footer></main>
</body>
</html>`;
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
        body: `<article class="article"><p class="eyebrow">${escape(chapter.part)} · 第 ${index + 1} 章</p><h1>${escape(chapter.title)}</h1><p class="deck">${escape(chapter.description)}</p><div class="meta"><span>約 ${chapter.minutes} 分鐘</span> <span>${index + 1} / ${chapters.length}</span></div>${content}</article>${navigation}`,
    });
}

function homePage(assets) {
    const total = chapters.reduce((sum, chapter) => sum + chapter.minutes, 0);
    const cards = chapters
        .map(
            (chapter, index) =>
                `<a class="path-card" href="/${chapter.slug}/"><span class="index">${String(index + 1).padStart(2, "0")}</span> <span><h2>${escape(chapter.title)}</h2><p>${escape(chapter.description)}</p></span> <time>${chapter.minutes} 分鐘</time></a>`,
        )
        .join("");
    return layout({
        title: "從第一性原理打造可靠 AI Agent",
        description:
            "給軟體工程師的繁體中文 AI Agent 工程教材：從最小迴圈、tools 與 context，一路走到 durable Session、recovery、測試與安全邊界。",
        path: "/",
        type: "home",
        assets,
        body: `<article class="article home-intro"><p class="eyebrow">繁體中文（臺灣）· 開源工程教材</p><h1>從第一性原理，打造能穩定執行的 AI Agent</h1><p class="deck">這不是功能清單，也不是 prompt 技巧合集。我們從不可再刪的 model → tool → result 閉環開始，逐步推導 context、durable intent、crash recovery 與 production 邊界。</p><div class="meta"><span>${chapters.length} 章</span> <span>約 ${total} 分鐘</span> <span>TypeScript / Go / Python / Rust</span></div><a href="/${chapters[0].slug}/">開始第一章 →</a><figure class="step-flow" id="fig-home-map" aria-labelledby="fig-home-map-caption"><ol><li><span class="step-label">第一部｜最小閉環</span><p>無壓力：迴圈本身</p></li><li class="step-arrow" aria-hidden="true">→</li><li><span class="step-label">第二部｜能力邊界</span><p>能力壓力：迴圈能做什麼</p></li><li class="step-arrow" aria-hidden="true">→</li><li><span class="step-label">第三部｜可靠執行</span><p>接下來登場</p></li></ol><figcaption id="fig-home-map-caption">圖 1：全書地圖（開場版）。後面還有第四部，讀到 08 章會看到完整版本。</figcaption></figure><section class="path" aria-labelledby="path-title"><h2 id="path-title">學習路徑</h2>${cards}</section><aside class="acknowledgement"><h2>感謝 Pi 帶來的啟發</h2><p>這本書與 tiny-agent 的許多設計思考受到 <a href="https://github.com/earendil-works/pi">Pi</a> 啟發，尤其是精簡的 agent loop、Tool 模型、skills 漸進載入、compaction，以及讓 coding agent 保持可理解與可操作的工程取向。感謝 Pi 及其貢獻者公開實作與文件。</p><p>Tiny-agent 不是 Pi 的 fork 或移植；它是獨立的四語言教學實作，並針對 transactional Session、crash recovery 與跨語言 conformance 發展自己的 contract。</p></aside><p class="version-note">本書內容對照 repository 目前狀態；四語言能力差異等細節請以 repo 原始碼為準。</p><section class="planned"><h2 id="planned-title">接下來會寫</h2><p>以下是已規劃的 polyglot 與企業實戰篇；先顯示路線，不建立空白頁面。</p><ul>${planned.map((item) => `<li>${escape(item)}</li>`).join("")}</ul></section></article>`,
    });
}

async function main() {
    await rm(out, { recursive: true, force: true });
    await mkdir(join(out, "assets"), { recursive: true });
    const [cssContent, jsContent, themeContent, faviconContent] = await Promise.all([
        readFile(join(bookRoot, "src/assets/styles.css"), "utf8"),
        readFile(join(bookRoot, "src/assets/book.js"), "utf8"),
        readFile(join(bookRoot, "src/assets/theme.js"), "utf8"),
        readFile(join(bookRoot, "src/assets/favicon.png")),
    ]);
    const assets = {
        css: `styles.${hash(cssContent)}.css`,
        js: `book.${hash(jsContent)}.js`,
        theme: `theme.${hash(themeContent)}.js`,
        favicon: `favicon.${hash(faviconContent)}.png`,
    };
    await Promise.all([
        writeFile(join(out, "assets", assets.css), cssContent),
        writeFile(join(out, "assets", assets.js), jsContent),
        writeFile(join(out, "assets", assets.theme), themeContent),
        writeFile(join(out, "assets", assets.favicon), faviconContent),
        writeFile(join(out, "index.html"), homePage(assets)),
    ]);
    for (const [index, chapter] of chapters.entries()) {
        const content = await readFile(join(bookRoot, "src/chapters", chapter.file), "utf8");
        const directory = join(out, chapter.slug);
        await mkdir(directory, { recursive: true });
        await writeFile(join(directory, "index.html"), articlePage(chapter, index, content, assets));
    }
    const urls = ["/", ...chapters.map((chapter) => `/${chapter.slug}/`)];
    await writeFile(
        join(out, "sitemap.xml"),
        `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.map((path) => `  <url><loc>${origin}${path}</loc></url>`).join("\n")}\n</urlset>\n`,
    );
    await writeFile(join(out, "robots.txt"), `User-agent: *\nAllow: /\nSitemap: ${origin}/sitemap.xml\n`);
    await writeFile(
        join(out, "404.html"),
        layout({
            title: "找不到頁面",
            description: "這個頁面不存在。",
            path: "/404.html",
            assets,
            body: `<article class="article"><p class="eyebrow">404</p><h1>這裡沒有章節</h1><p class="deck">連結可能已經改變，回到學習路徑繼續閱讀。</p><p><a href="/">返回全書目錄 →</a></p></article>`,
        }),
    );
    await writeFile(
        join(out, "_headers"),
        `/*\n  X-Content-Type-Options: nosniff\n  Referrer-Policy: strict-origin-when-cross-origin\n  Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=()\n  Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'none'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'\n\n/assets/*\n  Cache-Control: public, max-age=31536000, immutable\n`,
    );
    await writeFile(join(out, "_redirects"), `/index.html / 301\n`);
    await writeFile(
        join(out, "search-index.json"),
        JSON.stringify(
            chapters.map(({ slug, title, description, part }) => ({ slug, title, description, part })),
            null,
            2,
        ),
    );
    console.log(`Built ${chapters.length + 1} pages in ${out}`);
}

await main();
