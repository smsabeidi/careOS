import { AppShell } from "@/components/shell";

/**
 * Layout-mirroring skeleton (docs/10 §8, docs/17 §7.3).
 *
 * The time column, the avatar, the name line, the address line and the two action buttons
 * land in the same places they will occupy once the day arrives, so nothing jumps under a
 * thumb already moving toward "Clock in". No spinner wall, and no claim about how many
 * visits there are until that is actually known.
 *
 * Deliberately literal rather than translated: `loading.tsx` is rendered before the async
 * boundary resolves, and it says nothing — a translated string here would be a sentence
 * nobody reads, at the cost of an await on the render path.
 */
export default function Loading() {
  return (
    <AppShell active="/today">
      <div className="mx-auto max-w-xl" aria-busy="true" aria-label="Loading today">
        {/* Page header + connection chip */}
        <div className="mb-7 flex flex-wrap items-end justify-between gap-4">
          <div className="min-w-0">
            <div className="skeleton h-8 w-32" />
            <div className="skeleton mt-2.5 h-3.5 w-64 max-w-full" />
          </div>
          <div className="skeleton h-6 w-20 rounded-full" />
        </div>

        {/* Section title */}
        <div className="skeleton mb-3 h-4 w-28" />

        {/* Visit cards */}
        <div className="flex flex-col gap-3">
          {Array.from({ length: 2 }).map((_, i) => (
            <div key={i} className="card p-4">
              <div className="flex items-center gap-3.5">
                <div className="flex w-14 shrink-0 flex-col items-center gap-1.5">
                  <div className="skeleton h-4 w-12" />
                  <div className="skeleton h-3 w-10" />
                </div>
                <div className="skeleton size-11 shrink-0 rounded-full" />
                <div className="min-w-0 flex-1 space-y-2">
                  <div className="skeleton h-4 w-40 max-w-full" />
                  <div className="skeleton h-3 w-52 max-w-full" />
                </div>
              </div>
              <div className="mt-3 flex gap-2">
                <div className="skeleton h-11 flex-1 rounded-[var(--radius-sm)]" />
                <div className="skeleton h-11 w-32 rounded-[var(--radius-sm)]" />
              </div>
              <div className="skeleton mt-3 h-11 w-full rounded-[var(--radius-sm)]" />
            </div>
          ))}
        </div>
        <div className="skeleton mt-3.5 h-3 w-full max-w-md" />

        {/* My clients */}
        <div className="mt-8">
          <div className="skeleton mb-3 h-4 w-24" />
          <div className="card divide-y hairline overflow-hidden">
            {Array.from({ length: 3 }).map((_, i) => (
              <div key={i} className="flex items-center gap-4 px-5 py-4">
                <div className="skeleton size-11 rounded-full" />
                <div className="flex-1 space-y-2">
                  <div className="skeleton h-3.5 w-36" />
                  <div className="skeleton h-3 w-24" />
                </div>
                <div className="skeleton size-4 rounded" />
              </div>
            ))}
          </div>
        </div>
      </div>
    </AppShell>
  );
}
