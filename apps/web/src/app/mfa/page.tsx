"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { supabaseBrowser } from "@/lib/supabase/client";
import { IconAlert, IconLock } from "@/components/icons";
import { TintTile } from "@/components/ui";
import { useT } from "@/lib/i18n/client";

type Mode = "loading" | "enroll" | "challenge" | "error";

export default function MfaPage() {
  const t = useT();
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
      setError(t("auth.mfaCheckError"));
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
      setError(t("auth.mfaEnrollError"));
      setMode("error");
      return;
    }
    setFactorId(enrolled.id);
    setQr(enrolled.totp.qr_code);
    setSecret(enrolled.totp.secret);
    setMode("enroll");
  }, [router, supabase, t]);

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
      setError(t("auth.mfaChallengeError"));
      setBusy(false);
      return;
    }
    const { error: vErr } = await supabase.auth.mfa.verify({
      factorId,
      challengeId: challenge.id,
      code: code.trim(),
    });
    if (vErr) {
      setError(t("auth.mfaCodeError"));
      setBusy(false);
      return;
    }
    router.replace("/office/clients");
    router.refresh();
  }

  return (
    <div className="flex min-h-dvh items-center justify-center px-4 py-10">
      <div className="rise w-full max-w-sm">
        <div className="mb-8 flex flex-col items-center gap-4 text-center">
          <TintTile icon={<IconLock width={26} height={26} />} size={56} tone="accent" />
          <div>
            <h1 className="title-lg text-[28px]">
              {mode === "enroll" ? t("auth.mfaEnrollTitle") : t("auth.mfaVerifyTitle")}
            </h1>
            <p className="mx-auto mt-2 max-w-xs text-[15px] leading-relaxed" style={{ color: "var(--text-secondary)" }}>
              {t("auth.mfaSubtitle")}
            </p>
          </div>
        </div>

        {mode === "loading" && (
          <div className="card flex flex-col gap-4 p-7" aria-busy="true" aria-label={t("auth.mfaChecking")}>
            <div className="skeleton h-4 w-3/4" />
            <div className="skeleton mx-auto size-40 rounded-[var(--radius-lg)]" />
            <div className="skeleton h-14 w-full rounded-[var(--radius-md)]" />
            <div className="skeleton h-[52px] w-full rounded-[var(--radius-lg)]" />
          </div>
        )}

        {mode === "error" && (
          <div className="card flex flex-col items-center gap-3 p-7 text-center" role="alert">
            <TintTile icon={<IconAlert width={24} height={24} />} size={52} tone="danger" />
            <p className="text-[15px] leading-relaxed" style={{ color: "var(--text-secondary)" }}>{error}</p>
            <button className="btn btn-secondary mt-2" onClick={() => { setMode("loading"); void bootstrap(); }}>
              {t("common.tryAgain")}
            </button>
          </div>
        )}

        {(mode === "enroll" || mode === "challenge") && (
          <form onSubmit={verify} className="card flex flex-col gap-5 p-7">
            {mode === "enroll" && (
              <>
                <p className="text-[15px] leading-relaxed" style={{ color: "var(--text-secondary)" }}>
                  {t("auth.mfaScanHelp")}
                </p>
                {qr && (
                  <div className="mx-auto rounded-[var(--radius-lg)] border p-3.5 hairline" style={{ background: "#fff" }}>
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={qr} alt={t("auth.mfaQrAlt")} width={168} height={168} />
                  </div>
                )}
                {secret && (
                  <p className="text-center text-[13px] leading-relaxed" style={{ color: "var(--text-secondary)" }}>
                    {t("auth.mfaManualKey")}{" "}
                    <code data-testid="totp-secret" className="tabular font-medium tracking-wide" style={{ color: "var(--text)" }}>{secret}</code>
                  </p>
                )}
              </>
            )}

            <div>
              <label className="label" htmlFor="code">{t("auth.mfaCodeLabel")}</label>
              <input
                id="code"
                inputMode="numeric"
                pattern="[0-9]{6}"
                maxLength={6}
                required
                autoFocus
                autoComplete="one-time-code"
                className="input tabular h-14 text-center text-2xl font-medium tracking-[0.4em]"
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
                placeholder="000000"
              />
            </div>

            {error && (
              <p role="alert" className="flex items-start gap-2 rounded-[var(--radius-md)] px-3 py-2.5 text-[13px] leading-relaxed"
                 style={{ background: "var(--color-danger-50)", color: "var(--color-danger-700)" }}>
                <IconAlert width={16} height={16} className="mt-0.5 shrink-0" />
                <span>{error}</span>
              </p>
            )}

            <button className="btn btn-primary btn-lg btn-block" disabled={busy || code.length !== 6} type="submit">
              {busy ? t("auth.mfaVerifying") : t("auth.mfaVerifyCta")}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
