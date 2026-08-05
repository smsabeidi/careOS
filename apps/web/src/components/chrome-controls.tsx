"use client";

/* ─────────────────────────────────────────────────────────────────────────────
   Chrome controls — the top-right appearance + language cluster
   ───────────────────────────────────────────────────────────────────────────
   One frosted pill, two icon-only menus, a hairline between them. It is chrome:
   quiet, corporate, and never competing with the page. It is also the only
   interactive island in the shell — everything around it stays a server
   component, and nothing here ever touches PHI (invariant 5): the only values
   that leave this file are the string "light" | "dark" | "system" and a
   two-letter locale.

   The two halves persist in deliberately different places:

     APPEARANCE is a browser fact. It writes `localStorage.careos-theme` and sets
     `data-theme` on <html> synchronously, so the flip is instant — no round
     trip, no re-render of a care surface to change a colour. The blocking script
     in layout.tsx replays the same value before first paint, which is what keeps
     dark mode from flashing white on load.

     LANGUAGE is a server fact. Server components resolve copy through `t()` at
     render time, so the preference has to be on the request before the server
     renders — hence a cookie written by a server action, then `router.refresh()`
     to re-render the tree in the new language.

   Accessibility: each control is a real menu button (aria-haspopup, aria-expanded,
   role="menuitemradio" with aria-checked), operable with Enter/Space/arrows/Home/
   End/Escape, labelled from the dictionary, and focus returns to the trigger on
   close. The three appearance glyphs share one optical box and the locale code
   sits in a fixed-width slot, so nothing in the pill moves when state changes.
──────────────────────────────────────────────────────────────────────────── */

import { useRouter } from "next/navigation";
import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  useTransition,
  type CSSProperties,
  type FocusEvent,
  type KeyboardEvent,
  type ReactNode,
} from "react";

import { setLocalePreference } from "@/app/chrome-actions";
import { useLocale, useT } from "@/lib/i18n/client";
import { LOCALES, LOCALE_LABEL, type Locale } from "@/lib/i18n/config";
import { IconCheck, IconLanguage, IconMonitor, IconMoon, IconSun } from "./icons";

/* ── Appearance ─────────────────────────────────────────────────────────────── */

type Appearance = "light" | "dark" | "system";

/** Shared with the pre-paint script in layout.tsx. Change both or neither. */
const THEME_STORAGE_KEY = "careos-theme";

/**
 * Reads the stored appearance. Private-mode Safari and locked-down enterprise
 * profiles throw on `localStorage` access, so every read is guarded: chrome
 * failing must never be the reason a care surface fails to render.
 */
function readAppearance(): Appearance {
  try {
    const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
    return stored === "light" || stored === "dark" ? stored : "system";
  } catch {
    return "system";
  }
}

/**
 * Applies the appearance to the document. "system" REMOVES the attribute rather
 * than setting a value — globals.css keys system-dark off
 * `@media (prefers-color-scheme: dark) :root:not([data-theme="light"])`, so the
 * absence of the attribute is what "follow the OS" means.
 */
function paintAppearance(next: Appearance): void {
  const root = document.documentElement;
  if (next === "system") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", next);
}

/** Persists the choice. "system" clears the key, which is also the default. */
function persistAppearance(next: Appearance): void {
  try {
    if (next === "system") window.localStorage.removeItem(THEME_STORAGE_KEY);
    else window.localStorage.setItem(THEME_STORAGE_KEY, next);
  } catch {
    /* Storage unavailable — the choice still applies for this document. */
  }
}

/* ── Shared menu button ─────────────────────────────────────────────────────── */

type MenuOption<T extends string> = { value: T; label: string; icon?: ReactNode };

/** Trigger geometry: 36px on touch (the floor for a finger), 32px on a pointer. */
const TRIGGER_BASE =
  "relative flex h-9 min-w-9 items-center justify-center gap-1.5 px-2 transition duration-150 " +
  "hover:bg-[var(--color-surface-100)] hover:[color:var(--text)] " +
  "active:scale-[0.94] disabled:pointer-events-none disabled:opacity-45 md:h-8 md:min-w-8";

const TRIGGER_STYLE: CSSProperties = {
  // Beats the global `:focus-visible { border-radius: 6px }`, which would square
  // off a round button the moment it takes focus.
  borderRadius: "9999px",
};

function MenuButton<T extends string>({
  label,
  options,
  value,
  onSelect,
  disabled,
  busy,
  children,
}: {
  /** Accessible name AND tooltip — "Appearance: dark", "Language: English". */
  label: string;
  options: readonly MenuOption<T>[];
  value: T;
  onSelect: (next: T) => void;
  disabled?: boolean;
  busy?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuId = useId();

  const close = useCallback((restoreFocus = true) => {
    setOpen(false);
    if (restoreFocus) triggerRef.current?.focus();
  }, []);

  /* Escape closes; a pointer press anywhere else dismisses. Capture phase, so a
     click that lands on another control still closes this menu first. */
  useEffect(() => {
    if (!open) return;

    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        close();
      }
    };

    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open, close]);

  /* Opening lands focus on the current choice — the keyboard equivalent of the
     checkmark, and the reason the state is obvious without reading every row. */
  useEffect(() => {
    if (!open) return;
    const menu = menuRef.current;
    const target =
      menu?.querySelector<HTMLElement>('[data-checked="true"]') ??
      menu?.querySelector<HTMLElement>('[role="menuitemradio"]');
    target?.focus();
  }, [open]);

  function itemNodes(): HTMLElement[] {
    return Array.from(menuRef.current?.querySelectorAll<HTMLElement>('[role="menuitemradio"]') ?? []);
  }

  function onMenuKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const keys = ["ArrowDown", "ArrowUp", "Home", "End"];
    if (!keys.includes(event.key)) return;
    event.preventDefault();

    const nodes = itemNodes();
    if (nodes.length === 0) return;
    const current = nodes.indexOf(document.activeElement as HTMLElement);
    const next =
      event.key === "ArrowDown"
        ? (current + 1) % nodes.length
        : event.key === "ArrowUp"
          ? (current - 1 + nodes.length) % nodes.length
          : event.key === "Home"
            ? 0
            : nodes.length - 1;
    nodes[next]?.focus();
  }

  function onTriggerKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      setOpen(true);
    }
  }

  /* Tabbing out of the cluster closes the menu — no orphaned popover behind a
     surface the user has already moved on from. */
  function onBlurCapture(event: FocusEvent<HTMLDivElement>) {
    const next = event.relatedTarget as Node | null;
    if (next && rootRef.current?.contains(next)) return;
    setOpen(false);
  }

  return (
    <div ref={rootRef} className="relative" onBlur={onBlurCapture}>
      <button
        ref={triggerRef}
        type="button"
        className={TRIGGER_BASE}
        style={TRIGGER_STYLE}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        aria-label={label}
        aria-busy={busy || undefined}
        title={label}
        disabled={disabled}
        onClick={() => setOpen((wasOpen) => !wasOpen)}
        onKeyDown={onTriggerKeyDown}
      >
        {children}
      </button>

      {open && (
        <div
          ref={menuRef}
          id={menuId}
          role="menu"
          aria-label={label}
          onKeyDown={onMenuKeyDown}
          className="popover absolute right-0 top-[calc(100%+0.5rem)] z-50 min-w-[10.5rem] p-1"
          style={{ "--transform-origin": "top right" } as CSSProperties}
        >
          {options.map((option) => {
            const checked = option.value === value;
            return (
              <button
                key={option.value}
                type="button"
                role="menuitemradio"
                aria-checked={checked}
                data-checked={checked}
                onClick={() => {
                  onSelect(option.value);
                  close();
                }}
                className="flex w-full items-center gap-2.5 rounded-[var(--radius-sm)] px-2.5 py-2 text-left text-[13px]
                           font-medium transition-colors hover:bg-[var(--color-surface-100)]"
                style={{ color: checked ? "var(--accent-text)" : "var(--text)" }}
              >
                {option.icon}
                <span className="flex-1">{option.label}</span>
                {/* Always rendered, so checking a different row never reflows the menu. */}
                <IconCheck width={14} height={14} style={{ opacity: checked ? 1 : 0 }} />
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

/* ── The cluster ────────────────────────────────────────────────────────────── */

export function ChromeControls({ className = "" }: { className?: string }) {
  const t = useT();
  const locale = useLocale();
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  /* SSR has no localStorage, so the first render says "system" and an effect
     corrects it after hydration. The DOM is already right — the pre-paint script
     set `data-theme` — so this only ever reconciles the ICON, never the colours. */
  const [appearance, setAppearance] = useState<Appearance>("system");
  useEffect(() => setAppearance(readAppearance()), []);

  /* Two tabs, one preference: a change in another tab repaints this one. */
  useEffect(() => {
    function onStorage(event: StorageEvent) {
      if (event.key !== null && event.key !== THEME_STORAGE_KEY) return;
      const next = readAppearance();
      setAppearance(next);
      paintAppearance(next);
    }
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  function chooseAppearance(next: Appearance) {
    setAppearance(next);
    paintAppearance(next);
    persistAppearance(next);
  }

  function chooseLocale(next: Locale) {
    /* Re-entrancy guard instead of `disabled` on the trigger: disabling a button
       that has just been focused by the closing menu would drop focus to <body>
       and lose the keyboard user's place. */
    if (pending || next === locale) return;
    startTransition(async () => {
      await setLocalePreference(next);
      router.refresh();
    });
  }

  const appearanceOptions: readonly MenuOption<Appearance>[] = [
    { value: "light", label: t("appearance.light"), icon: <IconSun width={16} height={16} /> },
    { value: "dark", label: t("appearance.dark"), icon: <IconMoon width={16} height={16} /> },
    { value: "system", label: t("appearance.system"), icon: <IconMonitor width={16} height={16} /> },
  ];
  const activeAppearance =
    appearanceOptions.find((option) => option.value === appearance) ?? appearanceOptions[2];

  const localeOptions: readonly MenuOption<Locale>[] = LOCALES.map((value) => ({
    value,
    label: LOCALE_LABEL[value],
  }));

  return (
    <div
      className={`material inline-flex items-center rounded-full border p-[3px] hairline ${className}`}
      style={{ color: "var(--text-secondary)", boxShadow: "var(--shadow-sm)" }}
    >
      <MenuButton
        label={`${t("appearance.label")}: ${activeAppearance.label}`}
        options={appearanceOptions}
        value={appearance}
        onSelect={chooseAppearance}
      >
        {appearance === "light" ? (
          <IconSun width={16} height={16} />
        ) : appearance === "dark" ? (
          <IconMoon width={16} height={16} />
        ) : (
          <IconMonitor width={16} height={16} />
        )}
      </MenuButton>

      <span aria-hidden className="mx-0.5 h-4 w-px" style={{ background: "var(--separator)" }} />

      <MenuButton
        label={`${t("language.label")}: ${LOCALE_LABEL[locale]}`}
        options={localeOptions}
        value={locale}
        onSelect={chooseLocale}
        busy={pending}
      >
        <IconLanguage width={16} height={16} />
        {/* Fixed-width slot: EN and ES are not the same width, and chrome must
            not twitch when the language changes. The in-flight cue is opacity,
            for the same reason — a spinner here would resize the pill. */}
        <span
          className="w-5 text-center text-[11px] font-semibold"
          style={{ letterSpacing: "0.04em", opacity: pending ? 0.5 : 1 }}
        >
          {locale.toUpperCase()}
        </span>
      </MenuButton>
    </div>
  );
}
