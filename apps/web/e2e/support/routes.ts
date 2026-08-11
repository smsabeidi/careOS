/**
 * The surfaces this layer added, who can open each one, and on what permission.
 *
 * docs/17 §12 owes an axe pass on *every new screen*. A hand-maintained list inside each
 * spec would drift the first time somebody adds a route, so the list lives here once and
 * both a11y specs walk it.
 *
 * `heading` is the surface's own `<h1>`. The sweep waits for it, so a permission redirect
 * can never be mistaken for a clean scan: `requirePerm` sends an unauthorised reader to
 * their own home page, and axe would happily report that page as accessible while the
 * screen under test went unexamined.
 *
 * `permission` is recorded next to each route for exactly that failure. When the heading
 * never arrives, the message names the permission the persona is missing rather than
 * leaving somebody to guess.
 */

import type { Persona } from "./env";

export type Surface = {
  path: string;
  /** The page's h1 — the anchor that proves we landed on the surface itself. */
  heading: string;
  persona: Persona;
  /** The `requirePerm` gate the persona must hold, or null for an ungated surface. */
  permission: string | null;
  /** Why this surface is in the sweep, in one line, for whoever reads a failure. */
  note: string;
};

export const NEW_SURFACES: Surface[] = [
  {
    path: "/today",
    heading: "Today",
    persona: "caregiver",
    permission: null,
    note: "The caregiver's whole day and the clock control (docs/17 §7.1).",
  },
  {
    path: "/operations",
    heading: "Operations",
    persona: "coordinator",
    permission: "visit.verify.read",
    note: "Today's board — the live state of every visit (docs/17 §7.2).",
  },
  {
    path: "/operations/exceptions",
    heading: "Findings",
    persona: "coordinator",
    permission: "visit.verify.read",
    note: "The exception inbox, open tab (docs/17 §7.2, §11).",
  },
  {
    path: "/operations/exceptions?tab=decided",
    heading: "Findings",
    persona: "coordinator",
    permission: "visit.verify.read",
    note: "The exception inbox, decided tab — a different set of four states.",
  },
  {
    path: "/operations/attendance",
    heading: "Attendance",
    persona: "coordinator",
    permission: "visit.verify.read",
    note: "Who worked, measured from the clock ledger (docs/17 §7.2).",
  },
  {
    path: "/operations/evv",
    heading: "EVV records",
    persona: "coordinator",
    permission: "evv.read",
    note: "The canonical six elements and their submissions (docs/17 §4.6).",
  },
  {
    path: "/operations/workforce",
    heading: "Workforce",
    persona: "coordinator",
    permission: "workforce.read",
    note: "Deterministic workforce features (docs/17 §9).",
  },
  {
    path: "/operations/timesheets",
    heading: "Timesheets",
    persona: "payroll",
    permission: "payroll.read",
    note: "The approval surface and the payroll boundary (docs/17 §4.7).",
  },
  {
    path: "/operations/timesheets?tab=approved",
    heading: "Timesheets",
    persona: "payroll",
    permission: "payroll.read",
    note: "Approved hours — the append-only decision chain read at its head.",
  },
  {
    path: "/operations/locations",
    heading: "Places of care",
    persona: "admin",
    permission: "location.manage",
    note: "Places of care and the human attestation behind each pin (D-025).",
  },
  {
    path: "/settings/visit-policy",
    heading: "Visit policy",
    persona: "admin",
    permission: "policy.manage",
    note: "The policy editor, which only ever appends a version (docs/17 §3.4).",
  },
];

/** Grouped by persona so a sweep signs in once per role rather than once per route. */
export function surfacesByPersona(): Map<Persona, Surface[]> {
  const grouped = new Map<Persona, Surface[]>();
  for (const surface of NEW_SURFACES) {
    const list = grouped.get(surface.persona) ?? [];
    list.push(surface);
    grouped.set(surface.persona, list);
  }
  return grouped;
}

/** Every persona the sweep needs — fed straight to the skip predicate. */
export const SWEEP_PERSONAS: Persona[] = [...surfacesByPersona().keys()];

/** The sentence a failed landing prints, so nobody has to go digging for the gate. */
export function landingHint(surface: Surface): string {
  return (
    `Did not land on ${surface.path} (expected the heading "${surface.heading}"). ` +
    (surface.permission
      ? `requirePerm("${surface.permission}") redirects a reader who lacks it, so the ` +
        `${surface.persona} persona probably does not hold that permission in the seeded tenant.`
      : `The ${surface.persona} persona may not have a verified session.`)
  );
}
