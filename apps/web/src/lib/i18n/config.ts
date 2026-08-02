/* ─────────────────────────────────────────────────────────────────────────────
   i18n — locale configuration
   ───────────────────────────────────────────────────────────────────────────
   English and Spanish. Spanish is a product requirement, not decoration:
   `client.primary_language` carries 'es' in the schema and docs/16 F2 calls for
   Spanish family communication. Maryland home care is bilingual work.

   This module is environment-agnostic on purpose — it holds no `next/headers`
   and no React, so both the server helpers and the client provider can import it.
──────────────────────────────────────────────────────────────────────────── */

export const LOCALES = ["en", "es"] as const;

export type Locale = (typeof LOCALES)[number];

export const DEFAULT_LOCALE: Locale = "en";

/** Endonyms — a language picker names each language in that language. */
export const LOCALE_LABEL: Record<Locale, string> = {
  en: "English",
  es: "Español",
};

/** BCP 47 tags for <html lang> and Intl formatters. */
export const LOCALE_HTML_LANG: Record<Locale, string> = {
  en: "en",
  es: "es",
};

/** Preference cookie. Carries a two-letter locale and nothing else — never PHI. */
export const LOCALE_COOKIE = "careos_locale";

/** One year; a language preference should outlive a session. */
export const LOCALE_COOKIE_MAX_AGE = 60 * 60 * 24 * 365;

/** Narrowing guard — every cookie/header/query read must pass through this. */
export function isLocale(value: unknown): value is Locale {
  return typeof value === "string" && (LOCALES as readonly string[]).includes(value);
}

/** Guard + fallback in one, for the common "read an untrusted value" path. */
export function resolveLocale(value: unknown): Locale {
  return isLocale(value) ? value : DEFAULT_LOCALE;
}
