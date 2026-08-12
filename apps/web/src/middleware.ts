import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

/**
 * Session refresh + route gating (docs/09 §2):
 *  - unauthenticated → /login
 *  - authenticated at AAL1 on a PHI surface → /mfa step-up
 * RLS is the real perimeter; this is UX convenience on top of it.
 */
const PUBLIC_PATHS = ["/login", "/accept"];
/* /accept is AAL1 by design: a brand-new hire has no TOTP factor yet, and invitation
 * acceptance exposes no PHI (0030 header). MFA enrollment follows immediately after. */
const AAL1_ALLOWED = ["/login", "/mfa", "/accept"];

/* ═══════════════════════════════════════════════════════════════════════════
 * DEMO-ONLY AAL2 BYPASS — READ BEFORE TOUCHING.
 * The persona switcher signs personas in with a password only (no MFA factor),
 * so their session is AAL1. In demo mode we let those sessions through the
 * /mfa step-up so the "View as …" flow lands on a real surface instead of the
 * enrollment wall. This ONLY affects route gating here in middleware.
 *
 * AAL2 REMAINS LAW FOR REAL PHI: the database's app.is_aal2() RLS gate is NOT
 * touched by this, and it never should be. This flag can NEVER take effect in
 * production — it is doubly guarded by NODE_ENV so a stray CAREOS_DEMO_MODE=true
 * in a prod env is inert. CAREOS_DEMO_MODE is a server-only var (never
 * NEXT_PUBLIC_), so it can't be flipped from the client either.
 * ═══════════════════════════════════════════════════════════════════════════ */
const DEMO_AAL2_BYPASS =
  process.env.CAREOS_DEMO_MODE === "true" && process.env.NODE_ENV !== "production";

export async function middleware(request: NextRequest) {
  let response = NextResponse.next({ request });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
          response = NextResponse.next({ request });
          cookiesToSet.forEach(({ name, value, options }) =>
            response.cookies.set(name, value, options)
          );
        },
      },
    }
  );

  const {
    data: { user },
  } = await supabase.auth.getUser();

  const path = request.nextUrl.pathname;
  const isPublic = PUBLIC_PATHS.some((p) => path.startsWith(p));

  if (!user && !isPublic) {
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    return NextResponse.redirect(url);
  }

  if (user && !DEMO_AAL2_BYPASS && !AAL1_ALLOWED.some((p) => path.startsWith(p))) {
    const { data: aal } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
    if (aal && aal.currentLevel !== "aal2") {
      const url = request.nextUrl.clone();
      url.pathname = "/mfa";
      return NextResponse.redirect(url);
    }
  }

  if (user && path === "/login") {
    const url = request.nextUrl.clone();
    url.pathname = "/";
    return NextResponse.redirect(url);
  }

  return response;
}

export const config = {
  // sw.js and the manifest are exempt for the same reason _next/static is: they are
  // static, PHI-free assets the browser fetches OUTSIDE a signed-in navigation. Gated,
  // they 307 to /login, the service worker never registers, and offline clock capture
  // silently does not exist for the caregiver who needs it most (D-022, docs/17 §7.6).
  // The worker itself is an allowlist — non-GET, cross-origin and navigations are never
  // cached — so exempting it exposes nothing.
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|sw\\.js|manifest\\.webmanifest|.*\\.(?:svg|png|jpg|ico)$).*)",
  ],
};
