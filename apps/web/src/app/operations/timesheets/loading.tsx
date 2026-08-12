import { AppShell } from "@/components/shell";
import { PageHeader } from "@/components/ui";

/**
 * Layout-mirroring skeleton (docs/10 §8): tiles, the tab rail, three approval cards and
 * the period table land where the real ones will. Nothing jumps, and nothing claims a
 * queue is empty before it is known — an empty state is a fact, not a loading frame.
 */
export default function Loading() {
  return (
    <AppShell active="/operations/timesheets">
      <div aria-busy="true" aria-label="Loading timesheets">
        <PageHeader title="Timesheets" sub="Hours a person approves, then a file with a fingerprint on it" />

        {/* Metric tiles */}
        <div className="mb-3 grid grid-cols-2 gap-3 lg:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="card px-5 py-4">
              <div className="flex items-start justify-between gap-3">
                <div className="skeleton h-3.5 w-28" />
                <div className="skeleton size-8 rounded-[10px]" />
              </div>
              <div className="skeleton mt-2.5 h-7 w-12" />
              <div className="skeleton mt-2 h-3 w-24" />
            </div>
          ))}
        </div>

        {/* Standing note */}
        <div className="mb-6 space-y-1.5">
          <div className="skeleton h-3 w-full max-w-3xl" />
          <div className="skeleton h-3 w-2/3 max-w-2xl" />
        </div>

        {/* Tab rail */}
        <div className="mb-4">
          <div className="skeleton h-9 w-72 rounded-[var(--radius-md)]" />
        </div>

        {/* Approval cards */}
        <div className="mb-10 flex flex-col gap-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="card px-5 py-4">
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div className="min-w-0 flex-1">
                  <div className="skeleton h-4 w-40" />
                  <div className="skeleton mt-2 h-3 w-80 max-w-full" />
                  <div className="mt-3 flex gap-1.5">
                    <div className="skeleton h-6 w-24 rounded-full" />
                    <div className="skeleton h-6 w-20 rounded-full" />
                  </div>
                </div>
                <div className="flex shrink-0 gap-6">
                  <div>
                    <div className="skeleton h-3 w-16" />
                    <div className="skeleton mt-2 h-6 w-20" />
                  </div>
                  <div>
                    <div className="skeleton h-3 w-16" />
                    <div className="skeleton mt-2 h-6 w-20" />
                  </div>
                </div>
              </div>
              <div className="mt-4 flex gap-2 border-t pt-4 hairline">
                <div className="skeleton h-9 w-36 rounded-[var(--radius-sm)]" />
                <div className="skeleton h-9 w-24 rounded-[var(--radius-sm)]" />
                <div className="skeleton h-9 w-28 rounded-[var(--radius-sm)]" />
              </div>
            </div>
          ))}
        </div>

        {/* Pay periods */}
        <div className="mb-10">
          <div className="skeleton mb-3 h-4 w-28" />
          <div className="card mb-3 flex gap-3 px-5 py-4">
            <div className="skeleton h-11 w-44 rounded-[var(--radius-md)]" />
            <div className="skeleton h-11 w-44 rounded-[var(--radius-md)]" />
            <div className="skeleton mt-auto h-9 w-32 rounded-[var(--radius-sm)]" />
          </div>
          <div className="card overflow-hidden">
            {Array.from({ length: 3 }).map((_, i) => (
              <div key={i} className="flex items-center gap-6 border-b px-5 py-3.5 last:border-0 hairline">
                <div className="skeleton h-3.5 w-48" />
                <div className="skeleton h-6 w-20 rounded-full" />
                <div className="ml-auto skeleton h-9 w-32 rounded-[var(--radius-sm)]" />
              </div>
            ))}
          </div>
        </div>

        {/* Exports */}
        <div>
          <div className="skeleton mb-3 h-4 w-40" />
          <div className="flex flex-col gap-3">
            {Array.from({ length: 2 }).map((_, i) => (
              <div key={i} className="card px-5 py-4">
                <div className="skeleton h-4 w-56" />
                <div className="skeleton mt-2 h-3 w-64" />
                <div className="skeleton mt-3 h-3 w-full max-w-lg" />
              </div>
            ))}
          </div>
        </div>
      </div>
    </AppShell>
  );
}
