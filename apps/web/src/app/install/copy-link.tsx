"use client";

import { useState } from "react";
import { IconCheck, IconAlert } from "@/components/icons";

/**
 * The one interactive thing on the install guide: copy this page's address.
 *
 * WHY A CLIENT ISLAND AND NOTHING ELSE. /install is prose. The whole page is a server
 * component so it renders with JavaScript off, on a hardened profile, on a phone that
 * gave up loading the bundle — because the person reading it is being told how to get
 * the app working, and a broken page is a cruel place to say that. Only the clipboard
 * needs the browser, so only the clipboard is a client component.
 *
 * WHY THE ADDRESS IS ALSO PRINTED. `navigator.clipboard` is absent over plain HTTP,
 * absent in some embedded webviews, and refused outright by enterprise policy on
 * managed laptops. The address itself is therefore rendered as selectable text by the
 * server, and this button is a convenience on top of it. When the copy fails, the
 * failure is said out loud and points at the text that is already on screen — never a
 * button that quietly does nothing.
 *
 * PHI: the value handled here is the product's own public URL. Nothing else is read,
 * written or logged (invariant 5).
 */

type CopyState = "idle" | "copied" | "failed";

/** The copy stays put rather than flashing away, so a slow reader still gets the answer. */
const CLEAR_AFTER_MS = 6_000;

export function CopyInstallLink({ url, describedBy }: { url: string; describedBy: string }) {
  const [state, setState] = useState<CopyState>("idle");

  async function copy() {
    try {
      // Checked, not assumed: on an insecure origin `navigator.clipboard` is undefined
      // and reaching for `.writeText` would throw a TypeError we would then have to
      // interpret. Absent and refused end in the same honest place either way.
      if (!navigator.clipboard) throw new Error("clipboard unavailable");
      await navigator.clipboard.writeText(url);
      setState("copied");
      window.setTimeout(() => setState("idle"), CLEAR_AFTER_MS);
    } catch {
      // Deliberately terminal: a failure that clears itself is a failure nobody reads.
      setState("failed");
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <button
        type="button"
        className="btn btn-secondary self-start"
        onClick={copy}
        aria-describedby={describedBy}
      >
        {state === "copied" ? (
          <>
            <IconCheck width={16} height={16} aria-hidden />
            Copied
          </>
        ) : (
          "Copy this address"
        )}
      </button>

      {/* Words carry the outcome, never a colour or an icon alone (D-012). The region is
          always in the tree so a screen reader announces the change rather than a new
          node appearing under it. */}
      <p
        role="status"
        aria-live="polite"
        className="text-[13px] leading-snug"
        style={{ color: state === "failed" ? "var(--color-danger-700)" : "var(--text-secondary)" }}
      >
        {state === "copied" ? (
          "Copied. Paste it into a message to yourself, or type it into your phone's browser."
        ) : state === "failed" ? (
          <span className="flex items-start gap-1.5">
            <IconAlert width={15} height={15} className="mt-0.5 shrink-0" aria-hidden />
            <span>
              This browser wouldn&apos;t let us copy it, and nothing else changed. Select the
              address above and copy it yourself.
            </span>
          </span>
        ) : (
          ""
        )}
      </p>
    </div>
  );
}
