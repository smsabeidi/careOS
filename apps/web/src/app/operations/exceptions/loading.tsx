import { AppShell } from "@/components/shell";
import { PageHeader } from "@/components/ui";

/**
 * Layout-mirroring skeleton for the findings queue (docs/10 §8, docs/17 §7.3).
 *
 * Four tiles, the "how the order is worked out" line, the tab rail and three finding
 * cards land where the real ones will, so the queue does not jump under a reader who has
 * already started moving toward a button. Crucially, no count and no urgency word is
 * shown while loading: a skeleton that guesses "3 critical" and lands on none is worse
 * than one that says nothing.
 */
export default function Loading() {
  return (
    <AppShell active="/operations">
      <div aria-busy="true" aria-label="Loading the findings queue">
        <PageHeader title="Findings" sub="What the automatic checks want a person to look at" />

        {/* Four counters */}
        <div className="mb-3 grid grid-cols-2 gap-3 lg:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="card px-5 py-4">
              <div className="flex items-start justify-between gap-3">
                <div className="skeleton h-3.5 w-24" />
                <div className="skeleton size-8 rounded-[10px]" />
              </div>
              <div className="skeleton mt-2.5 h-7 w-14" />
              <div className="skeleton mt-2 h-3 w-20" />
            </div>
          ))}
        </div>

        {/* The "how the order is worked out" line */}
        <div className="mb-6 space-y-1.5">
          <div className="skeleton h-3 w-full max-w-3xl" />
          <div className="skeleton h-3 w-3/4 max-w-2xl" />
        </div>

        {/* Tab rail */}
        <div className="mb-4">
          <div className="skeleton h-9 w-72 rounded-[var(--radius-md)]" />
        </div>

        {/* One group heading + three finding cards */}
        <div className="skeleton mb-3 h-4 w-48" />
        <div className="flex flex-col gap-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="card px-5 py-4">
              <div className="flex items-start gap-3.5">
                <div className="skeleton size-10 shrink-0 rounded-[12px]" />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <div className="skeleton h-4 w-56" />
                    <div className="skeleton h-6 w-20 rounded-full" />
                    <div className="skeleton h-6 w-32 rounded-full" />
                  </div>
                  <div className="skeleton mt-2.5 h-3 w-full max-w-2xl" />
                  <div className="skeleton mt-1.5 h-3 w-2/3 max-w-xl" />
                  <div className="skeleton mt-3 h-3 w-80 max-w-full" />
                  <div className="skeleton mt-2 h-3 w-64 max-w-full" />
                  <div className="mt-3 flex gap-2 border-t pt-3 hairline">
                    <div className="skeleton h-9 w-32 rounded-[var(--radius-sm)]" />
                    <div className="skeleton h-9 w-24 rounded-[var(--radius-sm)]" />
                    <div className="skeleton h-9 w-24 rounded-[var(--radius-sm)]" />
                    <div className="skeleton h-9 w-24 rounded-[var(--radius-sm)]" />
                  </div>
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </AppShell>
  );
}
