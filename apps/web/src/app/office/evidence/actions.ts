"use server";

/**
 * Evidence packet assembly — the surveyor "show me" moment (docs/16 §2.2 O2, Wave 5).
 *
 * The doctrine this file implements, in one sentence: the packet is DETERMINISTIC and the
 * index is an accelerant. Assembly is SQL under the caller's own RLS — record identifiers,
 * version chains, signature bindings, obligation states, credential buckets, visit counts.
 * A model is asked for exactly one thing, afterwards: the plain-language index that sits on
 * top of a manifest that is already complete. A packet whose `narrative` is null is a
 * complete, defensible packet (the seeded demo packet says so on purpose) — so when the
 * model is unavailable, nothing is stored in its place and the surface renders the
 * platform's own index instead, labelled as such.
 *
 * Invariants at work here:
 *   · 1 — evidence_packet is append-only. Rebuilding produces a NEW packet; a packet is
 *     never edited, so what a surveyor was handed on a given day stays exactly what they
 *     were handed. `record_count` and `manifest` are frozen at assembly time.
 *   · 2/9 — every query runs as the requester. There is no privileged assembly path; two
 *     people with different permissions legitimately assemble different packets, and the
 *     RLS-scoped read is what makes the packet defensible rather than merely impressive.
 *   · 3 — every table touched here is PHI and every policy demands AAL2 already.
 *   · 5 — the model's input carries counts, dates, statuses, rule names and an id prefix.
 *     No client name, no address, no note content, no signer identity.
 *   · 13 — obligation due dates and statuses come from `cadence_obligation_status`, and
 *     credential buckets from `credential_expiry`. Nothing here recomputes a deadline.
 */

import { redirect } from "next/navigation";
import { supabaseServer } from "@/lib/supabase/server";
import { digest, runCapability } from "@/lib/ai/client";

/* ── Manifest shape (imported type-only by the page) ─────────────────────────── */

export type ManifestGroup = { key: string; label: string; count: number; detail: string | null };

export type ManifestForm = {
  instance_id: string;
  template: string;
  status: string;
  versions: number;
  latest_version: number | null;
  signatures: number;
  signature_required: boolean;
  ai_drafted: number;
  last_authored_at: string | null;
  chain_intact: boolean;
};

export type ManifestObligation = {
  rule: string;
  severity: string;
  due_on: string | null;
  status: string;
  source_ref: string | null;
};

export type EvidenceManifest = {
  version: 1;
  scope: string;
  generated_at: string;
  period: { from: string; to: string };
  client: {
    id: string;
    name: string;
    status: string;
    admitted_on: string | null;
    city: string | null;
    state: string | null;
  };
  records: ManifestGroup[];
  forms: ManifestForm[];
  signatures: { total: number; roles: string[]; latest: string | null };
  integrity: {
    version_chains_checked: number;
    version_chains_intact: number;
    signatures_checked: number;
    signatures_hash_bound: number;
    notes: string[];
  };
  obligations: ManifestObligation[];
  credentials: {
    care_team: number;
    on_file: number;
    valid: number;
    expiring_soon: number;
    lapsed: number;
    lapsed_blocking: number;
  };
  visits: { in_period: number; completed: number; with_clock_pair: number };
  gaps: string[];
};

export type EvidencePacketView = {
  id: string;
  client_id: string | null;
  scope: string;
  record_count: number;
  manifest: EvidenceManifest;
  narrative: string | null;
  created_at: string;
};

/* ── Constants ───────────────────────────────────────────────────────────────── */

const CAPABILITY = "evidence.index";
const PERIOD_DAYS = 365;
const SCOPE = "client_record.trailing_12_months";
const ID_CHUNK = 60;

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function chunk<T>(items: T[], size = ID_CHUNK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/* ── Row shapes read from Postgres ───────────────────────────────────────────── */

type ClientRow = {
  id: string;
  first_name: string;
  last_name: string;
  status: string;
  admitted_on: string | null;
  city: string | null;
  state: string | null;
};
type InstanceRow = { id: string; template_id: string; status: string; created_at: string; updated_at: string };
type TemplateRow = { id: string; title: string; requires_signature_roles: string[] | null };
type VersionRow = {
  id: string;
  instance_id: string;
  version_no: number;
  prev_version_id: string | null;
  content_hash: string;
  kind: string;
  authored_at: string;
};
type SignatureRow = {
  id: string;
  form_version_id: string;
  signer_role: string;
  signed_at: string;
  content_hash: string;
};
type ObligationRow = {
  rule_name: string;
  severity: string;
  due_on: string | null;
  computed_status: string;
  comar_source_ref: string | null;
};
type CredentialRow = { status: string; expiry_bucket: string; blocks_scheduling: boolean };
type VisitRow = { id: string; status: string };

/* ── Assembly ────────────────────────────────────────────────────────────────── */

type Supabase = Awaited<ReturnType<typeof supabaseServer>>;

async function assembleManifest(
  supabase: Supabase,
  clientId: string
): Promise<EvidenceManifest | null> {
  const to = new Date();
  const from = new Date(to.getTime() - PERIOD_DAYS * 86_400_000);

  const { data: clientRow } = await supabase
    .from("client")
    .select("id, first_name, last_name, status, admitted_on, city, state")
    .eq("id", clientId)
    .maybeSingle();
  if (!clientRow) return null;
  const client = clientRow as ClientRow;

  // ── Forms, their version chains, and the signatures bound to those versions ──
  const { data: instanceRows } = await supabase
    .from("form_instance")
    .select("id, template_id, status, created_at, updated_at")
    .eq("client_id", clientId)
    .order("created_at", { ascending: true })
    .limit(500);
  const instances = (instanceRows ?? []) as InstanceRow[];

  const templateIds = [...new Set(instances.map((i) => i.template_id))];
  const templates = new Map<string, TemplateRow>();
  for (const ids of chunk(templateIds)) {
    const { data } = await supabase
      .from("form_template")
      .select("id, title, requires_signature_roles")
      .in("id", ids);
    for (const t of (data ?? []) as TemplateRow[]) templates.set(t.id, t);
  }

  const instanceIds = instances.map((i) => i.id);
  const versions: VersionRow[] = [];
  for (const ids of chunk(instanceIds)) {
    const { data } = await supabase
      .from("form_version")
      .select("id, instance_id, version_no, prev_version_id, content_hash, kind, authored_at")
      .in("instance_id", ids)
      .order("version_no", { ascending: true })
      .limit(1000);
    versions.push(...((data ?? []) as VersionRow[]));
  }

  const versionIds = versions.map((v) => v.id);
  const signatures: SignatureRow[] = [];
  for (const ids of chunk(versionIds)) {
    const { data } = await supabase
      .from("signature")
      .select("id, form_version_id, signer_role, signed_at, content_hash")
      .in("form_version_id", ids)
      .limit(1000);
    signatures.push(...((data ?? []) as SignatureRow[]));
  }

  const versionById = new Map(versions.map((v) => [v.id, v]));
  const versionsByInstance = new Map<string, VersionRow[]>();
  for (const v of versions) {
    const list = versionsByInstance.get(v.instance_id) ?? [];
    list.push(v);
    versionsByInstance.set(v.instance_id, list);
  }
  const signaturesByVersion = new Map<string, SignatureRow[]>();
  for (const s of signatures) {
    const list = signaturesByVersion.get(s.form_version_id) ?? [];
    list.push(s);
    signaturesByVersion.set(s.form_version_id, list);
  }

  // Integrity check 1 — the version chain. Each instance's versions must run 1..N with
  // every prev_version_id pointing at the version before it. This is the append-only
  // history made checkable: a re-numbered or re-parented history shows up here.
  let chainsIntact = 0;
  const forms: ManifestForm[] = instances.map((inst) => {
    const list = (versionsByInstance.get(inst.id) ?? []).slice().sort((a, b) => a.version_no - b.version_no);
    let intact = list.length > 0;
    for (let i = 0; i < list.length; i += 1) {
      const expectedNo = i + 1;
      const expectedPrev = i === 0 ? null : list[i - 1].id;
      if (list[i].version_no !== expectedNo || (list[i].prev_version_id ?? null) !== expectedPrev) {
        intact = false;
        break;
      }
    }
    if (intact) chainsIntact += 1;
    const template = templates.get(inst.template_id);
    const sigCount = list.reduce((n, v) => n + (signaturesByVersion.get(v.id)?.length ?? 0), 0);
    return {
      instance_id: inst.id,
      template: template?.title ?? "Form",
      status: inst.status,
      versions: list.length,
      latest_version: list.length ? list[list.length - 1].version_no : null,
      signatures: sigCount,
      signature_required: (template?.requires_signature_roles ?? []).length > 0,
      ai_drafted: list.filter((v) => v.kind === "ai_draft").length,
      last_authored_at: list.length ? list[list.length - 1].authored_at : null,
      chain_intact: intact,
    };
  });

  // Integrity check 2 — every signature resolves to the exact content hash of the version
  // it signed. The database enforces this with a composite foreign key; re-checking it at
  // assembly time is what lets the packet SAY so.
  let hashBound = 0;
  for (const s of signatures) {
    const v = versionById.get(s.form_version_id);
    if (v && String(v.content_hash) === String(s.content_hash)) hashBound += 1;
  }

  // ── Obligations (deterministic engine output, invariant 13) ────────────────
  const { data: obligationRows } = await supabase
    .from("cadence_obligation_status")
    .select("rule_name, severity, due_on, computed_status, comar_source_ref")
    .eq("client_id", clientId)
    .order("due_on", { ascending: true })
    .limit(200);
  const obligations = ((obligationRows ?? []) as ObligationRow[]).map((o) => ({
    rule: o.rule_name,
    severity: o.severity,
    due_on: o.due_on,
    status: o.computed_status,
    source_ref: o.comar_source_ref,
  }));

  // ── The care team and its credentials (expiry buckets from the SQL engine) ──
  const { data: teamRows } = await supabase
    .from("care_team_assignment")
    .select("user_id")
    .eq("client_id", clientId)
    .is("ends_on", null)
    .limit(200);
  const teamIds = [...new Set(((teamRows ?? []) as { user_id: string }[]).map((r) => r.user_id))];
  const credentials: CredentialRow[] = [];
  for (const ids of chunk(teamIds)) {
    const { data } = await supabase
      .from("credential_expiry")
      .select("status, expiry_bucket, blocks_scheduling")
      .in("app_user_id", ids)
      .limit(500);
    credentials.push(...((data ?? []) as CredentialRow[]));
  }
  const credentialSummary = {
    care_team: teamIds.length,
    on_file: credentials.length,
    valid: credentials.filter((c) => c.expiry_bucket === "valid" && c.status === "verified").length,
    expiring_soon: credentials.filter((c) => c.expiry_bucket === "expiring_soon").length,
    lapsed: credentials.filter((c) => c.expiry_bucket === "lapsed").length,
    lapsed_blocking: credentials.filter((c) => c.expiry_bucket === "lapsed" && c.blocks_scheduling).length,
  };

  // ── Visits in the period and their EVV clock pairs ─────────────────────────
  const { data: visitRows } = await supabase
    .from("visit")
    .select("id, status")
    .eq("client_id", clientId)
    .gte("scheduled_start", from.toISOString())
    .order("scheduled_start", { ascending: true })
    .limit(600);
  const visits = (visitRows ?? []) as VisitRow[];
  const completedVisitIds = visits.filter((v) => v.status === "completed").map((v) => v.id);
  const clockIn = new Set<string>();
  const clockOut = new Set<string>();
  for (const ids of chunk(completedVisitIds)) {
    const { data } = await supabase
      .from("visit_event")
      .select("visit_id, event_type")
      .in("visit_id", ids)
      .limit(2000);
    for (const e of (data ?? []) as { visit_id: string; event_type: string }[]) {
      if (e.event_type === "clock_in") clockIn.add(e.visit_id);
      if (e.event_type === "clock_out") clockOut.add(e.visit_id);
    }
  }
  const paired = completedVisitIds.filter((id) => clockIn.has(id) && clockOut.has(id)).length;

  // ── Gaps: stated plainly, never explained away (docs/16 evidence.index rule 4) ──
  const gaps: string[] = [];
  const unsignedFinal = forms.filter((f) => f.status === "final" && f.signature_required && f.signatures === 0);
  if (unsignedFinal.length > 0) {
    gaps.push(
      `${unsignedFinal.length} finalized record${unsignedFinal.length === 1 ? "" : "s"} require a signature and none is on file.`
    );
  }
  const overdue = obligations.filter((o) => o.status === "overdue");
  if (overdue.length > 0) {
    gaps.push(`${overdue.length} compliance obligation${overdue.length === 1 ? " is" : "s are"} past due.`);
  }
  if (credentialSummary.lapsed > 0) {
    gaps.push(
      `${credentialSummary.lapsed} credential${credentialSummary.lapsed === 1 ? "" : "s"} on the care team ${credentialSummary.lapsed === 1 ? "has" : "have"} lapsed, ${credentialSummary.lapsed_blocking} of which block scheduling.`
    );
  }
  const unpaired = completedVisitIds.length - paired;
  if (unpaired > 0) {
    gaps.push(
      `${unpaired} completed visit${unpaired === 1 ? "" : "s"} in the period ${unpaired === 1 ? "does" : "do"} not have both an electronic clock-in and clock-out.`
    );
  }
  const brokenChains = forms.length - chainsIntact;
  if (brokenChains > 0) {
    gaps.push(
      `${brokenChains} record chain${brokenChains === 1 ? "" : "s"} could not be verified end to end from the versions visible to the person assembling this packet.`
    );
  }
  if (forms.length === 0) {
    gaps.push("No forms are on file for this client in the period covered.");
  }

  const records: ManifestGroup[] = [
    { key: "form_instance", label: "Records", count: forms.length, detail: "Forms on the chart" },
    {
      key: "form_version",
      label: "Versions",
      count: versions.length,
      detail: "Immutable versions across those records",
    },
    { key: "signature", label: "Signatures", count: signatures.length, detail: "Bound to a version hash" },
    {
      key: "obligation",
      label: "Obligations",
      count: obligations.length,
      detail: "Compliance cadence items for this client",
    },
    { key: "visit", label: "Visits", count: visits.length, detail: "Scheduled in the period" },
    {
      key: "credential",
      label: "Care-team credentials",
      count: credentialSummary.on_file,
      detail: `Across ${credentialSummary.care_team} assigned staff`,
    },
    {
      key: "ai_draft",
      label: "AI-drafted versions",
      count: forms.reduce((n, f) => n + f.ai_drafted, 0),
      detail: "Each reviewed and signed by a person",
    },
  ];

  return {
    version: 1,
    scope: SCOPE,
    generated_at: new Date().toISOString(),
    period: { from: isoDate(from), to: isoDate(to) },
    client: {
      id: client.id,
      name: `${client.first_name} ${client.last_name}`,
      status: client.status,
      admitted_on: client.admitted_on,
      city: client.city,
      state: client.state,
    },
    records,
    forms,
    signatures: {
      total: signatures.length,
      roles: [...new Set(signatures.map((s) => s.signer_role))].sort(),
      latest:
        signatures.length > 0
          ? signatures.map((s) => s.signed_at).sort().slice(-1)[0]
          : null,
    },
    integrity: {
      version_chains_checked: forms.length,
      version_chains_intact: chainsIntact,
      signatures_checked: signatures.length,
      signatures_hash_bound: hashBound,
      notes: [
        "Every version in this packet is append-only: a correction is a new version that references what it corrects, and no row is ever overwritten or deleted.",
        "Each signature is bound to the content hash of the exact version it signed by a database foreign key, and that binding was re-checked when this packet was assembled.",
        "The tamper-evident audit ledger is hash-chained per tenant and verified by the nightly anchor job. It is not readable from an application session by design, so this packet reports the record chains it can verify rather than claiming the ledger's own result.",
        "This packet was assembled under the permissions of the person who generated it. It contains what they are entitled to read, and nothing beyond it.",
      ],
    },
    obligations,
    credentials: credentialSummary,
    visits: { in_period: visits.length, completed: completedVisitIds.length, with_clock_pair: paired },
    gaps,
  };
}

/* ── The one model call: the plain-language index over a finished manifest ───── */

async function writeNarrative(
  supabase: Supabase,
  manifest: EvidenceManifest
): Promise<{ narrative: string | null; degraded: boolean }> {
  // PHI-minimized facts (invariant 5): counts, dates, statuses, rule names, an id prefix.
  const facts = {
    scope: manifest.scope,
    client_ref: manifest.client.id.slice(0, 8),
    client_status: manifest.client.status,
    period: manifest.period,
    records: manifest.records.map((r) => ({ kind: r.key, count: r.count })),
    forms: manifest.forms.map((f) => ({
      template: f.template,
      status: f.status,
      versions: f.versions,
      signatures: f.signatures,
      signature_required: f.signature_required,
      ai_drafted: f.ai_drafted,
      chain_intact: f.chain_intact,
    })),
    integrity: {
      version_chains_checked: manifest.integrity.version_chains_checked,
      version_chains_intact: manifest.integrity.version_chains_intact,
      signatures_checked: manifest.integrity.signatures_checked,
      signatures_hash_bound: manifest.integrity.signatures_hash_bound,
    },
    obligations: manifest.obligations.map((o) => ({
      rule: o.rule,
      severity: o.severity,
      due_on: o.due_on,
      status: o.status,
      source_ref: o.source_ref,
    })),
    credentials: manifest.credentials,
    visits: manifest.visits,
    gaps: manifest.gaps,
  };

  const run = await runCapability(supabase, CAPABILITY, {
    // The ACTIVE registry prompt (ai_prompt_template · evidence.index v1) overrides this.
    system:
      "You are the CareOS evidence-packet indexer. Describe only what the manifest contains, using " +
      "its counts, dates and identifiers. Never state a number the manifest does not contain, never " +
      "assert compliance or its absence, and state any gap plainly. Plain language, sentence case.",
    user:
      "Write the plain-language index for this deterministically assembled evidence packet. " +
      "Four to eight sentences.\n\nManifest facts:\n" +
      JSON.stringify(facts),
    temperature: 0,
    maxToolRounds: 0,
    inputDigest: digest(
      `evidence index · ${manifest.records.reduce((n, r) => n + r.count, 0)} records · ${manifest.gaps.length} gaps`,
      200
    ),
    fallback: () => ({ text: "", abstained: true }),
  });

  const text = run.status === "ok" ? run.text.trim() : "";
  // Nothing is stored in the model's place: a null narrative is a complete packet.
  return { narrative: text ? text.slice(0, 4000) : null, degraded: !text };
}

/* ── The action the page's form posts to ─────────────────────────────────────── */

function back(clientId: string, extra: Record<string, string> = {}): string {
  const p = new URLSearchParams({ client: clientId, ...extra });
  return `/office/evidence?${p.toString()}`;
}

/**
 * Assemble and file one evidence packet for a client, then show it.
 *
 * Filing is append-only: this always writes a NEW packet, so a packet handed to a surveyor
 * last month stays byte-for-byte what they were handed. Failures come back as a query
 * parameter the page renders — the surface never shows a stack trace, and no partial packet
 * is ever stored.
 */
export async function buildEvidencePacket(formData: FormData): Promise<void> {
  const clientId = String(formData.get("client") ?? "").trim();
  if (!clientId) redirect("/office/evidence?error=noclient");

  const supabase = await supabaseServer();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { data: me } = await supabase.from("app_user").select("tenant_id").eq("id", user.id).maybeSingle();
  const tenantId = (me as { tenant_id: string } | null)?.tenant_id;
  if (!tenantId) redirect(back(clientId, { error: "session" }));

  const manifest = await assembleManifest(supabase, clientId);
  if (!manifest) redirect(back(clientId, { error: "notfound" }));

  const { narrative } = await writeNarrative(supabase, manifest);
  const recordCount = manifest.records.reduce((n, r) => n + r.count, 0);

  const { data: packet, error } = await supabase
    .from("evidence_packet")
    .insert({
      tenant_id: tenantId,
      client_id: clientId,
      scope: manifest.scope,
      record_count: recordCount,
      manifest,
      narrative,
      generated_by: user.id,
    })
    .select("id")
    .single();

  if (error || !packet) redirect(back(clientId, { error: "denied" }));

  redirect(back(clientId, { packet: (packet as { id: string }).id }));
}
