"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { supabaseBrowser } from "@/lib/supabase/client";
import { IconShield } from "@/components/icons";

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
    router.push("/mfa");
    router.refresh();
  }

  return (
    <div className="flex min-h-dvh items-center justify-center px-4">
      <div className="rise w-full max-w-sm">
        <div className="mb-8 flex flex-col items-center gap-3">
          <span className="flex size-12 items-center justify-center rounded-xl text-white shadow-1"
                style={{ background: "var(--accent)" }}>
            <IconShield width={24} height={24} />
          </span>
          <div className="text-center">
            <h1 className="text-xl font-semibold tracking-[-0.01em]">Sign in to CareOS</h1>
            <p className="mt-1 text-sm" style={{ color: "var(--text-muted)" }}>
              Care operations, provably in order.
            </p>
          </div>
        </div>

        <form onSubmit={onSubmit} className="card flex flex-col gap-4 p-6">
          <div>
            <label className="label" htmlFor="email">Work email</label>
            <input
              id="email"
              type="email"
              autoComplete="email"
              required
              className="input"
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
              className="input"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="••••••••••"
            />
          </div>

          {error && (
            <p role="alert" className="rounded-md px-3 py-2 text-[13px]"
               style={{ background: "var(--color-danger-50)", color: "var(--color-danger-700)" }}>
              {error}
            </p>
          )}

          <button className="btn btn-primary btn-lg mt-1" disabled={busy} type="submit">
            {busy ? "Signing in…" : "Continue"}
          </button>
          <p className="text-center text-xs" style={{ color: "var(--text-muted)" }}>
            You'll verify with your authenticator app next — patient records require a verified session.
          </p>
        </form>
      </div>
    </div>
  );
}
