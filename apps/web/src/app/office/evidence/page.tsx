import Link from "next/link";
import Script from "next/script";
import { AppShell } from "@/components/shell";
import {
  Avatar,
  Badge,
  DataTable,
  EmptyState,
  ErrorState,
  MetricTile,
  PageHeader,
  SectionTitle,
  StatusChip,
} from "@/components/ui";
import {
  IconAlert,
  IconCheck,
  IconClipboardCheck,
  IconEye,
  IconLock,
  IconSearch,
  IconShield,
  IconSparkle,
  IconUsers,
} from "@/components/icons";
import { supabaseServer } from "@/lib/supabase/server";
import { requireRole } from "@/lib/profile";
import { buildEvidencePacket, type EvidenceManifest } from "./actions";

/**
 * /office/evidence — the surveyor "show me" surface (docs/16 §2.2 O2, Wave 5).
 *
 * A compliance lead picks a client, presses one button, and hands over a packet: what
 * records exist, how many versions each has, which signatures are bound to which content
 * hash, where the compliance cadence stands, which credentials the care team holds, and —
 * stated as plainly as everything else — what is missing.
 *
 * The packet is a record, not a view. It is assembled deterministically, filed append-only
 * in `evidence_packet`, and rendered from the filed manifest, so the thing on screen is
 * exactly the thing that was handed over. The AI-written index is the only part a model
 * touches, and a packet without one is complete.
 *
 * Print: the packet region is isolated for @media print, so ⌘P produces the packet alone —
 * no navigation, no controls.
 */

export const metadata = { title: "Evidence" };
export const dynamic = "force-dynamic";

const ROLES = ["owner", "admin", "compliance"];
const CLIENT_LIMIT = 20;
const PACKET_LIMIT = 10;

type ClientRow = {
  id: string;
  first_name: string;
  last_name: string;
  status: string;
  city: string | null;
  state: string | null;
  admitted_on: string | null;
};

type PacketRow = {
  id: string;
  client_id: string | null;
  scope: string;
  record_count: number;
  manifest: unknown;
  narrative: string | null;
  created_at: string;
};

const ERRORS: Record<string, string> = {
  noclient: "Pick a client first — a packet is always assembled for one chart.",
  session:
    "Your session couldn't be resolved. Sign in again with your authenticator; nothing was assembled or filed.",
  notfound:
    "That chart isn't readable from your account, so no packet was assembled. Nothing was filed.",
  denied:
    "The packet was assembled but couldn't be filed. Filing evidence needs the compliance permission — nothing partial was stored.",
};

/** A manifest this page fully understands (version 1, written by buildEvidencePacket). */
function isFullManifest(m: unknown): m is EvidenceManifest {
  const o = m as Partial<EvidenceManifest> | null;
  return Boolean(
    o &&
      typeof o === "object" &&
      o.version === 1 &&
      Array.isArray(o.records) &&
      Array.isArray(o.forms) &&
      o.integrity &&
      o.period
  );
}

/** The platform's own index, used when no model wrote one (a null narrative is complete). */
function deterministicIndex(m: EvidenceManifest): string {
  const versions = m.records.find((r) => r.key === "form_version")?.count ?? 0;
  return [
    `This packet covers one client record from ${m.period.from} to ${m.period.to}. It contains ${m.forms.length} record${m.forms.length === 1 ? "" : "s"}, ${versions} immutable version${versions === 1 ? "" : "s"} between them, and ${m.signatures.total} signature${m.signatures.total === 1 ? "" : "s"}.`,
    `${m.integrity.version_chains_intact} of ${m.integrity.version_chains_checked} record chains verified end to end at assembly, and ${m.integrity.signatures_hash_bound} of ${m.integrity.signatures_checked} signatures resolve to the content hash of the version they signed.`,
    `${m.obligations.length} compliance obligation${m.obligations.length === 1 ? "" : "s"} appear for this client, and ${m.credentials.on_file} credential${m.credentials.on_file === 1 ? "" : "s"} are on file across ${m.credentials.care_team} assigned staff.`,
    `${m.visits.completed} of ${m.visits.in_period} visits in the period are recorded as completed, and ${m.visits.with_clock_pair} of those carry both an electronic clock-in and clock-out.`,
    m.gaps.length === 0
      ? "No gaps were detected by the checks this packet runs."
      : `Gaps recorded in this packet: ${m.gaps.join(" ")}`,
  ].join(" ");
}

function severityTone(severity: string): "danger" | "warning" | "neutral" {
  if (severity === "high") return "danger";
  if (severity === "medium") return "warning";
  return "neutral";
}

function obligationTone(status: string): "danger" | "warning" | "success" | "neutral" {
  if (status === "overdue") return "danger";
  if (status === "at_risk") return "warning";
  if (status === "satisfied") return "success";
  return "neutral";
}

function shortDate(value: string | null): string {
  if (!value) return "—";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

export default async function EvidencePage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; client?: string; packet?: string; error?: string }>;
}) {
  const params = await searchParams;
  const q = (params.q ?? "").replace(/[%,()]/g, "").trim();
  const clientId = (params.client ?? "").trim();
  const packetId = (params.packet ?? "").trim();
  const errorNotice = params.error ? (ERRORS[params.error] ?? ERRORS.denied) : null;

  const profile = await requireRole(ROLES);
  const supabase = await supabaseServer();

  // ── Client picker (RLS-scoped; a name search, not an id box) ────────────────
  let clientQuery = supabase
    .from("client")
    .select("id, first_name, last_name, status, city, state, admitted_on")
    .order("last_name")
    .order("id")
    .limit(CLIENT_LIMIT);
  if (q) clientQuery = clientQuery.or(`first_name.ilike.%${q}%,last_name.ilike.%${q}%`);
  const { data: clientRows, error: clientError } = await clientQuery;
  const clients = (clientRows ?? []) as ClientRow[];

  const { data: selectedRow } = clientId
    ? await supabase
        .from("client")
        .select("id, first_name, last_name, status, city, state, admitted_on")
        .eq("id", clientId)
        .maybeSingle()
    : { data: null };
  const selected = selectedRow as ClientRow | null;

  const { data: packetRows } = selected
    ? await supabase
        .from("evidence_packet")
        .select("id, client_id, scope, record_count, manifest, narrative, created_at")
        .eq("client_id", selected.id)
        .order("created_at", { ascending: false })
        .limit(PACKET_LIMIT)
    : { data: [] as PacketRow[] };
  const packets = (packetRows ?? []) as PacketRow[];

  const { data: openPacketRow } = packetId
    ? await supabase
        .from("evidence_packet")
        .select("id, client_id, scope, record_count, manifest, narrative, created_at")
        .eq("id", packetId)
        .maybeSingle()
    : { data: null };
  const openPacket = openPacketRow as PacketRow | null;

  if (clientError) {
    return (
      <AppShell active="/office/evidence">
        <div className="rise">
          <PageHeader title="Evidence" sub="Assemble the packet a surveyor asks for" />
          <ErrorState
            title="Couldn't load charts"
            body="Nothing was changed. Refresh to try again. If your verified session expired, sign in again with your authenticator."
          />
        </div>
      </AppShell>
    );
  }

  const manifest = openPacket && isFullManifest(openPacket.manifest) ? openPacket.manifest : null;

  return (
    <AppShell active="/office/evidence">
      <style>{`
        @media print {
          body * { visibility: hidden !important; }
          #evidence-packet, #evidence-packet * { visibility: visible !important; }
          #evidence-packet { position: absolute; left: 0; top: 0; width: 100%; padding: 0; }
          .no-print { display: none !important; }
          .card { box-shadow: none !important; border: 1px solid #d6d6db !important; break-inside: avoid; }
        }
      `}</style>

      <div className="rise">
        <div className="no-print">
          <PageHeader
            title="Evidence"
            sub="Pick a chart, assemble the packet, hand it over"
            actions={
              <Link href="/office/compliance" className="btn btn-white btn-sm">
                Compliance
              </Link>
            }
          />

          {errorNotice && (
            <p
              className="card mb-5 flex items-start gap-2 px-5 py-4 text-[14px]"
              role="alert"
              style={{ color: "var(--color-danger-700)" }}
            >
              <IconAlert width={16} height={16} className="mt-0.5 shrink-0" />
              {errorNotice}
            </p>
          )}
        </div>

        <div className="grid gap-8 lg:grid-cols-[minmax(0,320px)_minmax(0,1fr)]">
          {/* ── Left: the picker ─────────────────────────────────────────── */}
          <aside className="no-print min-w-0">
            <SectionTitle icon={<IconUsers />}>Client</SectionTitle>

            <form method="get" action="/office/evidence" className="mb-3">
              {clientId && <input type="hidden" name="client" value={clientId} />}
              <label htmlFor="evidence-search" className="sr-only">
                Search clients by name
              </label>
              <div className="relative">
                <IconSearch
                  width={17}
                  height={17}
                  className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2"
                  style={{ color: "var(--text-muted)" }}
                />
                <input
                  id="evidence-search"
                  type="search"
                  name="q"
                  defaultValue={q}
                  placeholder="Search by name"
                  className="input w-full pl-10"
                />
              </div>
            </form>

            {clients.length === 0 ? (
              <EmptyState
                icon={<IconUsers />}
                title="No matching charts"
                body={
                  q
                    ? "No chart you can read matches that name. Try a different spelling."
                    : "There are no charts readable from your account yet."
                }
              />
            ) : (
              <ul className="card divide-y hairline overflow-hidden">
                {clients.map((c) => {
                  const active = selected?.id === c.id;
                  return (
                    <li key={c.id}>
                      <Link
                        href={`/office/evidence?client=${c.id}${q ? `&q=${encodeURIComponent(q)}` : ""}`}
                        className="row-link flex items-center gap-3 px-4 py-3"
                        style={active ? { background: "var(--accent-soft)" } : undefined}
                        aria-current={active ? "true" : undefined}
                      >
                        <Avatar name={`${c.first_name} ${c.last_name}`} size={32} />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-[14px] font-medium">
                            {c.first_name} {c.last_name}
                          </span>
                          <span className="block text-[12px]" style={{ color: "var(--text-muted)" }}>
                            {[c.city, c.state].filter(Boolean).join(", ") || "No address on file"}
                          </span>
                        </span>
                        <StatusChip status={c.status} />
                      </Link>
                    </li>
                  );
                })}
              </ul>
            )}

            {selected && (
              <div className="card mt-5 px-5 py-4">
                <p className="text-[14px] font-semibold">
                  {selected.first_name} {selected.last_name}
                </p>
                <p className="mt-1 text-[13px]" style={{ color: "var(--text-secondary)" }}>
                  {selected.admitted_on ? `Admitted ${shortDate(selected.admitted_on)}` : "No admission date on file"}
                </p>
                <form action={buildEvidencePacket} className="mt-3">
                  <input type="hidden" name="client" value={selected.id} />
                  <button type="submit" className="btn btn-primary btn-block">
                    Build packet
                  </button>
                </form>
                <p className="mt-2 text-[12px] leading-relaxed" style={{ color: "var(--text-muted)" }}>
                  Assembles the trailing twelve months and files it. Packets are append-only — building
                  again creates a new one and leaves the old one exactly as it was handed over.
                </p>

                {packets.length > 0 && (
                  <ul className="mt-4 flex flex-col gap-1 border-t pt-3 hairline">
                    {packets.map((p) => (
                      <li key={p.id}>
                        <Link
                          href={`/office/evidence?client=${selected.id}&packet=${p.id}`}
                          className="flex items-center justify-between gap-2 rounded-[var(--radius-sm)] px-2 py-1.5 text-[13px] hover:bg-[var(--color-surface-100)]"
                          style={openPacket?.id === p.id ? { background: "var(--accent-soft)" } : undefined}
                        >
                          <span className="truncate">
                            {new Date(p.created_at).toLocaleString(undefined, {
                              month: "short",
                              day: "numeric",
                              hour: "numeric",
                              minute: "2-digit",
                            })}
                          </span>
                          <span className="tabular shrink-0" style={{ color: "var(--text-muted)" }}>
                            {p.record_count} records
                          </span>
                        </Link>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </aside>

          {/* ── Right: the packet ────────────────────────────────────────── */}
          <div className="min-w-0">
            {!openPacket ? (
              <div className="no-print">
                <EmptyState
                  icon={<IconClipboardCheck />}
                  title={selected ? "No packet open" : "Pick a chart to begin"}
                  body={
                    selected
                      ? "Build a packet for this chart, or open one that was built earlier. Every packet lists the records, the versions, the signatures and the gaps exactly as they stood when it was assembled."
                      : "Search for a client on the left. A packet is assembled for one chart at a time, under your own permissions."
                  }
                />
              </div>
            ) : !manifest ? (
              <div className="card px-6 py-6" role="status">
                <h3 className="text-[15px] font-semibold">Packet filed in an earlier format</h3>
                <p className="mt-1.5 text-[14px] leading-relaxed" style={{ color: "var(--text-secondary)" }}>
                  This packet was assembled by an earlier version of the assembler, so this page shows its
                  manifest as filed rather than re-interpreting it. It is unchanged and still the record that
                  was handed over — {openPacket.record_count} records, filed{" "}
                  {shortDate(openPacket.created_at)}.
                </p>
                <pre
                  className="card-inset mt-4 overflow-x-auto px-4 py-3 text-[12px] leading-relaxed"
                  style={{ color: "var(--text-secondary)" }}
                >
                  {JSON.stringify(openPacket.manifest, null, 2)}
                </pre>
                {openPacket.narrative && (
                  <p className="mt-4 text-[14px] leading-relaxed">{openPacket.narrative}</p>
                )}
                {selected && (
                  <form action={buildEvidencePacket} className="no-print mt-4">
                    <input type="hidden" name="client" value={selected.id} />
                    <button type="submit" className="btn btn-secondary btn-sm">
                      Build a current packet
                    </button>
                  </form>
                )}
              </div>
            ) : (
              <>
                <div className="no-print mb-4 flex flex-wrap items-center justify-between gap-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge tone="accent" icon={<IconLock />}>
                      Filed evidence
                    </Badge>
                    <Badge tone="neutral">Packet {openPacket.id.slice(0, 8)}</Badge>
                    {openPacket.narrative ? (
                      <Badge tone="accent" icon={<IconSparkle />}>
                        Index written with AI
                      </Badge>
                    ) : (
                      <Badge tone="neutral">Index assembled by the platform</Badge>
                    )}
                  </div>
                  <button id="print-packet" type="button" className="btn btn-white btn-sm">
                    Print or save as PDF
                  </button>
                </div>

                <article id="evidence-packet" className="flex flex-col gap-6">
                  {/* Cover */}
                  <header className="card px-6 py-5">
                    <p className="label">Evidence packet</p>
                    <h2 className="title-lg mt-1 text-[26px]">
                      {manifest.client.name}
                    </h2>
                    <p className="mt-1.5 text-[14px]" style={{ color: "var(--text-secondary)" }}>
                      {manifest.scope.replace(/[._]/g, " ")} · {manifest.period.from} to {manifest.period.to}
                    </p>
                    <dl className="mt-4 grid grid-cols-2 gap-x-6 gap-y-2 text-[13px] sm:grid-cols-4">
                      <div>
                        <dt style={{ color: "var(--text-muted)" }}>Chart status</dt>
                        <dd className="font-medium">{manifest.client.status.replace(/_/g, " ")}</dd>
                      </div>
                      <div>
                        <dt style={{ color: "var(--text-muted)" }}>Admitted</dt>
                        <dd className="font-medium">{shortDate(manifest.client.admitted_on)}</dd>
                      </div>
                      <div>
                        <dt style={{ color: "var(--text-muted)" }}>Records in packet</dt>
                        <dd className="tabular font-medium">{openPacket.record_count}</dd>
                      </div>
                      <div>
                        <dt style={{ color: "var(--text-muted)" }}>Assembled</dt>
                        <dd className="font-medium">
                          {new Date(openPacket.created_at).toLocaleString(undefined, {
                            month: "short",
                            day: "numeric",
                            year: "numeric",
                            hour: "numeric",
                            minute: "2-digit",
                          })}
                        </dd>
                      </div>
                    </dl>
                  </header>

                  {/* What is in it */}
                  <section>
                    <SectionTitle icon={<IconClipboardCheck />}>What this packet contains</SectionTitle>
                    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                      {manifest.records.map((r) => (
                        <MetricTile key={r.key} label={r.label} value={r.count} hint={r.detail ?? undefined} />
                      ))}
                    </div>
                  </section>

                  {/* Integrity */}
                  <section>
                    <SectionTitle icon={<IconShield />}>Integrity</SectionTitle>
                    <div className="card px-6 py-5">
                      <div className="flex flex-wrap items-center gap-2">
                        <Badge
                          tone={
                            manifest.integrity.version_chains_intact === manifest.integrity.version_chains_checked
                              ? "success"
                              : "warning"
                          }
                          icon={
                            manifest.integrity.version_chains_intact === manifest.integrity.version_chains_checked ? (
                              <IconCheck />
                            ) : (
                              <IconAlert />
                            )
                          }
                        >
                          Version chains {manifest.integrity.version_chains_intact} of{" "}
                          {manifest.integrity.version_chains_checked} verified
                        </Badge>
                        <Badge
                          tone={
                            manifest.integrity.signatures_hash_bound === manifest.integrity.signatures_checked
                              ? "success"
                              : "warning"
                          }
                          icon={
                            manifest.integrity.signatures_hash_bound === manifest.integrity.signatures_checked ? (
                              <IconCheck />
                            ) : (
                              <IconAlert />
                            )
                          }
                        >
                          Signatures {manifest.integrity.signatures_hash_bound} of{" "}
                          {manifest.integrity.signatures_checked} bound to their version hash
                        </Badge>
                      </div>
                      <ul className="mt-4 flex flex-col gap-2.5">
                        {manifest.integrity.notes.map((n, i) => (
                          <li key={i} className="flex items-start gap-2 text-[13px] leading-relaxed">
                            <IconLock
                              width={14}
                              height={14}
                              className="mt-1 shrink-0"
                              style={{ color: "var(--accent)" }}
                            />
                            <span style={{ color: "var(--text-secondary)" }}>{n}</span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  </section>

                  {/* The index */}
                  <section>
                    <SectionTitle icon={<IconEye />}>Index</SectionTitle>
                    <div className="card px-6 py-5">
                      <p className="text-[15px] leading-relaxed">
                        {openPacket.narrative ?? deterministicIndex(manifest)}
                      </p>
                      <p className="mt-3 text-[12px] leading-relaxed" style={{ color: "var(--text-muted)" }}>
                        {openPacket.narrative
                          ? "Written with AI over the manifest below, which was assembled deterministically. Every figure in it comes from the manifest; the manifest is the evidence."
                          : "No model wrote an index for this packet, so this one is assembled by the platform from the manifest. A packet without an AI index is complete — the index is a convenience, the manifest is the evidence."}
                      </p>
                    </div>
                  </section>

                  {/* Gaps */}
                  <section>
                    <SectionTitle icon={<IconAlert />}>Gaps</SectionTitle>
                    <div className="card px-6 py-5">
                      {manifest.gaps.length === 0 ? (
                        <p className="flex items-center gap-2 text-[14px]">
                          <IconCheck width={16} height={16} style={{ color: "var(--color-success-700)" }} />
                          No gaps were detected by the checks this packet runs.
                        </p>
                      ) : (
                        <ul className="flex flex-col gap-2">
                          {manifest.gaps.map((g, i) => (
                            <li key={i} className="flex items-start gap-2 text-[14px] leading-relaxed">
                              <IconAlert
                                width={15}
                                height={15}
                                className="mt-1 shrink-0"
                                style={{ color: "var(--color-warning-700)" }}
                              />
                              {g}
                            </li>
                          ))}
                        </ul>
                      )}
                      <p className="mt-3 text-[12px] leading-relaxed" style={{ color: "var(--text-muted)" }}>
                        Gaps are stated as found. This packet describes records; it does not assert that a
                        requirement was met or that a deficiency exists.
                      </p>
                    </div>
                  </section>

                  {/* Records */}
                  <section>
                    <SectionTitle icon={<IconClipboardCheck />}>Records</SectionTitle>
                    <DataTable
                      caption="Records in this packet, with version and signature counts"
                      columns={[
                        { header: "Record" },
                        { header: "Status" },
                        { header: "Versions", align: "right" },
                        { header: "Signatures", align: "right" },
                        { header: "AI-drafted", align: "right" },
                        { header: "Chain" },
                      ]}
                      rows={manifest.forms.map((f) => ({
                        key: f.instance_id,
                        cells: [
                          <span key="t">
                            <span className="block text-[14px] font-medium">{f.template}</span>
                            <span className="tabular block text-[12px]" style={{ color: "var(--text-muted)" }}>
                              {f.instance_id.slice(0, 8)} · last authored {shortDate(f.last_authored_at)}
                            </span>
                          </span>,
                          <StatusChip key="s" status={f.status} />,
                          <span key="v" className="tabular">
                            {f.versions}
                          </span>,
                          <span key="g" className="tabular">
                            {f.signatures}
                            {f.signature_required && f.signatures === 0 ? " (required)" : ""}
                          </span>,
                          <span key="a" className="tabular">
                            {f.ai_drafted}
                          </span>,
                          f.chain_intact ? (
                            <Badge key="c" tone="success" icon={<IconCheck />}>
                              Verified
                            </Badge>
                          ) : (
                            <Badge key="c" tone="warning" icon={<IconAlert />}>
                              Not verified
                            </Badge>
                          ),
                        ],
                      }))}
                      empty={
                        <div className="card px-6 py-8 text-center text-[14px]" style={{ color: "var(--text-muted)" }}>
                          No forms are on file for this client in the period covered.
                        </div>
                      }
                    />
                  </section>

                  {/* Obligations */}
                  <section>
                    <SectionTitle icon={<IconShield />}>Compliance obligations</SectionTitle>
                    <DataTable
                      caption="Compliance cadence obligations for this client"
                      columns={[
                        { header: "Obligation" },
                        { header: "Severity" },
                        { header: "Due" },
                        { header: "State" },
                        { header: "Source" },
                      ]}
                      rows={manifest.obligations.map((o, i) => ({
                        key: `${o.rule}-${i}`,
                        cells: [
                          <span key="r" className="text-[14px] font-medium">
                            {o.rule}
                          </span>,
                          <Badge key="s" tone={severityTone(o.severity)}>
                            {o.severity}
                          </Badge>,
                          <span key="d" className="tabular">
                            {shortDate(o.due_on)}
                          </span>,
                          <Badge key="c" tone={obligationTone(o.status)}>
                            {o.status.replace(/_/g, " ")}
                          </Badge>,
                          <span key="x" className="text-[12px]" style={{ color: "var(--text-muted)" }}>
                            {o.source_ref ?? "—"}
                          </span>,
                        ],
                      }))}
                      empty={
                        <div className="card px-6 py-8 text-center text-[14px]" style={{ color: "var(--text-muted)" }}>
                          No compliance obligations are on file for this client.
                        </div>
                      }
                    />
                    <p className="mt-2 text-[12px]" style={{ color: "var(--text-muted)" }}>
                      Due dates and states are produced by the compliance engine in the database. Nothing on
                      this page recalculates them.
                    </p>
                  </section>

                  {/* Care team and visits */}
                  <section>
                    <SectionTitle icon={<IconUsers />}>Care team and delivery</SectionTitle>
                    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                      <MetricTile
                        label="Assigned staff"
                        value={manifest.credentials.care_team}
                        hint="Active assignments"
                      />
                      <MetricTile
                        label="Credentials valid"
                        value={manifest.credentials.valid}
                        tone="success"
                        hint={`${manifest.credentials.on_file} on file`}
                      />
                      <MetricTile
                        label="Expiring soon"
                        value={manifest.credentials.expiring_soon}
                        tone="warning"
                      />
                      <MetricTile
                        label="Lapsed"
                        value={manifest.credentials.lapsed}
                        tone={manifest.credentials.lapsed > 0 ? "danger" : "neutral"}
                        hint={`${manifest.credentials.lapsed_blocking} block scheduling`}
                      />
                      <MetricTile label="Visits in period" value={manifest.visits.in_period} />
                      <MetricTile label="Completed" value={manifest.visits.completed} tone="success" />
                      <MetricTile
                        label="With clock pair"
                        value={manifest.visits.with_clock_pair}
                        hint="Electronic visit verification"
                      />
                      <MetricTile
                        label="Signature roles"
                        value={manifest.signatures.roles.length}
                        hint={manifest.signatures.roles.join(", ") || "None recorded"}
                      />
                    </div>
                  </section>

                  <footer className="card px-6 py-4">
                    <p className="text-[12px] leading-relaxed" style={{ color: "var(--text-muted)" }}>
                      Assembled by {profile.name} on{" "}
                      {new Date(openPacket.created_at).toLocaleString(undefined, {
                        month: "long",
                        day: "numeric",
                        year: "numeric",
                        hour: "numeric",
                        minute: "2-digit",
                      })}
                      , under that account&rsquo;s own permissions, from records held in CareOS. This packet is
                      itself an append-only record: it is never edited, and rebuilding produces a new packet
                      alongside it. Packet identifier {openPacket.id}.
                    </p>
                  </footer>
                </article>

                <Script id="evidence-print" strategy="afterInteractive">
                  {`document.getElementById('print-packet')?.addEventListener('click',function(){window.print()});`}
                </Script>
              </>
            )}
          </div>
        </div>
      </div>
    </AppShell>
  );
}
