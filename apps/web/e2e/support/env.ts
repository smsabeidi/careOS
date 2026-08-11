/**
 * What the E2E suite needs, and the exact sentence it says when it does not have it.
 *
 * WHY THIS FILE EXISTS AT ALL. A Playwright suite that cannot reach its platform has two
 * dishonest options and one honest one. It can fail — and then a red CI light means
 * "somebody forgot a variable" rather than "the product is broken", which trains people
 * to ignore red. It can pass vacuously — which is worse, because a green gate that
 * asserted nothing is a lie told to whoever ships on the strength of it. Or it can SKIP,
 * naming the missing thing. This module is how the third option is implemented: every
 * spec asks it what is missing, and hands the answer to `test.skip(callback, reason)`, so
 * the run reports "skipped — NEXT_PUBLIC_SUPABASE_URL is not set" against each journey.
 *
 * Nothing here is a credential. It reads names out of `process.env` and reports which
 * ones are absent; no value is ever logged, printed, or written into a test title
 * (invariant 5 — a password in a Playwright report is a password in CI logs forever).
 *
 * @trace docs/12 §4 §7 §9, docs/17 §12
 */

/* ── Where the app under test lives ────────────────────────────────────────── */

/**
 * A dedicated port. The default deliberately avoids 3000: a developer with `next dev`
 * already running would otherwise have the suite silently drive their unbuilt working
 * copy and blame the product for it.
 */
export const DEFAULT_BASE_URL = "http://127.0.0.1:3100";

/** Set when the app is already running somewhere — staging, a preview deploy, a local dev server. */
export const EXTERNAL_BASE_URL = process.env.CAREOS_E2E_BASE_URL ?? null;

export const BASE_URL = EXTERNAL_BASE_URL ?? DEFAULT_BASE_URL;

/**
 * `next start` serves the production build, which is what a release gate should exercise
 * (docs/12 §9 — the gate ships a build, not a dev server). Override with
 * CAREOS_E2E_WEB_SERVER_CMD when you would rather drive `next dev`.
 */
export const WEB_SERVER_COMMAND =
  process.env.CAREOS_E2E_WEB_SERVER_CMD ?? `pnpm exec next start --port ${portOf(BASE_URL)}`;

/** We boot the app ourselves only when nobody handed us a running one. */
export const OWNS_WEB_SERVER = EXTERNAL_BASE_URL === null;

function portOf(url: string): string {
  try {
    const parsed = new URL(url);
    return parsed.port || (parsed.protocol === "https:" ? "443" : "80");
  } catch {
    return "3100";
  }
}

/* ── The platform: without these the app cannot authenticate or read a row ──── */

const PLATFORM_VARS = ["NEXT_PUBLIC_SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_ANON_KEY"] as const;

export const missingPlatformVars: string[] = PLATFORM_VARS.filter((name) => !process.env[name]);

export const HAS_PLATFORM = missingPlatformVars.length === 0;

/* ── The personas ───────────────────────────────────────────────────────────
 * Four seeded Meadowbrook accounts, one per capability the journeys exercise. They are
 * separate on purpose: the self-approval refusal (D-027) is only provable when the person
 * approving and the person who worked the shift can be the same principal, and the
 * "you may read but not act" states are only provable when someone holds read without act.
 * ────────────────────────────────────────────────────────────────────────── */

export type Persona = "caregiver" | "coordinator" | "payroll" | "admin" | "selfApprover";

const PERSONA_VARS: Record<Persona, { email: string; password: string }> = {
  caregiver: {
    email: "CAREOS_E2E_CAREGIVER_EMAIL",
    password: "CAREOS_E2E_CAREGIVER_PASSWORD",
  },
  coordinator: {
    email: "CAREOS_E2E_COORDINATOR_EMAIL",
    password: "CAREOS_E2E_COORDINATOR_PASSWORD",
  },
  payroll: {
    email: "CAREOS_E2E_PAYROLL_EMAIL",
    password: "CAREOS_E2E_PAYROLL_PASSWORD",
  },
  admin: {
    email: "CAREOS_E2E_ADMIN_EMAIL",
    password: "CAREOS_E2E_ADMIN_PASSWORD",
  },
  /**
   * A principal who both worked a shift and holds `visit.approve` — the only way to reach
   * the self-approval refusal (D-027) through the product rather than through pgTAP. The
   * refusal is enforced twice in the database (inside the RPC and again by a CHECK), and
   * this persona exists so the *screen's* handling of it can be proven too: a coordinator
   * who is also on the rota must be told plainly, not shown a generic failure.
   */
  selfApprover: {
    email: "CAREOS_E2E_SELF_APPROVER_EMAIL",
    password: "CAREOS_E2E_SELF_APPROVER_PASSWORD",
  },
};

/**
 * The self-approver's display name as `app_user.full_name` holds it. The timesheet queue
 * identifies a shift by the caregiver's name, so the journey needs to know which row is
 * theirs. A name, not a PHI field: a timesheet carries no client and nothing clinical.
 */
export const SELF_APPROVER_NAME = process.env.CAREOS_E2E_SELF_APPROVER_NAME ?? null;

export function missingSelfApproverVars(): string[] {
  return SELF_APPROVER_NAME ? [] : ["CAREOS_E2E_SELF_APPROVER_NAME"];
}

export type Credentials = { email: string; password: string };

/** Throws rather than returning a partial: a half-configured persona should stop the run. */
export function credentialsFor(persona: Persona): Credentials {
  const names = PERSONA_VARS[persona];
  const email = process.env[names.email];
  const password = process.env[names.password];
  if (!email || !password) {
    throw new Error(
      `The ${persona} persona is not configured. Set ${names.email} and ${names.password} ` +
        `(see apps/web/e2e/README.md). No value is read from anywhere else.`
    );
  }
  return { email, password };
}

export function missingPersonaVars(personas: Persona[]): string[] {
  return personas.flatMap((persona) => {
    const names = PERSONA_VARS[persona];
    return [names.email, names.password].filter((name) => !process.env[name]);
  });
}

/**
 * The seeded TOTP secret for the synthetic personas. Production sessions reach AAL2 with
 * a real authenticator; a headless browser cannot hold one, so an E2E tenant seeds a
 * known factor and the suite completes the genuine challenge/verify with it. AAL2 is NOT
 * bypassed — the step-up actually happens, exactly as `elevateDemoSession` does it for
 * the persona switcher (invariant 3 stands).
 *
 * Optional: an instance running with CAREOS_DEMO_MODE elevates on its own at sign-in, and
 * the suite never sees /mfa.
 */
export const TOTP_SECRET = process.env.CAREOS_E2E_TOTP_SECRET ?? null;

/* ── Geographic anchors for the clock journeys ──────────────────────────────
 * The in-fence pair must sit inside the attested pin + radius of the caregiver's first
 * visit of the day; the far pair must sit outside it. Both are supplied rather than
 * derived, because deriving them would mean reading the pin — and a coordinate never
 * leaves the database (D-030). They are synthetic-universe coordinates only.
 * ────────────────────────────────────────────────────────────────────────── */

export type Coordinate = { latitude: number; longitude: number; accuracy: number };

function coordinate(latName: string, lngName: string): Coordinate | null {
  const lat = Number.parseFloat(process.env[latName] ?? "");
  const lng = Number.parseFloat(process.env[lngName] ?? "");
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  return { latitude: lat, longitude: lng, accuracy: 12 };
}

export const IN_FENCE = coordinate("CAREOS_E2E_INFENCE_LAT", "CAREOS_E2E_INFENCE_LNG");

/**
 * Far away. Defaults to a point roughly 80 km from the in-fence anchor when only the
 * in-fence pair is configured — comfortably outside any policy tier, including `rural`
 * at its 750 m ceiling, so the refusal under test is unambiguous.
 */
export const OUT_OF_FENCE: Coordinate | null =
  coordinate("CAREOS_E2E_FAR_LAT", "CAREOS_E2E_FAR_LNG") ??
  (IN_FENCE
    ? { latitude: IN_FENCE.latitude + 0.75, longitude: IN_FENCE.longitude + 0.75, accuracy: 12 }
    : null);

export function missingGeoVars(): string[] {
  return IN_FENCE ? [] : ["CAREOS_E2E_INFENCE_LAT", "CAREOS_E2E_INFENCE_LNG"];
}

/* ── The one function every spec calls ──────────────────────────────────────── */

export type Requirement = {
  personas?: Persona[];
  /** Set on the clock journeys, which need a position the seeded fence agrees with. */
  geo?: boolean;
  /** Set on the self-approval refusal, which must be able to find its own row. */
  selfApproverName?: boolean;
};

/**
 * Everything this spec needs and does not have, as variable names — never values.
 * An empty array means "run it".
 */
export function whatIsMissing(requirement: Requirement = {}): string[] {
  return [
    ...missingPlatformVars,
    ...missingPersonaVars(requirement.personas ?? []),
    ...(requirement.geo ? missingGeoVars() : []),
    ...(requirement.selfApproverName ? missingSelfApproverVars() : []),
  ];
}

/**
 * The sentence a skipped test carries. It names the variables and points at the README,
 * so the reader of a skipped run knows precisely what to provide — and knows that nothing
 * was asserted.
 */
export function skipReason(requirement: Requirement = {}): string {
  const missing = whatIsMissing(requirement);
  if (missing.length === 0) return "";
  return (
    `NOT RUN — no CareOS platform to test against. Missing: ${missing.join(", ")}. ` +
    `This journey asserted nothing. See apps/web/e2e/README.md.`
  );
}

/** For `test.skip(callback, reason)` — evaluated at run time, so `--list` still enumerates. */
export function unavailable(requirement: Requirement = {}): () => boolean {
  return () => whatIsMissing(requirement).length > 0;
}
