"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { supabaseBrowser } from "@/lib/supabase/client";
import { IconLock } from "@/components/icons";

type Mode = "loading" | "enroll" | "challenge" | "error";

export default function MfaPage() {
  const router = useRouter();
  const supabase = useRef(supabaseBrowser()).current;
  const [mode, setMode] = useState<Mode>("loading");
  const [qr, setQr] = useState<string | null>(null);
  const [secret, setSecret] = useState<string | null>(null);
  const [factorId, setFactorId] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);

  const bootstrap = useCallback(async () => {
    if (inFlight.current) return; // strict-mode double-invoke guard: one enrollment, not two
    inFlight.current = true;
    try {
      await bootstrapInner();
    } finally {
      inFlight.current = false;
    }
  }, []);  // eslint-disable-line react-hooks/exhaustive-deps

  const bootstrapInner = useCallback(async () => {
    const { data: aal } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
    if (aal?.currentLevel === "aal2") {
      router.replace("/office/clients");
      return;
    }
    const { data: factors, error: fErr } = await supabase.auth.mfa.listFactors();
    if (fErr) {
      setError("Couldn't check your security setup. Your sign-in is intact — try again.");
      setMode("error");
      return;
    }
    const verified = factors?.totp?.find((f) => f.status === "verified");
    if (verified) {
      setFactorId(verified.id);
      setMode("challenge");
      return;
    }
    // Clear any half-finished enrollments (e.g. the page was closed mid-setup) so a
    // fresh QR can be issued without a name conflict.
    const stale = factors?.all?.filter((f) => f.factor_type === "totp" && f.status !== "verified") ?? [];
    for (const f of stale) {
      await supabase.auth.mfa.unenroll({ factorId: f.id });
    }
    // First sign-in: enroll a new authenticator (docs/09 §2 — TOTP mandatory for staff)
    const { data: enrolled, error: eErr } = await supabase.auth.mfa.enroll({
      factorType: "totp",
      friendlyName: "Authenticator app",
    });
    if (eErr || !enrolled) {
      setError("Couldn't start authenticator setup. Your sign-in is intact — try again.");
      setMode("error");
      return;
    }
    setFactorId(enrolled.id);
    setQr(enrolled.totp.qr_code);
    setSecret(enrolled.totp.secret);
    setMode("enroll");
  }, [router, supabase]);

  useEffect(() => {
    void bootstrap();
  }, [bootstrap]);

  async function verify(e: React.FormEvent) {
    e.preventDefault();
    if (!factorId) return;
    setBusy(true);
    setError(null);
    const { data: challenge, error: cErr } = await supabase.auth.mfa.challenge({ factorId });
    if (cErr || !challenge) {
      setError("Couldn't start verification — try again.");
      setBusy(false);
      return;
    }
    const { error: vErr } = await supabase.auth.mfa.verify({
      factorId,
      challengeId: challenge.id,
      code: code.trim(),
    });
    if (vErr) {
      setError("That code didn't match. Codes refresh every 30 seconds — try the current one.");
      setBusy(false);
      return;
    }
    router.replace("/office/clients");
    router.refresh();
  }

  return (
    <div className="flex min-h-dvh items-center justify-center px-4">
      <div className="rise w-full max-w-sm">
        <div className="mb-8 flex flex-col items-center gap-3 text-center">
          <span className="flex size-12 items-center justify-center rounded-xl shadow-1"
                style={{ background: "var(--accent-soft)", color: "var(--accent)" }}>
            <IconLock width={22} height={22} />
          </span>
          <div>
            <h1 className="text-xl font-semibold tracking-[-0.01em]">
              {mode === "enroll" ? "Set up your authenticator" : "Verify it's you"}
            </h1>
            <p className="mt-1 text-sm" style={{ color: "var(--text-muted)" }}>
              Patient records open only in a verified session.
            </p>
          </div>
        </div>

        {mode === "loading" && (
          <div className="card space-y-3 p-6" aria-busy="true" aria-label="Checking your security setup">
            <div className="skeleton h-4 w-3/4" />
            <div className="skeleton h-40 w-full" />
            <div className="skeleton h-11 w-full" />
          </div>
        )}

        {mode === "error" && (
          <div className="card p-6 text-center" role="alert">
            <p className="text-sm" style={{ color: "var(--text-secondary)" }}>{error}</p>
            <button className="btn btn-secondary mt-4" onClick={() => { setMode("loading"); void bootstrap(); }}>
              Try again
            </button>
          </div>
        )}

        {(mode === "enroll" || mode === "challenge") && (
          <form onSubmit={verify} className="card flex flex-col gap-4 p-6">
            {mode === "enroll" && (
              <>
                <p className="text-sm" style={{ color: "var(--text-secondary)" }}>
                  Scan this with any authenticator app (1Password, Google Authenticator, Authy), then
                  enter the 6-digit code it shows.
                </p>
                {qr && (
                  <div className="mx-auto rounded-lg border p-3 hairline" style={{ background: "#fff" }}>
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={qr} alt="Authenticator enrollment QR code" width={168} height={168} />
                  </div>
                )}
                {secret && (
                  <p className="text-center text-xs" style={{ color: "var(--text-muted)" }}>
                    Can't scan? Enter this key manually:{" "}
                    <code data-testid="totp-secret" className="tabular font-medium tracking-wide">{secret}</code>
                  </p>
                )}
              </>
            )}

            <div>
              <label className="label" htmlFor="code">6-digit code</label>
              <input
                id="code"
                inputMode="numeric"
                pattern="[0-9]{6}"
                maxLength={6}
                required
                autoFocus
                autoComplete="one-time-code"
                className="input tabular text-center text-lg tracking-[0.4em]"
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
                placeholder="000000"
              />
            </div>

            {error && (
              <p role="alert" className="rounded-md px-3 py-2 text-[13px]"
                 style={{ background: "var(--color-danger-50)", color: "var(--color-danger-700)" }}>
                {error}
              </p>
            )}

            <button className="btn btn-primary btn-lg" disabled={busy || code.length !== 6} type="submit">
              {busy ? "Verifying…" : "Verify and continue"}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
