/**
 * The trust assessment, rendered as EVIDENCE (ST-239, Front Door W5 · D-028).
 *
 * D-028 ratified a per-visit trust score and, in the same breath, forbade it from ever
 * driving an automated employment action. Migration 0048 makes that structural: the score
 * is a subtraction over six components, every deduction carries a machine-readable reason
 * code and the id of the row that evidences it, and nothing in the database writes a band
 * into an employment record. This component is the UI half of the same promise — it shows
 * a reviewer the arithmetic and then stops. There is no button here, no threshold, no
 * "recommended action". A person reads it and decides.
 *
 * WHY THE COMPONENTS ARE RENDERED "n of max". A bare 62 is a character assessment. "22 of
 * 35 for where the visit happened, because no location came with the clock-in" is a fact a
 * caregiver can check and, if it is wrong, dispute with a correction to the clock record.
 * The maxima are the ratified trust.v1 weight set; only `components` is persisted, so the
 * weights live here pinned to `model_version` — a snapshot from a future weight set
 * renders its numbers and says plainly that its maxima are not known to this screen
 * rather than silently measuring it against the wrong ruler.
 *
 * PHI (invariant 5, D-030): a reason is a CODE plus an id, never prose about a person and
 * never a coordinate — the database enforces both with CHECK constraints. This module
 * translates the twelve codes into English and renders nothing it was not handed.
 *
 * @trace ST-239, D-028, D-030, migration 0048, docs/17 §3.9
 */

import { Badge } from "@/components/ui";
import { IconAlert, IconCheck, IconShield } from "@/components/icons";

const AGENCY_TZ = "America/New_York";

/** The append-only snapshot, as `visit_trust_assessment` holds it (0048 §3). */
export type TrustAssessment = {
  id: string;
  visit_id: string;
  score: number;
  band: string;
  components: Record<string, number> | null;
  reasons: unknown;
  model_version: string;
  computed_at: string;
};

/** The ratified trust.v1 weight set (0048 §3): the maximum each component can earn. */
const TRUST_V1_WEIGHTS: Record<string, number> = {
  location: 35,
  time: 20,
  schedule: 15,
  identity: 15,
  device: 10,
  consistency: 5,
};

/** Component names in the words the office uses, not the column names. */
const COMPONENT_LABEL: Record<string, string> = {
  location: "Where the visit happened",
  time: "Timing",
  schedule: "On the schedule",
  identity: "Who worked it",
  device: "How it was recorded",
  consistency: "Consistency with other visits",
};

/** The order a reviewer reads them in — heaviest first, matching the weights. */
const COMPONENT_ORDER = ["location", "time", "schedule", "identity", "device", "consistency"];

/**
 * The closed trust.v1 reason vocabulary (0048 enforces all twelve with a CHECK). Every
 * code has a sentence here, so a raw code can never reach a caregiver's eyes.
 */
const REASON_WORDS: Record<string, string> = {
  "location.outside_geofence": "The clock was recorded away from the place of care",
  "location.low_accuracy": "The location reading was too imprecise to confirm",
  "location.unavailable": "No location came with the clock",
  "time.late_start": "The visit started later than it was booked",
  "time.no_clock_out": "The visit was never clocked out",
  "schedule.unscheduled": "This visit was not on the schedule",
  "identity.unassigned_caregiver": "The person who clocked was not the assigned caregiver",
  "device.offline_capture": "It was recorded offline and replayed later",
  "device.session_missing": "The clock arrived without a signed-in session",
  "consistency.impossible_travel": "The travel between this visit and the one beside it was not possible",
  "consistency.overlap": "This visit overlaps another one",
  "consistency.repeated_coordinates": "The location repeated another clock exactly",
};

const BAND: Record<string, { label: string; tone: "success" | "info" | "warning" | "danger" }> = {
  verified: { label: "Verified", tone: "success" },
  verified_with_exception: { label: "Verified, with an exception", tone: "info" },
  requires_review: { label: "Needs a human review", tone: "warning" },
  high_risk: { label: "Evidence is weak", tone: "danger" },
};

type Reason = { code: string; component: string; points: number; detail_id: string | null };

/** Read the reasons array defensively: it is jsonb, and a bad element must not blank the panel. */
function readReasons(raw: unknown): Reason[] {
  if (!Array.isArray(raw)) return [];
  const out: Reason[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const r = item as Record<string, unknown>;
    if (typeof r.code !== "string") continue;
    out.push({
      code: r.code,
      component: typeof r.component === "string" ? r.component : "",
      points: typeof r.points === "number" ? r.points : 0,
      detail_id: typeof r.detail_id === "string" ? r.detail_id : null,
    });
  }
  return out;
}

function stamp(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString("en-US", {
    timeZone: AGENCY_TZ,
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

/**
 * The disclosure a reviewer opens on a row. Native `<details>`, so it works without
 * JavaScript, is keyboard-reachable by default, and adds no client bundle to a page whose
 * only interactive islands are the decision controls.
 */
export function TrustEvidence({ assessment }: { assessment: TrustAssessment | null }) {
  if (!assessment) {
    return (
      <p className="mt-3 text-[13px] leading-relaxed" style={{ color: "var(--text-muted)" }}>
        No trust assessment has been recorded for this visit. That is not a mark against it —
        an assessment is a snapshot somebody chose to pin to the record, and the clock ledger
        and any findings on the visit stand on their own either way.
      </p>
    );
  }

  const known = assessment.model_version === "trust.v1";
  const band = BAND[assessment.band] ?? { label: assessment.band, tone: "neutral" as const };
  const components = assessment.components ?? {};
  const reasons = readReasons(assessment.reasons);
  const byComponent = new Map<string, Reason[]>();
  for (const r of reasons) {
    byComponent.set(r.component, [...(byComponent.get(r.component) ?? []), r]);
  }
  const keys = [
    ...COMPONENT_ORDER.filter((k) => k in components),
    ...Object.keys(components).filter((k) => !COMPONENT_ORDER.includes(k)),
  ];

  return (
    <details className="mt-3">
      <summary className="cursor-pointer text-[13px] font-medium">
        Show the trust assessment — {assessment.score} of 100, {band.label.toLowerCase()}
      </summary>

      <div className="card-inset mt-2 px-4 py-3">
        {/* The caption D-028 requires, stated before any number is read. */}
        <p
          className="flex items-start gap-1.5 text-[12px] font-semibold"
          style={{ color: "var(--text-secondary)" }}
        >
          <IconShield width={13} height={13} className="mt-0.5 shrink-0" />
          Evidence for a human decision — never an automated action.
        </p>
        <p className="mt-1 text-[12px] leading-relaxed" style={{ color: "var(--text-muted)" }}>
          Each part starts at full marks and loses points only for a condition that is true of a
          record somebody can open. Nothing here approves, rejects, or reports anything, and no
          score has ever changed anyone&rsquo;s pay or standing on its own.
        </p>

        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Badge tone={band.tone} icon={band.tone === "success" ? <IconCheck /> : <IconAlert />}>
            {band.label}
          </Badge>
          <span className="tabular text-[14px] font-semibold">{assessment.score} of 100</span>
          <span className="text-[12px]" style={{ color: "var(--text-muted)" }}>
            Assessed {stamp(assessment.computed_at)} · weight set {assessment.model_version}
          </span>
        </div>

        {!known && (
          <p className="mt-2 text-[12px] leading-relaxed" role="alert" style={{ color: "var(--color-warning-700)" }}>
            This snapshot was produced by a weight set this screen does not know, so the parts
            below are shown with their earned points and without a maximum. The total above is
            still the figure the database recorded.
          </p>
        )}

        <ul className="mt-3 flex flex-col gap-2.5">
          {keys.map((key) => {
            const earned = components[key];
            const max = known ? TRUST_V1_WEIGHTS[key] : undefined;
            const rs = byComponent.get(key) ?? [];
            return (
              <li key={key}>
                <p className="flex flex-wrap items-baseline gap-x-2 text-[13px]">
                  <span className="font-medium">{COMPONENT_LABEL[key] ?? key}</span>
                  <span className="tabular" style={{ color: "var(--text-secondary)" }}>
                    {typeof max === "number" ? `${earned} of ${max}` : `${earned} points`}
                  </span>
                  {typeof max === "number" && earned === max && (
                    <span className="text-[12px]" style={{ color: "var(--text-muted)" }}>
                      full marks
                    </span>
                  )}
                </p>
                {rs.length > 0 && (
                  <ul className="mt-1 flex flex-col gap-1 pl-4">
                    {rs.map((r, i) => (
                      <li
                        key={`${r.code}-${r.detail_id ?? i}`}
                        className="text-[12px] leading-relaxed"
                        style={{ color: "var(--text-muted)" }}
                      >
                        {REASON_WORDS[r.code] ?? "A condition this screen does not have words for"}
                        <span className="tabular"> ({r.points} points)</span>
                        {r.detail_id && (
                          <>
                            {" · record "}
                            <code className="text-[11px]">{r.detail_id.slice(0, 8)}</code>
                          </>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            );
          })}
        </ul>

        {reasons.length === 0 && (
          <p className="mt-2 text-[12px] leading-relaxed" style={{ color: "var(--text-muted)" }}>
            Nothing was deducted: every part of this visit&rsquo;s evidence held up.
          </p>
        )}
      </div>
    </details>
  );
}
