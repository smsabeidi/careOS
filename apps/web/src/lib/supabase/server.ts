import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";

/** RSC/server-action client — always user-scoped (invariant 6: no service_role in request paths). */
export async function supabaseServer() {
  const cookieStore = await cookies();
  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet) {
          try {
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options)
            );
          } catch {
            // Called from an RSC render — middleware handles the refresh.
          }
        },
      },
    }
  );
}
