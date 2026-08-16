import { AppShell } from "@/components/shell";
import { PageHeader } from "@/components/ui";

/**
 * Layout-mirroring skeleton (docs/10 §8) — the tiles, the tab rail and three proposal
 * cards land in the same places they will occupy once the data arrives, so nothing
 * jumps. No spinner walls, and no claim about what is waiting until it is known.
 */
export default function Loading() {
  return (
    <AppShell active="/inbox" skeleton>
      <div aria-busy="true" aria-label="Loading the approvals inbox">
        <PageHeader title="Approvals" sub="Every AI proposal, decided by a person" />

        {/* Metric tiles */}
        <div className="mb-3 grid grid-cols-2 gap-3 lg:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="card px-5 py-4">
              <div className="flex items-start justify-between gap-3">
                <div className="skeleton h-3.5 w-24" />
                <div className="skeleton size-8 rounded-[10px]" />
              </div>
              <div className="skeleton mt-2.5 h-7 w-12" />
              <div className="skeleton mt-2 h-3 w-20" />
            </div>
          ))}
        </div>

        {/* Flywheel line */}
        <div className="mb-6 space-y-1.5">
          <div className="skeleton h-3 w-full max-w-3xl" />
          <div className="skeleton h-3 w-2/3 max-w-xl" />
        </div>

        {/* Tab rail */}
        <div className="mb-4">
          <div className="skeleton h-9 w-64 rounded-[var(--radius-md)]" />
        </div>

        {/* Proposal cards */}
        <div className="flex flex-col gap-4">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="card px-5 py-5">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <div className="skeleton h-4 w-64" />
                  <div className="skeleton mt-2 h-3 w-80 max-w-full" />
                </div>
                <div className="flex gap-1.5">
                  <div className="skeleton h-6 w-32 rounded-full" />
                  <div className="skeleton h-6 w-24 rounded-full" />
                </div>
              </div>

              <div className="skeleton mt-4 h-3 w-28" />
              <div className="skeleton mt-2 h-28 w-full rounded-[var(--radius-md)]" />

              <div className="skeleton mt-3 h-14 w-full rounded-[var(--radius-md)]" />

              <div className="mt-4 flex gap-2 border-t pt-4 hairline">
                <div className="skeleton h-9 w-24 rounded-[var(--radius-sm)]" />
                <div className="skeleton h-9 w-36 rounded-[var(--radius-sm)]" />
                <div className="skeleton h-9 w-20 rounded-[var(--radius-sm)]" />
              </div>
            </div>
          ))}
        </div>
      </div>
    </AppShell>
  );
}
