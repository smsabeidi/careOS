/**
 * Feature flags, read from the database as the signed-in user (0026 · docs/13 §4).
 *
 * `app.feature_enabled(p_key, p_default)` is the same helper the RPCs and workers ask,
 * so a surface and the RPC behind it can never disagree about whether a feature is on —
 * there is one answer per tenant and Postgres owns it. Called with the user-scoped
 * client (invariant 6): the function is SECURITY DEFINER but resolves the tenant from
 * the caller's own claim, so service_role has no business in this path.
 *
 * FAIL CLOSED. Every failure mode — no session, RPC missing on a database that hasn't
 * taken the migration yet, network gone — returns the caller's `fallback` rather than
 * throwing. A page that cannot reach the flag table renders the world as the caller
 * declared it when the flag is absent, and for a dark feature that means "off". The
 * default is `false` precisely so that forgetting the second argument cannot turn an
 * unratified surface on for a real tenant.
 */

import { supabaseServer } from "@/lib/supabase/server";

/** Is `key` enabled for the caller's tenant? Any error resolves to `fallback`. */
export async function featureEnabled(key: string, fallback = false): Promise<boolean> {
  try {
    const supabase = await supabaseServer();
    const { data, error } = await supabase
      .schema("app")
      .rpc("feature_enabled", { p_key: key, p_default: fallback });
    if (error) return fallback;
    // An absent flag row is already resolved to `fallback` inside the function; anything
    // that is not a literal true here (null from a refused call) is treated as off.
    return data === true;
  } catch {
    return fallback;
  }
}
