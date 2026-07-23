import Link from "next/link";
import { redirect } from "next/navigation";
import type { ReactNode } from "react";
import { supabaseServer } from "@/lib/supabase/server";
import { StatusChip, Avatar } from "./ui";
import {
  IconUsers, IconClipboard, IconActivity, IconHome, IconHeart, IconLogOut, IconShield,
} from "./icons";

const NAV = [
  { href: "/office/clients", label: "Clients", icon: <IconUsers /> },
  { href: "/office/forms", label: "Forms", icon: <IconClipboard /> },
  { href: "/today", label: "Today", icon: <IconHome /> },
  { href: "/exec", label: "Command", icon: <IconActivity /> },
  { href: "/family", label: "Family", icon: <IconHeart /> },
];

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
  const supabase = await supabaseServer();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  const { data: profile } = await supabase
    .from("app_user")
    .select("full_name")
    .eq("id", user?.id ?? "")
    .maybeSingle();
  const name = profile?.full_name ?? user?.email ?? "Signed in";

  return (
    <div className="flex min-h-dvh">
      {/* Left rail — ≤5 items per persona (docs/10 §2) */}
      <aside
        className="hidden w-60 shrink-0 flex-col border-r px-3 py-5 md:flex hairline"
        style={{ background: "var(--panel)" }}
      >
        <Link href="/" className="mb-7 flex items-center gap-2.5 px-3">
          <span
            className="flex size-8 items-center justify-center rounded-lg text-white"
            style={{ background: "var(--accent)" }}
          >
            <IconShield width={17} height={17} />
          </span>
          <span className="text-[17px] font-semibold tracking-[-0.01em]">CareOS</span>
        </Link>

        <nav className="flex flex-col gap-1" aria-label="Primary">
          {NAV.map((item) => (
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
          <div className="flex items-center gap-3 px-3 pb-3">
            <Avatar name={name} size={34} />
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

      {/* Mobile top bar */}
      <div className="flex min-w-0 flex-1 flex-col">
        <header
          className="flex h-14 items-center justify-between border-b px-4 md:hidden hairline"
          style={{ background: "var(--panel)" }}
        >
          <Link href="/" className="flex items-center gap-2">
            <span className="flex size-7 items-center justify-center rounded-md text-white"
                  style={{ background: "var(--accent)" }}>
              <IconShield width={15} height={15} />
            </span>
            <span className="font-semibold">CareOS</span>
          </Link>
          <StatusChip status="aal2" />
        </header>

        <main className="mx-auto w-full max-w-5xl flex-1 px-4 py-8 md:px-8">{children}</main>

        {/* Mobile bottom tabs (docs/10 §2) */}
        <nav
          className="sticky bottom-0 z-10 flex border-t md:hidden hairline"
          style={{ background: "var(--panel)" }}
          aria-label="Primary"
        >
          {NAV.slice(0, 4).map((item) => (
            <Link
              key={item.href}
              href={item.href}
              data-active={active === item.href}
              className="flex flex-1 flex-col items-center gap-1 py-2.5 text-[11px] font-medium"
              style={{ color: active === item.href ? "var(--accent)" : "var(--text-muted)" }}
            >
              {item.icon}
              {item.label}
            </Link>
          ))}
        </nav>
      </div>
    </div>
  );
}
