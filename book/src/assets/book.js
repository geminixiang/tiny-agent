const root = document.documentElement;
root.classList.add("js");
const themeButton = document.querySelector("[data-theme-toggle]");
const menuButton = document.querySelector("[data-menu-toggle]");
const backdrop = document.querySelector("[data-drawer-backdrop]");
const sidebar = document.querySelector("[data-sidebar]");
const mobile = matchMedia("(max-width: 860px)");

// theme.js（render-blocking）已在 first paint 前套用儲存的主題。這裡只同步按鈕狀態與處理切換。
// 未曾手動切換過的讀者不寫 localStorage，讓他們繼續跟隨 OS 偏好。
function effectiveTheme() {
    return root.dataset.theme || (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
}

function syncThemeButton() {
    if (!themeButton) return;
    const theme = effectiveTheme();
    themeButton.dataset.activeTheme = theme;
    themeButton.setAttribute("aria-label", theme === "dark" ? "切換亮色主題" : "切換暗色主題");
}

syncThemeButton();
themeButton?.addEventListener("click", () => {
    const theme = effectiveTheme() === "dark" ? "light" : "dark";
    root.dataset.theme = theme;
    localStorage.setItem("book-theme", theme);
    syncThemeButton();
});

function syncDrawer(open, restoreFocus = false) {
    const isMobile = mobile.matches;
    document.body.dataset.drawer = open && isMobile ? "open" : "closed";
    menuButton?.setAttribute("aria-expanded", String(open && isMobile));
    if (sidebar) {
        sidebar.inert = isMobile && !open;
        if (isMobile && !open) sidebar.setAttribute("aria-hidden", "true");
        else sidebar.removeAttribute("aria-hidden");
    }
    if (open && isMobile) sidebar?.querySelector("a")?.focus();
    else if (restoreFocus && isMobile) menuButton?.focus();
}

function closeDrawer() {
    const wasOpen = document.body.dataset.drawer === "open";
    syncDrawer(false, wasOpen);
}
menuButton?.addEventListener("click", () => {
    syncDrawer(document.body.dataset.drawer !== "open");
});
mobile.addEventListener("change", () => syncDrawer(false));
syncDrawer(false);
backdrop?.addEventListener("click", closeDrawer);
document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") closeDrawer();
});
document.querySelectorAll(".chapter-nav a").forEach((link) => link.addEventListener("click", closeDrawer));

const progress = document.querySelector("[data-reading-progress]");
function updateProgress() {
    if (!progress) return;
    const max = document.documentElement.scrollHeight - innerHeight;
    progress.value = max > 0 ? Math.min(100, (scrollY / max) * 100) : 100;
}
addEventListener("scroll", updateProgress, { passive: true });
addEventListener("resize", updateProgress);
updateProgress();

const architectureDialog = document.querySelector("#architecture-dialog");
document.querySelector("[data-architecture-open]")?.addEventListener("click", () => {
    if (architectureDialog instanceof HTMLDialogElement) architectureDialog.showModal();
});
architectureDialog?.querySelector("[data-architecture-close]")?.addEventListener("click", () => architectureDialog.close());
architectureDialog?.addEventListener("click", (event) => {
    if (event.target === architectureDialog) architectureDialog.close();
});

document.querySelectorAll("figure.data-anim").forEach((figure) => {
    const button = document.createElement("button");
    button.className = "anim-toggle";
    button.type = "button";
    button.textContent = "⏸ 暫停動畫";
    button.setAttribute("aria-pressed", "false");
    button.addEventListener("click", () => {
        const paused = figure.classList.toggle("paused");
        button.textContent = paused ? "▶ 播放動畫" : "⏸ 暫停動畫";
        button.setAttribute("aria-pressed", String(paused));
    });
    figure.append(button);
});

document.querySelectorAll("pre").forEach((pre) => {
    const button = document.createElement("button");
    button.className = "copy-button";
    button.type = "button";
    button.textContent = "複製";
    button.setAttribute("aria-label", "複製程式碼");
    button.addEventListener("click", async () => {
        const code = pre.querySelector("code")?.textContent || pre.textContent;
        await navigator.clipboard.writeText(code);
        button.textContent = "已複製";
        setTimeout(() => (button.textContent = "複製"), 1200);
    });
    pre.append(button);
});
