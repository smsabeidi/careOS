"use server";

/**
 * Chrome server actions — persisting a user's shell preferences.
 *
 * Only ONE preference needs the server: language. Appearance is a pure browser
 * concern (localStorage + a `data-theme` attribute, applied before first paint),
 * but locale decides what the SERVER renders — nav labels, page titles, every
 * `t()` call in an RSC — so it has to travel on the request. A cookie is the only
 * carrier a server component can read.
 *
 * PHI safety (invariant 5): this cookie holds a two-letter locale and nothing
 * else. It is not an identifier, it is not derived from a client or a caregiver,
 * and it is safe in a log line. No other preference belongs here.
 *
 * The write is deliberately unauthenticated: language is chrome, it applies on
 * the sign-in screen too, and gating it behind a session would mean a caregiver
 * has to read English to find the Spanish switch.
 */

import { revalidatePath } from "next/cache";
import { cookies } from "next/headers";

import { LOCALE_COOKIE, LOCALE_COOKIE_MAX_AGE, resolveLocale } from "@/lib/i18n/config";

/**
 * Records the language preference for this browser.
 *
 * The incoming value is untrusted (it crosses the network like any action
 * argument), so it goes through `resolveLocale` — an unknown value falls back to
 * English rather than writing a cookie that would later fail to resolve.
 *
 * `revalidatePath("/", "layout")` drops the client router cache for every
 * segment; without it, an already-visited page would come back from cache still
 * rendered in the previous language.
 */
export async function setLocalePreference(next: string): Promise<void> {
  const locale = resolveLocale(next);
  const store = await cookies();

  store.set({
    name: LOCALE_COOKIE,
    value: locale,
    path: "/",
    maxAge: LOCALE_COOKIE_MAX_AGE,
    sameSite: "lax",
    // Nothing in the browser reads this — the locale reaches client components
    // through LocaleProvider — so there is no reason to expose it to script.
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
  });

  revalidatePath("/", "layout");
}
