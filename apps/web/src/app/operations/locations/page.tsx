import Link from "next/link";
import type { ReactNode } from "react";
import { AppShell } from "@/components/shell";
import { Badge, EmptyState, ErrorState, MetricTile, PageHeader, SectionTitle } from "@/components/ui";
import {
  IconAlert,
  IconCheck,
  IconHistory,
  IconHome,
  IconLock,
  IconMapPin,
  IconPen,
  IconPlus,
  IconShield,
} from "@/components/icons";
import { supabaseServer } from "@/lib/supabase/server";
import { requirePerm } from "@/lib/profile";
import { LocationForm } from "./location-form";
import {
  createServiceLocation,
  reviseServiceLocation,
  setLocationGeofence,
  verifyServiceLocation,
} from "./actions";
import { formatCoordinate, readPoint } from "./geo";

export const metadata = { title: "Places of care" };
export const dynamic = "force-dynamic";

/**
 * Service locations — docs/17 §3.2, §3.3, §6.1, decision D-025.
 *
 * A place of care has an identity (`service_location`) and a history of what it actually
 * WAS (`service_location_version`). The version is the geographic source of truth and is
 * append-only: revising an address writes a new version pointing at the old one, and the
 * old one keeps its pin and its attestation, because a visit already bound to it has to
 * keep meaning what it meant (invariant 1, the D-014 binding precedent).
 *
 * **D-025 — a coordinate arrives only by human attestation.** No geocoding provider puts a
 * pin on a map in CareOS. A coordinator reads the address, decides where it is, and signs
 * for it; `app.verify_service_location` records their id and the moment. A revised address
 * therefore starts unverified with no pin at all — a person attested to the old address,
 * not this one. That is why "Confirm this pin" is worded as a signature and not as a save.
 *
 * **Why coordinates are visible here and nowhere else.** D-030 keeps latitude, longitude
 * and distance off every other surface: an operations board shows a bucket, a caregiver
 * sees plain words, telemetry sees neither. This screen is the exception because the
 * coordinate IS the thing being attested to — you cannot ask someone to confirm a pin they
 * are not allowed to look at. It is shown to `location.manage` holders on an AAL2 session,
 * and it leaves through no other door.
 *
 * PHI: addresses and client names. Everything renders on the server; the only client code
 * is the form shell, which holds submission state and nothing else.
 */

const AGENCY_TZ = "America/New_York";

const KIND_OPTIONS: { value: string; label: string }[] = [
  { value: "primary_residence", label: "Primary home" },
  { value: "temporary_residence", label: "Temporary home" },
  { value: "family_residence", label: "A family member's home" },
  { value: "community", label: "In the community" },
  { value: "facility", label: "A facility" },
  { value: "alternate", label: "Another address" },
];
const KIND_LABEL = new Map(KIND_OPTIONS.map((k) => [k.value, k.label]));

/**
 * How exact the pin is, said in words a coordinator can actually judge. The stored
 * vocabulary is the geocoding trade's (`rooftop`, `parcel`, `interpolated`…); this is what
 * each one means when a person is the one deciding.
 */
const PRECISION_OPTIONS: { value: string; label: string }[] = [
  { value: "rooftop", label: "On the building itself" },
  { value: "parcel", label: "On the property" },
  { value: "street", label: "On the street, not the building" },
  { value: "interpolated", label: "Estimated along the street" },
  { value: "locality", label: "The town only — not the address" },
  { value: "manual", label: "Placed by hand from the map" },
  { value: "unknown", label: "Not sure" },
];
const PRECISION_LABEL = new Map(PRECISION_OPTIONS.map((p) => [p.value, p.label]));

const SOURCE_LABEL: Record<string, string> = {
  manual: "placed by a person",
  import: "brought in with the client record",
  provider: "supplied by an address service",
  derived: "worked out from other records",
};

/* ── Row shapes (explicit columns only; never select(*)) ───────────────────── */

type LocationRow = {
  id: string;
  client_id: string;
  current_version_id: string | null;
  kind: string;
  label: string | null;
  is_primary: boolean;
  effective_from: string;
  effective_until: string | null;
  active: boolean;
  created_by: string;
  created_at: string;
  updated_at: string;
};

type VersionRow = {
  id: string;
  service_location_id: string;
  supersedes_id: string | null;
  created_by: string;
  version_no: number;
  original_address: string;
  address_line1: string | null;
  address_line2: string | null;
  city: string | null;
  state: string | null;
  postal_code: string | null;
  country: string;
  geo: unknown;
  geo_precision: string;
  geo_source: string;
  verification: string;
  verified_by: string | null;
  verified_at: string | null;
  geofence_radius_m: number | null;
  change_reason: string | null;
  created_at: string;
};

/**
 * How many ids may ride in one `.in()` filter. PostgREST takes the list in the query
 * string, so the cap is a URL length, not a row count: 40 UUIDs plus this column list sits
 * comfortably inside the 8 KB a proxy will carry, where 200 did not.
 */
const ID_BATCH = 40;

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

const VERSION_COLUMNS =
  "id, service_location_id, supersedes_id, created_by, version_no, original_address, " +
  "address_line1, address_line2, city, state, postal_code, country, geo, geo_precision, " +
  "geo_source, verification, verified_by, verified_at, geofence_radius_m, change_reason, created_at";

type ClientRow = { id: string; first_name: string; last_name: string; status: string };

/* ── Helpers ───────────────────────────────────────────────────────────────── */

function fmtStamp(value: string | null | undefined): string {
  if (!value) return "—";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString("en-US", {
    timeZone: AGENCY_TZ,
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function Disclosure({ summary, children }: { summary: string; children: ReactNode }) {
  return (
    <details className="mt-3 border-t pt-3 hairline">
      <summary className="cursor-pointer list-none text-[13px] font-medium" style={{ color: "var(--accent-text)" }}>
        {summary}
      </summary>
      <div className="mt-3">{children}</div>
    </details>
  );
}

/** The six address parts, server-rendered. Used by both the add and the revise forms. */
function AddressFields({ version, idPrefix }: { version?: VersionRow; idPrefix: string }) {
  const f = (name: string) => `${idPrefix}_${name}`;
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <div className="sm:col-span-2">
        <label className="label" htmlFor={f("line1")}>
          Street
        </label>
        <input
          id={f("line1")}
          name="line1"
          required
          maxLength={200}
          defaultValue={version?.address_line1 ?? ""}
          autoComplete="off"
          className="input"
        />
      </div>
      <div className="sm:col-span-2">
        <label className="label" htmlFor={f("line2")}>
          Apartment, unit or floor (optional)
        </label>
        <input
          id={f("line2")}
          name="line2"
          maxLength={200}
          defaultValue={version?.address_line2 ?? ""}
          autoComplete="off"
          className="input"
        />
      </div>
      <div>
        <label className="label" htmlFor={f("city")}>
          City
        </label>
        <input id={f("city")} name="city" maxLength={120} defaultValue={version?.city ?? ""} className="input" />
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="label" htmlFor={f("state")}>
            State
          </label>
          <input
            id={f("state")}
            name="state"
            maxLength={40}
            defaultValue={version?.state ?? "MD"}
            className="input"
          />
        </div>
        <div>
          <label className="label" htmlFor={f("postal_code")}>
            ZIP
          </label>
          <input
            id={f("postal_code")}
            name="postal_code"
            maxLength={20}
            defaultValue={version?.postal_code ?? ""}
            className="input tabular"
          />
        </div>
      </div>
      <input type="hidden" name="country" value={version?.country ?? "US"} />
    </div>
  );
}

/* ── Page ──────────────────────────────────────────────────────────────────── */

export default async function LocationsPage({
  searchParams,
}: {
  searchParams: Promise<{ client?: string }>;
}) {
  const params = await searchParams;
  const clientFilter = typeof params.client === "string" && params.client.trim() ? params.client.trim() : null;

  await requirePerm("location.manage");
  const supabase = await supabaseServer();

  let locationQuery = supabase
    .from("service_location")
    .select(
      "id, client_id, current_version_id, kind, label, is_primary, effective_from, " +
        "effective_until, active, created_by, created_at, updated_at"
    )
    .order("created_at", { ascending: false })
    .limit(200);
  if (clientFilter) locationQuery = locationQuery.eq("client_id", clientFilter);

  const [locationRes, pickerRes] = await Promise.all([
    locationQuery,
    supabase
      .from("client")
      .select("id, first_name, last_name, status")
      .order("last_name", { ascending: true })
      .limit(300),
  ]);

  const header = (
    <PageHeader title="Places of care" sub="Where visits happen, and who confirmed each pin" />
  );

  if (locationRes.error) {
    return (
      <AppShell active="/operations/locations">
        <div className="rise">
          {header}
          <ErrorState
            title="Couldn't load the places of care"
            body="Nothing was changed. Every address and every confirmed pin stands exactly as it was — this screen simply could not read them. Refresh to try again."
            retry={
              <Link href="/operations/locations" className="btn btn-primary btn-sm">
                Try again
              </Link>
            }
          />
        </div>
      </AppShell>
    );
  }

  // `as unknown as` because the column list is assembled from string fragments, which
  // defeats supabase-js's literal-type inference; the shape is asserted by LocationRow above.
  const locations = (locationRes.data ?? []) as unknown as LocationRow[];
  const pickerClients = (pickerRes.data ?? []) as ClientRow[];

  // Degraded read: service_location is AAL2-gated in RLS, so an unverified session sees an
  // empty list rather than an error. Say which one it is instead of implying "none exist".
  if (locations.length === 0 && !clientFilter) {
    let aal2 = true;
    try {
      const { data } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
      aal2 = !data || data.currentLevel === "aal2";
    } catch {
      aal2 = true; // never block the page on an assurance-level probe
    }
    if (!aal2) {
      return (
        <AppShell active="/operations/locations">
          <div className="rise">
            {header}
            <EmptyState
              icon={<IconLock />}
              title="Verify your session to see places of care"
              body="A place of care is a client's address, so it appears only on a verified (MFA) session. Nothing has been removed — you just cannot read it from here yet."
              action={
                <Link href="/mfa" className="btn btn-primary btn-sm">
                  Verify session
                </Link>
              }
            />
          </div>
        </AppShell>
      );
    }
  }

  const locationIds = locations.map((l) => l.id);
  const clientIds = [...new Set(locations.map((l) => l.client_id))];

  /**
   * The address versions, asked for in batches of ID_BATCH.
   *
   * `.in()` puts every id in the query string, so one request for 200 places builds a URL
   * of nearly 8 KB — and past that the request comes back empty rather than large. The
   * failure was silent and total: every place on the page read "No address version is on
   * file for this place", which is the sentence for a place that has never had an address,
   * on 200 places that all had one. The pin, the address and the confirm control all went
   * with it. Batching keeps each URL short; the batches are merged below exactly as one
   * result would have been.
   */
  const versionBatches = await Promise.all(
    chunk(locationIds, ID_BATCH).map((ids) =>
      supabase
        .from("service_location_version")
        .select(VERSION_COLUMNS)
        .in("service_location_id", ids)
        .order("version_no", { ascending: false })
        .limit(1000)
    )
  );
  const clientRes = clientIds.length
    ? await supabase.from("client").select("id, first_name, last_name").in("id", clientIds)
    : { data: [] as { id: string; first_name: string; last_name: string }[], error: null };

  /* A batch that failed is not "no address on file" — say so rather than render the
   * sentence that means something else entirely. */
  const versionsUnreadable = versionBatches.some((b) => b.error);
  const versions = versionBatches.flatMap((b) => (b.data ?? [])) as unknown as VersionRow[];
  const versionById = new Map(versions.map((v) => [v.id, v]));
  const versionsByLocation = new Map<string, VersionRow[]>();
  for (const v of versions) {
    const list = versionsByLocation.get(v.service_location_id) ?? [];
    list.push(v);
    versionsByLocation.set(v.service_location_id, list);
  }

  // IDs travel; names are refetched under RLS and read "(restricted)" when a policy hides
  // the row (invariant 5).
  const clientName = new Map<string, string>();
  for (const c of pickerClients) clientName.set(c.id, `${c.first_name} ${c.last_name}`);
  for (const c of (clientRes.data ?? []) as { id: string; first_name: string; last_name: string }[]) {
    clientName.set(c.id, `${c.first_name} ${c.last_name}`);
  }

  const staffIds = [
    ...new Set([
      ...locations.map((l) => l.created_by),
      ...versions.map((v) => v.created_by),
      ...versions.map((v) => v.verified_by).filter((x): x is string => Boolean(x)),
    ]),
  ];
  const staffRes = staffIds.length
    ? await supabase.from("app_user").select("id, full_name").in("id", staffIds)
    : { data: [] as { id: string; full_name: string | null }[] };
  const staffName = new Map(
    ((staffRes.data ?? []) as { id: string; full_name: string | null }[]).map((s) => [
      s.id,
      s.full_name ?? "A team member",
    ])
  );

  const currentOf = (l: LocationRow): VersionRow | undefined =>
    l.current_version_id ? versionById.get(l.current_version_id) : undefined;

  const confirmed = locations.filter((l) => currentOf(l)?.verification === "verified").length;
  const awaiting = locations.filter((l) => {
    const v = currentOf(l);
    return !v || v.verification !== "verified";
  }).length;
  const ownRadius = locations.filter((l) => currentOf(l)?.geofence_radius_m != null).length;

  const addForm = (
    <LocationForm action={createServiceLocation} submitLabel="Add this place">
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <label className="label" htmlFor="add_client">
            Client
          </label>
          <select id="add_client" name="client_id" required defaultValue={clientFilter ?? ""} className="select">
            <option value="">Choose a client…</option>
            {pickerClients.map((c) => (
              <option key={c.id} value={c.id}>
                {c.last_name}, {c.first_name}
                {c.status === "active" ? "" : ` · ${c.status.replace(/_/g, " ")}`}
              </option>
            ))}
          </select>
          {pickerClients.length === 0 && (
            // Managing places of care and reading the client roster are separate
            // permissions. Say which one is missing rather than showing an empty list.
            <p className="mt-1.5 text-[12px] leading-relaxed" style={{ color: "var(--text-muted)" }}>
              No client is readable on this session. A place of care belongs to a client record, so you need a
              verified session and access to that client — through the care team or agency-wide client access —
              before one can be added here.
            </p>
          )}
        </div>
        <div>
          <label className="label" htmlFor="add_kind">
            What kind of place
          </label>
          <select id="add_kind" name="kind" required defaultValue="primary_residence" className="select">
            {KIND_OPTIONS.map((k) => (
              <option key={k.value} value={k.value}>
                {k.label}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="label" htmlFor="add_label">
            What people call it (optional)
          </label>
          <input id="add_label" name="label" maxLength={80} placeholder="Home" className="input" />
        </div>
        <div>
          <label className="label" htmlFor="add_primary">
            Is this the main address?
          </label>
          <select id="add_primary" name="is_primary" defaultValue="true" className="select">
            <option value="true">Yes — visits default here</option>
            <option value="false">No — an additional address</option>
          </select>
          <p className="mt-1.5 text-[12px]" style={{ color: "var(--text-muted)" }}>
            A client has one main address at a time. Choosing yes moves it here; the previous one is kept and
            simply stops being the default.
          </p>
        </div>
      </div>
      <div className="mt-3">
        <AddressFields idPrefix="add" />
      </div>
      <p className="mt-3 text-[12px] leading-relaxed" style={{ color: "var(--text-muted)" }}>
        Adding an address does not put it on the map. Nobody&rsquo;s arrival is checked against this place until a
        coordinator confirms where it is — that confirmation is a separate, deliberate step, and it carries
        their name.
      </p>
    </LocationForm>
  );

  return (
    <AppShell active="/operations/locations">
      <div className="rise">
        {header}

        <div className="mb-3 grid grid-cols-2 gap-3 lg:grid-cols-4">
          <MetricTile label="Places on file" value={locations.length} tone="accent" icon={<IconHome />} />
          <MetricTile label="Pin confirmed" value={confirmed} tone="success" icon={<IconCheck />} />
          <MetricTile
            label="Waiting on a pin"
            value={awaiting}
            tone={awaiting ? "warning" : "neutral"}
            icon={<IconAlert />}
            hint={awaiting ? "Arrival is not checked until confirmed" : "Nothing outstanding"}
          />
          <MetricTile
            label="Own arrival radius"
            value={ownRadius}
            tone="neutral"
            icon={<IconMapPin />}
            hint="The rest use the policy default"
          />
        </div>

        <div className="card-inset mb-6 px-5 py-4">
          <SectionTitle icon={<IconShield />}>A pin is something a person signs for</SectionTitle>
          <p className="text-[13px] leading-relaxed" style={{ color: "var(--text-secondary)" }}>
            CareOS does not geocode addresses on its own and never guesses where a client lives. A coordinator
            reads the address, decides where it actually is, and confirms it — and their name and the moment go
            on the record. This is the only screen in CareOS that shows a coordinate, because it is the only
            place where someone is being asked to vouch for one. Everywhere else, an arrival is described in
            words: inside, nearby, or too far to tell.
          </p>
        </div>

        {/* ── Filter + add ── */}
        <div className="mb-4 flex flex-wrap items-end gap-3">
          <form method="get" action="/operations/locations" className="flex flex-wrap items-end gap-3">
            <div className="min-w-56">
              <label className="label" htmlFor="filter_client">
                Show
              </label>
              <select id="filter_client" name="client" defaultValue={clientFilter ?? ""} className="select">
                <option value="">Every client</option>
                {pickerClients.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.last_name}, {c.first_name}
                  </option>
                ))}
              </select>
            </div>
            <button type="submit" className="btn btn-secondary btn-sm">
              Apply
            </button>
            {clientFilter && (
              <Link href="/operations/locations" className="btn btn-ghost btn-sm">
                Clear
              </Link>
            )}
          </form>
        </div>

        <details className="card mb-6 px-5 py-4">
          <summary className="cursor-pointer list-none text-[14px] font-medium" style={{ color: "var(--accent-text)" }}>
            <IconPlus width={14} height={14} className="mr-1.5 inline align-[-2px]" />
            Add a place of care
          </summary>
          <div className="mt-4">{addForm}</div>
        </details>

        {locations.length === 0 ? (
          <EmptyState
            icon={<IconHome />}
            title={clientFilter ? "No place of care on file for this client" : "No places of care yet"}
            body="A place of care is where a visit actually happens — usually a client's home, sometimes a family member's or a facility. Add one above, then confirm where it is so arrivals can be checked against it."
            action={
              clientFilter ? (
                <Link href="/operations/locations" className="btn btn-secondary btn-sm">
                  Show every client
                </Link>
              ) : undefined
            }
          />
        ) : (
          <div className="flex flex-col gap-4">
            {locations.map((loc) => {
              const current = currentOf(loc);
              const history = (versionsByLocation.get(loc.id) ?? []).filter((v) => v.id !== current?.id);
              const pin = current ? readPoint(current.geo) : null;
              const verified = current?.verification === "verified";
              const rejected = current?.verification === "rejected";

              return (
                <article key={loc.id} className="card px-5 py-5">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      <h3 className="text-[16px] font-semibold tracking-[-0.01em]">
                        {clientName.get(loc.client_id) ?? "(restricted)"}
                        {loc.label ? ` · ${loc.label}` : ""}
                      </h3>
                      <p className="mt-1 text-[13px]" style={{ color: "var(--text-secondary)" }}>
                        {KIND_LABEL.get(loc.kind) ?? loc.kind.replace(/_/g, " ")}
                        {current ? ` · version ${current.version_no}` : ""} · added {fmtStamp(loc.created_at)} by{" "}
                        {staffName.get(loc.created_by) ?? "a team member"}
                      </p>
                    </div>
                    <div className="flex flex-wrap items-center gap-1.5">
                      {loc.is_primary && <Badge tone="accent">Main address</Badge>}
                      {!loc.active && <Badge tone="neutral">No longer in use</Badge>}
                      {verified ? (
                        <Badge tone="success" icon={<IconCheck />}>
                          Pin confirmed
                        </Badge>
                      ) : rejected ? (
                        <Badge tone="danger" icon={<IconAlert />}>
                          Pin rejected
                        </Badge>
                      ) : (
                        <Badge tone="warning" icon={<IconAlert />}>
                          Pin not confirmed
                        </Badge>
                      )}
                    </div>
                  </div>

                  {!current ? (
                    <p className="mt-4 text-[13px]" style={{ color: "var(--text-muted)" }}>
                      {versionsUnreadable
                        ? "The address on file for this place could not be read just now. Nothing has been changed or removed — refresh to try again."
                        : "No address version is on file for this place, so there is nothing to show or confirm yet."}
                    </p>
                  ) : (
                    <>
                      <div className="mt-4 grid gap-4 sm:grid-cols-2">
                        <div>
                          <p
                            className="mb-1 text-[11px] font-semibold uppercase"
                            style={{ color: "var(--text-muted)", letterSpacing: "0.04em" }}
                          >
                            Address on file
                          </p>
                          <address className="not-italic text-[14px] leading-relaxed">
                            {current.address_line1}
                            {current.address_line2 && (
                              <>
                                <br />
                                {current.address_line2}
                              </>
                            )}
                            <br />
                            {[current.city, current.state].filter(Boolean).join(", ")}{" "}
                            <span className="tabular">{current.postal_code ?? ""}</span>
                          </address>
                        </div>
                        <div>
                          <p
                            className="mb-1 text-[11px] font-semibold uppercase"
                            style={{ color: "var(--text-muted)", letterSpacing: "0.04em" }}
                          >
                            The pin
                          </p>
                          {pin ? (
                            <p className="tabular text-[14px]">
                              {formatCoordinate(pin.lat)}, {formatCoordinate(pin.lng)}
                            </p>
                          ) : verified ? (
                            <p className="text-[14px]" style={{ color: "var(--text-muted)" }}>
                              A pin is on file but could not be read on this screen.
                            </p>
                          ) : (
                            <p className="text-[14px]" style={{ color: "var(--text-muted)" }}>
                              No pin yet.
                            </p>
                          )}
                          <p className="mt-1 text-[12px] leading-relaxed" style={{ color: "var(--text-muted)" }}>
                            {verified
                              ? `${PRECISION_LABEL.get(current.geo_precision) ?? current.geo_precision} · ${
                                  SOURCE_LABEL[current.geo_source] ?? current.geo_source
                                } · confirmed by ${staffName.get(current.verified_by ?? "") ?? "a coordinator"} on ${fmtStamp(
                                  current.verified_at
                                )}`
                              : "Until someone confirms where this address is, nobody's arrival here can be checked against it — visits still record normally and simply carry no arrival check."}
                          </p>
                          <p className="mt-1 text-[12px]" style={{ color: "var(--text-muted)" }}>
                            Arrival radius:{" "}
                            {current.geofence_radius_m != null ? (
                              <span className="tabular">{current.geofence_radius_m} m (set for this place)</span>
                            ) : (
                              "the agency policy default"
                            )}
                          </p>
                        </div>
                      </div>

                      {/* ── The D-025 attestation ── */}
                      <Disclosure summary={verified ? "Confirm this pin again" : "Confirm this pin"}>
                        <p className="mb-3 text-[13px] leading-relaxed" style={{ color: "var(--text-secondary)" }}>
                          You are saying: this pin is where that address is. CareOS records your name and the
                          moment against it, and from then on arrivals here are measured from it. Confirming
                          appends a new version — the one on file now is kept, so what was in use before stays
                          readable.
                        </p>
                        <LocationForm
                          action={verifyServiceLocation}
                          submitLabel="Confirm — this pin is correct"
                          pendingLabel="Recording your confirmation…"
                        >
                          <input type="hidden" name="version_id" value={current.id} />
                          <div className="grid gap-3 sm:grid-cols-2">
                            <div>
                              <label className="label" htmlFor={`lat_${loc.id}`}>
                                Latitude
                              </label>
                              <input
                                id={`lat_${loc.id}`}
                                name="lat"
                                type="number"
                                step="any"
                                min={-90}
                                max={90}
                                required
                                defaultValue={pin ? formatCoordinate(pin.lat) : ""}
                                className="input tabular"
                              />
                            </div>
                            <div>
                              <label className="label" htmlFor={`lng_${loc.id}`}>
                                Longitude
                              </label>
                              <input
                                id={`lng_${loc.id}`}
                                name="lng"
                                type="number"
                                step="any"
                                min={-180}
                                max={180}
                                required
                                defaultValue={pin ? formatCoordinate(pin.lng) : ""}
                                className="input tabular"
                              />
                            </div>
                            <div>
                              <label className="label" htmlFor={`prec_${loc.id}`}>
                                How exact is it?
                              </label>
                              <select
                                id={`prec_${loc.id}`}
                                name="precision"
                                required
                                defaultValue={verified ? current.geo_precision : "manual"}
                                className="select"
                              >
                                {PRECISION_OPTIONS.map((p) => (
                                  <option key={p.value} value={p.value}>
                                    {p.label}
                                  </option>
                                ))}
                              </select>
                            </div>
                            <div>
                              <label className="label" htmlFor={`note_${loc.id}`}>
                                Note (optional)
                              </label>
                              <input
                                id={`note_${loc.id}`}
                                name="note"
                                maxLength={200}
                                placeholder="e.g. Back building, entrance off the alley"
                                className="input"
                              />
                            </div>
                          </div>
                          {/* The signature itself. Required in the browser, re-checked in
                              the Server Action — a confirmation has to be an act, not a
                              side effect of a mis-click (D-025). */}
                          <label
                            className="mt-3 flex items-start gap-2.5 text-[13px] leading-relaxed"
                            htmlFor={`attest_${loc.id}`}
                          >
                            <input
                              id={`attest_${loc.id}`}
                              name="attest"
                              type="checkbox"
                              value="true"
                              required
                              className="mt-0.5 size-4 shrink-0"
                              style={{ accentColor: "var(--accent)" }}
                            />
                            <span>
                              I have checked this against the address and I am confirming it. My name and the
                              current time are recorded with it.
                            </span>
                          </label>
                        </LocationForm>
                      </Disclosure>

                      {/* ── Revise the address ── */}
                      {loc.active && (
                        <Disclosure summary="The address changed">
                          <p className="mb-3 text-[13px] leading-relaxed" style={{ color: "var(--text-secondary)" }}>
                            This writes a new version rather than correcting this one. The version on file keeps
                            its address, its pin and whoever confirmed it, so every visit already recorded
                            against it still means what it meant. The new version starts with no pin — someone
                            confirmed where the old address was, not this one.
                          </p>
                          <LocationForm
                            action={reviseServiceLocation}
                            submitLabel="Save the new address"
                            variant="secondary"
                          >
                            <input type="hidden" name="location_id" value={loc.id} />
                            <AddressFields version={current} idPrefix={`rev_${loc.id}`} />
                            <div className="mt-3">
                              <label className="label" htmlFor={`rev_reason_${loc.id}`}>
                                Why it changed
                              </label>
                              <input
                                id={`rev_reason_${loc.id}`}
                                name="reason"
                                required
                                maxLength={300}
                                placeholder="e.g. Moved to the daughter's house after discharge"
                                className="input"
                              />
                            </div>
                          </LocationForm>
                        </Disclosure>
                      )}

                      {/* ── Per-place arrival radius ── */}
                      <Disclosure summary="Arrival radius for this place">
                        <p className="mb-3 text-[13px] leading-relaxed" style={{ color: "var(--text-secondary)" }}>
                          Most places use the agency&rsquo;s policy default. Set a radius here only when this
                          particular place needs one — a long rural driveway, a large campus, a building where
                          signal is poor. This is an operating choice, not a rule anyone imposes on the agency,
                          and it is between 25 and 5000 metres.
                        </p>
                        <LocationForm action={setLocationGeofence} submitLabel="Save the radius" variant="secondary">
                          <input type="hidden" name="version_id" value={current.id} />
                          <div className="grid gap-3 sm:grid-cols-2">
                            <div>
                              <label className="label" htmlFor={`radius_${loc.id}`}>
                                Radius in metres
                              </label>
                              <input
                                id={`radius_${loc.id}`}
                                name="radius_m"
                                type="number"
                                step={1}
                                min={25}
                                max={5000}
                                required
                                defaultValue={current.geofence_radius_m ?? 200}
                                className="input tabular w-40"
                              />
                            </div>
                            <div>
                              <label className="label" htmlFor={`radius_reason_${loc.id}`}>
                                Why
                              </label>
                              <input
                                id={`radius_reason_${loc.id}`}
                                name="reason"
                                required
                                maxLength={300}
                                placeholder="e.g. Quarter-mile driveway; the standard radius fails at the gate"
                                className="input"
                              />
                            </div>
                          </div>
                        </LocationForm>
                      </Disclosure>

                      {/* ── History ── */}
                      {history.length > 0 && (
                        <Disclosure summary={`Earlier versions (${history.length})`}>
                          <ol className="flex flex-col gap-3">
                            {history.map((v) => (
                              <li key={v.id} className="text-[13px]">
                                <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                                  <span className="tabular font-medium">Version {v.version_no}</span>
                                  {v.verification === "verified" ? (
                                    <Badge tone="neutral" icon={<IconCheck />}>
                                      Was confirmed
                                    </Badge>
                                  ) : (
                                    <Badge tone="neutral">Never confirmed</Badge>
                                  )}
                                  <span className="tabular text-[12px]" style={{ color: "var(--text-muted)" }}>
                                    {fmtStamp(v.created_at)} · {staffName.get(v.created_by) ?? "a team member"}
                                  </span>
                                </div>
                                <p className="mt-0.5" style={{ color: "var(--text-secondary)" }}>
                                  {v.original_address}
                                </p>
                                {v.change_reason && (
                                  <p className="mt-0.5 text-[12px]" style={{ color: "var(--text-muted)" }}>
                                    {v.change_reason}
                                  </p>
                                )}
                              </li>
                            ))}
                          </ol>
                          <p className="mt-3 text-[12px] leading-relaxed" style={{ color: "var(--text-muted)" }}>
                            <IconHistory width={12} height={12} className="mr-1 inline align-[-1px]" />
                            Earlier versions are never removed. A visit records which version it was measured
                            against, so this history is what makes an old visit still legible.
                          </p>
                        </Disclosure>
                      )}
                    </>
                  )}
                </article>
              );
            })}
          </div>
        )}

        <p className="mt-6 text-[12px] leading-relaxed" style={{ color: "var(--text-muted)" }}>
          <IconPen width={12} height={12} className="mr-1 inline align-[-1px]" />
          Every change here runs through a database function on your own session, which checks your permission
          and your verification, assigns the version number, and refuses to attach a confirmation to anything but
          the current version. Nothing on this screen can write around that.
        </p>
      </div>
    </AppShell>
  );
}
