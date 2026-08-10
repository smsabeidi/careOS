/**
 * Reading one stored pin back out.
 *
 * `service_location_version.geo` is `extensions.geography(Point,4326)`. PostgREST has no
 * JSON cast for that type, so it serialises through PostGIS's own output function and the
 * column arrives as an EWKB hex string (`0101000020E6100000…`). This decodes exactly that
 * one shape — a single point — and refuses everything else.
 *
 * WHY THIS EXISTS AT ALL, given D-030 closes the coordinate list: `/operations/locations`
 * is the one surface where a coordinate is legitimate, because a coordinator is ATTESTING
 * to it (D-025). Someone confirming "this pin is on the right house" has to be able to see
 * the pin they are confirming. It is shown here, to `location.manage` holders, and nowhere
 * else in CareOS — not on an operations board, not in a notification, not in telemetry, not
 * in a prompt.
 *
 * It fails closed: anything it cannot read with certainty returns null, and the caller says
 * "a pin is on file" rather than rendering a number it is not sure about.
 */

export type LatLng = { lat: number; lng: number };

const SRID_FLAG = 0x2000_0000;
const Z_FLAG = 0x8000_0000;
const M_FLAG = 0x4000_0000;
const WKB_POINT = 1;

function fromHex(hex: string): DataView | null {
  if (hex.length % 2 !== 0) return null;
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    const byte = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    if (!Number.isFinite(byte)) return null;
    bytes[i] = byte;
  }
  return new DataView(bytes.buffer);
}

function plausible(lat: number, lng: number): boolean {
  return (
    Number.isFinite(lat) &&
    Number.isFinite(lng) &&
    lat >= -90 &&
    lat <= 90 &&
    lng >= -180 &&
    lng <= 180 &&
    !(lat === 0 && lng === 0) // Null Island is a decode failure, never an address
  );
}

/**
 * Decode whatever the `geo` column came back as. Two shapes are accepted because the
 * serialisation is PostgREST's choice, not ours: EWKB hex (today's default) and GeoJSON
 * (what a `geo+json` representation would produce). Anything else is treated as unreadable.
 */
export function readPoint(value: unknown): LatLng | null {
  if (!value) return null;

  // GeoJSON: { type: "Point", coordinates: [lng, lat] }
  if (typeof value === "object") {
    const candidate = value as { coordinates?: unknown };
    if (Array.isArray(candidate.coordinates) && candidate.coordinates.length >= 2) {
      const lng = Number(candidate.coordinates[0]);
      const lat = Number(candidate.coordinates[1]);
      return plausible(lat, lng) ? { lat, lng } : null;
    }
    return null;
  }

  if (typeof value !== "string") return null;
  const hex = value.trim();
  if (!/^[0-9a-fA-F]+$/.test(hex) || hex.length < 42) return null;

  const view = fromHex(hex);
  if (!view) return null;

  const order = view.getUint8(0);
  if (order !== 0 && order !== 1) return null;
  const little = order === 1;

  const typeWord = view.getUint32(1, little);
  // A plain 2D point and nothing else. The low word must be exactly 1: ISO's 1001/2001/3001
  // (PointZ/PointM/PointZM) and EWKB's Z/M flags all put ordinates after X/Y that this
  // reader does not know how to skip, so they are refused rather than mis-read.
  if ((typeWord & 0x0000_ffff) !== WKB_POINT) return null;
  if ((typeWord & Z_FLAG) !== 0 || (typeWord & M_FLAG) !== 0) return null;

  let offset = 5;
  if ((typeWord & SRID_FLAG) !== 0) offset += 4; // SRID word, if EWKB carried one
  if (view.byteLength < offset + 16) return null;

  // PostGIS stores (x, y) = (longitude, latitude) — the order everyone gets backwards.
  const lng = view.getFloat64(offset, little);
  const lat = view.getFloat64(offset + 8, little);
  return plausible(lat, lng) ? { lat, lng } : null;
}

/** Six decimal places is roughly a tenth of a metre — past that is false precision. */
export function formatCoordinate(n: number): string {
  return n.toFixed(6);
}
