/* ─────────────────────────────────────────────────────────────────────────────
   CareOS service worker — docs/17 §7.6 · invariant 5 · docs/09 §4
   ───────────────────────────────────────────────────────────────────────────
   THIS FILE IS A SECURITY BOUNDARY. A service worker is a programmable proxy in
   front of every request the app makes, and its cache is durable storage on a
   device that may be shared, lost, or seized. So the rule is not "cache
   carefully" — it is CACHE NOTHING THAT COULD CARRY PHI, proven by construction
   rather than by inspection.

   The proof is an ALLOWLIST, not a denylist:

     1. Non-GET is never touched. Server Actions (the clock RPC, every write) are
        POSTs: never intercepted, never retried, never stored.
     2. Cross-origin is never touched. Supabase and everything else goes to the
        network untouched.
     3. Navigations are network-ONLY. Every HTML document in this app is an
        authenticated PHI surface (next.config.ts already sends no-store for
        /today, /office, /clinical, /exec, /family). No navigation response is
        ever written to a cache. When the network fails, the worker synthesises
        the data-free document below — see WHY IT IS INLINE.
     4. Everything else goes to the network unless its URL is on STATIC_PREFIXES:
        content-hashed build output plus the manifest and icons. A new route, a
        new API path or a new data endpoint therefore cannot become cacheable by
        accident — it has to be added here on purpose.

   WHY THE OFFLINE DOCUMENT IS INLINE. Precaching an /offline.html would mean
   fetching it at install time, and src/middleware.ts gates every path that is
   not a .svg/.png/.jpg/.ico — so that fetch redirects to /login whenever the
   session has lapsed, and the app would cache a login page as its offline
   fallback, or nothing at all. Synthesising the response removes the dependency
   entirely: the fallback exists from the first activation, needs no network, and
   cannot be poisoned by a redirect.

   THE OFFLINE QUEUE IS NOT IN THIS FILE and never will be. Queued clock events
   live in IndexedDB (src/lib/offline/queue.ts) and replay through the ordinary
   Server Action. A Background Sync handler here would have to hold a session's
   credentials and reconstruct a PHI write outside React's knowledge; replaying
   from the page, under the caregiver's live session and RLS, is the honest path.
──────────────────────────────────────────────────────────────────────────── */

const VERSION = "careos-v1";
const SHELL_CACHE = `${VERSION}-shell`;

/** URL prefixes safe to serve from cache: content-hashed build output and brand assets.
 *  Nothing here is generated per-user, so nothing here can carry a fact about a person. */
const STATIC_PREFIXES = [
  "/_next/static/",
  "/icon.svg",
  "/icon-180.png",
  "/icon-192.png",
  "/icon-512.png",
  "/manifest.webmanifest",
  "/auth-art.jpg",
];

/* ── The offline document: three sentences, zero data ────────────────────────
 * What happened · what is preserved · what to do next (docs/10 voice). It names
 * no client, no visit and no schedule, and it runs no script that could fetch
 * one. The worker picks a language from the DEVICE's preference rather than the
 * app's locale cookie — a worker cannot read that cookie synchronously, and a
 * best-effort Spanish beats an English-only wall for a bilingual workforce. */
const COPY = {
  en: {
    title: "You're offline right now",
    lead: "CareOS couldn't reach the network, so this page can't open. Nothing you already saved was lost.",
    held: "Anything you recorded while offline is held on this device and sends by itself as soon as you have a signal.",
    retry: "Try again",
    docTitle: "No connection · CareOS",
  },
  es: {
    title: "Está sin conexión",
    lead: "CareOS no pudo conectarse a la red, así que esta página no puede abrirse. No se perdió nada de lo que ya guardó.",
    held: "Lo que registró sin conexión se guarda en este dispositivo y se envía solo en cuanto tenga señal.",
    retry: "Intentar de nuevo",
    docTitle: "Sin conexión · CareOS",
  },
};

function offlineDocument() {
  const lang =
    typeof navigator !== "undefined" && String(navigator.language || "").toLowerCase().startsWith("es")
      ? "es"
      : "en";
  const c = COPY[lang];
  return `<!doctype html><html lang="${lang}"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>${c.docTitle}</title><style>
:root{color-scheme:light dark}
body{margin:0;min-height:100dvh;display:flex;align-items:center;justify-content:center;padding:2rem 1.5rem;
background:#f2f2f7;color:#1c1c1e;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;-webkit-font-smoothing:antialiased}
main{max-width:27rem;text-align:center}
svg{width:52px;height:52px;margin:0 auto 1.25rem;display:block}
h1{font-size:1.375rem;font-weight:600;letter-spacing:-.02em;margin:0 0 .75rem}
p{font-size:1rem;line-height:1.6;color:#636366;margin:0 0 .75rem}
button{margin-top:1.25rem;min-height:2.875rem;padding:0 1.25rem;font:inherit;font-weight:600;font-size:.9375rem;color:#fff;background:#007aff;border:0;border-radius:12px;cursor:pointer}
@media(prefers-color-scheme:dark){body{background:#000;color:#f2f2f7}p{color:#98989d}button{background:#0a84ff}}
</style></head><body><main>
<svg viewBox="0 0 128 128" fill="none" aria-hidden="true">
<path d="M 64 22 L 64 44 Q 64 64 44 64 L 22 64" stroke="#9cc4f5" stroke-width="40" stroke-linecap="round"/>
<path d="M 64 106 L 64 84 Q 64 64 84 64 L 106 64" stroke="#1f7bfa" stroke-width="40" stroke-linecap="round"/>
</svg>
<h1>${c.title}</h1><p>${c.lead}</p><p>${c.held}</p>
<button type="button" onclick="location.reload()">${c.retry}</button>
</main></body></html>`;
}

self.addEventListener("install", () => {
  // Nothing to precache: the offline document is synthesised, and every cacheable asset
  // is content-hashed and fetched on first use. Take over immediately.
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((k) => k !== SHELL_CACHE).map((k) => caches.delete(k)))
      )
      .then(() => self.clients.claim())
  );
});

function isStatic(pathname) {
  return STATIC_PREFIXES.some((prefix) => pathname.startsWith(prefix));
}

self.addEventListener("fetch", (event) => {
  const request = event.request;

  // Rules 1 + 2 — anything that could be a write, or is not ours, is not our business.
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // Rule 3 — documents: network only, with a data-free fallback and no caching, ever.
  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request).catch(
        () =>
          new Response(offlineDocument(), {
            status: 503,
            headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
          })
      )
    );
    return;
  }

  // Rule 4 — the allowlist. Cache-first, because these URLs are content-hashed or
  // brand-stable; a response is stored only when it is a clean same-origin 200.
  if (!isStatic(url.pathname)) return;
  event.respondWith(
    caches.match(request).then((cached) => {
      if (cached) return cached;
      return fetch(request).then((response) => {
        if (response && response.status === 200 && response.type === "basic") {
          const copy = response.clone();
          caches.open(SHELL_CACHE).then((cache) => cache.put(request, copy));
        }
        return response;
      });
    })
  );
});
