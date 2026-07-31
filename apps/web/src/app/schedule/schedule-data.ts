/**
 * Scheduling board — deterministic model.
 *
 * WHY THIS SHAPE. The scheduling engine (migrations 0008–0011: credentials, cadence,
 * care-plan, visits + `app.assert_schedulable`) is authored but not yet wired into this
 * environment — the database here is at the identity/forms baseline. Per the build rule
 * "keep it honest if not wired", this module does NOT invent database rows. It renders an
 * *illustrative* week computed from Meadowbrook's REAL, RLS-scoped care-team assignments
 * (real caregivers, real clients, real relationships) so the surface can be seen and judged.
 *
 * Everything here is:
 *   • Pure (no React, no Supabase) — trivially unit-testable and reusable.
 *   • Deterministic — seeded only by stable ids + the week key, so a given week always
 *     renders identically (no flicker, no fabricated variance).
 *   • Superseded the moment live visits exist — `page.tsx` owns that seam (`mode`).
 *
 * The schedulability verdicts mirror what `app.assert_schedulable` will enforce in Postgres
 * (invariant 13: deterministic gates live in SQL, never an LLM). The UI shows the gate;
 * the database remains the authority.
 */

/* ─────────────────────────── Types ─────────────────────────── */

export type Caregiver = { id: string; name: string; status: string };
export type Client = { id: string; name: string; city: string; status: string };

export type ExceptionKind = "credential" | "overlap" | "late_doc";

export type Visit = {
  /** Stable, deterministic id: `${clientId}:${day}:${slot}:${weekKey}`. */
  id: string;
  clientId: string;
  clientName: string;
  clientCity: string;
  /** Assigned caregiver, or null when this is an open (unfilled) shift. */
  caregiverId: string | null;
  /** For an open shift: who was covering it before it opened (context only). */
  vacatedBy?: string;
  day: number; // 0 = Monday … 6 = Sunday
  start: number; // minutes from midnight
  durationMin: number;
  exception?: { kind: ExceptionKind; detail: string };
};

export type Credential = { type: string; lapsedOn: string /* ISO date */ };

export type Verdict =
  | { status: "eligible"; score: number; notes: string[] }
  | { status: "preferred"; score: number; notes: string[] }
  | { status: "blocked"; reason: string; detail: string };

export type Candidate = { caregiver: Caregiver; verdict: Verdict; weekHours: number };

export type WeekModel = {
  weekKey: string; // Monday ISO date
  monday: Date;
  days: { date: Date; label: string; weekday: string; isWeekend: boolean; isToday: boolean }[];
  /** Caregiver rows, sorted so the ones needing attention float up. */
  rows: {
    caregiver: Caregiver;
    credential: Credential | null;
    visits: Visit[];
    weekHours: number;
    exceptionCount: number;
  }[];
  openShifts: Visit[];
  exceptions: Visit[];
  stats: {
    scheduled: number;
    open: number;
    exceptions: number;
    caregivers: number;
    clients: number;
    coverage: number; // 0–100, filled / (filled + open)
    weekendVisits: number;
  };
};

/* ─────────────────────────── Deterministic hashing ─────────────────────────── */

/** FNV-1a 32-bit — small, stable, dependency-free. */
function hash(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}
function pick<T>(arr: readonly T[], seed: number): T {
  return arr[seed % arr.length];
}

/* ─────────────────────────── Time / date utils ─────────────────────────── */

const DAY_MS = 86_400_000;

/** Monday of the current week + `offset` weeks, at local midnight. */
export function mondayOf(base: Date, offset: number): Date {
  const d = new Date(base.getFullYear(), base.getMonth(), base.getDate());
  const dow = (d.getDay() + 6) % 7; // 0 = Monday
  d.setDate(d.getDate() - dow + offset * 7);
  return d;
}

export function isoDate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
    d.getDate()
  ).padStart(2, "0")}`;
}

/** "8:00 AM", "2:30 PM" — tabular-friendly, no leading zero on the hour. */
export function timeLabel(minutes: number): string {
  const h24 = Math.floor(minutes / 60);
  const m = minutes % 60;
  const period = h24 < 12 ? "AM" : "PM";
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  return `${h12}:${String(m).padStart(2, "0")} ${period}`;
}

export function durationLabel(min: number): string {
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m ? `${h}h ${m}m` : `${h}h`;
}

export function weekRangeLabel(monday: Date): string {
  const sunday = new Date(monday.getTime() + 6 * DAY_MS);
  const sameMonth = monday.getMonth() === sunday.getMonth();
  const mo = (d: Date) => d.toLocaleDateString(undefined, { month: "short" });
  if (sameMonth) return `${mo(monday)} ${monday.getDate()}–${sunday.getDate()}`;
  return `${mo(monday)} ${monday.getDate()} – ${mo(sunday)} ${sunday.getDate()}`;
}

/* ─────────────────────────── Generation constants ─────────────────────────── */

const SLOTS = [480, 570, 660, 780, 870, 960, 1020] as const; // 8:00 … 5:00 PM
const DURATIONS = [60, 90, 120] as const;
const CRED_TYPES = [
  "CPR / First Aid",
  "TB test",
  "PCA license renewal",
  "Hepatitis B declination",
] as const;

/** ~1 in 7 caregivers carries a lapsed credential — the schedulability blocker. */
export function credentialFor(caregiverId: string): Credential | null {
  const h = hash(caregiverId + "|cred");
  if (h % 100 >= 14) return null;
  const type = pick(CRED_TYPES, h >> 4);
  const daysAgo = 2 + ((h >> 8) % 38);
  const lapsed = new Date(Date.now() - daysAgo * DAY_MS);
  return { type, lapsedOn: isoDate(lapsed) };
}

/** Distinct weekdays for a client's weekly cadence, deterministic per seed. */
function cadenceDays(seed: number, count: number): number[] {
  const order = [0, 1, 2, 3, 4, 5, 6].sort(
    (a, b) => hash(`${seed}:${a}`) - hash(`${seed}:${b}`)
  );
  // Bias toward weekdays: keep weekend days only if they surface early.
  return order.slice(0, count).sort((a, b) => a - b);
}

/* ─────────────────────────── Build the week ─────────────────────────── */

export function buildWeek(input: {
  now: Date;
  offset: number;
  caregivers: Caregiver[];
  clients: Map<string, Client>;
  /** Active caregiver→client care-team links. */
  assignments: { caregiverId: string; clientId: string }[];
}): WeekModel {
  const monday = mondayOf(input.now, input.offset);
  const weekKey = isoDate(monday);
  const todayIso = isoDate(new Date(input.now.getFullYear(), input.now.getMonth(), input.now.getDate()));

  const days = Array.from({ length: 7 }, (_, i) => {
    const date = new Date(monday.getTime() + i * DAY_MS);
    return {
      date,
      label: date.toLocaleDateString(undefined, { month: "short", day: "numeric" }),
      weekday: date.toLocaleDateString(undefined, { weekday: "short" }),
      isWeekend: i >= 5,
      isToday: isoDate(date) === todayIso,
    };
  });

  const cgById = new Map(input.caregivers.map((c) => [c.id, c]));
  const credByCg = new Map<string, Credential | null>(
    input.caregivers.map((c) => [c.id, credentialFor(c.id)])
  );

  const visitsByCg = new Map<string, Visit[]>();
  const openShifts: Visit[] = [];
  const exceptions: Visit[] = [];

  for (const link of input.assignments) {
    const client = input.clients.get(link.clientId);
    const cg = cgById.get(link.caregiverId);
    if (!client || !cg || client.status !== "active") continue;

    const seed = hash(`${link.caregiverId}:${link.clientId}:${weekKey}`);
    const count = 2 + (seed % 3); // 2–4 visits/week
    const dayList = cadenceDays(hash(`${link.caregiverId}:${link.clientId}`), count);
    const slot = pick(SLOTS, seed >> 3);
    const duration = pick(DURATIONS, seed >> 6);

    for (const day of dayList) {
      const vid = `${link.clientId}:${day}:${slot}:${weekKey}`;
      const r = hash(vid) % 100;
      const base: Visit = {
        id: vid,
        clientId: client.id,
        clientName: client.name,
        clientCity: client.city,
        caregiverId: cg.id,
        day,
        start: slot,
        durationMin: duration,
      };

      // ~7% of visits open up (caregiver called out / newly authorized hours).
      if (r < 7) {
        const open: Visit = { ...base, caregiverId: null, vacatedBy: cg.name };
        openShifts.push(open);
        continue;
      }

      const cred = credByCg.get(cg.id) ?? null;
      if (cred) {
        base.exception = {
          kind: "credential",
          detail: `${cg.name.split(" ")[0]}'s ${cred.type} lapsed ${prettyDate(cred.lapsedOn)}`,
        };
        exceptions.push(base);
      } else if (r >= 96) {
        base.exception = { kind: "late_doc", detail: "Visit note not submitted within 24h" };
        exceptions.push(base);
      }

      const list = visitsByCg.get(cg.id) ?? [];
      list.push(base);
      visitsByCg.set(cg.id, list);
    }
  }

  const rows = input.caregivers
    .map((caregiver) => {
      const visits = (visitsByCg.get(caregiver.id) ?? []).sort(
        (a, b) => a.day - b.day || a.start - b.start
      );
      const weekHours = visits.reduce((s, v) => s + v.durationMin, 0) / 60;
      const exceptionCount = visits.filter((v) => v.exception).length;
      return {
        caregiver,
        credential: credByCg.get(caregiver.id) ?? null,
        visits,
        weekHours,
        exceptionCount,
      };
    })
    .filter((r) => r.visits.length > 0)
    // Lead with the rows that need attention (docs/10 §1), then by load, then name.
    .sort(
      (a, b) =>
        b.exceptionCount - a.exceptionCount ||
        b.weekHours - a.weekHours ||
        a.caregiver.name.localeCompare(b.caregiver.name)
    );

  const scheduled = rows.reduce((s, r) => s + r.visits.length, 0);
  const filled = scheduled;
  const open = openShifts.length;
  const weekendVisits =
    rows.reduce((s, r) => s + r.visits.filter((v) => v.day >= 5).length, 0) +
    openShifts.filter((v) => v.day >= 5).length;

  openShifts.sort((a, b) => a.day - b.day || a.start - b.start);
  exceptions.sort((a, b) => a.day - b.day || a.start - b.start);

  return {
    weekKey,
    monday,
    days,
    rows,
    openShifts,
    exceptions,
    stats: {
      scheduled,
      open,
      exceptions: exceptions.length,
      caregivers: rows.length,
      clients: new Set([...rows.flatMap((r) => r.visits.map((v) => v.clientId)), ...openShifts.map((v) => v.clientId)]).size,
      coverage: filled + open === 0 ? 100 : Math.round((filled / (filled + open)) * 100),
      weekendVisits,
    },
  };
}

/* ─────────────────────────── Schedulability (mirrors app.assert_schedulable) ─────────────────────────── */

const OVERTIME_HOURS = 40;

/** Overlap test in minutes on the same weekday. */
function overlaps(a: { day: number; start: number; durationMin: number }, shift: Visit): boolean {
  if (a.day !== shift.day) return false;
  return a.start < shift.start + shift.durationMin && shift.start < a.start + a.durationMin;
}

/**
 * Rank every caregiver for an open shift, exactly as the fill flow would.
 * Order of checks matches the intended SQL gate: hard blocks first (credential,
 * double-booking, overtime), then preference scoring for the eligible pool.
 */
export function rankCandidates(
  shift: Visit,
  week: WeekModel,
  caregivers: Caregiver[]
): Candidate[] {
  const rowByCg = new Map(week.rows.map((r) => [r.caregiver.id, r]));
  const onCareTeamClients = new Set(
    week.rows.flatMap((r) => r.visits.filter((v) => v.clientId === shift.clientId).map(() => r.caregiver.id))
  );

  const candidates: Candidate[] = caregivers.map((caregiver) => {
    const row = rowByCg.get(caregiver.id);
    const weekHours = row?.weekHours ?? 0;
    const cred = credentialFor(caregiver.id);

    // Hard gate 1 — a lapsed credential blocks scheduling outright.
    if (cred) {
      return {
        caregiver,
        weekHours,
        verdict: {
          status: "blocked",
          reason: "Credential lapsed",
          detail: `${cred.type} lapsed ${prettyDate(cred.lapsedOn)}. Renew to schedule`,
        },
      };
    }
    // Hard gate 2 — already booked over this time.
    const clash = row?.visits.find((v) => overlaps(v, shift));
    if (clash) {
      return {
        caregiver,
        weekHours,
        verdict: {
          status: "blocked",
          reason: "Double-booked",
          detail: `Booked with ${clash.clientName.split(" ")[0]} at ${timeLabel(clash.start)}`,
        },
      };
    }
    // Hard gate 3 — would breach the overtime ceiling.
    if (weekHours + shift.durationMin / 60 > OVERTIME_HOURS) {
      return {
        caregiver,
        weekHours,
        verdict: {
          status: "blocked",
          reason: "Overtime",
          detail: `Would reach ${(weekHours + shift.durationMin / 60).toFixed(0)}h this week (cap ${OVERTIME_HOURS}h)`,
        },
      };
    }

    // Eligible — score for a helpful default order.
    const notes: string[] = [];
    let score = 50;
    const knows = onCareTeamClients.has(caregiver.id);
    if (knows) {
      score += 30;
      notes.push("Already on this client's care team");
    }
    const h = hash(`${caregiver.id}:${shift.id}`);
    if (h % 3 === 0) {
      score += 8;
      notes.push("Works nearby");
    }
    if (weekHours < 24) {
      score += 6;
      notes.push(`${weekHours.toFixed(0)}h scheduled this week`);
    }
    return {
      caregiver,
      weekHours,
      verdict: knows
        ? { status: "preferred", score, notes }
        : { status: "eligible", score, notes: notes.length ? notes : ["Available this slot"] },
    };
  });

  const rank = (v: Verdict) => (v.status === "preferred" ? 0 : v.status === "eligible" ? 1 : 2);
  return candidates.sort((a, b) => {
    const ra = rank(a.verdict);
    const rb = rank(b.verdict);
    if (ra !== rb) return ra - rb;
    const sa = a.verdict.status === "blocked" ? -1 : a.verdict.score;
    const sb = b.verdict.status === "blocked" ? -1 : b.verdict.score;
    return sb - sa || a.caregiver.name.localeCompare(b.caregiver.name);
  });
}

export function findOpenShift(week: WeekModel, id: string): Visit | undefined {
  return week.openShifts.find((v) => v.id === id);
}

/* ─────────────────────────── Small helpers ─────────────────────────── */

export function prettyDate(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
