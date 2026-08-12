import type { Metadata, Viewport } from "next";
import { Inter } from "next/font/google";
import "./globals.css";

import { LocaleProvider } from "@/lib/i18n/client";
import { LOCALE_HTML_LANG } from "@/lib/i18n/config";
import { getLocale } from "@/lib/i18n/server";
import { ServiceWorkerRegistrar } from "@/lib/offline/register-sw";

/* Inter — the single corporate face: UI, display titles, and tabular numerals.
   Loaded as the full variable axis (wght 100–900) plus opsz (optical sizing)
   for dense 13px tables. Self-hosted at build via next/font — no runtime CDN. */
const inter = Inter({
  subsets: ["latin"],
  axes: ["opsz"],
  variable: "--font-inter",
  display: "swap",
});

/* ─────────────────────────────────────────────────────────────────────────────
   Installable, because the field tool has to survive a basement (docs/17 §7.6)
   ───────────────────────────────────────────────────────────────────────────
   The manifest and the icons make CareOS installable to a phone's home screen;
   the service worker registered below gives an offline navigation somewhere to
   land. Neither one caches a PHI response — public/sw.js is an allowlist of
   build assets and two static files, and the reasoning is written out there.
   `start_url` is /today because the person who installs this is a caregiver.
──────────────────────────────────────────────────────────────────────────── */
export const metadata: Metadata = {
  title: { default: "CareOS", template: "%s · CareOS" },
  description: "Care operations, provably in order.",
  applicationName: "CareOS",
  manifest: "/manifest.webmanifest",
  icons: {
    icon: [
      { url: "/icon.svg", type: "image/svg+xml" },
      { url: "/icon-192.png", sizes: "192x192", type: "image/png" },
    ],
    // iOS ignores SVG for the home screen and will fall back to a screenshot without this.
    apple: [{ url: "/icon-180.png", sizes: "180x180", type: "image/png" }],
  },
  appleWebApp: { capable: true, title: "CareOS", statusBarStyle: "default" },
  formatDetection: { telephone: false },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  /* Two entries, so the browser chrome (iOS status bar, Android address bar)
     matches the canvas in each appearance: systemGray6 light, true black dark. */
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f2f2f7" },
    { media: "(prefers-color-scheme: dark)", color: "#000000" },
  ],
  colorScheme: "light dark",
};

/* ─────────────────────────────────────────────────────────────────────────────
   Pre-paint appearance script — the entire anti-flash mechanism
   ───────────────────────────────────────────────────────────────────────────
   Server rendering cannot know the stored appearance: the preference lives in
   localStorage, which is browser-only, and reading it in an effect happens after
   first paint — a white flash on every navigation for a dark-mode user.

   So this runs synchronously in <head>, before <body> exists and before the
   first paint: it stamps `data-theme` on <html>, and the stylesheet (already
   parsed, since it is linked above) resolves against the right appearance from
   the very first frame.

   Three properties matter and each is deliberate:
     · It is BLOCKING (no defer/async, no next/script). Deferring it would put it
       after paint, which is the bug it exists to fix.
     · It is TOTALLY guarded. Private-mode Safari and hardened enterprise
       profiles throw on localStorage access; an exception here would abort the
       parse and take the document with it. Chrome must never be the reason a
       care surface fails to render, so the whole body is a try/catch.
     · "system" REMOVES the attribute rather than setting a value: globals.css
       keys the OS preference off `:root:not([data-theme="light"])` inside a
       prefers-color-scheme media query, so absence is what "follow the OS"
       means. And because that media query is plain CSS, system-dark is already
       correct on first paint even with JavaScript disabled entirely — this
       script only has to carry an EXPLICIT choice.

   The key string is duplicated in components/chrome-controls.tsx by necessity
   (this is a string, not a module — nothing can import into it). Change both.
──────────────────────────────────────────────────────────────────────────── */
const APPEARANCE_SCRIPT = `try{var t=localStorage.getItem("careos-theme"),d=document.documentElement;t==="light"||t==="dark"?d.setAttribute("data-theme",t):d.removeAttribute("data-theme")}catch(e){}`;

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const locale = await getLocale();

  return (
    /* suppressHydrationWarning: the script above mutates this element before
       React hydrates, so the server's markup and the live DOM differ by design.
       It suppresses the mismatch on <html>'s own attributes only — never on the
       tree below it. */
    <html
      lang={LOCALE_HTML_LANG[locale]}
      className={inter.variable}
      suppressHydrationWarning
    >
      <head>
        <script dangerouslySetInnerHTML={{ __html: APPEARANCE_SCRIPT }} />
      </head>
      <body>
        <LocaleProvider locale={locale}>{children}</LocaleProvider>
        {/* Renders nothing. Registers the offline worker after `load`, and fails silently:
            no worker means "online only", which is exactly where the app was yesterday. */}
        <ServiceWorkerRegistrar />
      </body>
    </html>
  );
}
