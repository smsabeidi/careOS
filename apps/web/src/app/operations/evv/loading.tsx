import { AppShell } from "@/components/shell";
import { PageHeader } from "@/components/ui";

/**
 * Layout-mirroring skeleton (docs/10 §8): the tiles, the D-026 note, the adapter rail and
 * two record cards land where they will sit once the data arrives, so nothing jumps and
 * no claim is made about what is on file until it is known.
 */
export default function Loading() {
  return (
    <AppShell active="/operations/evv" skeleton>
      <div aria-busy="true" aria-label="Loading EVV records">
        <PageHeader title="EVV records" sub="What CareOS asserts about each visit, and what has been sent" />

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

        {/* D-026 note */}
        <div className="card-inset mb-6 px-5 py-4">
          <div className="skeleton h-4 w-72" />
          <div className="mt-3 space-y-1.5">
            <div className="skeleton h-3 w-full max-w-3xl" />
            <div className="skeleton h-3 w-11/12 max-w-3xl" />
            <div className="skeleton h-3 w-2/3 max-w-xl" />
          </div>
        </div>

        {/* Adapter rail */}
        <div className="mb-6">
          <div className="skeleton mb-3 h-4 w-24" />
          <div className="card divide-y hairline overflow-hidden">
            {Array.from({ length: 2 }).map((_, i) => (
              <div key={i} className="flex items-center gap-4 px-5 py-4">
                <div className="flex-1 space-y-2">
                  <div className="skeleton h-3.5 w-40" />
                  <div className="skeleton h-3 w-56" />
                </div>
                <div className="skeleton h-6 w-44 rounded-full" />
              </div>
            ))}
          </div>
        </div>

        {/* Tab rail */}
        <div className="mb-4">
          <div className="skeleton h-9 w-72 rounded-[var(--radius-md)]" />
        </div>

        {/* Record cards */}
        <div className="flex flex-col gap-4">
          {Array.from({ length: 2 }).map((_, i) => (
            <div key={i} className="card px-5 py-5">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0 flex-1 space-y-2">
                  <div className="skeleton h-4 w-64" />
                  <div className="skeleton h-3 w-80 max-w-full" />
                </div>
                <div className="flex gap-1.5">
                  <div className="skeleton h-6 w-28 rounded-full" />
                  <div className="skeleton h-6 w-20 rounded-full" />
                </div>
              </div>

              <div className="skeleton mt-4 h-3 w-40" />
              <div className="mt-2 grid gap-x-6 gap-y-2 sm:grid-cols-2">
                {Array.from({ length: 6 }).map((__, j) => (
                  <div key={j} className="skeleton h-3.5 w-44" />
                ))}
              </div>

              <div className="skeleton mt-3 h-3 w-72 max-w-full" />

              <div className="mt-4 border-t pt-4 hairline">
                <div className="skeleton h-3 w-36" />
                <div className="skeleton mt-2 h-3.5 w-full max-w-md" />
              </div>
            </div>
          ))}
        </div>
      </div>
    </AppShell>
  );
}
