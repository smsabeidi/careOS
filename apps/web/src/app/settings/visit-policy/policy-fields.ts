/**
 * The eighteen settings `app.upsert_visit_policy` accepts (migration 0044, docs/17 §3.4),
 * described once so the editor, the inheritance preview and the server action cannot
 * drift apart. Keys here ARE the keys of the RPC's `p_settings` allowlist — an unknown key
 * is refused with CAREOS_BAD_SETTING rather than silently discarded, so this list is
 * load-bearing.
 *
 * Bounds mirror the table's CHECK constraints. They exist so the browser can refuse an
 * obviously impossible number before a round trip; Postgres remains the authority that
 * actually enforces them.
 *
 * Tier metre-ranges below are THIS AGENCY'S OPERATING CHOICE, not a regulatory threshold.
 * No COMAR provision and no federal EVV rule sets a geofence radius, a grace period or a
 * rounding increment — agencies set them and answer for them (docs/17 §3.4, D-017).
 */

export type PolicySettingKey =
  | "geofence_tier"
  | "geofence_radius_m"
  | "max_accuracy_m"
  | "require_clock_in_location"
  | "require_clock_out_location"
  | "allow_location_exception"
  | "early_clock_in_minutes"
  | "late_threshold_minutes"
  | "clock_out_grace_minutes"
  | "missing_clock_out_minutes"
  | "missed_visit_minutes"
  | "max_visit_minutes"
  | "require_visit_note"
  | "require_task_completion"
  | "signature_requirement"
  | "rounding_policy"
  | "overtime_weekly_minutes"
  | "impossible_travel_kmh";

export type PolicyGroupKey = "arrival" | "timing" | "documentation" | "pay" | "integrity";

export const POLICY_GROUPS: { key: PolicyGroupKey; title: string; blurb: string }[] = [
  {
    key: "arrival",
    title: "Arrival check",
    blurb:
      "How close to the place of care a clock-in has to be before CareOS calls it verified, and what happens when it cannot tell. These are the agency's operating choices — no regulation sets a distance.",
  },
  {
    key: "timing",
    title: "Timing",
    blurb:
      "The grace periods and thresholds the detection rules measure a visit against. Every one of them is arithmetic in SQL, never a judgement call (invariant 13).",
  },
  {
    key: "documentation",
    title: "Documentation",
    blurb: "What a caregiver has to leave behind before a visit counts as finished.",
  },
  {
    key: "pay",
    title: "Hours and pay",
    blurb:
      "How verified minutes become payable minutes. Rounding is applied once, at approval, and both the verified and the approved figure are kept.",
  },
  {
    key: "integrity",
    title: "Integrity checks",
    blurb: "The ceiling above which a pattern is flagged for a person to look at — never acted on automatically.",
  },
];

export type PolicyField =
  | {
      key: PolicySettingKey;
      group: PolicyGroupKey;
      kind: "int";
      label: string;
      help: string;
      unit: string;
      min: number;
      max: number;
    }
  | {
      key: PolicySettingKey;
      group: PolicyGroupKey;
      kind: "bool";
      label: string;
      help: string;
      trueLabel: string;
      falseLabel: string;
    }
  | {
      key: PolicySettingKey;
      group: PolicyGroupKey;
      kind: "enum";
      label: string;
      help: string;
      options: { value: string; label: string }[];
    };

export const POLICY_FIELDS: PolicyField[] = [
  /* ── Arrival check ── */
  {
    key: "geofence_tier",
    group: "arrival",
    kind: "enum",
    label: "Arrival tier",
    help:
      "A shorthand this agency uses for how tight the arrival check is. The ranges are our own operating bands, not requirements: strict 75–150 m, standard 150–300 m, rural 300–750 m. The radius below is what actually applies.",
    options: [
      { value: "strict", label: "Strict — dense addresses, 75–150 m band" },
      { value: "standard", label: "Standard — most homes, 150–300 m band" },
      { value: "rural", label: "Rural — long driveways and poor signal, 300–750 m band" },
      { value: "custom", label: "Custom — the radius below stands on its own" },
    ],
  },
  {
    key: "geofence_radius_m",
    group: "arrival",
    kind: "int",
    label: "Arrival radius",
    help: "How far from the recorded place of care a clock-in can be and still be called verified.",
    unit: "metres",
    min: 25,
    max: 5000,
  },
  {
    key: "max_accuracy_m",
    group: "arrival",
    kind: "int",
    label: "Usable fix quality",
    help:
      "When the phone's own margin of error is wider than this, CareOS refuses to judge the distance at all and records that it could not tell — rather than guessing and calling it an exception.",
    unit: "metres",
    min: 10,
    max: 5000,
  },
  {
    key: "require_clock_in_location",
    group: "arrival",
    kind: "bool",
    label: "Check the place at clock-in",
    help: "Whether arriving has to be checked against the place of care.",
    trueLabel: "Checked",
    falseLabel: "Not checked",
  },
  {
    key: "require_clock_out_location",
    group: "arrival",
    kind: "bool",
    label: "Check the place at clock-out",
    help: "Whether leaving has to be checked against the place of care.",
    trueLabel: "Checked",
    falseLabel: "Not checked",
  },
  {
    key: "allow_location_exception",
    group: "arrival",
    kind: "bool",
    label: "Let a caregiver ask for an exception",
    help:
      "When the check cannot be made, whether the caregiver may give a reason and continue. The visit is still recorded and the reason goes to the exception queue for a person to resolve.",
    trueLabel: "Allowed, with a reason",
    falseLabel: "Not allowed",
  },

  /* ── Timing ── */
  {
    key: "early_clock_in_minutes",
    group: "timing",
    kind: "int",
    label: "Earliest clock-in",
    help: "How far ahead of the scheduled start a caregiver may clock in.",
    unit: "minutes early",
    min: 0,
    max: 720,
  },
  {
    key: "late_threshold_minutes",
    group: "timing",
    kind: "int",
    label: "Counts as late after",
    help: "Past this point with no clock-in, the caregiver is prompted and the visit is marked late.",
    unit: "minutes",
    min: 0,
    max: 720,
  },
  {
    key: "clock_out_grace_minutes",
    group: "timing",
    kind: "int",
    label: "Clock-out grace",
    help: "How long past the scheduled end a clock-out is still treated as ordinary rather than an overrun.",
    unit: "minutes",
    min: 0,
    max: 720,
  },
  {
    key: "missing_clock_out_minutes",
    group: "timing",
    kind: "int",
    label: "Missing clock-out after",
    help:
      "Past this point with no clock-out, the caregiver is reminded; the supervisor follows. Nothing is closed automatically — a missing clock-out is corrected by a person.",
    unit: "minutes",
    min: 0,
    max: 1440,
  },
  {
    key: "missed_visit_minutes",
    group: "timing",
    kind: "int",
    label: "Counts as missed after",
    help: "Past this point with no clock-in at all, the visit is treated as missed and the supervisor is told.",
    unit: "minutes",
    min: 0,
    max: 1440,
  },
  {
    key: "max_visit_minutes",
    group: "timing",
    kind: "int",
    label: "Longest plausible visit",
    help: "A visit running past this is flagged for review rather than accepted at face value.",
    unit: "minutes",
    min: 1,
    max: 2880,
  },

  /* ── Documentation ── */
  {
    key: "require_visit_note",
    group: "documentation",
    kind: "bool",
    label: "A visit note",
    help: "Whether a note has to be left before the visit is complete.",
    trueLabel: "Required",
    falseLabel: "Not required",
  },
  {
    key: "require_task_completion",
    group: "documentation",
    kind: "bool",
    label: "Tasks marked off",
    help: "Whether the care-plan tasks have to be marked before the visit is complete.",
    trueLabel: "Required",
    falseLabel: "Not required",
  },
  {
    key: "signature_requirement",
    group: "documentation",
    kind: "enum",
    label: "Signature",
    help: "Whether the visit is signed for, and by whose rule.",
    options: [
      { value: "none", label: "Not asked for" },
      { value: "optional", label: "Offered, not required" },
      { value: "required_for_service", label: "Required — this agency's rule for this service" },
      { value: "required_for_payer", label: "Required — the payer's rule" },
    ],
  },

  /* ── Hours and pay ── */
  {
    key: "rounding_policy",
    group: "pay",
    kind: "enum",
    label: "Rounding",
    help:
      "Applied once, when hours are approved. The verified minutes are always kept beside the approved minutes, so the two can never be confused for one another.",
    options: [
      { value: "none", label: "None — approved minutes are the verified minutes" },
      { value: "nearest_1", label: "Nearest minute" },
      { value: "nearest_5", label: "Nearest 5 minutes" },
      { value: "nearest_6", label: "Nearest 6 minutes (a tenth of an hour)" },
      { value: "nearest_15", label: "Nearest 15 minutes" },
    ],
  },
  {
    key: "overtime_weekly_minutes",
    group: "pay",
    kind: "int",
    label: "Overtime begins after",
    help: "Weekly approved minutes past this point are computed as overtime. 2400 minutes is 40 hours.",
    unit: "minutes a week",
    min: 0,
    max: 10080,
  },

  /* ── Integrity ── */
  {
    key: "impossible_travel_kmh",
    group: "integrity",
    kind: "int",
    label: "Implausible travel speed",
    help:
      "Two clock-ins that would need a higher average speed between them than this raise an exception for a person to look at. It is a prompt to check, never a conclusion about anybody.",
    unit: "km/h",
    min: 1,
    max: 2000,
  },
];

/** The shape a `visit_policy` row exposes for the settings this editor owns. */
export type PolicyValues = Record<PolicySettingKey, string | number | boolean>;

/**
 * The column defaults from migration 0044, used for ONE thing: pre-filling the form when
 * this agency has no policy at all yet, so the first save is a review of real numbers
 * rather than eighteen blank boxes.
 *
 * These are not a fallback anywhere else on this screen. When a policy exists, every
 * displayed value comes from the stored row. `app.seed_visit_policy` — not this constant —
 * is what actually lays the agency floor inside `app.upsert_visit_policy`.
 */
export const POLICY_BASELINE: PolicyValues = {
  geofence_tier: "standard",
  geofence_radius_m: 200,
  max_accuracy_m: 250,
  require_clock_in_location: true,
  require_clock_out_location: true,
  allow_location_exception: true,
  early_clock_in_minutes: 15,
  late_threshold_minutes: 7,
  clock_out_grace_minutes: 10,
  missing_clock_out_minutes: 20,
  missed_visit_minutes: 60,
  max_visit_minutes: 900,
  require_visit_note: false,
  require_task_completion: false,
  signature_requirement: "none",
  rounding_policy: "none",
  overtime_weekly_minutes: 2400,
  impossible_travel_kmh: 120,
};

/** One value, rendered the way a coordinator reads it (never a bare enum token). */
export function displayPolicyValue(field: PolicyField, value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (field.kind === "bool") return value === true ? field.trueLabel : field.falseLabel;
  if (field.kind === "enum") {
    const opt = field.options.find((o) => o.value === value);
    // Take the words before the em dash: the long form belongs in the help text.
    return opt ? opt.label.split(" — ")[0] : String(value);
  }
  return `${value} ${field.unit}`;
}
