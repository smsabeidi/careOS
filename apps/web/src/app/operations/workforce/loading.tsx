import { AppShell } from "@/components/shell";
import { PageHeader } from "@/components/ui";

/**
 * Layout-mirroring skeleton (docs/10 §8, docs/17 §7.3). The four metric tiles, the
 * provenance line, the range rail, the written-summary card, the weekday strip and the
 * caregiver table land in the places they will occupy once the figures arrive, so nothing
 * jumps. No spinner walls, and no claim about what the report says until it says it.
 */
export default function Loading() {
  return (
    <AppShell active="/operations/workforce">
      <div aria-busy="true" aria-label="Loading workforce figures">
        <PageHeader title="Workforce" sub="Visit performance across the agency" />

        {/* Metric tiles */}
        <div className="mb-3 grid grid-cols-2 gap-3 lg:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="card px-5 py-4">
              <div className="flex items-start justify-between gap-3">
                <div className="skeleton h-3.5 w-28" />
                <div className="skeleton size-8 rounded-[10px]" />
              </div>
              <div className="skeleton mt-2.5 h-7 w-16" />
              <div className="skeleton mt-2 h-3 w-32" />
            </div>
          ))}
        </div>

        {/* Provenance line */}
        <div className="mb-5 space-y-1.5">
          <div className="skeleton h-3 w-full max-w-3xl" />
          <div className="skeleton h-3 w-2/3 max-w-xl" />
        </div>

        {/* Range rail */}
        <div className="mb-4">
          <div className="skeleton h-9 w-56 rounded-[var(--radius-md)]" />
        </div>

        {/* Written summary */}
        <div className="card mb-6 px-5 py-4">
          <div className="skeleton h-4 w-36" />
          <div className="skeleton mt-3 h-4 w-3/4" />
          <div className="mt-4 space-y-3">
            {Array.from({ length: 3 }).map((_, i) => (
              <div key={i}>
                <div className="skeleton h-2.5 w-24" />
                <div className="skeleton mt-1.5 h-3 w-full" />
                <div className="skeleton mt-1.5 h-3 w-5/6" />
              </div>
            ))}
          </div>
        </div>

        {/* Weekday strip */}
        <div className="card mb-6 px-5 py-4">
          <div className="skeleton h-3 w-72 max-w-full" />
          <div className="mt-3 flex items-end gap-1.5">
            {Array.from({ length: 7 }).map((_, i) => (
              <div key={i} className="flex flex-1 flex-col items-center gap-1">
                <div className="skeleton h-2.5 w-5" />
                <div className="skeleton w-full" style={{ height: 20 + ((i * 7) % 24) }} />
                <div className="skeleton h-2.5 w-6" />
              </div>
            ))}
          </div>
        </div>

        {/* Caregiver table */}
        <div className="skeleton mb-3 h-4 w-32" />
        <div className="card divide-y hairline overflow-hidden">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="flex items-center gap-4 px-5 py-4">
              <div className="min-w-0 flex-1 space-y-2">
                <div className="skeleton h-3.5 w-40" />
                <div className="skeleton h-3 w-32" />
              </div>
              <div className="skeleton h-6 w-28 rounded-full" />
              <div className="skeleton hidden h-3 w-10 sm:block" />
              <div className="skeleton hidden h-3 w-10 sm:block" />
              <div className="skeleton hidden h-3 w-10 md:block" />
              <div className="skeleton hidden h-3 w-12 md:block" />
            </div>
          ))}
        </div>
      </div>
    </AppShell>
  );
}
