/* ─────────────────────────────────────────────────────────────────────────────
   i18n — server helpers (RSC · Server Actions · Route Handlers)
   ───────────────────────────────────────────────────────────────────────────
   Server-only by construction: importing `next/headers` makes this module
   unusable from a client component (Next fails the build), so there is no way
   to accidentally pull request state into the browser bundle.

   Both helpers are wrapped in React `cache()`, so a page that translates in
   twenty server components reads the cookie once and builds one translator per
   request. Nothing here is memoised across requests.
──────────────────────────────────────────────────────────────────────────── */

import { cookies } from "next/headers";
import { cache } from "react";

import {
  DEFAULT_LOCALE,
  LOCALE_COOKIE,
  LOCALE_HTML_LANG,
  resolveLocale,
  type Locale,
} from "./config";
import {
  createTranslator,
  getDictionary,
  type Dictionary,
  type Translate,
} from "./dictionaries";

/**
 * The request's locale, from the preference cookie.
 *
 * Any value that is not a known locale — stale cookie, hand-edited header,
 * missing entirely — falls back to English rather than throwing. Chrome must
 * never be the reason a care surface fails to render.
 */
export const getLocale = cache(async (): Promise<Locale> => {
  try {
    const store = await cookies();
    return resolveLocale(store.get(LOCALE_COOKIE)?.value);
  } catch {
    // Reading cookies outside a request scope (e.g. static prerender).
    return DEFAULT_LOCALE;
  }
});

/** `t(key, vars?)` for the current request. */
export const getT = cache(async (): Promise<Translate> => {
  return createTranslator(await getLocale());
});

/** The full dictionary — for passing to a client boundary when that is cheaper. */
export const getServerDictionary = cache(async (): Promise<Dictionary> => {
  return getDictionary(await getLocale());
});

/** BCP 47 tag for `<html lang>`. */
export const getHtmlLang = cache(async (): Promise<string> => {
  return LOCALE_HTML_LANG[await getLocale()];
});
