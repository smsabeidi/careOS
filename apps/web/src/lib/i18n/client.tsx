"use client";

/* ─────────────────────────────────────────────────────────────────────────────
   i18n — client provider + hook
   ───────────────────────────────────────────────────────────────────────────
   The server resolves the locale once and hands it down as a plain string; the
   provider builds the translator in the browser. Client components then call
   `useT()` instead of prop-drilling copy through every layer.

   Only the dictionaries travel to the browser, and they are UI chrome strings —
   never PHI (invariant 5). Passing the two-letter locale rather than the whole
   dictionary keeps it out of the RSC payload on every navigation.
──────────────────────────────────────────────────────────────────────────── */

import { createContext, useContext, useMemo, type ReactNode } from "react";

import { DEFAULT_LOCALE, LOCALE_LABEL, type Locale } from "./config";
import { createTranslator, type Dictionary, type Translate } from "./dictionaries";

type LocaleContextValue = {
  locale: Locale;
  t: Translate;
};

/**
 * Defaulting to English rather than `null` is deliberate: a control rendered
 * outside the provider degrades to English instead of throwing and taking a
 * care surface down with it.
 */
const LocaleContext = createContext<LocaleContextValue>({
  locale: DEFAULT_LOCALE,
  t: createTranslator(DEFAULT_LOCALE),
});

LocaleContext.displayName = "LocaleContext";

export function LocaleProvider({
  locale,
  children,
}: {
  locale: Locale;
  children: ReactNode;
}) {
  const value = useMemo<LocaleContextValue>(
    () => ({ locale, t: createTranslator(locale) }),
    [locale]
  );

  return <LocaleContext.Provider value={value}>{children}</LocaleContext.Provider>;
}

/** `t(key, vars?)` — the same signature as the server's `getT()`. */
export function useT(): Translate {
  return useContext(LocaleContext).t;
}

/** The active locale — for the language toggle's checked state and aria-current. */
export function useLocale(): Locale {
  return useContext(LocaleContext).locale;
}

/** Locale + endonym label, for rendering the language control itself. */
export function useLocaleLabel(): string {
  return LOCALE_LABEL[useLocale()];
}

export type { Dictionary, Locale, Translate };
