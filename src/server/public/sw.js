// Cast PWA — offline shell for static assets, network-first for APIs.
// __CAST_VERSION__ is patched to the release version at build time (see
// scripts/build.mjs) — a fixed cache name never rotates out old entries: the
// fetch handler below is cache-first, so once *anything* (sidebar.js,
// message.js, ...) gets cached this way, it's served forever regardless of
// deploys, since `activate` only evicts keys that don't match CACHE.
const CACHE = "cast-__CAST_VERSION__";
// The built app is one hash-named bundle (see scripts/build.mjs), so the shell
// list cannot be written here — the build replaces this placeholder with the
// exact assets the built HTML loads. Unreplaced (running from src/ during
// development) it stays a string, and the dev list below is used instead.
const BUILT_SHELL = "__CAST_SHELL__";
const DEV_SHELL = [
  "/",
  "/index.html",
  "/manifest.json",
  "/tokens.css",
  "/chat.css",
  "/tools.css",
  "/workspace.css",
  "/settings.css",
  "/style.css",
  "/login.css",
  "/app.js",
  "/api.js",
  "/vendor/preact.mjs",
  "/vendor/preact-hooks.mjs",
  "/vendor/htm.mjs",
  "/favicon.svg"
];
const SHELL = Array.isArray(BUILT_SHELL) ? BUILT_SHELL : DEV_SHELL;
self.addEventListener("install", (e) => {
  // Per-entry, not addAll: one 404 in the list rejects addAll, which fails the
  // whole install — and then there is no service worker at all, silently.
  e.waitUntil(
    caches.open(CACHE)
      .then((c) => Promise.all(SHELL.map((url) => c.add(url).catch(() => {}))))
      .then(() => self.skipWaiting()),
  );
});
self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  // APIs and SSE — network only, but fallback to offline page for navigations
  if (url.pathname.startsWith("/api/")) return;
  if (e.request.mode === "navigate") {
    e.respondWith(fetch(e.request).catch(() => caches.match("/index.html")));
    return;
  }
  e.respondWith(caches.match(e.request).then((hit) => hit || fetch(e.request).then((res) => {
    // cache successful GETs for next offline
    if (e.request.method === "GET" && res.ok) {
      const clone = res.clone();
      caches.open(CACHE).then((c) => c.put(e.request, clone));
    }
    return res;
  }).catch(() => hit)));
});
