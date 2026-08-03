"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { supabaseBrowser } from "@/lib/supabase/client";
import { elevateDemoSession } from "@/lib/demo-totp";
import { IconAlert, IconShield, IconCheck, IconClipboardCheck } from "@/components/icons";
import { BrandLogo } from "@/components/logo";

const DEMO_MODE = process.env.NEXT_PUBLIC_CAREOS_DEMO_MODE === "true";

/**
 * Two failure modes, two messages.
 *
 * Every failure used to collapse into "Email and password didn't match" — so a Supabase
 * outage or a dead connection told the caregiver their password was wrong. They would
 * retype a correct password until they gave up. Supabase answers bad credentials with
 * HTTP 400 (`invalid_credentials`); transport failures arrive with no status at all.
 * Splitting on that is the difference between "you got it wrong" and "we can't reach us
 * right now" — and per docs/10 the second must also say what is preserved.
 */
const MSG_CREDENTIALS =
  "Email and password didn't match. Your entries are unchanged. Check and try again.";
const MSG_UNREACHABLE =
  "We couldn't reach CareOS just now. Nothing was sent and your entries are unchanged. Check your connection and try again in a moment.";

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const supabase = supabaseBrowser();

    try {
      const { error } = await supabase.auth.signInWithPassword({ email, password });
      if (error) {
        const status = (error as { status?: number }).status;
        const rejected = status === 400 || status === 422;
        setError(rejected ? MSG_CREDENTIALS : MSG_UNREACHABLE);
        setBusy(false);
        return;
      }
    } catch {
      // Thrown (not returned) — the request never completed: offline, DNS, CORS, TLS.
      setError(MSG_UNREACHABLE);
      setBusy(false);
      return;
    }

    // Demo mode: auto-complete the persona's real MFA step-up so PHI surfaces open
    // exactly as a verified session. Production takes the genuine /mfa path below.
    if (DEMO_MODE && (await elevateDemoSession(supabase))) {
      router.push("/");
      router.refresh();
      return;
    }
    router.push("/mfa");
    router.refresh();
  }

  return (
    <main className="grid min-h-dvh lg:grid-cols-[1.05fr_1fr]">
      {/* ── Art panel ──────────────────────────────────────────────────────────
          Decorative on small screens (the form is the task), so it collapses to a
          short banner rather than pushing the fields below the fold. */}
      <section className="auth-art hidden flex-col justify-between p-10 lg:flex xl:p-14">
        <div className="auth-art-body flex items-center gap-3">
          <BrandLogo size={34} />
          <span className="text-[17px] font-semibold tracking-[-0.01em]">CareOS</span>
        </div>

        <div className="auth-art-body max-w-[30rem]">
          <h2 className="title-lg text-[clamp(1.75rem,2.4vw,2.5rem)] leading-[1.12] tracking-[-0.02em]">
            Care records that can&apos;t be lost.
          </h2>
          <p className="auth-art-muted mt-4 text-[15px] leading-relaxed">
            Every note, signature and correction is written once and kept. Nothing is
            overwritten — so what happened, and who did it, stays recoverable.
          </p>

          <ul className="mt-7 flex flex-wrap gap-2" aria-label="What this platform guarantees">
            <li className="auth-chip">
              <IconClipboardCheck width={13} height={13} aria-hidden />
              Append-only records
            </li>
            <li className="auth-chip">
              <IconCheck width={13} height={13} aria-hidden />
              Verified visits
            </li>
            <li className="auth-chip">
              <IconShield width={13} height={13} aria-hidden />
              MFA-protected
            </li>
          </ul>
        </div>
      </section>

      {/* ── Form panel ─────────────────────────────────────────────────────── */}
      <section
        className="flex items-center justify-center px-5 py-12 sm:px-10"
        style={{ background: "var(--panel)" }}
      >
        <div className="rise w-full max-w-[25rem]">
          {/* Brand shows here only when the art panel is hidden, so it never doubles. */}
          <div className="mb-9 flex flex-col gap-5 lg:mb-10">
            <span className="lg:hidden">
              <BrandLogo size={52} onLight />
            </span>
            <div className="flex flex-col gap-2">
              <h1 className="title-lg text-[clamp(1.75rem,4vw,2.125rem)] tracking-[-0.02em]">
                Sign in
              </h1>
              <p className="text-[15px]" style={{ color: "var(--text-secondary)" }}>
                CareOS care operations platform
              </p>
            </div>
          </div>

          <form onSubmit={onSubmit} className="flex flex-col gap-5" noValidate>
            <div>
              <label className="label" htmlFor="email">Work email</label>
              <input
                id="email"
                type="email"
                autoComplete="email"
                autoFocus
                required
                aria-invalid={error ? true : undefined}
                aria-describedby={error ? "signin-error" : undefined}
                className="input h-12"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@agency.com"
              />
            </div>
            <div>
              <label className="label" htmlFor="password">Password</label>
              <input
                id="password"
                type="password"
                autoComplete="current-password"
                required
                aria-invalid={error ? true : undefined}
                aria-describedby={error ? "signin-error" : undefined}
                className="input h-12"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••••••"
              />
            </div>

            {error && (
              <p
                id="signin-error"
                role="alert"
                className="flex items-start gap-2 rounded-[var(--radius-md)] px-3.5 py-2.5 text-[13px] leading-snug"
                style={{ background: "var(--color-danger-50)", color: "var(--color-danger-700)" }}
              >
                <IconAlert width={16} height={16} className="mt-0.5 shrink-0" aria-hidden />
                <span>{error}</span>
              </p>
            )}

            <button className="btn btn-primary btn-lg btn-block mt-1" disabled={busy} type="submit">
              {busy ? "Signing in…" : "Continue"}
            </button>

            <p
              className="text-[13px] leading-snug"
              style={{ color: "var(--text-secondary)" }}
            >
              You&apos;ll verify with your authenticator app next. Patient records require a
              verified session.
            </p>
          </form>
        </div>
      </section>
    </main>
  );
}
