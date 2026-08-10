"use server";

/**
 * Service-location write paths — thin wrappers over the §6.1 Lane-B RPCs (migration 0043).
 *
 * Four rules hold across all of them, and none of them are enforced here:
 *
 *  1. **The database is the authority.** AAL2, `location.manage`, address shape, coordinate
 *     range, precision vocabulary and the current-version check all live in the RPC. This
 *     file shapes a form and turns CAREOS_* refusals into plain language.
 *  2. **Nothing is edited.** `service_location_version` is append-only. Revising an address
 *     writes a NEW version pointing at the old one; the old version keeps its geocode and
 *     its human attestation, so any visit already bound to it still means what it meant
 *     (invariant 1, the D-014 binding precedent).
 *  3. **A coordinate arrives only by human attestation (D-025).** A revised address starts
 *     with no pin at all, because a person signed for the OLD one. `verify_service_location`
 *     is the only way a coordinate enters the system, and it records who said so.
 *  4. **No PHI in a return value.** An address is PHI; not one message below echoes a
 *     street, a city, a coordinate, or a client's name (invariant 5). The row is where the
 *     address lives — an error message travels much further than a row does.
 */

import { revalidatePath } from "next/cache";
import { supabaseServer } from "@/lib/supabase/server";

export type ActionResult = { ok: boolean; error?: string; message?: string };

/** CAREOS_* refusals → plain language. Everything else stays generic. */
function friendly(raw: string | undefined): string {
  const code = raw?.match(/CAREOS_[A-Z_]+/)?.[0];
  switch (code) {
    case "CAREOS_AAL2_REQUIRED":
      return "Your session needs a fresh verification — unlock with your authenticator and try again. Nothing was saved.";
    case "CAREOS_FORBIDDEN":
      return "Your role does not include managing places of care. Nothing was saved.";
    case "CAREOS_BAD_KIND":
      return "That is not a kind of place CareOS records. Nothing was saved.";
    case "CAREOS_BAD_ADDRESS":
      return "A street line is required. Nothing was saved.";
    case "CAREOS_NOT_FOUND":
      return "That record is not available on your account. Nothing was saved.";
    case "CAREOS_REASON_REQUIRED":
      return "A reason is required — it is kept on the new version so the change explains itself later.";
    case "CAREOS_BAD_STATE":
      return "This place of care is no longer in use, so it cannot be revised. Nothing was saved.";
    case "CAREOS_BAD_PRECISION":
      return "Choose how exact the pin is before confirming it. Nothing was saved.";
    case "CAREOS_BAD_COORDINATES":
      return "Those numbers are not a usable latitude and longitude. Nothing was saved — the pin on file is unchanged.";
    case "CAREOS_STALE_VERSION":
      return "Someone else changed this place of care while you were working. Nothing was saved — reload to see the current version, then confirm the pin against it.";
    case "CAREOS_BAD_RADIUS":
      return "An arrival radius has to be between 25 and 5000 metres. Nothing was saved.";
    case "CAREOS_NO_TENANT_CONTEXT":
      return "Your workspace could not be resolved on this session. Nothing was saved.";
    default:
      return "That could not be saved. Nothing was changed — the version on file stands exactly as it was.";
  }
}

/** Re-guard inside the action: a Server Action is a public endpoint, not a page child. */
async function assertLocationManager(
  supabase: Awaited<ReturnType<typeof supabaseServer>>
): Promise<string | null> {
  const { data, error } = await supabase.schema("app").rpc("has_perm", { p: "location.manage" });
  if (error) return "Your permissions could not be checked on this session. Nothing was saved.";
  if (data !== true) return "Your role does not include managing places of care. Nothing was saved.";
  return null;
}

const LOCATION_KINDS = new Set([
  "primary_residence",
  "temporary_residence",
  "family_residence",
  "community",
  "facility",
  "alternate",
]);

const GEO_PRECISIONS = new Set([
  "rooftop",
  "parcel",
  "interpolated",
  "street",
  "locality",
  "manual",
  "unknown",
]);

/** `p_address` per §6.1 — the six parts, trimmed; the RPC normalises and stores both forms. */
function addressFrom(formData: FormData): Record<string, string> {
  return {
    line1: String(formData.get("line1") ?? "").trim(),
    line2: String(formData.get("line2") ?? "").trim(),
    city: String(formData.get("city") ?? "").trim(),
    state: String(formData.get("state") ?? "").trim(),
    postal_code: String(formData.get("postal_code") ?? "").trim(),
    country: String(formData.get("country") ?? "").trim() || "US",
  };
}

/* ── Create ─────────────────────────────────────────────────────────────────── */

export async function createServiceLocation(formData: FormData): Promise<ActionResult> {
  const client = String(formData.get("client_id") ?? "").trim();
  const kind = String(formData.get("kind") ?? "").trim();
  const label = String(formData.get("label") ?? "").trim();
  const address = addressFrom(formData);

  if (!client) return { ok: false, error: "Choose which client this place belongs to. Nothing was saved." };
  if (!LOCATION_KINDS.has(kind)) {
    return { ok: false, error: "Choose what kind of place this is. Nothing was saved." };
  }
  if (!address.line1) return { ok: false, error: "A street line is required. Nothing was saved." };

  const supabase = await supabaseServer();
  const denied = await assertLocationManager(supabase);
  if (denied) return { ok: false, error: denied };

  const { data, error } = await supabase.schema("app").rpc("create_service_location", {
    p_client: client,
    p_kind: kind,
    p_label: label || null,
    p_address: address,
    p_is_primary: String(formData.get("is_primary") ?? "") === "true",
  });
  if (error) return { ok: false, error: friendly(error.message) };

  const result = (data ?? {}) as { version_no?: number };
  revalidatePath("/operations/locations");
  return {
    ok: true,
    message:
      `Saved as version ${result.version_no ?? 1}. There is no pin on it yet — a coordinator has to confirm ` +
      "where it actually is before CareOS will check anyone's arrival against it.",
  };
}

/* ── Revise ─────────────────────────────────────────────────────────────────── */

export async function reviseServiceLocation(formData: FormData): Promise<ActionResult> {
  const location = String(formData.get("location_id") ?? "").trim();
  const reason = String(formData.get("reason") ?? "").trim();
  const address = addressFrom(formData);

  if (!location) return { ok: false, error: "That place of care could not be identified. Nothing was saved." };
  if (!address.line1) return { ok: false, error: "A street line is required. Nothing was saved." };
  if (!reason) {
    return {
      ok: false,
      error: "Add a reason before saving — it is kept on the new version so the change explains itself later.",
    };
  }

  const supabase = await supabaseServer();
  const denied = await assertLocationManager(supabase);
  if (denied) return { ok: false, error: denied };

  const { data, error } = await supabase.schema("app").rpc("revise_service_location", {
    p_location: location,
    p_address: address,
    p_reason: reason,
  });
  if (error) return { ok: false, error: friendly(error.message) };

  const result = (data ?? {}) as { unchanged?: boolean; version_no?: number };
  revalidatePath("/operations/locations");

  if (result.unchanged) {
    return {
      ok: true,
      message:
        "That is the same place as the one already on file, so no new version was created. Nothing was lost — the version on file already says this.",
    };
  }
  return {
    ok: true,
    message:
      `Saved as version ${result.version_no ?? "the next version"}. The previous version is kept with its pin ` +
      "and its confirmation intact, so visits already recorded against it are unaffected. The new version has " +
      "no pin yet — someone confirmed where the old address was, not this one.",
  };
}

/* ── Confirm the pin — the D-025 human attestation ──────────────────────────── */

export async function verifyServiceLocation(formData: FormData): Promise<ActionResult> {
  const version = String(formData.get("version_id") ?? "").trim();
  const latRaw = String(formData.get("lat") ?? "").trim();
  const lngRaw = String(formData.get("lng") ?? "").trim();
  const precision = String(formData.get("precision") ?? "").trim();
  const note = String(formData.get("note") ?? "").trim();

  if (!version) return { ok: false, error: "That place of care could not be identified. Nothing was saved." };
  const lat = Number(latRaw);
  const lng = Number(lngRaw);
  if (!latRaw || !lngRaw || !Number.isFinite(lat) || !Number.isFinite(lng)) {
    return { ok: false, error: "Enter both numbers before confirming. Nothing was saved." };
  }
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) {
    return {
      ok: false,
      error: "Those numbers are outside the range of a real place. Nothing was saved — the pin on file is unchanged.",
    };
  }
  if (!GEO_PRECISIONS.has(precision)) {
    return { ok: false, error: "Choose how exact the pin is before confirming it. Nothing was saved." };
  }
  // The attestation itself (D-025). The browser enforces the checkbox; this re-checks it,
  // because a Server Action is a public endpoint and a direct POST never met the form.
  if (String(formData.get("attest") ?? "") !== "true") {
    return {
      ok: false,
      error:
        "Confirming a pin puts your name on it, so it has to be a deliberate act. Tick the confirmation before saving — nothing was saved.",
    };
  }

  const supabase = await supabaseServer();
  const denied = await assertLocationManager(supabase);
  if (denied) return { ok: false, error: denied };

  const { data, error } = await supabase.schema("app").rpc("verify_service_location", {
    p_version: version,
    p_lat: lat,
    p_lng: lng,
    p_precision: precision,
    p_note: note || null,
  });
  if (error) return { ok: false, error: friendly(error.message) };

  const result = (data ?? {}) as { unchanged?: boolean; version_no?: number };
  revalidatePath("/operations/locations");

  if (result.unchanged) {
    return {
      ok: true,
      message: "That is the pin already confirmed for this address, so nothing was added. The confirmation on file stands.",
    };
  }
  return {
    ok: true,
    message:
      `Confirmed as version ${result.version_no ?? "the next version"}, in your name and with today's date. ` +
      "From here, arrivals at this address are checked against the pin you just signed for — and the version " +
      "before it is kept, so the record shows what was in use beforehand.",
  };
}

/* ── Arrival radius for one place ───────────────────────────────────────────── */

export async function setLocationGeofence(formData: FormData): Promise<ActionResult> {
  const version = String(formData.get("version_id") ?? "").trim();
  const radiusRaw = String(formData.get("radius_m") ?? "").trim();
  const reason = String(formData.get("reason") ?? "").trim();

  if (!version) return { ok: false, error: "That place of care could not be identified. Nothing was saved." };
  const radius = Number(radiusRaw);
  if (!radiusRaw || !Number.isInteger(radius) || radius < 25 || radius > 5000) {
    return { ok: false, error: "An arrival radius has to be a whole number between 25 and 5000 metres. Nothing was saved." };
  }
  if (!reason) {
    return {
      ok: false,
      error: "Add a reason before saving — it is kept on the new version so the change explains itself later.",
    };
  }

  const supabase = await supabaseServer();
  const denied = await assertLocationManager(supabase);
  if (denied) return { ok: false, error: denied };

  const { data, error } = await supabase.schema("app").rpc("set_service_location_geofence", {
    p_version: version,
    p_radius_m: radius,
    p_reason: reason,
  });
  if (error) return { ok: false, error: friendly(error.message) };

  const result = (data ?? {}) as { unchanged?: boolean; version_no?: number };
  revalidatePath("/operations/locations");

  if (result.unchanged) {
    return { ok: true, message: "That is already the radius for this place, so no new version was created." };
  }
  return {
    ok: true,
    message:
      `Saved as version ${result.version_no ?? "the next version"}. The confirmation on the address carries ` +
      "forward untouched — the address did not change, so the signature on it still stands.",
  };
}
