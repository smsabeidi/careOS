/* ─────────────────────────────────────────────────────────────────────────────
   /welcome — the first authenticated frame of CareOS
   ───────────────────────────────────────────────────────────────────────────
   Shown once, after MFA, before somebody's home screen. It is a checklist of
   REAL work on LIVE screens rather than a tour, because the ratified training
   doctrine is learning by doing (docs/14 §6) and because a tour would have to
   point at features that are still dark, which docs/10 §10 forbids.

   Deliberately not wrapped in AppShell. The nav rail is the thing this screen
   is teaching; putting it behind the chrome would ask somebody to navigate
   before they have been shown how. /login and /mfa make the same choice.

   NO PHI. The reader's own first name and their own role are the only personal
   facts here, and the checklist itself is dictionary keys and routes. Nothing
   on this screen is fetched from a client chart.

   The guard is `needsWelcome`, which fails closed towards the product: any
   doubt — flag off, unreadable progress, unrecognised role — sends somebody to
   their real home screen instead of holding them here. A first-run surface is
   never allowed to become a door that will not open.
──────────────────────────────────────────────────────────────────────────── */

import { redirect } from "next/navigation";

import { BrandLogo } from "@/components/logo";
import { getT } from "@/lib/i18n/server";
import { checklistFor, introKeyFor } from "@/lib/onboarding";
import { getMilestones, needsWelcome } from "@/lib/onboarding.server";
import { getProfile } from "@/lib/profile";

import WelcomeClient from "./welcome-client";

export const dynamic = "force-dynamic";

/** First name only: the greeting should read the way somebody is spoken to, not filed. */
function firstNameOf(name: string): string {
  return name.trim().split(/\s+/)[0] || name;
}

export default async function WelcomePage() {
  const profile = await getProfile();
  if (!profile) redirect("/login");

  // The same question the root route asked. Asked again here because a page is
  // reachable by typing its address, and because the answer can have changed in
  // the seconds since: somebody who finished this screen in another tab should
  // land on their work, not on a second copy of their first day.
  if (!(await needsWelcome(profile.roles))) redirect("/");

  const t = await getT();
  const steps = checklistFor(profile.roles);
  const introKey = introKeyFor(profile.roles);

  // `needsWelcome` already refuses an empty checklist, so this is belt-and-braces
  // against a future role that gains an intro but no steps — an empty checklist
  // renders as a blank promise, and the four-state doctrine says pass through.
  if (steps.length === 0 || !introKey) redirect("/");

  // A failed read answers with an empty set rather than an error: every row simply
  // renders unticked, which is a screen somebody can still finish. Recording is
  // idempotent, so re-doing an already-done step costs nothing.
  const done = await getMilestones();

  return (
    <main className="flex min-h-dvh items-center justify-center px-4 py-10 sm:py-14">
      <div className="rise w-full max-w-xl">
        <header className="mb-8 flex flex-col gap-5">
          <BrandLogo size={44} />
          <div className="flex flex-col gap-2.5">
            <h1 className="title-lg text-[clamp(1.75rem,5vw,2.125rem)]">
              {t("onboarding.title", { name: firstNameOf(profile.name) })}
            </h1>
            <p className="text-[15px] leading-relaxed" style={{ color: "var(--text-secondary)" }}>
              {t(introKey)}
            </p>
          </div>
        </header>

        <WelcomeClient steps={steps} done={[...done]} />
      </div>
    </main>
  );
}
