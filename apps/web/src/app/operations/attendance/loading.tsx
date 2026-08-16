import { AppShell } from "@/components/shell";
import { PageHeader } from "@/components/ui";

/**
 * Layout-mirroring skeleton (docs/10 §8): the window rail, four tiles and the two tables
 * land where the real thing will, so nothing jumps when the data arrives. No spinner
 * wall, and no claim about attendance until it is known.
 */
export default function Loading() {
  return (
    <AppShell active="/operations/attendance" skeleton>
      <div aria-busy="true" aria-label="Loading attendance">
        <PageHeader title="Attendance" sub="Scheduled against actual" />

        {/* Window rail */}
        <div className="mb-4">
          <div className="skeleton h-9 w-56 rounded-[var(--radius-md)]" />
        </div>

        {/* Metric tiles */}
        <div className="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="card px-5 py-4">
              <div className="flex items-start justify-between gap-3">
                <div className="skeleton h-3.5 w-24" />
                <div className="skeleton size-8 rounded-[10px]" />
              </div>
              <div className="skeleton mt-2.5 h-7 w-12" />
            </div>
          ))}
        </div>

        {/* By caregiver */}
        <div className="mb-8">
          <div className="skeleton mb-3 h-4 w-32" />
          <div className="card overflow-hidden">
            <div className="border-b px-5 py-3 hairline">
              <div className="skeleton h-3 w-full max-w-xl" />
            </div>
            {Array.from({ length: 5 }).map((_, i) => (
              <div key={i} className="flex items-center gap-6 border-b px-5 py-3.5 last:border-0 hairline">
                <div className="skeleton h-3.5 w-40" />
                <div className="ml-auto flex gap-6">
                  {Array.from({ length: 6 }).map((__, j) => (
                    <div key={j} className="skeleton h-3.5 w-10" />
                  ))}
                </div>
              </div>
            ))}
          </div>
          <div className="skeleton mt-3 h-3 w-2/3 max-w-2xl" />
        </div>

        {/* Visit by visit */}
        <div>
          <div className="skeleton mb-3 h-4 w-28" />
          <div className="card overflow-hidden">
            <div className="border-b px-5 py-3 hairline">
              <div className="skeleton h-3 w-full max-w-2xl" />
            </div>
            {Array.from({ length: 8 }).map((_, i) => (
              <div key={i} className="flex items-center gap-6 border-b px-5 py-2.5 last:border-0 hairline">
                <div className="skeleton h-3.5 w-24" />
                <div className="skeleton h-3.5 w-32" />
                <div className="skeleton h-3.5 w-28" />
                <div className="ml-auto flex gap-4">
                  <div className="skeleton h-6 w-20 rounded-full" />
                  <div className="skeleton h-6 w-24 rounded-full" />
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </AppShell>
  );
}
