import Link from "next/link";
import { redirect } from "next/navigation";
import type { ReactNode } from "react";
import { supabaseServer } from "@/lib/supabase/server";
import { getProfile } from "@/lib/profile";
import { StatusChip, Avatar } from "./ui";
import {
  IconUsers, IconClipboard, IconActivity, IconHome, IconHeart, IconLogOut,
  IconShield, IconPen,
} from "./icons";

type NavItem = { href: string; label: string; icon: ReactNode };

/** Each persona gets its own surface set — ≤5 items (docs/10 §2). */
function navFor(roles: string[]): NavItem[] {
  if (roles.includes("owner") || roles.includes("admin")) {
    return [
      { href: "/exec", label: "Command", icon: <IconActivity /> },
      { href: "/office/clients", label: "Clients", icon: <IconUsers /> },
      { href: "/office/staff", label: "Staff", icon: <IconShield /> },
      { href: "/clinical", label: "Clinical", icon: <IconPen /> },
      { href: "/office/forms", label: "Forms", icon: <IconClipboard /> },
    ];
  }
  if (roles.includes("coordinator") || roles.includes("hr")) {
    return [
      { href: "/office/clients", label: "Clients", icon: <IconUsers /> },
      { href: "/office/staff", label: "Staff", icon: <IconShield /> },
      { href: "/office/forms", label: "Forms", icon: <IconClipboard /> },
    ];
  }
  if (roles.includes("rn")) {
    return [
      { href: "/clinical", label: "Clinical", icon: <IconPen /> },
      { href: "/office/clients", label: "Clients", icon: <IconUsers /> },
      { href: "/office/forms", label: "Forms", icon: <IconClipboard /> },
    ];
  }
  if (roles.includes("caregiver")) {
    return [
      { href: "/today", label: "Today", icon: <IconHome /> },
      { href: "/office/clients", label: "My clients", icon: <IconUsers /> },
      { href: "/office/forms", label: "My notes", icon: <IconClipboard /> },
    ];
  }
  return [{ href: "/family", label: "Family", icon: <IconHeart /> }];
}

function BrandMark({ size = 30 }: { size?: number }) {
  return (
    <span
      className="flex items-center justify-center text-white"
      style={{
        width: size,
        height: size,
        borderRadius: size * 0.3,
        background: "linear-gradient(160deg, var(--color-accent-500), var(--accent-active))",
        boxShadow: "var(--shadow-sm)",
      }}
    >
      <IconShield width={size * 0.56} height={size * 0.56} />
    </span>
  );
}

async function signOut() {
  "use server";
  const supabase = await supabaseServer();
  await supabase.auth.signOut();
  redirect("/login");
}

export async function AppShell({
  children,
  active,
}: {
  children: ReactNode;
  active: string;
}) {
  const profile = await getProfile();
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
              {item.label}
            </Link>
          ))}
        </nav>

        <div className="mt-auto border-t pt-4 hairline">
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
              Sign out
            </button>
          </form>
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        {/* ── Mobile frosted top bar ── */}
        <header
          className="material sticky top-0 z-20 flex h-14 items-center justify-between border-b px-4 md:hidden hairline"
        >
          <Link href="/" className="flex items-center gap-2.5">
            <BrandMark size={26} />
            <span className="text-[17px] font-semibold tracking-[-0.02em]">CareOS</span>
          </Link>
          <StatusChip status="aal2" />
        </header>

        <main className="mx-auto w-full max-w-5xl flex-1 px-4 py-8 md:px-10 md:py-10">{children}</main>

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
                {item.label}
              </Link>
            );
          })}
        </nav>
      </div>
    </div>
  );
}
