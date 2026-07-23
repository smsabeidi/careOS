import { cache } from "react";
import { redirect } from "next/navigation";
import { supabaseServer } from "@/lib/supabase/server";

export type Profile = {
  userId: string;
  name: string;
  roles: string[]; // role keys: owner | admin | rn | coordinator | caregiver | hr | family
};

/** Resolve the signed-in user's identity + role keys (RLS-scoped; deduped per request). */
export const getProfile = cache(async (): Promise<Profile | null> => {
  const supabase = await supabaseServer();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;

  const [{ data: me }, { data: roleRows }] = await Promise.all([
    supabase.from("app_user").select("full_name").eq("id", user.id).maybeSingle(),
    supabase.from("user_role").select("role(key)").eq("user_id", user.id),
  ]);

  const roles = (roleRows ?? [])
    .map((r) => {
      const role = Array.isArray(r.role) ? r.role[0] : r.role;
      return role?.key as string | undefined;
    })
    .filter((k): k is string => Boolean(k));

  return { userId: user.id, name: me?.full_name ?? user.email ?? "Signed in", roles };
});

/** Where each role starts their day. First match wins. */
export function homeFor(roles: string[]): string {
  if (roles.includes("owner") || roles.includes("admin")) return "/exec";
  if (roles.includes("coordinator") || roles.includes("hr")) return "/office/clients";
  if (roles.includes("rn")) return "/clinical";
  if (roles.includes("caregiver")) return "/today";
  if (roles.includes("family")) return "/family";
  return "/today";
}

/** Server-side surface guard. RLS remains the real perimeter; this is routing UX. */
export async function requireRole(allowed: string[]): Promise<Profile> {
  const profile = await getProfile();
  if (!profile) redirect("/login");
  if (!profile.roles.some((r) => allowed.includes(r))) redirect(homeFor(profile.roles));
  return profile;
}
