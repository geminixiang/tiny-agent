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
const faviconAsset = generatedAssets.find((path) => /^\/assets\/favicon\.[a-f0-9]{12}\.png$/.test(path));

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
    assert.ok(faviconAsset, "hashed favicon asset");
    assert.equal(generatedAssets.length, 3);
    assert.equal(pages.size, chapters.length + 2);
    for (const html of pages.values()) {
        assert.match(html, new RegExp(`<link rel="stylesheet" href="${cssAsset}">`));
        assert.match(html, new RegExp(`<script src="${jsAsset}" defer></script>`));
        assert.match(html, new RegExp(`<link rel="icon" type="image/png" sizes="64x64" href="${faviconAsset}">`));
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
