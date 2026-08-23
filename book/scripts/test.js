import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { chapters } from "../src/chapters.js";

const root = resolve(import.meta.dirname, "..");
const out = await mkdtemp(join(tmpdir(), "tiny-agent-book-"));
const build = spawnSync(process.execPath, [join(root, "scripts/build.js")], {
    cwd: root,
    env: { ...process.env, BOOK_OUT_DIR: out },
    encoding: "utf8",
});
if (build.status !== 0) throw new Error(build.stderr || build.stdout);
test.after(async () => rm(out, { recursive: true, force: true }));

async function files(directory) {
    const result = [];
    for (const entry of await readdir(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) result.push(...(await files(path)));
        else result.push(path);
    }
    return result;
}

const outputFiles = await files(out);
const htmlFiles = outputFiles.filter((file) => file.endsWith(".html"));
const assets = new Set(outputFiles.map((file) => file.slice(out.length).replaceAll("\\", "/")));
const pages = new Map();
for (const file of htmlFiles) {
    const relative = file.slice(out.length).replaceAll("\\", "/");
    const route =
        relative === "/index.html"
            ? "/"
            : relative === "/404.html"
              ? "/404.html"
              : relative.replace(/index\.html$/, "");
    pages.set(route, await readFile(file, "utf8"));
}

const generatedAssets = [...assets].filter((path) => path.startsWith("/assets/"));
const cssAsset = generatedAssets.find((path) => /^\/assets\/styles\.[a-f0-9]{12}\.css$/.test(path));
const jsAsset = generatedAssets.find((path) => /^\/assets\/book\.[a-f0-9]{12}\.js$/.test(path));

test("chapter registry is unique and complete", () => {
    assert.equal(new Set(chapters.map((chapter) => chapter.slug)).size, chapters.length);
    assert.equal(new Set(chapters.map((chapter) => chapter.title)).size, chapters.length);
    for (const chapter of chapters) {
        assert.match(chapter.slug, /^\d{2}-[a-z0-9-]+$/);
        assert.ok(chapter.description.length > 30);
        assert.ok(chapter.minutes > 0);
        assert.ok(pages.has(`/${chapter.slug}/`));
    }
});

test("build emits Cloudflare Pages files and content-hashed assets", async () => {
    for (const file of [
        "index.html",
        "404.html",
        "sitemap.xml",
        "robots.txt",
        "_headers",
        "_redirects",
        "search-index.json",
    ]) {
        assert.ok((await stat(join(out, file))).isFile(), file);
    }
    assert.ok(cssAsset, "hashed CSS asset");
    assert.ok(jsAsset, "hashed JavaScript asset");
    assert.equal(generatedAssets.length, 2);
    assert.equal(pages.size, chapters.length + 2);
    for (const html of pages.values()) {
        assert.match(html, new RegExp(`<link rel="stylesheet" href="${cssAsset}">`));
        assert.match(html, new RegExp(`<script src="${jsAsset}" defer></script>`));
        assert.doesNotMatch(html, /<script(?:\s[^>]*)?>\s*[^<]/);
    }
});

test("every page has accessible and canonical HTML basics", () => {
    for (const [route, html] of pages) {
        assert.match(html, /^<!doctype html>/);
        assert.match(html, /<html lang="zh-Hant-TW">/);
        assert.match(html, /<meta name="viewport"/);
        assert.match(html, /<main id="main"/);
        assert.match(html, /<h1[ >]/);
        assert.match(
            html,
            new RegExp(
                `<link rel="canonical" href="https://tiny-agent\\.geminixiang\\.com${route.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}">`,
            ),
        );
        const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1]);
        assert.equal(new Set(ids).size, ids.length, `duplicate id in ${route}`);
    }
});

test("internal links resolve", () => {
    for (const [route, html] of pages) {
        for (const match of html.matchAll(/href="([^"]+)"/g)) {
            const href = match[1];
            if (/^(https?:|mailto:|#)/.test(href)) continue;
            const [path, anchor] = href.split("#");
            if (path.startsWith("/assets/")) assert.ok(assets.has(path), `${route} → ${href}`);
            else assert.ok(pages.has(path || route), `${route} → ${href}`);
            if (anchor)
                assert.match(
                    pages.get(path || route),
                    new RegExp(`id="${anchor.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`),
                );
        }
    }
});

test("repository source links point at real, current code", async () => {
    const repoRoot = resolve(root, "..");
    const blobPrefix = "https://github.com/geminixiang/tiny-agent/blob/main/";
    const treePrefix = "https://github.com/geminixiang/tiny-agent/tree/main/";
    for (const [route, html] of pages) {
        for (const asideMatch of html.matchAll(/<aside class="note">[\s\S]*?<\/aside>/g)) {
            for (const [, href, innerHtml] of asideMatch[0].matchAll(/<a href="([^"]+)">([\s\S]*?)<\/a>/g)) {
                if (href.startsWith(treePrefix)) {
                    const dirPath = href.slice(treePrefix.length).split("#")[0];
                    assert.ok(
                        (await stat(join(repoRoot, dirPath))).isDirectory(),
                        `${route}: ${href} 指向不存在的目錄`,
                    );
                    continue;
                }
                if (!href.startsWith(blobPrefix)) continue;
                const [filePath, lineAnchor] = href.slice(blobPrefix.length).split("#");
                const absPath = join(repoRoot, filePath);
                assert.ok((await stat(absPath)).isFile(), `${route}: ${href} 指向不存在的檔案 ${filePath}`);
                if (!lineAnchor) continue;
                const lineNum = Number(lineAnchor.replace(/^L/, ""));
                const lines = (await readFile(absPath, "utf8")).split("\n");
                assert.ok(
                    lineNum >= 1 && lineNum <= lines.length,
                    `${route}: ${href} 行號 ${lineNum} 超出檔案長度 ${lines.length}`,
                );
                const codeMatch = innerHtml.match(/<code>([^<]+)<\/code>/);
                assert.ok(
                    codeMatch,
                    `${route}: ${href} 帶行號但連結文字沒有 <code>符號</code>，無法驗證連結是否指向正確位置`,
                );
                const symbol = codeMatch[1].replace(/\(\)$/, "").split(".").pop().trim();
                const windowStart = Math.max(0, lineNum - 6);
                const windowEnd = Math.min(lines.length, lineNum + 40);
                const window = lines.slice(windowStart, windowEnd).join("\n");
                assert.ok(
                    window.includes(symbol),
                    `${route}: ${href} 的 <code>${symbol}</code> 在 ${filePath}:${lineNum} 附近 ${windowStart + 1}-${windowEnd} 行範圍內找不到，連結可能已經漂移`,
                );
            }
        }
    }
});

test("chapters 01-07 close with a reader-facing bridge, chapter 08 closes with a closure", () => {
    for (const chapter of chapters) {
        const html = pages.get(`/${chapter.slug}/`);
        const isLast = chapter.slug === "08-test-observe-secure";
        const markerClass = isLast ? "closure" : "bridge";
        const otherClass = isLast ? "bridge" : "closure";
        const matches = [...html.matchAll(new RegExp(`<p class="${markerClass}">`, "g"))];
        assert.equal(matches.length, 1, `${chapter.slug} 應恰好有一個 <p class="${markerClass}">`);
        assert.ok(!html.includes(`<p class="${otherClass}">`), `${chapter.slug} 不應包含 <p class="${otherClass}">`);
        // 必須落在最後一個 <h2> 之後的尾段，不能是章節中段的過渡句
        const lastH2Index = html.lastIndexOf("<h2 ");
        const markerIndex = html.indexOf(`<p class="${markerClass}">`);
        assert.ok(markerIndex > lastH2Index, `${chapter.slug} 的 ${markerClass} 應該在最後一個 <h2> 之後`);
    }
});

test("chapter 03 and 05 foreshadow the deep-interface callback exactly once each with the fixed anchor phrase", () => {
    const anchor = "稍後你會再看到這個形狀";
    for (const slug of ["03-tools", "05-durable-session"]) {
        const html = pages.get(`/${slug}/`);
        const callbacks = [...html.matchAll(/<p class="deep-interface-callback">([\s\S]*?)<\/p>/g)];
        assert.equal(callbacks.length, 1, `${slug} 應恰好有一個 deep-interface-callback`);
        assert.ok(callbacks[0][1].includes(anchor), `${slug} 的 callback 必須包含固定錨句「${anchor}」`);
    }
});

test("chapter 06 names all three deep-interface seams and all four recovery outcomes", () => {
    const html = pages.get("/06-recovery/");
    const summary = html.match(/<p class="three-interfaces-summary">([\s\S]*?)<\/p>/);
    assert.ok(summary, "06章缺少 three-interfaces-summary");
    assert.match(summary[1], /第三次/);
    assert.match(summary[1], /Tool 的 execute/);
    assert.match(summary[1], /SessionStore 的 commit\/load/);
    assert.match(summary[1], /reducer\/planner/);
    const outcomes = html.match(/<p class="four-outcomes">([\s\S]*?)<\/p>/);
    assert.ok(outcomes, "06章缺少 four-outcomes");
    for (const term of ["retry", "replay", "blocked", "failed"]) {
        assert.match(outcomes[1], new RegExp(`<strong>${term}</strong>`, "i"), `four-outcomes 缺少 ${term}`);
    }
});

test("chapter 05 opens with three visually distinct paragraphs naming a core rule", () => {
    const html = pages.get("/05-durable-session/");
    const leadEnd = Math.min(
        ...["<details", '<h2 id="promise"'].map((marker) => html.indexOf(marker)).filter((index) => index !== -1),
    );
    const leadBlock = html.slice(html.indexOf('<p class="lead">'), leadEnd);
    const paragraphs = [...leadBlock.matchAll(/<p[^>]*>[\s\S]*?<\/p>/g)];
    assert.equal(paragraphs.length, 3, "05章開場應為三個獨立段落，不是一段散文");
    assert.match(leadBlock, /<strong>核心規則/, "第二段應以<strong>明確命名核心規則");
});

test("chapter 07 places a transition between the abort-race and compaction sections", () => {
    const html = pages.get("/07-cancel-compact/");
    const raceIndex = html.indexOf('<h2 id="race">');
    const compactionIndex = html.indexOf('<h2 id="compaction">');
    const transitionIndex = html.indexOf('<p class="transition">');
    assert.ok(
        transitionIndex > raceIndex && transitionIndex < compactionIndex,
        "transition 應位於 race 與 compaction 兩個 h2 之間",
    );
    assert.match(
        html.slice(raceIndex, compactionIndex),
        /durable\s*\n?\s*operation/i,
        "transition 必須說明 compaction 本身也是 durable operation",
    );
});

test("chapter 08 backreferences the chapter 1 responsibility table inside the security section", () => {
    const html = pages.get("/08-test-observe-secure/");
    const securitySection = html.slice(html.indexOf('<h2 id="security"'), html.indexOf('<h2 id="multi-tenant"'));
    assert.match(securitySection, /第 1\s+章的責任表/);
});

test("diagrams are controlled semantic HTML: no mermaid/svg/canvas/inline-style, every figure has a unique id and a matching figcaption", () => {
    const seenIds = new Set();
    let figureCount = 0;
    for (const [route, html] of pages) {
        assert.doesNotMatch(html, /<svg[\s>]/i, `${route} 不應含 <svg>`);
        assert.doesNotMatch(html, /<canvas[\s>]/i, `${route} 不應含 <canvas>`);
        assert.doesNotMatch(html, /mermaid/i, `${route} 不應含 mermaid`);
        for (const figureMatch of html.matchAll(/<figure\b([^>]*)>([\s\S]*?)<\/figure>/g)) {
            figureCount += 1;
            const [, attrs, body] = figureMatch;
            const idMatch = attrs.match(/\bid="([^"]+)"/);
            assert.ok(idMatch, `${route} 有一個 <figure> 缺少 id`);
            assert.ok(!seenIds.has(idMatch[1]), `figure id 重複：${idMatch[1]}`);
            seenIds.add(idMatch[1]);
            const labelledby = attrs.match(/aria-labelledby="([^"]+)"/);
            assert.ok(labelledby, `${route} 的 <figure id="${idMatch[1]}"> 缺少 aria-labelledby`);
            assert.match(
                body,
                new RegExp(`<figcaption id="${labelledby[1]}">`),
                `${route} 的 <figure id="${idMatch[1]}"> 的 figcaption id 與 aria-labelledby 不匹配`,
            );
        }
    }
    assert.equal(figureCount, 8, `全書應恰好有 8 個 <figure>，實際 ${figureCount}`);
});

test("figures sit in the documented reading order relative to their anchoring prose", () => {
    const home = pages.get("/");
    assert.ok(home.indexOf('id="fig-home-map"') > home.indexOf("開始第一章"), "首頁圖1a應在「開始第一章」連結之後");
    assert.ok(home.indexOf('id="fig-home-map"') < home.indexOf('id="path-title"'), "首頁圖1a應在學習路徑清單之前");

    const ch01 = pages.get("/01-first-principles/");
    assert.ok(ch01.indexOf('id="fig-01-loop"') > ch01.indexOf("runAgentLoop"), "01章圖2應在 runAgentLoop 程式碼之後");
    assert.ok(ch01.indexOf('id="fig-01-loop"') < ch01.indexOf('id="why-coding-agent"'), "01章圖2應在下一個 h2 之前");

    const ch05 = pages.get("/05-durable-session/");
    assert.ok(ch05.indexOf('id="fig-05-bridge"') > ch05.indexOf("核心規則"), "05章圖3應在三段式開場之後");
    assert.ok(ch05.indexOf('id="fig-05-bridge"') < ch05.indexOf('id="promise"'), "05章圖3應在 h2#promise 之前");
    assert.ok(
        ch05.indexOf('id="fig-05-intent-effect"') > ch05.indexOf('id="intent-effect"'),
        "05章圖4應在 h2#intent-effect 之後",
    );
    assert.ok(ch05.indexOf('id="fig-05-intent-effect"') < ch05.indexOf('id="fact-kinds"'), "05章圖4應在下一個 h2 之前");

    const ch06 = pages.get("/06-recovery/");
    assert.ok(
        ch06.indexOf('id="fig-06-planner"') > ch06.indexOf('id="configuration"'),
        "06章圖5應在 h2#configuration 完整定義段落之後",
    );
    assert.ok(
        ch06.indexOf('id="fig-06-planner"') > ch06.indexOf("任何不一致都回傳 blocked"),
        "06章圖5應在 configuration/environment/replayKey 定義段落結尾之後",
    );
    assert.ok(ch06.indexOf('id="fig-06-planner"') < ch06.indexOf('id="synthetic"'), "06章圖5應在 h2#synthetic 之前");

    const ch07 = pages.get("/07-cancel-compact/");
    assert.ok(
        ch07.indexOf('id="fig-07-compaction"') > ch07.indexOf('id="two-boundaries"'),
        "07章圖6應緊接在 h2#two-boundaries 之後",
    );
    assert.ok(ch07.indexOf('id="fig-07-compaction"') < ch07.indexOf("<h3>"), "07章圖6應在第一個 h3 之前");

    const ch08 = pages.get("/08-test-observe-secure/");
    assert.ok(
        ch08.indexOf('id="fig-08-responsibility"') > ch08.indexOf("responsibility-backref"),
        "08章圖7應在責任表回指句之後",
    );
    assert.ok(
        ch08.indexOf('id="fig-08-responsibility"') < ch08.indexOf("Agent implementation 與"),
        "08章圖7應在既有安全邊界清單之前",
    );
    assert.ok(ch08.indexOf('id="fig-08-map"') > ch08.lastIndexOf("<h2 "), "08章圖1b應在最後一個 h2 之後");
    assert.ok(ch08.indexOf('id="fig-08-map"') < ch08.indexOf('class="closure"'), "08章圖1b應在收束句之前");
});

test("figure 5 shows configuration/environment/replay gates before failed/retry/replay outcomes, with all four blocked reasons independently visible", () => {
    const html = pages.get("/06-recovery/");
    const figure = html.slice(
        html.indexOf('id="fig-06-planner"'),
        html.indexOf("</figure>", html.indexOf('id="fig-06-planner"')),
    );
    for (const reason of [
        "configuration_changed",
        "environment_changed",
        "replay_declaration_changed",
        "attempts_exhausted",
    ]) {
        assert.match(figure, new RegExp(reason), `圖5缺少 blocked reason: ${reason}`);
    }
    // configuration/environment 閘門必須先於 stepFailed 判斷出現在文件順序中（不能暗示 stepFailed 永遠先被檢查）
    assert.ok(
        figure.indexOf("configurationDigest 不符") < figure.indexOf("已 <code>stepFailed</code>"),
        "圖5的 configuration 閘門應在 stepFailed 分支之前出現",
    );
    assert.match(
        figure,
        /只有先通過上面兩關/,
        "圖5必須明確說明 stepFailed 不保證優先於 configuration/environment 檢查",
    );
});

test("figure 5 only labels Aborted and Failed as terminal; blocked/retry/replay/start/synthetic nodes never say (終局)", () => {
    const html = pages.get("/06-recovery/");
    const figure = html.slice(
        html.indexOf('id="fig-06-planner"'),
        html.indexOf("</figure>", html.indexOf('id="fig-06-planner"')),
    );
    const outcomeSpans = [...figure.matchAll(/<span class="outcome([^"]*)">([\s\S]*?)<\/span>/g)];
    assert.ok(outcomeSpans.length > 0, "圖5應至少有一個 outcome span");
    let terminalCount = 0;
    for (const [, classSuffix, text] of outcomeSpans) {
        const isTerminal = classSuffix.includes("terminal");
        if (isTerminal) {
            terminalCount += 1;
            assert.match(text, /終局/, `終局節點應包含「終局」字樣：${text}`);
        } else {
            assert.doesNotMatch(text, /（終局/, `非終局節點不應寫「（終局」：${text}`);
        }
    }
    assert.equal(terminalCount, 2, "只有 Aborted 與 Failed 兩個節點應標記為 terminal");
});

test("figure 3 is collapsed by default via native <details>, not JavaScript", () => {
    const html = pages.get("/05-durable-session/");
    assert.match(html, /<details class="reading-branch">/, '05章應有預設收合的 <details class="reading-branch">');
    assert.doesNotMatch(html, /<details class="reading-branch"[^>]*\bopen\b/, "圖3的 <details> 不應帶 open 屬性");
});

test("figure 6 and figure 7 captions disambiguate track alignment and responsibility-vs-process boundaries", () => {
    const ch07 = pages.get("/07-cancel-compact/");
    assert.match(ch07, /找不到\s+user 邊界就放棄本次 compact/, "圖6 caption 應說明兩軌對齊的防護機制");
    const ch08 = pages.get("/08-test-observe-secure/");
    assert.match(ch08, /不是 process 邊界/, "圖7 caption 應明確排除「兩個 process」的誤讀");
});

test("diagram CSS components degrade on narrow viewports and print via stylesheet rules, not inline style", async () => {
    const css = await readFile(join(root, "src/assets/styles.css"), "utf8");
    assert.match(css, /html \{[^}]*overflow-x: clip;/, "off-canvas drawer must not widen the document");
    assert.match(css, /@media \(max-width: 860px\) \{[\s\S]*?\.step-flow ol \{ flex-direction: column; \}/);
    assert.match(
        css,
        /@media \(max-width: 860px\) \{[\s\S]*?\.decision-tree ol, \.decision-tree ul \{ padding-left: \.85rem; \}/,
    );
    assert.match(css, /@media print \{[\s\S]*?\.step-flow li, \.decision-tree li \{ break-inside: avoid; \}/);
    assert.doesNotMatch(css, /\.track-grid/, "track-grid 元件已被移除，07章圖6改用原生 table");
    assert.doesNotMatch(css, /style="/);
});

test("figure 2's loop-back marker keeps the return condition readable to screen readers", () => {
    const html = pages.get("/01-first-principles/");
    assert.match(
        html,
        /<li class="step-loop-back"><span aria-hidden="true">↻<\/span> 回到 messages，直到不再有 tool_calls<\/li>/,
        "loop-back li 本身不應整個 aria-hidden；只有↻符號用 span aria-hidden，終止條件文字須保留給 screen reader",
    );
});

test("chapters contain substantial required concepts and exercises", () => {
    const all = chapters.map((chapter) => pages.get(`/${chapter.slug}/`)).join("\n");
    for (const term of [
        "runAgentLoop",
        "normalizeAssistantMessage",
        "Tool",
        "AGENTS.md",
        "progressive",
        "toolStarted",
        "process-crash",
        "planRecovery",
        "replayKey",
        "abortRequested",
        "source partition",
        "--json",
        "MCP",
        "authorization",
    ]) {
        assert.ok(all.includes(term), `missing concept: ${term}`);
    }
    for (const chapter of chapters) {
        const html = pages.get(`/${chapter.slug}/`);
        const text = html.replace(/<[^>]+>/g, " ");
        assert.ok(text.length > 1800, `${chapter.slug} is too short`);
    }
    for (const chapter of chapters) {
        assert.match(pages.get(`/${chapter.slug}/`), /<h2 id="hands-on">(?:親手驗證|動手驗證)<\/h2>/, chapter.slug);
    }
});

test("home acknowledges Pi without claiming a fork", () => {
    const home = pages.get("/");
    assert.match(home, /感謝 Pi 帶來的啟發/);
    assert.match(home, /href="https:\/\/github\.com\/earendil-works\/pi"/);
    assert.match(home, /Tiny-agent 不是 Pi 的 fork 或移植/);
    assert.match(home, /本書內容對照 repository 目前狀態/);
});

test("source prose and interface strings use zh-TW", async () => {
    const deny = [
        "章节",
        "筛选",
        "复制",
        "软件工程师",
        "代码",
        "数据",
        "服务器",
        "连接",
        "执行结果",
        "错误信息",
        "验证",
        "测试计划",
        "系统",
        "创建",
        "支持",
        "设置",
        "当前",
        "开始",
        "学习路径",
        "页面",
        "链接",
        "用户",
        "实现",
        "调用",
        "返回",
        "历史",
        "默认",
        "继续阅读",
        "加载",
        "读取",
        "档案",
        "进程",
        "恢复",
        "必须",
        "应该",
        "不会",
        "这些",
        "这个",
        "之后",
        "来自",
        "显示",
        "选择",
        "完整目录",
        "没有符合",
        "输入关键词",
        "分钟",
        "繁体中文（台湾）",
        "几十",
        "精确",
        "可见",
        "隐藏",
        "复杂",
        "阅读",
        "什么",
        "认识",
        "这样",
        "给",
        "触碰",
        "机会",
        "补出",
        "维护",
        "当测试",
        "等价",
        "尽力",
        "终止",
        "三条",
        "两者",
        "Repo内",
        "适配",
        "占用",
        "步骤",
        "成长",
        "下一轮",
        "变长",
        "减少",
        "单独",
        "规則",
    ];
    const sourceFiles = [
        join(root, "README.md"),
        join(root, "src/chapters.js"),
        join(root, "src/assets/book.js"),
        join(root, "src/assets/styles.css"),
        ...(await files(join(root, "src/chapters"))),
    ];
    for (const file of sourceFiles) {
        let source = await readFile(file, "utf8");
        if (file.endsWith(".html")) source = source.replace(/<(pre|code)\b[^>]*>[\s\S]*?<\/\1>/gi, "");
        for (const phrase of deny)
            assert.ok(!source.includes(phrase), `${file.slice(root.length + 1)} contains ${phrase}`);
    }
});

test("mobile navigation remains available without JavaScript", async () => {
    const css = await readFile(join(out, cssAsset), "utf8");
    const js = await readFile(join(out, jsAsset), "utf8");
    assert.match(js, /classList\.add\("js"\)/);
    assert.match(js, /sidebar\.inert = isMobile && !open/);
    assert.match(js, /sidebar\.setAttribute\("aria-hidden", "true"\)/);
    assert.match(js, /search\?\.focus\(\)/);
    assert.match(js, /menuButton\?\.focus\(\)/);
    assert.doesNotMatch(js, /\.style\.|setAttribute\(["']style/);
    for (const html of pages.values()) {
        assert.match(html, /<progress class="progress-line"[^>]*max="100"[^>]*value="0"/);
        assert.match(html, /data-nav-empty hidden/);
        assert.doesNotMatch(html, /<[^>]+\sstyle=/);
    }
    assert.match(css, /\.menu-button \{ display: none; \}/);
    assert.match(css, /\.js \.menu-button \{ display: inline-grid; \}/);
    assert.match(css, /\.js \.sidebar \{[^}]*transform: translateX\(-100%\)/s);
    assert.doesNotMatch(css, /@media \(max-width: 860px\)[\s\S]*?\n\s*\.sidebar \{[^}]*transform: translateX\(-100%\)/);
    for (const [route, html] of pages) {
        assert.equal((html.match(/data-search-item/g) || []).length, chapters.length, `${route} complete chapter nav`);
    }
});

test("security and cache headers are restrictive", async () => {
    const headers = await readFile(join(out, "_headers"), "utf8");
    assert.match(headers, /X-Content-Type-Options: nosniff/);
    assert.match(headers, /Content-Security-Policy:/);
    assert.match(headers, /script-src 'self';/);
    assert.match(headers, /connect-src 'none'/);
    assert.match(headers, /frame-ancestors 'none'/);
    assert.doesNotMatch(headers, /unsafe-inline|unsafe-eval/);
    assert.match(headers, /\/assets\/\*\n  Cache-Control: public, max-age=31536000, immutable/);
});

test("sitemap and robots use the canonical origin", async () => {
    const sitemap = await readFile(join(out, "sitemap.xml"), "utf8");
    const robots = await readFile(join(out, "robots.txt"), "utf8");
    for (const route of ["/", ...chapters.map((chapter) => `/${chapter.slug}/`)]) {
        assert.ok(sitemap.includes(`https://tiny-agent.geminixiang.com${route}`));
    }
    assert.match(robots, /Sitemap: https:\/\/tiny-agent\.geminixiang\.com\/sitemap\.xml/);
});
