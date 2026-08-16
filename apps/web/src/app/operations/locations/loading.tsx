import { AppShell } from "@/components/shell";
import { PageHeader } from "@/components/ui";

/**
 * Layout-mirroring skeleton (docs/10 §8): tiles, the standing note about attestation, the
 * filter row, the add disclosure and two place cards land where they will sit once the
 * data arrives. Nothing claims a pin is or is not confirmed until that has been read.
 */
export default function Loading() {
  return (
    <AppShell active="/operations/locations" skeleton>
      <div aria-busy="true" aria-label="Loading places of care">
        <PageHeader title="Places of care" sub="Where visits happen, and who confirmed each pin" />

        <div className="mb-3 grid grid-cols-2 gap-3 lg:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="card px-5 py-4">
              <div className="flex items-start justify-between gap-3">
                <div className="skeleton h-3.5 w-24" />
                <div className="skeleton size-8 rounded-[10px]" />
              </div>
              <div className="skeleton mt-2.5 h-7 w-12" />
              <div className="skeleton mt-2 h-3 w-24" />
            </div>
          ))}
        </div>

        {/* Standing note */}
        <div className="card-inset mb-6 px-5 py-4">
          <div className="skeleton h-4 w-64" />
          <div className="mt-3 space-y-1.5">
            <div className="skeleton h-3 w-full max-w-3xl" />
            <div className="skeleton h-3 w-11/12 max-w-3xl" />
            <div className="skeleton h-3 w-1/2 max-w-md" />
          </div>
        </div>

        {/* Filter + add */}
        <div className="mb-4 flex items-end gap-3">
          <div>
            <div className="skeleton h-3 w-12" />
            <div className="skeleton mt-2 h-11 w-56 rounded-[var(--radius-md)]" />
          </div>
          <div className="skeleton h-9 w-20 rounded-[var(--radius-sm)]" />
        </div>
        <div className="card mb-6 px-5 py-4">
          <div className="skeleton h-4 w-48" />
        </div>

        {/* Place cards */}
        <div className="flex flex-col gap-4">
          {Array.from({ length: 2 }).map((_, i) => (
            <div key={i} className="card px-5 py-5">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0 flex-1 space-y-2">
                  <div className="skeleton h-4 w-56" />
                  <div className="skeleton h-3 w-72 max-w-full" />
                </div>
                <div className="flex gap-1.5">
                  <div className="skeleton h-6 w-28 rounded-full" />
                  <div className="skeleton h-6 w-32 rounded-full" />
                </div>
              </div>

              <div className="mt-4 grid gap-4 sm:grid-cols-2">
                <div>
                  <div className="skeleton h-3 w-28" />
                  <div className="skeleton mt-2 h-3.5 w-48" />
                  <div className="skeleton mt-1.5 h-3.5 w-36" />
                </div>
                <div>
                  <div className="skeleton h-3 w-16" />
                  <div className="skeleton mt-2 h-3.5 w-44" />
                  <div className="skeleton mt-1.5 h-3 w-full max-w-xs" />
                </div>
              </div>

              <div className="mt-3 space-y-2 border-t pt-3 hairline">
                <div className="skeleton h-3.5 w-36" />
                <div className="skeleton h-3.5 w-40" />
                <div className="skeleton h-3.5 w-44" />
              </div>
            </div>
          ))}
        </div>
      </div>
    </AppShell>
  );
}
