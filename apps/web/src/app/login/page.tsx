"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { supabaseBrowser } from "@/lib/supabase/client";
import { elevateDemoSession } from "@/lib/demo-totp";
import { IconShield, IconAlert } from "@/components/icons";

const DEMO_MODE = process.env.NEXT_PUBLIC_CAREOS_DEMO_MODE === "true";

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
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) {
      setError("That email and password didn't match. Nothing you typed was lost — check and try again.");
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
    <div
      className="flex min-h-dvh items-center justify-center px-5 py-12"
      style={{ background: "var(--bg)" }}
    >
      <div className="rise w-full max-w-[400px]">
        <div className="mb-9 flex flex-col items-center gap-5 text-center">
          <span
            className="flex items-center justify-center text-white"
            style={{
              width: 62,
              height: 62,
              borderRadius: 19,
              background: "linear-gradient(160deg, var(--color-accent-500), var(--accent-active))",
              boxShadow: "var(--shadow-md)",
            }}
          >
            <IconShield width={34} height={34} />
          </span>
          <div className="flex flex-col gap-2">
            <h1 className="title-lg text-[34px]">Welcome back</h1>
            <p className="text-[15px]" style={{ color: "var(--text-secondary)" }}>
              Sign in to CareOS — care operations, provably in order.
            </p>
          </div>
        </div>

        <form onSubmit={onSubmit} className="card flex flex-col gap-5 p-7">
          <div>
            <label className="label" htmlFor="email">Work email</label>
            <input
              id="email"
              type="email"
              autoComplete="email"
              required
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
              className="input h-12"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="••••••••••"
            />
          </div>

          {error && (
            <p
              role="alert"
              className="flex items-start gap-2 rounded-[var(--radius-md)] px-3.5 py-2.5 text-[13px] leading-snug"
              style={{ background: "var(--color-danger-50)", color: "var(--color-danger-700)" }}
            >
              <IconAlert width={16} height={16} className="mt-0.5 shrink-0" />
              <span>{error}</span>
            </p>
          )}

          <button className="btn btn-primary btn-lg btn-block mt-1" disabled={busy} type="submit">
            {busy ? "Signing in…" : "Continue"}
          </button>
          <p className="text-center text-[13px] leading-snug" style={{ color: "var(--text-secondary)" }}>
            You'll verify with your authenticator app next — patient records require a verified session.
          </p>
        </form>
      </div>
    </div>
  );
}
