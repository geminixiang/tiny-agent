// Render-blocking on purpose: applies the stored theme before first paint so
// chapter navigation never flashes the wrong background. Kept tiny and separate
// from book.js, which stays deferred. Without JavaScript the CSS
// prefers-color-scheme rules still provide the correct default.
const theme = localStorage.getItem("book-theme");
if (theme === "dark" || theme === "light") document.documentElement.dataset.theme = theme;
