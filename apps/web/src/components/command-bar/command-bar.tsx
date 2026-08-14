"use client";

/**
 * The command bar (ST-232) — one door onto the agency, on every authenticated surface.
 *
 * It opens with ⌘K / Ctrl-K, with "/" when nobody is typing, and with a button that is
 * always visible: a top-bar control on a desktop, a thumb-reachable button above the tab
 * bar on a phone. The button is not decoration — a caregiver on an Android in a basement
 * has no keyboard shortcut, and a feature only reachable by chord is a feature only the
 * office has.
 *
 * WHAT THIS COMPONENT MAY NOT DO, and why the code looks the way it does:
 *
 *  · IT HOLDS NO PHI. Pinned context lives here as {type, id} — the browser sends
 *    references and the server sends back labels it has just read under RLS. The
 *    recent-context memory in `sessionStorage` is ids ONLY: names are refetched every time
 *    the bar opens, so a shared laptop's storage never holds a client's name (invariant 5).
 *  · IT EXECUTES NOTHING. A draft comes back as a card describing a proposal that is
 *    already inert in the database, with one link to /inbox. There is no approve button
 *    here and there never will be: disposition happens under the human-disposer trigger,
 *    on the surface that owns it (invariant 8).
 *  · IT IS HONEST IN ALL FOUR STATES. Empty says what the bar is for; loading says what is
 *    running; error says what did and did not happen; success shows the answer or the
 *    draft. No state is a spinner with no words.
 *
 * Accessibility: a real dialog (`aria-modal`, labelled, described), focus moved in on open
 * and restored on close, Tab and Shift-Tab trapped inside, Escape closing the picker first
 * and the dialog second, arrow-navigable search results, real <button>/<label> throughout,
 * and every status carried by words as well as by tone (D-012).
 */

import Link from "next/link";
import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  useTransition,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { askCommand, draftScheduleCommand, resolveContext, searchContext } from "./actions";
import type { CommandResult, ContextEntity, EntityRef } from "./types";
import {
  IconAlert,
  IconCheck,
  IconInbox,
  IconPlus,
  IconSearch,
  IconSparkle,
  IconUsers,
  IconX,
} from "@/components/icons";

/* ── The browser's memory: references, never names ───────────────────────────── */

const RECENTS_KEY = "careos-command-context";
const MAX_RECENTS = 5;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isRef(value: unknown): value is EntityRef {
  const ref = value as { type?: unknown; id?: unknown } | null;
  return (
    !!ref &&
    (ref.type === "client" || ref.type === "caregiver") &&
    typeof ref.id === "string" &&
    UUID_RE.test(ref.id)
  );
}

/** sessionStorage throws in locked-down profiles; chrome failing must never break a page. */
function readRecents(): EntityRef[] {
  try {
    const raw = window.sessionStorage.getItem(RECENTS_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter(isRef).slice(0, MAX_RECENTS) : [];
  } catch {
    return [];
  }
}

function writeRecents(refs: EntityRef[]): void {
  try {
    // Ids only. A label written here would be a client's name left on a shared machine.
    const payload = refs.slice(0, MAX_RECENTS).map((r) => ({ type: r.type, id: r.id }));
    window.sessionStorage.setItem(RECENTS_KEY, JSON.stringify(payload));
  } catch {
    /* Storage unavailable — the pin still applies for this session. */
  }
}

/* ── Small helpers ───────────────────────────────────────────────────────────── */

const FOCUSABLE =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** True when the keystroke belongs to whatever the person is already typing into. */
function isTypingTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el || !el.tagName) return false;
  const tag = el.tagName.toLowerCase();
  return tag === "input" || tag === "textarea" || tag === "select" || el.isContentEditable === true;
}

function entityNoun(type: EntityRef["type"]): string {
  return type === "client" ? "Client" : "Caregiver";
}

/* ── Context chips + picker ──────────────────────────────────────────────────── */

function ContextPicker({
  onPick,
  onClose,
}: {
  onPick: (entity: ContextEntity) => void;
  onClose: () => void;
}) {
  const [term, setTerm] = useState("");
  const [results, setResults] = useState<ContextEntity[]>([]);
  const [searched, setSearched] = useState(false);
  const [failed, setFailed] = useState(false);
  const [pending, startTransition] = useTransition();
  const listRef = useRef<HTMLDivElement>(null);
  const inputId = useId();
  const listId = useId();

  // Debounced so a fast typist does not issue a query per keystroke.
  useEffect(() => {
    const q = term.trim();
    if (q.length < 2) {
      setResults([]);
      setSearched(false);
      setFailed(false);
      return;
    }
    const timer = setTimeout(() => {
      startTransition(async () => {
        try {
          setResults(await searchContext(q));
          setFailed(false);
        } catch {
          setResults([]);
          setFailed(true);
        }
        setSearched(true);
      });
    }, 220);
    return () => clearTimeout(timer);
  }, [term]);

  function moveFocus(direction: 1 | -1 | "first" | "last") {
    const nodes = Array.from(listRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? []);
    if (nodes.length === 0) return;
    const current = nodes.indexOf(document.activeElement as HTMLElement);
    const next =
      direction === "first"
        ? 0
        : direction === "last"
          ? nodes.length - 1
          : current < 0
            ? 0
            : (current + direction + nodes.length) % nodes.length;
    nodes[next]?.focus();
  }

  function onKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      moveFocus(1);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      moveFocus(-1);
    } else if (event.key === "Home") {
      event.preventDefault();
      moveFocus("first");
    } else if (event.key === "End") {
      event.preventDefault();
      moveFocus("last");
    }
  }

  return (
    <div className="card-inset mt-3 p-3" onKeyDown={onKeyDown}>
      <div className="flex items-end gap-2">
        <div className="min-w-0 flex-1">
          <label htmlFor={inputId} className="label">
            Find a client or caregiver
          </label>
          <input
            id={inputId}
            type="text"
            autoFocus
            value={term}
            onChange={(e) => setTerm(e.target.value)}
            placeholder="Start typing a name…"
            className="input w-full text-[15px]"
            aria-controls={listId}
            aria-describedby={`${listId}-hint`}
          />
        </div>
        <button type="button" className="btn btn-white btn-sm shrink-0" onClick={onClose}>
          Done
        </button>
      </div>

      <p id={`${listId}-hint`} className="mt-1.5 text-[11px]" style={{ color: "var(--text-muted)" }}>
        Only people this session is allowed to see appear here. Pinning stores the record
        reference, never the name.
      </p>

      <div ref={listRef} id={listId} role="menu" aria-label="Search results" className="mt-2">
        {pending && (
          <p className="px-1 py-2 text-[13px]" style={{ color: "var(--text-muted)" }}>
            Searching…
          </p>
        )}
        {!pending && failed && (
          <p className="px-1 py-2 text-[13px]" style={{ color: "var(--color-danger-700)" }}>
            The search didn&apos;t run. Nothing was pinned — try typing the name again.
          </p>
        )}
        {!pending && !failed && searched && results.length === 0 && (
          <p className="px-1 py-2 text-[13px]" style={{ color: "var(--text-muted)" }}>
            No one by that name is visible to you. The record may not exist, or it may be
            outside your care-team scope.
          </p>
        )}
        {!pending &&
          !failed &&
          results.map((entity) => (
            <button
              key={`${entity.type}:${entity.id}`}
              type="button"
              role="menuitem"
              onClick={() => onPick(entity)}
              className="flex w-full items-center gap-2.5 rounded-[var(--radius-sm)] px-2.5 py-2 text-left text-[14px]
                         transition-colors hover:bg-[var(--color-surface-100)]"
            >
              <IconUsers width={15} height={15} />
              <span className="min-w-0 flex-1 truncate">{entity.label}</span>
              <span className="text-[11px]" style={{ color: "var(--text-muted)" }}>
                {entityNoun(entity.type)}
              </span>
            </button>
          ))}
      </div>
    </div>
  );
}

/* ── The draft card ──────────────────────────────────────────────────────────── */

const CHECK_TONE: Record<string, { color: string; word: string }> = {
  pass: { color: "var(--color-success-700)", word: "Clear" },
  attention: { color: "var(--color-warning-700)", word: "Needs attention" },
  unknown: { color: "var(--text-muted)", word: "Not established" },
};

function DraftCardView({ draft }: { draft: Extract<CommandResult, { kind: "draft" }> }) {
  const d = draft.draft;
  return (
    <div className="card p-4" role="region" aria-label="Draft awaiting a decision">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <span className="chip chip-accent">
          <IconSparkle width={13} height={13} />
          Draft · nothing has changed
        </span>
        <span className="chip chip-neutral">
          Tier {d.tier}
          {d.requiresHuman ? " · a person decides" : ""}
        </span>
      </div>

      <h3 className="text-[16px] font-semibold tracking-[-0.01em]">{d.headline}</h3>
      <p className="mt-0.5 text-[14px]" style={{ color: "var(--text-secondary)" }}>
        {d.when}
      </p>
      <p className="mt-2 text-[13px] leading-relaxed" style={{ color: "var(--text-secondary)" }}>
        {d.effect}
      </p>

      <div className="mt-3 border-t pt-3 hairline">
        <p
          className="mb-2 text-[11px] font-semibold uppercase"
          style={{ color: "var(--text-muted)", letterSpacing: "0.04em" }}
        >
          Pre-flight checks
        </p>
        <ul className="flex flex-col gap-2">
          {d.checks.map((check) => {
            const tone = CHECK_TONE[check.status] ?? CHECK_TONE.unknown;
            return (
              <li key={check.key} className="text-[13px] leading-relaxed">
                {/* The dot never carries the meaning on its own — the word beside it does (D-012). */}
                <span className="flex items-center gap-1.5 font-medium">
                  <span
                    aria-hidden
                    className="inline-block h-2 w-2 shrink-0 rounded-full"
                    style={{ background: tone.color }}
                  />
                  {check.label}: {tone.word}
                </span>
                <span className="mt-0.5 block" style={{ color: "var(--text-secondary)" }}>
                  {check.finding}
                </span>
              </li>
            );
          })}
        </ul>
      </div>

      {d.narration && (
        <p className="mt-3 border-t pt-3 text-[13px] leading-relaxed hairline">{d.narration}</p>
      )}
      {d.narrationNote && (
        <p
          className="mt-3 border-t pt-3 text-[12px] leading-relaxed hairline"
          style={{ color: "var(--text-muted)" }}
        >
          {d.narrationNote}
        </p>
      )}

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <Link href="/inbox" className="btn btn-primary btn-sm">
          <IconInbox width={15} height={15} />
          Review in Approvals
        </Link>
        <p className="text-[12px]" style={{ color: "var(--text-muted)" }}>
          Approving or rejecting happens there, on your own session.
        </p>
      </div>
    </div>
  );
}

/* ── The bar ─────────────────────────────────────────────────────────────────── */

type Mode = "ask" | "draft";

export function CommandBar({ actionsEnabled }: { actionsEnabled: boolean }) {
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<Mode>("ask");
  const [text, setText] = useState("");
  const [pinned, setPinned] = useState<ContextEntity[]>([]);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [result, setResult] = useState<CommandResult | null>(null);
  const [pending, startTransition] = useTransition();

  const panelRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const restoreRef = useRef<HTMLElement | null>(null);
  const desktopTriggerRef = useRef<HTMLButtonElement>(null);
  const fabRef = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  const hintId = useId();

  const close = useCallback(() => {
    setOpen(false);
    setPickerOpen(false);
  }, []);

  /* ── Opening: ⌘K / Ctrl-K anywhere, "/" when nobody is typing ─────────────── */
  useEffect(() => {
    function onKey(event: globalThis.KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && (event.key === "k" || event.key === "K")) {
        event.preventDefault();
        setOpen((wasOpen) => !wasOpen);
        return;
      }
      if (event.key === "/" && !open && !isTypingTarget(event.target)) {
        event.preventDefault();
        setOpen(true);
      }
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  /* ── While open: body scroll lock, focus in, focus restored on close ───────── */
  useEffect(() => {
    if (!open) return;
    restoreRef.current = document.activeElement as HTMLElement | null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    composerRef.current?.focus();
    return () => {
      document.body.style.overflow = previousOverflow;
      // Opening with ⌘K usually means focus was on <body>, and restoring it there would
      // drop a keyboard user at the top of the document with no idea where they are. The
      // trigger is the honest landing place: it is where the bar came from.
      const previous = restoreRef.current;
      if (previous && previous.isConnected && previous !== document.body) {
        previous.focus();
        return;
      }
      // offsetParent is null for the button the viewport has hidden (md:hidden / hidden md:block).
      const visible =
        desktopTriggerRef.current && desktopTriggerRef.current.offsetParent !== null
          ? desktopTriggerRef.current
          : fabRef.current;
      visible?.focus();
    };
  }, [open]);

  /* ── Recent context: ids out of sessionStorage, labels back from the server ── */
  useEffect(() => {
    if (!open) return;
    const refs = readRecents();
    if (refs.length === 0) return;
    let cancelled = false;
    void (async () => {
      try {
        const entities = await resolveContext(refs);
        if (!cancelled) setPinned((current) => (current.length > 0 ? current : entities));
      } catch {
        /* A failed refetch simply means no suggestions — never a broken bar. */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open]);

  function onPanelKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape") {
      event.stopPropagation();
      if (pickerOpen) setPickerOpen(false);
      else close();
      return;
    }
    if (event.key !== "Tab") return;

    // The trap. Without it, Tab walks out of a modal onto the page behind it, and a
    // keyboard user is left interacting with a surface they cannot see.
    const nodes = Array.from(panelRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? []).filter(
      (node) => node.offsetParent !== null || node === document.activeElement
    );
    if (nodes.length === 0) return;
    const first = nodes[0];
    const last = nodes[nodes.length - 1];
    const active = document.activeElement as HTMLElement | null;

    if (event.shiftKey && (active === first || !panelRef.current?.contains(active))) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && active === last) {
      event.preventDefault();
      first.focus();
    }
  }

  function pin(entity: ContextEntity) {
    setPinned((current) => {
      if (current.some((e) => e.type === entity.type && e.id === entity.id)) return current;
      const next = [entity, ...current].slice(0, MAX_RECENTS);
      writeRecents(next.map((e) => ({ type: e.type, id: e.id })));
      return next;
    });
    setPickerOpen(false);
    composerRef.current?.focus();
  }

  function unpin(entity: ContextEntity) {
    setPinned((current) => {
      const next = current.filter((e) => !(e.type === entity.type && e.id === entity.id));
      writeRecents(next.map((e) => ({ type: e.type, id: e.id })));
      return next;
    });
  }

  function submit() {
    const said = text.trim();
    if (!said || pending) return;
    const refs = pinned.map((e) => ({ type: e.type, id: e.id }));
    setResult(null);
    startTransition(async () => {
      try {
        const res =
          mode === "draft" && actionsEnabled
            ? await draftScheduleCommand(said, refs)
            : await askCommand(said, refs);
        setResult(res);
      } catch {
        setResult({
          kind: "error",
          message:
            "That didn't reach CareOS. Nothing was saved and nothing was changed — try again.",
        });
      }
    });
  }

  function onComposerKeyDown(event: ReactKeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      submit();
    }
  }

  const statusLine = pending
    ? mode === "draft" && actionsEnabled
      ? "Running the checks and drafting…"
      : "Looking through agency policy…"
    : result?.kind === "draft"
      ? "A draft is ready for review. Nothing has changed."
      : result?.kind === "answer"
        ? "Answer ready."
        : "";

  return (
    <>
      {/* ── The always-visible way in ─────────────────────────────────────────── */}
      {/* Desktop: the top bar's left edge, mirroring the chrome row's geometry so it
          shares that band instead of overlapping the page or the appearance cluster. */}
      <div className="pointer-events-none fixed inset-x-0 top-0 z-30 hidden md:block md:pl-64">
        <div className="mx-auto flex w-full max-w-5xl px-10 pt-5">
          <button
            ref={desktopTriggerRef}
            type="button"
            onClick={() => setOpen(true)}
            aria-haspopup="dialog"
            aria-expanded={open}
            aria-keyshortcuts="Meta+K Control+K"
            data-testid="command-bar-trigger"
            className="material pointer-events-auto flex h-9 items-center gap-2 rounded-full border px-3.5
                       text-[13px] font-medium transition-colors hairline
                       hover:bg-[var(--color-surface-100)]"
            style={{ color: "var(--text-secondary)", boxShadow: "var(--shadow-sm)" }}
          >
            <IconSearch width={15} height={15} />
            Ask or find anything
            <kbd
              className="ml-1 rounded px-1.5 py-0.5 text-[11px] font-semibold"
              style={{ background: "var(--color-surface-100)", color: "var(--text-muted)" }}
            >
              ⌘K
            </kbd>
          </button>
        </div>
      </div>

      {/* Phone: a thumb-reachable button above the tab bar. Field users have no keyboard,
          so this is the primary entry point, not a fallback. */}
      <button
        ref={fabRef}
        type="button"
        onClick={() => setOpen(true)}
        aria-haspopup="dialog"
        aria-expanded={open}
        data-testid="command-bar-fab"
        className="btn btn-primary fixed right-4 z-30 flex h-14 w-14 items-center justify-center rounded-full p-0 md:hidden"
        style={{ bottom: "calc(env(safe-area-inset-bottom) + 4.75rem)", boxShadow: "var(--shadow-lg)" }}
      >
        <IconSparkle width={22} height={22} />
        <span className="sr-only">Ask or find anything</span>
      </button>

      {/* ── The overlay ──────────────────────────────────────────────────────── */}
      {open && (
        <div className="fixed inset-0 z-50 flex flex-col" role="presentation">
          <div className="scrim absolute inset-0" onClick={close} aria-hidden />

          <div
            ref={panelRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby={titleId}
            aria-describedby={hintId}
            onKeyDown={onPanelKeyDown}
            data-testid="command-bar-dialog"
            className="sheet relative z-10 mx-auto mt-[7vh] flex max-h-[84dvh] w-[min(94vw,44rem)] flex-col overflow-hidden"
          >
            <header className="flex items-start justify-between gap-4 border-b px-5 py-4 hairline">
              <div className="min-w-0">
                <h2 id={titleId} className="text-[17px] font-semibold tracking-[-0.01em]">
                  Ask or find anything
                </h2>
                <p id={hintId} className="mt-0.5 text-[13px]" style={{ color: "var(--text-muted)" }}>
                  {actionsEnabled
                    ? "Answers come from agency policy with sources. Drafts are proposals — a person decides on them in Approvals."
                    : "Answers come from agency policy documents, with sources. When no policy applies, the Brain says so."}
                </p>
              </div>
              <button
                type="button"
                onClick={close}
                aria-label="Close"
                className="btn btn-plain btn-sm -mr-2 -mt-1 shrink-0"
                style={{ minWidth: "2.25rem", paddingInline: 0, width: "2.25rem" }}
              >
                <IconX width={18} height={18} />
              </button>
            </header>

            <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
              {/* The lane picker exists only when the drafting flag is on. When it is off
                  there is no teaser and no disabled control — the bar is a question box. */}
              {actionsEnabled && (
                <div role="group" aria-label="What do you need?" className="mb-3 flex flex-wrap gap-2">
                  <button
                    type="button"
                    aria-pressed={mode === "ask"}
                    onClick={() => setMode("ask")}
                    className="btn btn-sm btn-pill"
                    style={
                      mode === "ask"
                        ? { background: "var(--accent-fill)", color: "#fff", borderColor: "var(--accent-fill)" }
                        : { background: "var(--panel)" }
                    }
                  >
                    Ask a question
                  </button>
                  <button
                    type="button"
                    aria-pressed={mode === "draft"}
                    onClick={() => setMode("draft")}
                    className="btn btn-sm btn-pill"
                    style={
                      mode === "draft"
                        ? { background: "var(--accent-fill)", color: "#fff", borderColor: "var(--accent-fill)" }
                        : { background: "var(--panel)" }
                    }
                  >
                    Draft a schedule change
                  </button>
                </div>
              )}

              <label htmlFor="command-bar-input" className="sr-only">
                {mode === "draft" && actionsEnabled
                  ? "Describe the schedule change you need"
                  : "Ask a question about agency policy or operations"}
              </label>
              <textarea
                id="command-bar-input"
                ref={composerRef}
                value={text}
                onChange={(e) => setText(e.target.value)}
                onKeyDown={onComposerKeyDown}
                rows={2}
                placeholder={
                  mode === "draft" && actionsEnabled
                    ? "Assign Sam Okafor to Doris Fenwick's visit tomorrow at 8am"
                    : "How often are supervisory visits required?"
                }
                className="input w-full resize-none py-2.5"
                style={{ minHeight: 60 }}
              />

              {/* ── Pinned context: references in, labels out ──────────────────── */}
              <div className="mt-2.5 flex flex-wrap items-center gap-2">
                {pinned.map((entity) => (
                  <span key={`${entity.type}:${entity.id}`} className="chip chip-neutral">
                    <span className="max-w-[12rem] truncate">{entity.label}</span>
                    <span className="sr-only">{entityNoun(entity.type)}</span>
                    <button
                      type="button"
                      onClick={() => unpin(entity)}
                      aria-label={`Remove ${entity.label} from context`}
                      className="-mr-1 rounded-full p-0.5 hover:bg-[var(--color-surface-200)]"
                    >
                      <IconX width={12} height={12} />
                    </button>
                  </span>
                ))}
                <button
                  type="button"
                  onClick={() => setPickerOpen((wasOpen) => !wasOpen)}
                  aria-expanded={pickerOpen}
                  className="btn btn-white btn-sm btn-pill"
                >
                  <IconPlus width={13} height={13} />
                  Add context
                </button>
                <span className="flex-1" />
                <button
                  type="button"
                  className="btn btn-primary btn-sm"
                  disabled={pending || !text.trim()}
                  onClick={submit}
                >
                  <IconSparkle width={15} height={15} />
                  {pending
                    ? "Working…"
                    : mode === "draft" && actionsEnabled
                      ? "Draft it"
                      : "Ask"}
                </button>
              </div>

              {pickerOpen && <ContextPicker onPick={pin} onClose={() => setPickerOpen(false)} />}

              {/* Screen readers hear the state change without watching the panel. */}
              <p role="status" aria-live="polite" className="sr-only">
                {statusLine}
              </p>

              {/* ── The four states ───────────────────────────────────────────── */}
              <div className="mt-4">
                {pending ? (
                  <div className="card p-5" aria-hidden>
                    <div className="skeleton h-3.5 w-2/3" />
                    <div className="skeleton mt-2 h-3.5 w-full" />
                    <div className="skeleton mt-2 h-3.5 w-1/2" />
                    <p className="mt-3 text-[13px]" style={{ color: "var(--text-muted)" }}>
                      {statusLine}
                    </p>
                  </div>
                ) : result === null ? (
                  <div className="card-inset p-4">
                    <p className="text-[13px] leading-relaxed" style={{ color: "var(--text-secondary)" }}>
                      {actionsEnabled
                        ? "Ask about agency policy, a client's obligations, or what is due — or switch to drafting to turn a sentence into a schedule proposal. Drafts never take effect on their own."
                        : "Ask about agency policy, a client's obligations, or what is due. Answers cite the policy they came from, and say so plainly when no policy covers the question."}
                    </p>
                    <p className="mt-2 text-[12px]" style={{ color: "var(--text-muted)" }}>
                      Escape closes this. Enter sends; Shift-Enter adds a line.
                    </p>
                  </div>
                ) : result.kind === "error" ? (
                  <div className="card p-4" role="alert">
                    <span className="chip chip-danger">
                      <IconAlert width={13} height={13} />
                      Not done
                    </span>
                    <p className="mt-3 text-[14px] leading-relaxed">{result.message}</p>
                  </div>
                ) : result.kind === "clarify" ? (
                  <div className="card p-4">
                    <span className="chip chip-warning">
                      <IconAlert width={13} height={13} />
                      One more thing
                    </span>
                    <p className="mt-3 text-[14px] leading-relaxed">{result.message}</p>
                    <p className="mt-2 text-[12px]" style={{ color: "var(--text-muted)" }}>
                      Nothing was drafted and nothing was changed.
                    </p>
                  </div>
                ) : result.kind === "draft" ? (
                  <DraftCardView draft={result} />
                ) : (
                  <div className="card p-4" role="region" aria-label="Answer">
                    <div className="mb-2 flex flex-wrap items-center gap-2">
                      {result.abstained ? (
                        <span className="chip chip-warning">
                          <IconAlert width={13} height={13} />
                          No policy found
                        </span>
                      ) : (
                        <span className="chip chip-success">
                          <IconCheck width={13} height={13} />
                          Answered from policy
                        </span>
                      )}
                      <span className="chip chip-neutral">
                        {result.provider === "openai" ? "OpenAI" : "Mock"} · {result.model}
                      </span>
                    </div>
                    <p className="whitespace-pre-wrap text-[15px] leading-relaxed">{result.answer}</p>
                    {result.citations.length > 0 && (
                      <ul className="mt-3 flex flex-col gap-1.5 border-t pt-3 hairline">
                        {result.citations.map((c) => (
                          <li key={c.n} className="flex items-start gap-2 text-[13px]">
                            <span className="tabular shrink-0 font-semibold" style={{ color: "var(--accent)" }}>
                              [{c.n}]
                            </span>
                            <span>
                              {c.title}
                              {c.source_ref && (
                                <span style={{ color: "var(--text-muted)" }}> · {c.source_ref}</span>
                              )}
                            </span>
                          </li>
                        ))}
                      </ul>
                    )}
                    <p className="mt-3 text-[12px]" style={{ color: "var(--text-muted)" }}>
                      Open the Brain to record whether this answer was useful.
                    </p>
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
