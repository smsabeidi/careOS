import Link from "next/link";
import { redirect } from "next/navigation";
import type { ReactNode } from "react";
import { supabaseServer } from "@/lib/supabase/server";
import { getProfile, homeFor } from "@/lib/profile";
import { elevateDemoSession } from "@/lib/demo-totp";
import { getT } from "@/lib/i18n/server";
import type { TranslationKey } from "@/lib/i18n/dictionaries";
import { BrandLogo } from "./logo";
import { ChromeControls } from "./chrome-controls";
import { StatusChip, Avatar } from "./ui";
import {
  IconUsers, IconClipboard, IconActivity, IconHome, IconHeart, IconLogOut,
  IconPen, IconCalendar, IconClipboardCheck, IconEye, IconCheck,
  IconSparkle, IconInbox, IconPlus, IconSearch,
} from "./icons";

/** Rails carry a translation KEY, not a string: the label is resolved once, at
 *  render, in the request's language (invariant 14 — plain language, and the
 *  caregiver's plain language may be Spanish). */
type NavItem = { href: string; labelKey: TranslationKey; icon: ReactNode };

/* ── Demo mode — the "View as …" persona switcher ───────────────────────────────
 * Flag-gated (CAREOS_DEMO_MODE), so it can be enabled on a SYNTHETIC deployment
 * (e.g. a Vercel preview) as well as locally. The switcher signs in as the seeded
 * demo personas (supabase/seeds/demo_users.sql) via a genuine password sign-in and
 * reaches AAL2 through the REAL MFA step-up (elevateDemoSession) — no AAL2 bypass,
 * no service_role. It can only ever impersonate those hardcoded synthetic accounts.
 * NEVER set CAREOS_DEMO_MODE on a deployment holding real PHI. */
const DEMO_MODE = process.env.CAREOS_DEMO_MODE === "true";

type Persona = { key: string; label: string; name: string; email: string; role: string };
const DEMO_PERSONAS: Persona[] = [
  { key: "owner",       label: "Owner",       name: "Dr. Fatima",  email: "fatima@americancareteam.demo",  role: "owner" },
  { key: "coordinator", label: "Coordinator", name: "Hussien Barre",     email: "hussien@americancareteam.demo",   role: "coordinator" },
  { key: "rn",          label: "Nurse (RN)",  name: "Nina Vasquez",  email: "nina@americancareteam.demo",   role: "rn" },
  { key: "caregiver",   label: "Caregiver",   name: "Dee Alvarez",   email: "dee@americancareteam.demo",    role: "caregiver" },
  { key: "family",      label: "Family",      name: "Grace Vance",   email: "family@americancareteam.demo", role: "family" },
];

/** Each persona gets its own surface set — ≤7 items, most-used first (docs/10 §2).
 *  The first four also become the mobile tab bar, so ordering is the phone layout too.
 *  Surfaces left off a rail stay reachable from the command, client and compliance
 *  pages — the rail is the daily path, not the sitemap. */
function navFor(roles: string[]): NavItem[] {
  if (roles.includes("owner") || roles.includes("admin")) {
    // Command → what needs a decision → who it is about → the regulator's view,
    // then the two AI surfaces. Schedule and Credentials are one click from Command.
    return [
      { href: "/exec", labelKey: "nav.command", icon: <IconActivity /> },
      { href: "/inbox", labelKey: "nav.approvals", icon: <IconInbox /> },
      { href: "/office/clients", labelKey: "nav.clients", icon: <IconUsers /> },
      { href: "/office/compliance", labelKey: "nav.compliance", icon: <IconClipboardCheck /> },
      { href: "/office/intake", labelKey: "nav.intake", icon: <IconPlus /> },
      { href: "/analytics", labelKey: "nav.analytics", icon: <IconSearch /> },
      { href: "/brain", labelKey: "nav.brain", icon: <IconSparkle /> },
    ];
  }
  if (roles.includes("coordinator") || roles.includes("hr")) {
    // Analytics is an owner/admin/coordinator surface; HR gets the same rail without it.
    const rail: NavItem[] = [
      { href: "/office/clients", labelKey: "nav.clients", icon: <IconUsers /> },
      { href: "/schedule", labelKey: "nav.schedule", icon: <IconCalendar /> },
      { href: "/inbox", labelKey: "nav.approvals", icon: <IconInbox /> },
      { href: "/office/compliance", labelKey: "nav.compliance", icon: <IconClipboardCheck /> },
      { href: "/office/intake", labelKey: "nav.intake", icon: <IconPlus /> },
    ];
    if (roles.includes("coordinator")) {
      rail.push({ href: "/analytics", labelKey: "nav.analytics", icon: <IconSearch /> });
    }
    rail.push({ href: "/brain", labelKey: "nav.brain", icon: <IconSparkle /> });
    return rail;
  }
  if (roles.includes("rn")) {
    return [
      { href: "/clinical", labelKey: "nav.clinical", icon: <IconPen /> },
      { href: "/inbox", labelKey: "nav.approvals", icon: <IconInbox /> },
      { href: "/office/clients", labelKey: "nav.clients", icon: <IconUsers /> },
      { href: "/brain", labelKey: "nav.brain", icon: <IconSparkle /> },
    ];
  }
  if (roles.includes("caregiver")) {
    return [
      { href: "/today", labelKey: "nav.today", icon: <IconHome /> },
      { href: "/office/clients", labelKey: "nav.myClients", icon: <IconUsers /> },
      { href: "/office/forms", labelKey: "nav.myNotes", icon: <IconClipboard /> },
    ];
  }
  return [{ href: "/family", labelKey: "nav.family", icon: <IconHeart /> }];
}

function BrandMark({ size = 30 }: { size?: number }) {
  return <BrandLogo size={size} />;
}

async function signOut() {
  "use server";
  const supabase = await supabaseServer();
  await supabase.auth.signOut();
  redirect("/login");
}

/** Demo-only: sign out, then sign in as the chosen seeded persona and land on
 *  their home surface. A real password sign-in (user-scoped client, NO
 *  service_role — invariant 6). Re-guarded here so it is inert outside demo mode. */
async function signInAsPersona(formData: FormData) {
  "use server";
  if (process.env.CAREOS_DEMO_MODE !== "true") {
    redirect("/login");
  }
  const email = String(formData.get("persona") ?? "");
  const persona = DEMO_PERSONAS.find((p) => p.email === email);
  if (!persona) redirect("/login");

  const supabase = await supabaseServer();
  await supabase.auth.signOut();
  const { error } = await supabase.auth.signInWithPassword({
    email: persona.email,
    password: process.env.CAREOS_DEMO_PASSWORD ?? "AmericanCare!demo1",
  });
  if (error) redirect("/login");
  // Auto-complete the seeded persona's real MFA step-up so PHI surfaces open at AAL2.
  await elevateDemoSession(supabase);
  redirect(homeFor([persona.role]));
}

export async function AppShell({
  children,
  active,
}: {
  children: ReactNode;
  active: string;
}) {
  const profile = await getProfile();
  const t = await getT();
  const name = profile?.name ?? "Signed in";
  const nav = navFor(profile?.roles ?? []);

  return (
    <div className="flex min-h-dvh">
      {/* ── macOS-style frosted sidebar ── */}
      <aside
        className="material-strong hidden w-64 shrink-0 flex-col border-r px-3.5 py-5 md:flex hairline"
      >
        <Link href="/" className="mb-8 flex items-center gap-3 px-2.5">
          <BrandMark size={30} />
          <span className="text-[19px] font-semibold tracking-[-0.02em]">CareOS</span>
        </Link>

        <nav className="flex flex-col gap-1" aria-label="Primary">
          {nav.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className="rail-link"
              data-active={active === item.href}
              aria-current={active === item.href ? "page" : undefined}
            >
              {item.icon}
              {t(item.labelKey)}
            </Link>
          ))}
        </nav>

        {DEMO_MODE && (
          <div className="mt-auto pt-4">
            <p
              className="mb-1.5 flex items-center gap-1.5 px-2.5 text-[11px] font-semibold uppercase"
              style={{ color: "var(--text-muted)", letterSpacing: "0.04em" }}
            >
              <IconEye width={13} height={13} />
              {`${t("nav.demo")} · ${t("nav.viewAs")}`}
            </p>
            <div className="flex flex-col gap-0.5">
              {DEMO_PERSONAS.map((p) => {
                const on = (profile?.roles ?? []).includes(p.role);
                return (
                  <form action={signInAsPersona} key={p.key}>
                    <input type="hidden" name="persona" value={p.email} />
                    <button
                      type="submit"
                      className="rail-link w-full"
                      data-active={on}
                      aria-current={on ? "true" : undefined}
                      title={`Sign in as ${p.name}`}
                    >
                      <Avatar name={p.name} size={22} />
                      <span className="min-w-0 flex-1 truncate text-left">{p.label}</span>
                      {on && <IconCheck width={14} height={14} />}
                    </button>
                  </form>
                );
              })}
            </div>
          </div>
        )}

        <div className={`${DEMO_MODE ? "mt-4" : "mt-auto"} border-t pt-4 hairline`}>
          <div className="flex items-center gap-3 px-2.5 pb-3">
            <Avatar name={name} size={36} />
            <div className="min-w-0">
              <p className="truncate text-[13px] font-medium">{name}</p>
              <StatusChip status="aal2" />
            </div>
          </div>
          <form action={signOut}>
            <button className="rail-link w-full" type="submit">
              <IconLogOut />
              {t("nav.signOut")}
            </button>
          </form>
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        {/* ── Mobile frosted top bar ── */}
        <header
          className="material sticky top-0 z-20 flex h-14 items-center justify-between gap-2 border-b px-4 md:hidden hairline"
        >
          <Link href="/" className="flex min-w-0 items-center gap-2.5">
            <BrandMark size={26} />
            {/* The wordmark yields below 360px so the session chip and the chrome
                cluster both stay whole on a small phone. The mark never yields. */}
            <span className="text-[17px] font-semibold tracking-[-0.02em] max-[359px]:hidden">CareOS</span>
          </Link>
          <div className="flex shrink-0 items-center gap-2">
            <StatusChip status="aal2" />
            <ChromeControls />
          </div>
        </header>

        {/* ── Desktop chrome row — the cluster's top-right anchor ──
         * In flow (never overlapping a page header) but `sticky`, so it stays in
         * the corner as the page scrolls and content passes under the frosted
         * pill. `main`'s top padding is reduced to match, so the total space
         * above a page title is close to what it was before the row existed. */}
        <div className="pointer-events-none sticky top-0 z-30 mx-auto hidden w-full max-w-5xl justify-end px-10 pt-5 md:flex">
          <ChromeControls className="pointer-events-auto" />
        </div>

        <main className="mx-auto w-full max-w-5xl flex-1 px-4 py-8 md:px-10 md:pt-3 md:pb-10">{children}</main>

        {/* ── iOS-style frosted tab bar ── */}
        <nav
          className="material sticky bottom-0 z-20 flex border-t md:hidden hairline"
          style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
          aria-label="Primary"
        >
          {nav.slice(0, 4).map((item) => {
            const on = active === item.href;
            return (
              <Link
                key={item.href}
                href={item.href}
                data-active={on}
                aria-current={on ? "page" : undefined}
                className="flex min-h-14 flex-1 flex-col items-center justify-center gap-1 py-2 text-[11px] font-medium transition-colors"
                style={{ color: on ? "var(--accent-text)" : "var(--text-secondary)" }}
              >
                {item.icon}
                {t(item.labelKey)}
              </Link>
            );
          })}
        </nav>
      </div>
    </div>
  );
}
