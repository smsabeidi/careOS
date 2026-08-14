/**
 * The attention queue's severity mapping — ONE table, and the only place severity is
 * decided (ST-238, Front Door W5).
 *
 * WHY A TABLE AND NOT A JUDGEMENT. Six sources feed one queue. If each lane invented its
 * own idea of "urgent" at the point of rendering, the queue's ordering would be an
 * emergent property of six unrelated files, and the first person to ask "why is this
 * above that?" would get six different answers. The design plan makes the per-source
 * mapping an acceptance criterion for exactly this reason
 * (docs/designs/intelligent-front-door.md W5: "Per-source severity mapping table is an
 * AC"). So it lives here, as data, exported once, readable by a person who does not read
 * TypeScript, and covered by its own unit test.
 *
 * DETERMINISTIC, NOT PROBABILISTIC (invariant 13). Nothing in this module asks a model
 * anything. Two of the six lanes are graded, and both grade on a value POSTGRES already
 * computed — `visit_exception.severity` and the credential engine's `days_to_expiry` —
 * so the queue never re-derives a deadline or re-judges a finding. It reads a column and
 * looks it up here.
 *
 * WORDS, NEVER COLOUR ALONE (D-012). Every severity carries `SEVERITY_WORD`; a chip that
 * renders the colour without the word is a bug, and the Playwright journey asserts the
 * word.
 *
 * @trace ST-238, docs/designs/intelligent-front-door.md W5 + T14, invariant 13, D-012
 */

/** The six lanes, matching the closed `alert_ack.source` CHECK in migration 0054. */
export type AttentionSource =
  | "proposal"
  | "credential"
  | "exception"
  | "clinical"
  | "notification"
  | "offer";

export type AttentionSeverity = "critical" | "warning" | "info";

/**
 * A lane's rule: one severity for the whole lane, or a grade looked up on a value the
 * database already decided. `otherwise` is not a fallback for laziness — it is the answer
 * for a grade a future migration adds, and it is deliberately never quieter than the
 * grades above it, so a new enum value cannot arrive silently at the bottom of the queue.
 */
export type SeverityRule =
  | { readonly fixed: AttentionSeverity }
  | {
      readonly graded: Readonly<Record<string, AttentionSeverity>>;
      readonly otherwise: AttentionSeverity;
    };

/**
 * THE MAPPING. Source → severity, per the W5 acceptance criterion.
 *
 *  - `proposal` — a drafted action waiting on a person. Inert until disposed (nothing is
 *    sent, saved to a chart or acted on), so it is not Critical; but the whole premise of
 *    this inbox is that a person decides, so it is not merely informational either.
 *  - `credential` — the 60/30/0 ladder, graded on the deterministic expiry engine
 *    (migration 0008 `credential_expiry`). At or past the expiry date the credential
 *    blocks scheduling, which the database enforces on its own — that is Critical because
 *    it is already changing what the agency can roster, not because someone is worried.
 *  - `exception` — graded on `visit_exception.severity` (0047). Critical stays Critical
 *    (an unresolved critical finding blocks hours approval in the database); everything
 *    else is a Warning, because a finding nobody has disposed of is not information.
 *  - `clinical` — Critical outright, as the W5 criterion states. The flag's own severity
 *    still travels in the row's words; the queue does not triage a finding about a
 *    person's condition below the top lane, and over-surfacing one is the safe direction.
 *  - `notification` — an in-app nudge that has already been rendered PHI-free by its
 *    template. Information.
 *  - `offer` — a shift offer awaiting a reply. It expires on its own; nothing is lost by
 *    reading it after the criticals. Information.
 */
export const SOURCE_SEVERITY: Readonly<Record<AttentionSource, SeverityRule>> = {
  proposal: { fixed: "warning" },
  credential: {
    graded: { lapsed: "critical", due_30: "warning", due_60: "info" },
    otherwise: "warning",
  },
  exception: {
    graded: { critical: "critical", warning: "warning", info: "warning" },
    otherwise: "warning",
  },
  clinical: { fixed: "critical" },
  notification: { fixed: "info" },
  offer: { fixed: "info" },
};

/** The one reader of the table above. `grade` is ignored by a fixed lane, by design. */
export function severityFor(source: AttentionSource, grade?: string | null): AttentionSeverity {
  const rule = SOURCE_SEVERITY[source];
  if ("fixed" in rule) return rule.fixed;
  if (!grade) return rule.otherwise;
  return rule.graded[grade] ?? rule.otherwise;
}

/* ── The credential ladder, as a pure function of a number Postgres computed ──── */

export type CredentialRung = "lapsed" | "due_30" | "due_60";

/**
 * Which rung of the 60/30/0 ladder a credential sits on, or `null` when it is not on the
 * ladder at all and belongs nowhere near this queue.
 *
 * `days` is `credential_expiry.days_to_expiry` — `expires_on - current_date`, computed in
 * SQL. Zero means "expires today": the credential is still valid this minute and lapsed
 * tomorrow, which is the 0-day rung and is treated as Critical. This function never
 * computes a date; it buckets one.
 */
export function credentialRung(days: number | null | undefined): CredentialRung | null {
  if (days === null || days === undefined || !Number.isFinite(days)) return null;
  if (days <= 0) return "lapsed";
  if (days <= 30) return "due_30";
  if (days <= 60) return "due_60";
  return null;
}

/* ── Words. A status is never a colour on this surface (D-012). ───────────────── */

export const SEVERITY_WORD: Readonly<Record<AttentionSeverity, string>> = {
  critical: "Critical",
  warning: "Warning",
  info: "For information",
};

/** Chip tone. Paired with the word above, never rendered alone. */
export const SEVERITY_TONE: Readonly<Record<AttentionSeverity, "danger" | "warning" | "neutral">> = {
  critical: "danger",
  warning: "warning",
  info: "neutral",
};

/** Sort key: Critical first, then Warning, then information. Ties break on age. */
export const SEVERITY_RANK: Readonly<Record<AttentionSeverity, number>> = {
  critical: 0,
  warning: 1,
  info: 2,
};

/** What each lane is called in front of a coordinator — never the table name. */
export const SOURCE_LABEL: Readonly<Record<AttentionSource, string>> = {
  proposal: "Approval",
  credential: "Credential",
  exception: "Visit finding",
  clinical: "Clinical flag",
  notification: "Notification",
  offer: "Shift offer",
};
