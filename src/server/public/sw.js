// Cast PWA — offline shell for static assets, network-first for APIs.
const CACHE = "cast-v1";
const SHELL = [
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
self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
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
