"use client";

/* ─────────────────────────────────────────────────────────────────────────────
   The first-run checklist — the only interactive part of /welcome
   ───────────────────────────────────────────────────────────────────────────
   A client island earns its place by interaction, not by convenience: the
   greeting and the intro are rendered on the server and stay there. What lives
   here is the ticking, the disclosure, and the two buttons that end the screen.

   Every row is something somebody can actually do, so progress can actually
   reach the end. A row that could never be ticked would leave the meter stalled
   at two thirds on somebody's first day, which is the opposite of the promise
   the meter is making.

   Ticks are optimistic and recording is fire-and-forget. The tick reflects what
   the person just did, not whether we managed to store it — a dropped write
   means the row is simply unticked next time, and the database makes recording
   idempotent so re-doing it costs nothing. Nothing here can block the flow.
──────────────────────────────────────────────────────────────────────────── */

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useId, useState, useTransition, type ReactNode } from "react";

import {
  IconActivity,
  IconArrowRight,
  IconCalendar,
  IconCheck,
  IconChevronDown,
  IconClipboardCheck,
  IconClock,
  IconEye,
  IconHeart,
  IconInbox,
  IconLanguage,
  IconPen,
  IconPlus,
  IconShield,
  IconUsers,
} from "@/components/icons";
import { ProgressMeter, TintTile } from "@/components/ui";
import { setLocalePreference } from "@/app/chrome-actions";
import { useLocale, useT } from "@/lib/i18n/client";
import { LOCALES, LOCALE_LABEL, type Locale } from "@/lib/i18n/config";
import { milestoneFor, type OnboardingStep } from "@/lib/onboarding";

import { completeWelcome, recordMilestone } from "./actions";

/** One glyph per step, so a row is recognisable before it is read. */
const STEP_ICON: Record<OnboardingStep["key"], ReactNode> = {
  first_look: <IconCalendar />,
  language: <IconLanguage />,
  home_screen: <IconPlus />,
  how_visits_work: <IconClock />,
  what_you_see: <IconEye />,
  who_to_contact: <IconUsers />,
  clients: <IconUsers />,
  intake: <IconInbox />,
  compliance: <IconClipboardCheck />,
  clinical_home: <IconHeart />,
  reviews: <IconPen />,
  exec_overview: <IconActivity />,
  evidence: <IconShield />,
};

export default function WelcomeClient({
  steps,
  done,
}: {
  steps: OnboardingStep[];
  /** Milestone names already recorded for this person, from the server. */
  done: string[];
}) {
  const t = useT();
  const locale = useLocale();
  const router = useRouter();
  const baseId = useId();

  // Seed the ticks from what the database already knows. Every step records a
  // milestone (0059), so every tick survives a sign-out, a new device, a new tab.
  const [ticked, setTicked] = useState<ReadonlySet<string>>(
    () => new Set(steps.filter((s) => done.includes(milestoneFor(s))).map((s) => s.key))
  );
  const [openKey, setOpenKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const total = steps.length;
  const count = steps.filter((s) => ticked.has(s.key)).length;

  /** Tick a row and remember it, so the next visit starts where this one finished. */
  function mark(step: OnboardingStep) {
    setTicked((prev) => (prev.has(step.key) ? prev : new Set(prev).add(step.key)));
    // Deliberately not awaited and deliberately swallowed: a link row navigates away
    // mid-flight, and a failed tick is not worth a sentence on this screen.
    void recordMilestone(milestoneFor(step)).catch(() => {});
  }

  function toggle(step: OnboardingStep) {
    setOpenKey((prev) => (prev === step.key ? null : step.key));
    mark(step);
  }

  function chooseLocale(step: OnboardingStep, next: Locale) {
    if (pending) return;
    // Tapping the language you already have is an answer, not a no-op: it confirms the
    // choice and ticks the row. Without this, anyone whose language was already right —
    // the common case — could only finish this step by switching the whole UI away and
    // back, so the meter stalled one short of the end for exactly the people who had
    // nothing to change. Only an actual switch pays for a preference write and refresh.
    mark(step);
    if (next === locale) return;
    startTransition(async () => {
      await setLocalePreference(next);
      router.refresh();
    });
  }

  function finish(skipped: boolean) {
    setError(null);
    startTransition(async () => {
      // On success this redirects and never returns; only a refusal comes back.
      const result = await completeWelcome(skipped);
      if (result && !result.ok) setError(result.error ?? t("onboarding.error.body"));
    });
  }

  return (
    <div className="card flex flex-col gap-5 p-5 sm:p-6">
      <ProgressMeter
        value={count}
        max={total}
        label={t("onboarding.progress", { done: count, total })}
        tone={count === total ? "success" : "accent"}
        showValue={false}
      />

      {/* The meter is a graphic; this is the same fact for a screen reader, announced
          only when it changes rather than on every keystroke of navigation. */}
      <p className="sr-only" role="status" aria-live="polite">
        {t("onboarding.progress", { done: count, total })}
      </p>

      {/* Bled to the card's edges so the dividers and the row hover run the full width of
          the group, while each row's own padding puts its content back in line with the
          meter and the button below it — the grouped-list shape iOS uses. */}
      <ul className="stagger -mx-5 flex flex-col sm:-mx-6">
        {steps.map((step) => {
          const isTicked = ticked.has(step.key);
          const title = t(step.titleKey);
          const body = t(step.bodyKey);
          const icon = STEP_ICON[step.key];

          return (
            <li key={step.key} className="border-t first:border-t-0" style={{ borderColor: "var(--border)" }}>
              {step.kind === "link" && step.href ? (
                <Link
                  href={step.href}
                  onClick={() => mark(step)}
                  className="row-link w-full px-5 py-4 text-left sm:px-6"
                >
                  <TintTile icon={icon} size={40} tone={isTicked ? "success" : "accent"} />
                  <StepText title={title} body={body} />
                  <Trailing ticked={isTicked} check={t("onboarding.stepDone")}>
                    <IconArrowRight width={16} height={16} aria-hidden style={{ color: "var(--text-muted)" }} />
                  </Trailing>
                </Link>
              ) : step.kind === "language" ? (
                <div className="flex items-center gap-4 px-5 py-4 sm:px-6">
                  <TintTile icon={icon} size={40} tone={isTicked ? "success" : "accent"} />
                  {/* The two buttons sit beside the sentence on a desktop and drop beneath
                      it on a phone: side by side in a 390px column, the body text is squeezed
                      into a two-word ribbon and the row stops being readable. */}
                  <div className="flex min-w-0 flex-1 flex-col gap-2.5 sm:flex-row sm:items-center sm:gap-4">
                    <StepText title={title} body={body} />
                    <div className="flex shrink-0 gap-1.5" role="group" aria-label={title}>
                      {LOCALES.map((code) => (
                        <button
                          key={code}
                          type="button"
                          lang={code}
                          aria-pressed={locale === code}
                          onClick={() => chooseLocale(step, code)}
                          className={`btn btn-sm ${locale === code ? "btn-tinted" : "btn-plain"}`}
                        >
                          {LOCALE_LABEL[code]}
                        </button>
                      ))}
                    </div>
                  </div>
                  {/* The same done affordance every other row gets. Without it this row's
                      only finished signal was the tile tinting green — colour alone, and
                      aria-hidden colour at that, which docs/10 §3 forbids. */}
                  <Trailing ticked={isTicked} check={t("onboarding.stepDone")} />
                </div>
              ) : (
                <>
                  <button
                    type="button"
                    onClick={() => toggle(step)}
                    aria-expanded={openKey === step.key}
                    aria-controls={`${baseId}-${step.key}`}
                    className="row-link w-full px-5 py-4 text-left sm:px-6"
                  >
                    <TintTile icon={icon} size={40} tone={isTicked ? "success" : "accent"} />
                    <StepText title={title} />
                    <Trailing ticked={isTicked} check={t("onboarding.stepDone")}>
                      <IconChevronDown
                        width={16}
                        height={16}
                        aria-hidden
                        style={{
                          color: "var(--text-muted)",
                          transform: openKey === step.key ? "rotate(180deg)" : undefined,
                          transition: "transform var(--dur) var(--ease-out)",
                        }}
                      />
                    </Trailing>
                  </button>
                  <div
                    id={`${baseId}-${step.key}`}
                    hidden={openKey !== step.key}
                    /* Indented to the row's text on a wide screen (tile 40 + gap 16), flush
                       on a phone where 56px of indent would cost a third of the column. */
                    className="px-5 pb-4 sm:px-6 sm:pl-[4.5rem]"
                  >
                    <p className="text-[14px] leading-relaxed" style={{ color: "var(--text-secondary)" }}>
                      {body}
                    </p>
                    {step.key === "home_screen" && (
                      <ul className="mt-3 flex flex-col gap-2">
                        {(["onboarding.step.home_screen.ios", "onboarding.step.home_screen.android"] as const).map(
                          (key) => (
                            <li
                              key={key}
                              className="rounded-[var(--radius-md)] px-3 py-2.5 text-[13px] leading-relaxed"
                              style={{ background: "var(--color-surface-100)", color: "var(--text-secondary)" }}
                            >
                              {t(key)}
                            </li>
                          )
                        )}
                      </ul>
                    )}
                  </div>
                </>
              )}
            </li>
          );
        })}
      </ul>

      {error && (
        <p
          role="alert"
          className="rounded-[var(--radius-md)] px-3.5 py-2.5 text-[13px] leading-snug"
          style={{ background: "var(--color-danger-50)", color: "var(--color-danger-700)" }}
        >
          {error}
        </p>
      )}

      <div className="flex flex-col gap-3">
        <button
          type="button"
          onClick={() => finish(false)}
          disabled={pending}
          className="btn btn-primary btn-lg btn-block"
        >
          {t("onboarding.ready")}
        </button>
        <div className="flex items-center justify-between gap-3">
          <p className="text-[12.5px] leading-snug" style={{ color: "var(--text-muted)" }}>
            {t("onboarding.savedNote")}
          </p>
          <button
            type="button"
            onClick={() => finish(true)}
            disabled={pending}
            className="btn btn-plain btn-sm shrink-0"
          >
            {t("onboarding.skip")}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ── Row internals ───────────────────────────────────────────────────────── */

function StepText({ title, body }: { title: string; body?: string }) {
  return (
    <span className="flex min-w-0 flex-1 flex-col gap-0.5">
      <span className="text-[15px] font-medium tracking-[-0.01em]">{title}</span>
      {body && (
        <span className="text-[13.5px] leading-snug" style={{ color: "var(--text-muted)" }}>
          {body}
        </span>
      )}
    </span>
  );
}

/**
 * The right-hand affordance. A finished row swaps its chevron or arrow for a tick —
 * colour is never the only signal (docs/10 §3), so the tick is a shape and carries
 * a label for anyone who cannot see it.
 */
function Trailing({ ticked, check, children }: { ticked: boolean; check: string; children?: ReactNode }) {
  if (!ticked) return children ? <span className="flex shrink-0 items-center">{children}</span> : null;
  return (
    <span className="flex shrink-0 items-center" style={{ color: "var(--color-success-700)" }}>
      <IconCheck width={17} height={17} aria-hidden />
      <span className="sr-only">{check}</span>
    </span>
  );
}
