"use client";

/**
 * The forms runtime (docs/10 §4) — the make-or-break component.
 * Autosave ≤3s + on-blur → append-only versions via app.save_draft.
 * Conflicts: keep-both, always. Finalize: exact content + hash excerpt + intent.
 * Post-final: locked; corrections (with reason) are the only path. No overwrite button exists.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { supabaseBrowser } from "@/lib/supabase/client";
import { StatusChip } from "@/components/ui";
import { IconAlert, IconCheck, IconHistory, IconLock, IconPen } from "@/components/icons";

export type TemplateField = {
  key: string;
  label: string;
  type: "text" | "textarea" | "date" | "select" | "boolean" | "number";
  options?: string[];
  help?: string;
};

export type VersionMeta = {
  id: string;
  version_no: number;
  kind: string;
  authored_at: string;
  author_id: string;
  note: string | null;
  content_hash: string;
};

export type SignatureMeta = {
  form_version_id: string;
  signer_role: string;
  signed_at: string;
  method: string;
};

const KIND_LABEL: Record<string, string> = {
  create: "Created",
  edit: "Edited",
  correction: "Correction",
  merge: "Merged",
  import: "Imported",
  ai_draft: "AI draft",
};

function friendlyError(message: string): string {
  if (message.includes("CAREOS_AAL2_REQUIRED"))
    return "Your verified session expired. Sign in again with your authenticator — everything on this screen is kept.";
  if (message.includes("CAREOS_SIGNATURES_INCOMPLETE"))
    return "A required signature is still missing — collect it below, then finalize.";
  if (message.includes("CAREOS_NOT_AUTHORIZED"))
    return "Your role isn't one of the required signers for this form.";
  if (message.includes("CAREOS_STALE_VERSION"))
    return "A newer version was saved — review it below, then finalize the latest.";
  if (message.includes("CAREOS_INVALID_STATE"))
    return "This record's status changed. Refresh to see the latest.";
  if (message.includes("CAREOS_REASON_REQUIRED"))
    return "Corrections need a short reason — it becomes part of the permanent record.";
  return "That didn't go through. Your work is still on this screen — try again.";
}

function hashExcerpt(hex: string) {
  return hex.replace(/^\\x/, "").slice(0, 12);
}

export function FormRuntime(props: {
  instanceId: string;
  status: string;
  templateTitle: string;
  clientName: string | null;
  fields: TemplateField[];
  requiredRoles: string[];
  latest: { id: string; version_no: number; content: Record<string, unknown> };
  versions: VersionMeta[];
  signatures: SignatureMeta[];
  authorNames: Record<string, string>;
}) {
  const router = useRouter();
  const supabase = useRef(supabaseBrowser()).current;

  const [content, setContent] = useState<Record<string, unknown>>(props.latest.content ?? {});
  const [base, setBase] = useState(props.latest);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<Date | null>(null);
  const [conflict, setConflict] = useState<{
    versionId: string;
    versionNo: number;
    authorId: string;
    authoredAt: string;
    content: Record<string, unknown>;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [finalizeOpen, setFinalizeOpen] = useState(false);
  const [finalizeHash, setFinalizeHash] = useState<string | null>(null);
  const [correcting, setCorrecting] = useState(false);
  const [reason, setReason] = useState("");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const editable = props.status === "draft" || props.status === "in_review";
  const isFinal = props.status === "final";

  const signedRoles = useMemo(
    () => new Set(props.signatures.filter((s) => s.form_version_id === base.id).map((s) => s.signer_role)),
    [props.signatures, base.id]
  );

  /* ── Autosave: debounce 2.5s + flush on blur ── */
  const save = useCallback(async (next?: Record<string, unknown>) => {
    const body = next ?? content;
    setSaving(true);
    setError(null);
    const { data, error } = await supabase.schema("app").rpc("save_draft", {
      p_instance: props.instanceId,
      p_content: body,
      p_base_version: base.id,
    });
    setSaving(false);
    if (error) {
      setError(friendlyError(error.message));
      return;
    }
    const res = data as Record<string, unknown>;
    if (res.conflict) {
      setConflict({
        versionId: String(res.server_version_id),
        versionNo: Number(res.server_version_no),
        authorId: String(res.server_author_id),
        authoredAt: String(res.server_authored_at),
        content: (res.server_content ?? {}) as Record<string, unknown>,
      });
      return;
    }
    setBase({ id: String(res.version_id), version_no: Number(res.version_no), content: body });
    setDirty(false);
    setSavedAt(new Date());
  }, [content, base.id, props.instanceId, supabase]);

  const scheduleSave = useCallback((next: Record<string, unknown>) => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => void save(next), 2500);
  }, [save]);

  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  function setField(key: string, value: unknown) {
    const next = { ...content, [key]: value };
    setContent(next);
    setDirty(true);
    scheduleSave(next);
  }

  function flush() {
    if (dirty && !saving && editable && !conflict) {
      if (timer.current) clearTimeout(timer.current);
      void save();
    }
  }

  /* ── Keep-both resolution — both antecedents persist as versions ── */
  function resolveTakeTheirs() {
    if (!conflict) return;
    setContent(conflict.content);
    setBase({ id: conflict.versionId, version_no: conflict.versionNo, content: conflict.content });
    setDirty(false);
    setConflict(null);
    setSavedAt(new Date());
  }
  function resolveKeepMine() {
    if (!conflict) return;
    setBase({ id: conflict.versionId, version_no: conflict.versionNo, content: conflict.content });
    setConflict(null);
    setDirty(true);
    void save();
  }

  /* ── Sign / Finalize / Correct ── */
  async function sign() {
    flush();
    setBusy("sign");
    setError(null);
    const { error } = await supabase.schema("app").rpc("sign_version", {
      p_version: base.id,
      p_method: "click",
    });
    setBusy(null);
    if (error) { setError(friendlyError(error.message)); return; }
    router.refresh();
  }

  async function openFinalize() {
    flush();
    setError(null);
    const { data } = await supabase
      .from("form_version")
      .select("content_hash")
      .eq("id", base.id)
      .maybeSingle();
    setFinalizeHash(data ? hashExcerpt(String(data.content_hash)) : null);
    setFinalizeOpen(true);
  }

  async function finalize() {
    setBusy("finalize");
    setError(null);
    const { error } = await supabase.schema("app").rpc("finalize_form", {
      p_instance: props.instanceId,
      p_version: base.id,
    });
    setBusy(null);
    if (error) { setError(friendlyError(error.message)); setFinalizeOpen(false); return; }
    setFinalizeOpen(false);
    router.refresh();
  }

  async function submitCorrection() {
    setBusy("correct");
    setError(null);
    const { error } = await supabase.schema("app").rpc("correct_form", {
      p_instance: props.instanceId,
      p_content: content,
      p_reason: reason,
    });
    setBusy(null);
    if (error) { setError(friendlyError(error.message)); return; }
    setCorrecting(false);
    setReason("");
    router.refresh();
  }

  const conflictDiffKeys = useMemo(() => {
    if (!conflict) return [];
    return props.fields
      .map((f) => f.key)
      .filter((k) => JSON.stringify(content[k] ?? "") !== JSON.stringify(conflict.content[k] ?? ""));
  }, [conflict, content, props.fields]);

  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_290px]">
      <div className="min-w-0">
        {/* ── Conflict: keep-both, never overwrite ── */}
        {conflict && (
          <div className="card mb-5 overflow-hidden border-2" role="alertdialog"
               aria-label="Two versions of this form exist"
               style={{ borderColor: "var(--color-warning-600)" }}>
            <div className="flex items-center gap-2 px-5 py-3 text-sm font-medium"
                 style={{ background: "var(--color-warning-50)", color: "var(--color-warning-700)" }}>
              <IconAlert width={16} height={16} />
              {(props.authorNames[conflict.authorId] ?? "A teammate")} saved a version while you were editing
            </div>
            <div className="p-5">
              <p className="text-sm" style={{ color: "var(--text-secondary)" }}>
                Both versions are kept either way — nothing is lost. Choose where to continue:
              </p>
              {conflictDiffKeys.length > 0 && (
                <div className="mt-4 grid gap-3 sm:grid-cols-2">
                  <div className="card-flat p-4">
                    <p className="label">Your changes (this screen)</p>
                    {conflictDiffKeys.map((k) => (
                      <p key={k} className="mt-1 text-[13px]">
                        <span style={{ color: "var(--text-muted)" }}>
                          {props.fields.find((f) => f.key === k)?.label ?? k}:
                        </span>{" "}
                        {String(content[k] ?? "—")}
                      </p>
                    ))}
                  </div>
                  <div className="card-flat p-4">
                    <p className="label">
                      Their version ·{" "}
                      {new Date(conflict.authoredAt).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}
                    </p>
                    {conflictDiffKeys.map((k) => (
                      <p key={k} className="mt-1 text-[13px]">
                        <span style={{ color: "var(--text-muted)" }}>
                          {props.fields.find((f) => f.key === k)?.label ?? k}:
                        </span>{" "}
                        {String(conflict.content[k] ?? "—")}
                      </p>
                    ))}
                  </div>
                </div>
              )}
              <div className="mt-4 flex flex-wrap gap-2">
                <button className="btn btn-primary" onClick={resolveKeepMine}>
                  Keep my changes on top
                </button>
                <button className="btn btn-secondary" onClick={resolveTakeTheirs}>
                  Continue from theirs
                </button>
              </div>
            </div>
          </div>
        )}

        {/* ── Final banner ── */}
        {isFinal && !correcting && (
          <div className="card mb-5 flex items-center gap-3 px-5 py-4"
               style={{ background: "var(--accent-soft)", borderColor: "var(--accent-soft-border)" }}>
            <IconLock style={{ color: "var(--accent)" }} />
            <div className="flex-1 text-sm" style={{ color: "var(--text-secondary)" }}>
              This record is final. It can't be edited — a correction creates a new version with a reason,
              and every earlier version stays on file.
            </div>
            <button className="btn btn-secondary btn-sm" onClick={() => setCorrecting(true)}>
              <IconPen width={14} height={14} />
              Create correction
            </button>
          </div>
        )}

        {correcting && (
          <div className="card mb-5 p-5" style={{ borderColor: "var(--accent-soft-border)" }}>
            <p className="text-sm font-medium">Correction reason</p>
            <p className="mt-0.5 text-[13px]" style={{ color: "var(--text-muted)" }}>
              Becomes part of the permanent record — say what was wrong, plainly.
            </p>
            <textarea
              className="textarea mt-3"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="e.g. Visit date was entered as the 12th; it was the 13th."
            />
            <div className="mt-3 flex gap-2">
              <button className="btn btn-primary" disabled={!reason.trim() || busy === "correct"} onClick={submitCorrection}>
                {busy === "correct" ? "Filing…" : "File correction"}
              </button>
              <button className="btn btn-ghost" onClick={() => { setCorrecting(false); setReason(""); }}>
                Cancel
              </button>
            </div>
          </div>
        )}

        {/* ── The form itself ── */}
        <div className="card p-6">
          <div className="flex flex-col gap-6">
            {props.fields.map((f) => {
              const value = content[f.key];
              const disabled = (!editable && !correcting) || !!conflict;
              return (
                <div key={f.key}>
                  <label className="label" htmlFor={`f-${f.key}`}>{f.label}</label>
                  {f.type === "textarea" ? (
                    <textarea
                      id={`f-${f.key}`}
                      className="textarea"
                      disabled={disabled}
                      value={String(value ?? "")}
                      onChange={(e) => setField(f.key, e.target.value)}
                      onBlur={flush}
                    />
                  ) : f.type === "select" ? (
                    <select
                      id={`f-${f.key}`}
                      className="select"
                      disabled={disabled}
                      value={String(value ?? "")}
                      onChange={(e) => { setField(f.key, e.target.value); }}
                      onBlur={flush}
                    >
                      <option value="">Choose…</option>
                      {f.options?.map((o) => <option key={o} value={o}>{o}</option>)}
                    </select>
                  ) : f.type === "boolean" ? (
                    <label className="flex h-11 cursor-pointer items-center gap-3 text-[15px]">
                      <input
                        id={`f-${f.key}`}
                        type="checkbox"
                        className="size-5 accent-[var(--accent)]"
                        disabled={disabled}
                        checked={Boolean(value)}
                        onChange={(e) => { setField(f.key, e.target.checked); flush(); }}
                      />
                      Yes
                    </label>
                  ) : (
                    <input
                      id={`f-${f.key}`}
                      type={f.type === "date" ? "date" : f.type === "number" ? "number" : "text"}
                      className="input"
                      disabled={disabled}
                      value={String(value ?? "")}
                      onChange={(e) => setField(f.key, e.target.value)}
                      onBlur={flush}
                    />
                  )}
                  {f.help && <p className="mt-1.5 text-xs" style={{ color: "var(--text-muted)" }}>{f.help}</p>}
                </div>
              );
            })}
          </div>
        </div>

        {error && (
          <p role="alert" className="mt-4 rounded-md px-4 py-3 text-sm"
             style={{ background: "var(--color-danger-50)", color: "var(--color-danger-700)" }}>
            {error}
          </p>
        )}

        {/* ── Finalize review ── */}
        {finalizeOpen && (
          <div className="card mt-5 p-5" role="dialog" aria-label="Finalize this record"
               style={{ borderColor: "var(--accent-soft-border)" }}>
            <p className="text-[15px] font-semibold">Finalize as a permanent record</p>
            <p className="mt-1 text-sm" style={{ color: "var(--text-secondary)" }}>
              Finalizing locks version {base.version_no} exactly as shown above. After this, changes
              happen only as corrections — with a reason, on the record.
            </p>
            {finalizeHash && (
              <p className="tabular mt-2 text-xs" style={{ color: "var(--text-muted)" }}>
                Record fingerprint: <code>{finalizeHash}</code>
              </p>
            )}
            <div className="mt-4 flex gap-2">
              <button className="btn btn-primary" disabled={busy === "finalize"} onClick={finalize}>
                {busy === "finalize" ? "Finalizing…" : `Finalize version ${base.version_no}`}
              </button>
              <button className="btn btn-ghost" onClick={() => setFinalizeOpen(false)}>Not yet</button>
            </div>
          </div>
        )}
      </div>

      {/* ── Side rail: status, signatures, actions, history ── */}
      <aside className="flex flex-col gap-4">
        <div className="card p-5">
          <div className="flex items-center justify-between">
            <StatusChip status={props.status} />
            <span aria-live="polite" className="text-xs" style={{ color: "var(--text-muted)" }}>
              {saving ? "Saving…" : dirty ? "Unsaved changes" : savedAt ? (
                <span className="inline-flex items-center gap-1">
                  <IconCheck width={12} height={12} style={{ color: "var(--color-success-600)" }} />
                  Saved {savedAt.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}
                </span>
              ) : `Version ${base.version_no}`}
            </span>
          </div>

          {props.requiredRoles.length > 0 && (
            <div className="mt-4 border-t pt-4 hairline">
              <p className="label">Required signatures</p>
              <ul className="mt-1 space-y-1.5">
                {props.requiredRoles.map((r) => (
                  <li key={r} className="flex items-center gap-2 text-[13px]">
                    {signedRoles.has(r) ? (
                      <>
                        <IconCheck width={14} height={14} style={{ color: "var(--color-success-600)" }} />
                        <span>{r.toUpperCase()} — signed</span>
                      </>
                    ) : (
                      <>
                        <span aria-hidden className="inline-block size-3.5 rounded-full border-2"
                              style={{ borderColor: "var(--border-strong)" }} />
                        <span style={{ color: "var(--text-muted)" }}>{r.toUpperCase()} — waiting</span>
                      </>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {editable && (
            <div className="mt-4 flex flex-col gap-2 border-t pt-4 hairline">
              {props.requiredRoles.length > 0 && (
                <button className="btn btn-secondary" disabled={busy === "sign" || !!conflict} onClick={sign}>
                  <IconPen width={15} height={15} />
                  {busy === "sign" ? "Signing…" : "Sign this version"}
                </button>
              )}
              <button className="btn btn-primary" disabled={!!conflict || saving} onClick={openFinalize}>
                Review &amp; finalize
              </button>
            </div>
          )}
        </div>

        <div className="card p-5">
          <p className="mb-3 flex items-center gap-2 text-[13px] font-semibold">
            <IconHistory width={15} height={15} style={{ color: "var(--text-muted)" }} />
            History
          </p>
          <ol className="relative space-y-4 border-l pl-4 hairline">
            {props.versions.map((v) => (
              <li key={v.id} className="relative">
                <span aria-hidden className="absolute -left-[21.5px] top-1.5 size-2.5 rounded-full border-2"
                      style={{ background: "var(--panel)", borderColor: v.kind === "correction" ? "var(--color-warning-600)" : "var(--accent)" }} />
                <p className="text-[13px] font-medium">
                  {KIND_LABEL[v.kind] ?? v.kind} · v{v.version_no}
                </p>
                <p className="text-xs" style={{ color: "var(--text-muted)" }}>
                  {props.authorNames[v.author_id] ?? "Staff member"} ·{" "}
                  {new Date(v.authored_at).toLocaleString(undefined, {
                    month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
                  })}
                </p>
                {v.note && <p className="mt-0.5 text-xs italic" style={{ color: "var(--text-secondary)" }}>"{v.note}"</p>}
                <p className="tabular mt-0.5 text-[10px]" style={{ color: "var(--text-muted)" }}>
                  {hashExcerpt(v.content_hash)}
                </p>
              </li>
            ))}
          </ol>
          {props.signatures.length > 0 && (
            <div className="mt-4 border-t pt-3 hairline">
              <p className="label">Signatures</p>
              {props.signatures.map((s, i) => (
                <p key={i} className="mt-1 flex items-center gap-1.5 text-xs" style={{ color: "var(--text-secondary)" }}>
                  <IconPen width={12} height={12} />
                  {s.signer_role.toUpperCase()} ·{" "}
                  {new Date(s.signed_at).toLocaleString(undefined, {
                    month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
                  })}
                </p>
              ))}
            </div>
          )}
        </div>
      </aside>
    </div>
  );
}
