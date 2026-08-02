/**
 * The Daily Huddle Brief renderer (docs/16 §2.1 X5).
 *
 * Draws only from `brief.facts` — the deterministic payload. When narration is present it
 * supplies the ordering and one line of "why this matters today" per item; when it is
 * absent (kill switch, budget stop, provider error) the same facts render grouped, and the
 * page says so plainly. The morning page never depends on a model being reachable.
 */
import Link from "next/link";
import { revalidatePath } from "next/cache";
import { supabaseServer } from "@/lib/supabase/server";
import {
  regenerateBrief,
  GROUP_LABEL,
  type HuddleBrief,
  type HuddleItem,
  type HuddleRoleKey,
  type HuddleTone,
} from "@/lib/ai/huddle";
import { IconActivity, IconAlert, IconCheck, IconChevronRight, IconSparkle } from "./icons";

const TONE_COLOR: Record<HuddleTone, string> = {
  danger: "var(--color-danger-600)",
  warning: "var(--color-warning-600)",
  accent: "var(--accent)",
  success: "var(--color-success-600)",
  neutral: "var(--text-muted)",
};

function longDate(date: string): string {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
  });
}

/** One line of the brief: the fact, the model's why (when present), and the way in. */
function BriefRow({ item, line, index }: { item: HuddleItem; line?: string; index: number }) {
  return (
    <Link href={item.href} className="row-link group items-start">
      <span
        className="tabular mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full text-[12px] font-semibold"
        style={{ background: "var(--color-surface-100)", color: TONE_COLOR[item.tone] }}
      >
        {index}
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-[15px] font-medium leading-snug">{item.headline}</p>
        {line && (
          <p className="mt-1 text-[13.5px] leading-relaxed" style={{ color: "var(--text-secondary)" }}>
            {line}
          </p>
        )}
        {(item.detail || item.source_ref) && (
          <p className="mt-1 text-[12.5px]" style={{ color: "var(--text-muted)" }}>
            {item.detail}
            {item.detail && item.source_ref ? " · " : ""}
            {item.source_ref}
          </p>
        )}
      </div>
      <IconChevronRight
        className="mt-1 shrink-0 opacity-0 transition-opacity duration-150 group-hover:opacity-60"
        style={{ color: "var(--text-muted)" }}
      />
    </Link>
  );
}

export async function HuddleBriefCard({
  brief,
  canRegenerate = false,
}: {
  brief: HuddleBrief;
  canRegenerate?: boolean;
}) {
  const { facts, narration } = brief;
  const byKey = new Map(facts.items.map((i) => [i.key, i]));

  // Narration supplies the order when it is present and validated; facts supply it otherwise.
  const ranked: { item: HuddleItem; line?: string }[] =
    narration?.kind === "ranked"
      ? narration.items
          .map((n) => ({ item: byKey.get(n.key), line: n.line }))
          .filter((r): r is { item: HuddleItem; line: string } => Boolean(r.item))
      : facts.items.slice(0, 6).map((item) => ({ item }));

  async function regenerate() {
    "use server";
    const supabase = await supabaseServer();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (user) await regenerateBrief(supabase, brief.role as HuddleRoleKey, user.id);
    revalidatePath("/");
  }

  return (
    <section className="card mb-6 overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-3 px-5 pt-4">
        <div className="flex items-center gap-2">
          <IconActivity width={16} height={16} style={{ color: "var(--accent)" }} />
          <h2 className="text-[15px] font-semibold tracking-[-0.01em]">Today&apos;s brief</h2>
          <span className="text-[13px]" style={{ color: "var(--text-muted)" }}>
            {longDate(facts.date)}
          </span>
        </div>
        {canRegenerate && brief.canRegenerate && (
          <form action={regenerate}>
            <button type="submit" className="btn btn-secondary btn-sm">
              <IconSparkle width={14} height={14} />
              Refresh
            </button>
          </form>
        )}
      </div>

      {ranked.length === 0 ? (
        <div className="flex items-center gap-3.5 px-5 py-5">
          <span
            className="flex size-9 shrink-0 items-center justify-center rounded-full"
            style={{ background: "var(--color-success-50)", color: "var(--color-success-700)" }}
          >
            <IconCheck width={18} height={18} />
          </span>
          <p className="text-[15px]" style={{ color: "var(--text-secondary)" }}>
            Nothing needs attention this morning. Coverage, compliance, and credentials are all clear.
          </p>
        </div>
      ) : (
        <div className="mt-3 divide-y hairline border-t hairline">
          {ranked.map((r, i) => (
            <BriefRow key={r.item.key} item={r.item} line={r.line} index={i + 1} />
          ))}
        </div>
      )}

      {narration?.kind === "ranked" && narration.closing && (
        <p className="border-t px-5 py-3 text-[13px] hairline" style={{ color: "var(--text-secondary)" }}>
          {narration.closing}
        </p>
      )}
      {narration?.kind === "prose" && (
        <p className="border-t px-5 py-3 text-[14px] leading-relaxed hairline">{narration.text}</p>
      )}

      <div
        className="flex flex-wrap items-center gap-x-2 gap-y-1 border-t px-5 py-2.5 text-[12px] hairline"
        style={{ color: "var(--text-muted)" }}
      >
        {brief.note ? (
          <span className="inline-flex items-center gap-1.5">
            <IconAlert width={12} height={12} />
            {brief.note}
          </span>
        ) : (
          <span>
            Every figure here is computed by the platform from live records
            {brief.provider === "openai" ? "; the ordering and summaries are AI-written." : "."}
          </span>
        )}
      </div>
    </section>
  );
}

/** Group fallback used where a page wants the raw facts rather than the ranked brief. */
export function HuddleGroups({ facts }: { facts: HuddleBrief["facts"] }) {
  const groups = [...new Set(facts.items.map((i) => i.group))];
  return (
    <div className="flex flex-col gap-4">
      {groups.map((g) => (
        <div key={g}>
          <p
            className="mb-1.5 text-[11px] font-semibold uppercase"
            style={{ color: "var(--text-muted)", letterSpacing: "0.04em" }}
          >
            {GROUP_LABEL[g]}
          </p>
          <div className="card divide-y hairline overflow-hidden">
            {facts.items
              .filter((i) => i.group === g)
              .map((item, i) => (
                <BriefRow key={item.key} item={item} index={i + 1} />
              ))}
          </div>
        </div>
      ))}
    </div>
  );
}
