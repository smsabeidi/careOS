"use client";

/**
 * Workforce action forms — small client shells over the server actions. Every guard
 * lives in the database; these render plain-language results and never assume success.
 * Separation is a two-step confirm with the consequence list spelled out (docs/10:
 * one next action, no surprises, no dark automation).
 */

import { useActionState, useState } from "react";
import type { ActionResult } from "./actions";
import {
  completeOnboardingItem,
  completeRevocationStep,
  inviteStaff,
  reinstateUser,
  revokeInvitation,
  separateUser,
  suspendUser,
  waiveOnboardingItem,
} from "./actions";

const idle: ActionResult = { ok: true, message: "" };

function ResultLine({ state }: { state: ActionResult }) {
  if (!state.message) return null;
  return (
    <p
      className="mt-2 text-[13px]"
      style={{ color: state.ok ? "var(--text-secondary)" : "var(--danger, #b00020)" }}
      role="status"
    >
      {state.message}
    </p>
  );
}

const inputCls =
  "w-full rounded-[10px] border px-3 py-2 text-[15px] outline-none " +
  "focus:ring-2 focus:ring-[var(--accent,#007AFF)]/40";
const inputStyle = { borderColor: "var(--separator, #d1d1d6)", background: "var(--bg-elevated, #fff)" };
const btnPrimary =
  "rounded-full px-4 py-2 text-[14px] font-medium text-white disabled:opacity-40";
const btnQuiet =
  "rounded-full px-3 py-1.5 text-[13px] font-medium";

/* ── Invite ───────────────────────────────────────────────────────────────── */

export function InviteForm({
  roles,
}: {
  roles: { id: string; key: string; name: string }[];
}) {
  const [state, action, pending] = useActionState(
    async (_prev: ActionResult, fd: FormData) => inviteStaff(fd),
    idle
  );
  const [copied, setCopied] = useState(false);

  return (
    <form action={action} className="flex flex-col gap-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <input name="full_name" placeholder="Full name" required aria-label="Full name"
          className={inputCls} style={inputStyle} />
        <input name="email" type="email" placeholder="Work email" required aria-label="Work email"
          className={inputCls} style={inputStyle} />
        <select name="role_id" required aria-label="Role" className={inputCls} style={inputStyle}>
          <option value="">Role…</option>
          {roles.map((r) => (
            <option key={r.id} value={r.id}>{r.name}</option>
          ))}
        </select>
        <select name="role_title" required aria-label="Title" className={inputCls} style={inputStyle}>
          <option value="">Title…</option>
          {["RN", "LPN", "CNA", "HHA", "Coordinator", "Office"].map((t) => (
            <option key={t} value={t}>{t}</option>
          ))}
        </select>
      </div>
      <div>
        <button type="submit" disabled={pending} className={btnPrimary}
          style={{ background: "var(--accent, #007AFF)" }}>
          {pending ? "Inviting…" : "Send invitation"}
        </button>
      </div>
      <ResultLine state={state} />
      {state.ok && state.inviteLink ? (
        <div className="card flex items-center gap-2 p-3">
          <code className="min-w-0 flex-1 truncate text-[12px]">{state.inviteLink}</code>
          <button
            type="button"
            className={btnQuiet}
            style={{ background: "var(--fill-secondary, #f2f2f7)" }}
            onClick={async () => {
              await navigator.clipboard.writeText(state.inviteLink ?? "");
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            }}
          >
            {copied ? "Copied" : "Copy link"}
          </button>
        </div>
      ) : null}
    </form>
  );
}

/* ── One-shot forms (revoke invite, reinstate, checklist + onboarding acts) ── */

type NamedAction = (fd: FormData) => Promise<ActionResult>;
const ACTIONS: Record<string, NamedAction> = {
  revokeInvitation,
  reinstateUser,
  completeRevocationStep,
  completeOnboardingItem,
};

export function QuickAction({
  action,
  label,
  fields,
  quiet = true,
}: {
  action: keyof typeof ACTIONS;
  label: string;
  fields: Record<string, string>;
  quiet?: boolean;
}) {
  const fn = ACTIONS[action];
  const [state, act, pending] = useActionState(
    async (_prev: ActionResult, fd: FormData) => fn(fd),
    idle
  );
  return (
    <form action={act} className="inline-flex flex-col items-end">
      {Object.entries(fields).map(([k, v]) => (
        <input key={k} type="hidden" name={k} value={v} />
      ))}
      <button type="submit" disabled={pending}
        className={quiet ? btnQuiet : btnPrimary}
        style={quiet
          ? { background: "var(--fill-secondary, #f2f2f7)" }
          : { background: "var(--accent, #007AFF)" }}>
        {pending ? "Working…" : label}
      </button>
      <ResultLine state={state} />
    </form>
  );
}

/* ── Reason-carrying forms: suspend, waive ────────────────────────────────── */

export function ReasonAction({
  kind,
  label,
  placeholder,
  fields,
}: {
  kind: "suspend" | "waive";
  label: string;
  placeholder: string;
  fields: Record<string, string>;
}) {
  const fn = kind === "suspend" ? suspendUser : waiveOnboardingItem;
  const [state, act, pending] = useActionState(
    async (_prev: ActionResult, fd: FormData) => fn(fd),
    idle
  );
  return (
    <form action={act} className="flex w-full items-start gap-2">
      {Object.entries(fields).map(([k, v]) => (
        <input key={k} type="hidden" name={k} value={v} />
      ))}
      <input name="reason" required placeholder={placeholder} aria-label="Reason"
        className={inputCls + " flex-1"} style={inputStyle} />
      <button type="submit" disabled={pending} className={btnQuiet}
        style={{ background: "var(--fill-secondary, #f2f2f7)" }}>
        {pending ? "…" : label}
      </button>
      <ResultLine state={state} />
    </form>
  );
}

/* ── Separation: two-step confirm with the consequence list ───────────────── */

export function SeparateForm({ userId, fullName }: { userId: string; fullName: string }) {
  const [armed, setArmed] = useState(false);
  const [state, act, pending] = useActionState(
    async (_prev: ActionResult, fd: FormData) => separateUser(fd),
    idle
  );

  if (!armed) {
    return (
      <button type="button" className={btnQuiet}
        style={{ background: "var(--fill-secondary, #f2f2f7)", color: "var(--danger, #b00020)" }}
        onClick={() => setArmed(true)}>
        Separate {fullName}…
      </button>
    );
  }
  return (
    <form action={act} className="card flex flex-col gap-3 p-4"
      style={{ borderColor: "var(--danger, #b00020)" }}>
      <p className="text-[14px] font-medium">Separating {fullName} will, immediately:</p>
      <ul className="ml-4 list-disc text-[13px]" style={{ color: "var(--text-secondary)" }}>
        <li>close their access — every open session goes dark at commit</li>
        <li>end their care-team assignments and vacate their future visits</li>
        <li>open the six-step revocation checklist with the 15-minute clock</li>
      </ul>
      <p className="text-[13px]" style={{ color: "var(--text-secondary)" }}>
        There is no undo. Rehiring means a fresh invitation and a fresh file.
      </p>
      <input type="hidden" name="user_id" value={userId} />
      <input name="reason" required placeholder="Reason (goes on the record)" aria-label="Reason"
        className={inputCls} style={inputStyle} />
      <div className="flex gap-2">
        <button type="submit" disabled={pending} className={btnPrimary}
          style={{ background: "var(--danger, #b00020)" }}>
          {pending ? "Separating…" : "Confirm separation"}
        </button>
        <button type="button" className={btnQuiet}
          style={{ background: "var(--fill-secondary, #f2f2f7)" }}
          onClick={() => setArmed(false)}>
          Cancel
        </button>
      </div>
      <ResultLine state={state} />
    </form>
  );
}
