"use client";

import { useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { supabaseBrowser } from "@/lib/supabase/client";
import { BrandLogo } from "@/components/logo";

const inputCls =
  "w-full rounded-[10px] border px-3 py-2.5 text-[15px] outline-none " +
  "focus:ring-2 focus:ring-[var(--accent,#007AFF)]/40";
const inputStyle = { borderColor: "var(--separator, #d1d1d6)", background: "var(--bg-elevated, #fff)" };

/** CAREOS_* refusals → plain language, mirroring the office actions. */
function friendly(raw: string | undefined): string {
  const code = raw?.match(/CAREOS_[A-Z_]+/)?.[0];
  switch (code) {
    case "CAREOS_NOT_FOUND":
      return "That invitation link isn't valid. Check you copied the whole link, or ask for a new one.";
    case "CAREOS_EXPIRED":
      return "This invitation has expired — ask your coordinator for a fresh one.";
    case "CAREOS_EMAIL_MISMATCH":
      return "This invitation belongs to a different email address. Sign in with the email it was sent to.";
    case "CAREOS_ALREADY_ENROLLED":
      return "This account already belongs to an agency. Sign in normally instead.";
    case "CAREOS_BAD_STATE":
      return "This invitation was already used or withdrawn.";
    default:
      return raw ?? "Something went wrong. Nothing was saved.";
  }
}

export function AcceptClient() {
  const router = useRouter();
  const token = useSearchParams().get("token") ?? "";
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [mode, setMode] = useState<"create" | "signin">("create");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function accept() {
    setBusy(true);
    setError(null);
    const supabase = supabaseBrowser();

    // 1 · A session for the invited email — create the account or sign in.
    const auth =
      mode === "create"
        ? await supabase.auth.signUp({ email, password })
        : await supabase.auth.signInWithPassword({ email, password });
    if (auth.error) {
      setBusy(false);
      setError(
        mode === "create" && /already/i.test(auth.error.message)
          ? "That email already has a sign-in — switch to “I already have a sign-in”."
          : auth.error.message
      );
      return;
    }

    // 2 · Bind the account to the agency. The database checks token, expiry and email.
    const { error: rpcError } = await supabase
      .schema("app")
      .rpc("accept_invitation", { p_token_hex: token });
    if (rpcError) {
      setBusy(false);
      setError(friendly(rpcError.message));
      return;
    }

    // 3 · Straight to MFA enrollment — PHI stays locked until it's done.
    router.push("/mfa");
  }

  if (!token) {
    return (
      <main className="flex min-h-dvh items-center justify-center p-6">
        <div className="card w-full max-w-md p-6 text-center">
          <p className="text-[15px] font-medium">This page needs an invitation link.</p>
          <p className="mt-1 text-[13px]" style={{ color: "var(--text-secondary)" }}>
            Open the link your agency sent you.
          </p>
        </div>
      </main>
    );
  }

  return (
    <main className="flex min-h-dvh items-center justify-center p-6">
      <div className="card w-full max-w-md p-6">
        <div className="mb-5 flex flex-col items-center gap-2 text-center">
          <BrandLogo />
          <h1 className="text-[19px] font-semibold tracking-[-0.01em]">Join your agency</h1>
          <p className="text-[13px]" style={{ color: "var(--text-secondary)" }}>
            Use the email address your invitation was sent to.
          </p>
        </div>

        <form
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            void accept();
          }}
        >
          <input
            type="email" required autoComplete="email" placeholder="Work email"
            aria-label="Work email" value={email}
            onChange={(e) => setEmail(e.target.value)}
            className={inputCls} style={inputStyle}
          />
          <input
            type="password" required minLength={8}
            autoComplete={mode === "create" ? "new-password" : "current-password"}
            placeholder={mode === "create" ? "Choose a password" : "Password"}
            aria-label="Password" value={password}
            onChange={(e) => setPassword(e.target.value)}
            className={inputCls} style={inputStyle}
          />
          <button
            type="submit" disabled={busy}
            className="rounded-full px-4 py-2.5 text-[15px] font-medium text-white disabled:opacity-40"
            style={{ background: "var(--accent, #007AFF)" }}
          >
            {busy ? "Joining…" : mode === "create" ? "Create sign-in & join" : "Sign in & join"}
          </button>
          {error ? (
            <p className="text-[13px]" role="alert" style={{ color: "var(--danger, #b00020)" }}>
              {error}
            </p>
          ) : null}
        </form>

        <button
          type="button"
          className="mt-4 w-full text-center text-[13px] underline-offset-2 hover:underline"
          style={{ color: "var(--text-secondary)" }}
          onClick={() => setMode(mode === "create" ? "signin" : "create")}
        >
          {mode === "create" ? "I already have a sign-in" : "I need to create a sign-in"}
        </button>

        <p className="mt-4 text-center text-[12px]" style={{ color: "var(--text-muted)" }}>
          Next you&apos;ll set up your authenticator app — patient information stays locked
          until that&apos;s done.
        </p>
      </div>
    </main>
  );
}
