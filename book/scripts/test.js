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
    const route = relative === "/index.html" ? "/" : relative === "/404.html" ? "/404.html" : relative.replace(/index\.html$/, "");
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
    for (const file of ["index.html", "404.html", "sitemap.xml", "robots.txt", "_headers", "_redirects", "search-index.json"]) {
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
        assert.match(html, new RegExp(`<link rel="canonical" href="https://tiny-agent\\.geminixiang\\.com${route.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}">`));
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
            if (anchor) assert.match(pages.get(path || route), new RegExp(`id="${anchor.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`));
        }
    }
});

test("chapters contain substantial required concepts and exercises", () => {
    const all = chapters.map((chapter) => pages.get(`/${chapter.slug}/`)).join("\n");
    for (const term of ["runAgentLoop", "normalizeAssistantMessage", "Tool", "AGENTS.md", "progressive", "toolStarted", "process-crash", "planRecovery", "replayKey", "abortRequested", "source partition", "--json", "MCP", "authorization"]) {
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
    assert.match(home, /不是Pi的fork或移植/);
});

test("source prose and interface strings use zh-TW", async () => {
    const deny = [
        "章节", "筛选", "复制", "软件工程师", "代码", "数据", "服务器", "连接", "执行结果", "错误信息", "验证", "测试计划", "系统", "创建", "支持", "设置", "当前", "开始", "学习路径", "页面", "链接", "用户", "实现", "调用", "返回", "历史", "默认", "继续阅读", "加载", "读取", "档案", "进程", "恢复", "必须", "应该", "不会", "这些", "这个", "之后", "来自", "显示", "选择", "完整目录", "没有符合", "输入关键词", "分钟", "繁体中文（台湾）", "几十", "精确", "可见", "隐藏", "复杂", "阅读", "什么", "认识", "这样", "给", "触碰", "机会", "补出", "维护", "当测试", "等价", "尽力", "终止", "三条", "两者", "Repo内", "适配", "占用", "步骤", "成长", "下一轮", "变长", "减少", "单独", "规則",
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
        for (const phrase of deny) assert.ok(!source.includes(phrase), `${file.slice(root.length + 1)} contains ${phrase}`);
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
