"use client";

/** CareOS interactive primitives — the client island half of the component set.
 *  Kept separate from ui.tsx (which is server-safe) and re-exported from it, so
 *  callers still `import { Sheet } from "@/components/ui"`. Apple 2026 language:
 *  frosted scrim, spring-eased sheet, reduced-motion-safe via globals.css. */
import {
  cloneElement,
  isValidElement,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from "react";
import { IconX } from "./icons";

/* ── Sheet / Drawer — an uncontrolled overlay panel with a trigger ──
 * <Sheet trigger={<button className="btn btn-secondary">Details</button>} title="…">
 *   …content…
 * </Sheet>
 * Right-side drawer by default; `side="bottom"` for a bottom sheet. Closes on
 * scrim click, Escape, or the close button. The trigger (pass a real <button> or
 * link) gets the open handler + dialog aria wired in; focus moves into the panel
 * on open and back to the trigger on close. */
export function Sheet({
  trigger,
  title,
  description,
  children,
  side = "right",
  footer,
}: {
  trigger: ReactNode;
  title: string;
  description?: string;
  children: ReactNode;
  side?: "right" | "bottom";
  footer?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const titleId = useId();
  const descId = useId();
  const closeRef = useRef<HTMLButtonElement>(null);

  const close = useCallback(() => setOpen(false), []);

  useEffect(() => {
    if (!open) return;
    const toRestore = document.activeElement as HTMLElement | null;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    document.addEventListener("keydown", onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    closeRef.current?.focus();
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
      toRestore?.focus?.();
    };
  }, [open, close]);

  const openProps = {
    onClick: () => setOpen(true),
    "aria-haspopup": "dialog" as const,
    "aria-expanded": open,
  };
  const triggerEl = isValidElement(trigger) ? (
    cloneElement(trigger as ReactElement<Record<string, unknown>>, openProps)
  ) : (
    <button type="button" {...openProps}>
      {trigger}
    </button>
  );

  const panelBox =
    side === "bottom"
      ? "fixed inset-x-0 bottom-0 mx-auto w-full max-w-2xl max-h-[85dvh]"
      : "fixed inset-y-0 right-0 w-[min(92vw,26rem)] max-h-dvh";

  return (
    <>
      {triggerEl}

      {open && (
        <div className="fixed inset-0 z-50 flex" role="presentation">
          <div className="scrim absolute inset-0" onClick={close} aria-hidden />
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby={titleId}
            aria-describedby={description ? descId : undefined}
            className={`sheet relative z-10 flex flex-col ${panelBox}`}
          >
            <header className="flex items-start justify-between gap-4 border-b px-5 py-4 hairline">
              <div className="min-w-0">
                <h2 id={titleId} className="text-[17px] font-semibold tracking-[-0.01em]">
                  {title}
                </h2>
                {description && (
                  <p id={descId} className="mt-0.5 text-[13px]" style={{ color: "var(--text-muted)" }}>
                    {description}
                  </p>
                )}
              </div>
              <button
                ref={closeRef}
                type="button"
                onClick={close}
                aria-label="Close"
                className="btn btn-plain btn-sm -mr-2 -mt-1 shrink-0"
                style={{ minWidth: "2.25rem", paddingInline: 0, width: "2.25rem" }}
              >
                <IconX width={18} height={18} />
              </button>
            </header>

            <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">{children}</div>

            {footer && <footer className="border-t px-5 py-3.5 hairline">{footer}</footer>}
          </div>
        </div>
      )}
    </>
  );
}

/** Drawer is a semantic alias for Sheet (same behavior). */
export const Drawer = Sheet;
