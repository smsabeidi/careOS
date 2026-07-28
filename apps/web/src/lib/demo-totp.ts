/**
 * Demo-only MFA auto-elevation (LOCAL / synthetic universe only).
 *
 * The persona demo accounts carry a real, verified TOTP factor seeded with a known
 * secret (supabase/seeds/demo_users.sql). In demo mode we complete the genuine MFA
 * challenge/verify on their behalf so the session reaches AAL2 and PHI-gated RLS
 * (app.is_aal2()) opens exactly as it does for a real verified session — no invariant
 * is weakened, the step-up is just automated for a synthetic account. This code is inert
 * unless CAREOS_DEMO_MODE / NEXT_PUBLIC_CAREOS_DEMO_MODE is "true".
 *
 * The secret is a synthetic demo secret; exposing it is harmless (it only unlocks the
 * synthetic Meadowbrook accounts on a local instance).
 */
import type { SupabaseClient } from "@supabase/supabase-js";

export const DEMO_TOTP_SECRET = "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP";

const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

function base32decode(s: string): ArrayBuffer {
  let bits = "";
  for (const c of s.replace(/=+$/, "").toUpperCase()) {
    const v = B32.indexOf(c);
    if (v < 0) continue;
    bits += v.toString(2).padStart(5, "0");
  }
  const bytes: number[] = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));
  return new Uint8Array(bytes).buffer as ArrayBuffer;
}

/** RFC 6238 TOTP (SHA-1, 6 digits, 30s) via Web Crypto — works in the browser and Node. */
export async function totp(secret: string, tMs: number = Date.now()): Promise<string> {
  const counter = Math.floor(tMs / 1000 / 30);
  const buf = new ArrayBuffer(8);
  new DataView(buf).setBigInt64(0, BigInt(counter), false);
  const key = await crypto.subtle.importKey(
    "raw",
    base32decode(secret),
    { name: "HMAC", hash: "SHA-1" },
    false,
    ["sign"]
  );
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, buf));
  const o = sig[sig.length - 1] & 0xf;
  const code =
    ((sig[o] & 0x7f) << 24) | ((sig[o + 1] & 0xff) << 16) | ((sig[o + 2] & 0xff) << 8) | (sig[o + 3] & 0xff);
  return String(code % 1_000_000).padStart(6, "0");
}

/** Complete the seeded persona's MFA challenge to reach AAL2. Best-effort; no-op on failure. */
export async function elevateDemoSession(supabase: SupabaseClient): Promise<boolean> {
  try {
    const { data: factors } = await supabase.auth.mfa.listFactors();
    const totpFactors = (factors?.totp ?? []) as { id: string; factor_type: string }[];
    const factor = totpFactors[0];
    if (!factor) return false;
    const { data: ch, error: ce } = await supabase.auth.mfa.challenge({ factorId: factor.id });
    if (ce || !ch) return false;
    const code = await totp(DEMO_TOTP_SECRET);
    const { error: ve } = await supabase.auth.mfa.verify({ factorId: factor.id, challengeId: ch.id, code });
    return !ve;
  } catch {
    return false;
  }
}
