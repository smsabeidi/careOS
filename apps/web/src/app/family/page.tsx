import { AppShell } from "@/components/shell";
import { Avatar, Badge, EmptyState, PageHeader, SectionTitle, TintTile } from "@/components/ui";
import {
  IconBell, IconCalendar, IconCheck, IconClipboard, IconHeart, IconShield, IconUsers,
} from "@/components/icons";
import { supabaseServer } from "@/lib/supabase/server";

export const metadata = { title: "Family" };
export const dynamic = "force-dynamic";

const PREVIEW = [
  { icon: <IconBell width={20} height={20} />, title: "Approved updates", body: "Gentle notes your loved one's care team has chosen to share with you." },
  { icon: <IconCalendar width={20} height={20} />, title: "Visit calendar", body: "Upcoming visits at a glance — only what you're cleared to see." },
  { icon: <IconClipboard width={20} height={20} />, title: "Shared documents", body: "Care plans and paperwork the agency shares, ready when you need them." },
  { icon: <IconUsers width={20} height={20} />, title: "Contact & on-call", body: "Who to reach during the day, and who's on call after hours." },
];

const SCOPE_LABEL: Record<string, string> = {
  updates: "Updates", calendar: "Visit calendar", documents: "Documents",
};

function fmtDay(iso: string) {
  return new Date(iso).toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" });
}
function fmtTime(iso: string) {
  return new Date(iso).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

export default async function FamilyPage() {
  const supabase = await supabaseServer();
  const { data: { user } } = await supabase.auth.getUser();

  // A family member sees their loved one only through an active link + granted consent.
  const { data: links } = user
    ? await supabase
        .from("family_link")
        .select("client_id, relationship")
        .eq("family_user_id", user.id)
        .eq("status", "active")
        .limit(1)
    : { data: [] as { client_id: string; relationship: string | null }[] };
  const link = links?.[0];

  // Not linked (or a non-family user landed here): the honest preview.
  if (!link) {
    return (
      <AppShell active="/family">
        <div className="rise mx-auto max-w-xl">
          <PageHeader title="Family" sub="A window into your loved one's care — always with their consent." />
          <EmptyState
            icon={<IconHeart />}
            title="The family portal opens soon"
            body="Once your agency turns it on and consent is on file, approved updates, the visit calendar, and shared documents appear here. Nothing is ever shared without permission."
          />
          <section className="mt-6">
            <SectionTitle>What you&apos;ll find here</SectionTitle>
            <div className="card stagger divide-y hairline overflow-hidden">
              {PREVIEW.map((item) => (
                <div key={item.title} className="flex items-center gap-4 px-5 py-4">
                  <TintTile icon={item.icon} size={40} />
                  <div className="min-w-0 flex-1">
                    <p className="text-[15px] font-medium">{item.title}</p>
                    <p className="mt-0.5 text-[13px] leading-relaxed" style={{ color: "var(--text-secondary)" }}>{item.body}</p>
                  </div>
                </div>
              ))}
            </div>
          </section>
        </div>
      </AppShell>
    );
  }

  // Linked: pull the consent-gated content. All of this is RLS/RPC-gated to what the
  // client agreed to share (app.on_family_link + consent scope).
  const [clientRes, consentRes, updatesRes, docsRes, calRes] = await Promise.all([
    supabase.schema("app").rpc("family_client", { p_client: link.client_id }),
    supabase.from("consent").select("scope, status, created_at").eq("client_id", link.client_id).order("created_at", { ascending: false }).limit(1),
    supabase.from("family_update").select("id, title, body, created_at").eq("client_id", link.client_id).order("created_at", { ascending: false }).limit(20),
    supabase.from("shared_document").select("id, title, doc_kind, note, created_at").eq("client_id", link.client_id).order("created_at", { ascending: false }).limit(20),
    supabase.schema("app").rpc("family_calendar", { p_client: link.client_id }),
  ]);

  const c = (clientRes.data as { first_name: string; last_name: string; city: string | null }[] | null)?.[0];
  const lovedOne = c ? `${c.first_name} ${c.last_name}` : "Your loved one";
  const scope: string[] = (consentRes.data?.[0]?.scope as string[] | undefined) ?? [];
  const updates = updatesRes.data ?? [];
  const docs = docsRes.data ?? [];
  const calendar = (calRes.data as { scheduled_start: string; scheduled_end: string; status: string }[] | null) ?? [];

  return (
    <AppShell active="/family">
      <div className="rise mx-auto max-w-xl">
        {/* Hero */}
        <div className="card mb-6 p-6" style={{ background: "linear-gradient(180deg, var(--accent-soft) 0%, var(--panel) 120px)" }}>
          <div className="flex items-center gap-4">
            <Avatar name={lovedOne} size={56} />
            <div className="min-w-0">
              <p className="text-[13px]" style={{ color: "var(--text-muted)" }}>
                {link.relationship ? `Your ${link.relationship}` : "Your loved one"}
              </p>
              <h1 className="title-lg text-[26px]">{lovedOne}</h1>
              {c?.city && <p className="text-[13px]" style={{ color: "var(--text-muted)" }}>{c.city}</p>}
            </div>
          </div>
          <div className="mt-4 flex flex-wrap items-center gap-2 border-t pt-4 hairline">
            <span className="flex items-center gap-1.5 text-[12px]" style={{ color: "var(--text-muted)" }}>
              <IconShield width={13} height={13} /> You&apos;re cleared to see:
            </span>
            {scope.length ? (
              scope.map((s) => <Badge key={s} tone="success" icon={<IconCheck />}>{SCOPE_LABEL[s] ?? s}</Badge>)
            ) : (
              <span className="text-[12px]" style={{ color: "var(--text-muted)" }}>nothing yet</span>
            )}
          </div>
        </div>

        {/* Approved updates */}
        {scope.includes("updates") && (
          <section className="mb-6">
            <SectionTitle icon={<IconBell width={16} height={16} />}>Approved updates</SectionTitle>
            {!updates.length ? (
              <p className="card px-5 py-6 text-center text-sm" style={{ color: "var(--text-muted)" }}>
                When the care team shares an update, it appears here.
              </p>
            ) : (
              <div className="stagger flex flex-col gap-3">
                {updates.map((u) => (
                  <div key={u.id} className="card p-5">
                    <div className="flex items-baseline justify-between gap-3">
                      <p className="text-[15px] font-semibold">{u.title}</p>
                      <span className="shrink-0 text-[12px]" style={{ color: "var(--text-muted)" }}>
                        {new Date(u.created_at).toLocaleDateString(undefined, { month: "short", day: "numeric" })}
                      </span>
                    </div>
                    <p className="mt-1.5 text-[14px] leading-relaxed" style={{ color: "var(--text-secondary)" }}>{u.body}</p>
                  </div>
                ))}
              </div>
            )}
          </section>
        )}

        {/* Visit calendar */}
        {scope.includes("calendar") && (
          <section className="mb-6">
            <SectionTitle icon={<IconCalendar width={16} height={16} />}>Visit calendar</SectionTitle>
            {!calendar.length ? (
              <p className="card px-5 py-6 text-center text-sm" style={{ color: "var(--text-muted)" }}>
                Upcoming visits will appear here.
              </p>
            ) : (
              <div className="card stagger divide-y hairline overflow-hidden">
                {calendar.slice(0, 8).map((v, i) => (
                  <div key={i} className="flex items-center gap-4 px-5 py-4">
                    <TintTile icon={<IconCalendar width={18} height={18} />} size={40} />
                    <div className="min-w-0 flex-1">
                      <p className="text-[15px] font-medium">{fmtDay(v.scheduled_start)}</p>
                      <p className="text-[13px]" style={{ color: "var(--text-muted)" }}>{fmtTime(v.scheduled_start)} – {fmtTime(v.scheduled_end)}</p>
                    </div>
                    {v.status === "completed" && <Badge tone="success" icon={<IconCheck />}>Visited</Badge>}
                  </div>
                ))}
              </div>
            )}
          </section>
        )}

        {/* Shared documents */}
        {scope.includes("documents") && (
          <section className="mb-6">
            <SectionTitle icon={<IconClipboard width={16} height={16} />}>Shared documents</SectionTitle>
            {!docs.length ? (
              <p className="card px-5 py-6 text-center text-sm" style={{ color: "var(--text-muted)" }}>
                Documents the agency shares with you appear here.
              </p>
            ) : (
              <div className="card stagger divide-y hairline overflow-hidden">
                {docs.map((d) => (
                  <div key={d.id} className="flex items-center gap-4 px-5 py-4">
                    <TintTile icon={<IconClipboard width={18} height={18} />} size={40} />
                    <div className="min-w-0 flex-1">
                      <p className="text-[15px] font-medium">{d.title}</p>
                      {d.note && <p className="text-[13px]" style={{ color: "var(--text-muted)" }}>{d.note}</p>}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </section>
        )}

        <section>
          <div className="card flex items-start gap-4 p-5">
            <TintTile icon={<IconShield width={20} height={20} />} size={40} />
            <div className="min-w-0">
              <p className="text-[15px] font-semibold tracking-[-0.01em]">Private by default</p>
              <p className="mt-1 text-[13.5px] leading-relaxed" style={{ color: "var(--text-secondary)" }}>
                You only ever see what {c?.first_name ?? "your loved one"} has agreed to share, and they can change that at
                any time. Nothing reaches this page without their permission.
              </p>
            </div>
          </div>
        </section>
      </div>
    </AppShell>
  );
}
