import { AppShell } from "@/components/shell";
import { PageHeader } from "@/components/ui";

/** Layout-mirroring skeleton (docs/10 §8) — no spinner walls. */
export default async function Loading() {
  return (
    <AppShell active="/schedule" skeleton>
      <div aria-busy="true" aria-label="Loading the schedule">
        <PageHeader title="Schedule" sub="Week at a glance" />

        {/* Metrics */}
        <div className="mb-6 grid grid-cols-2 gap-3 md:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="card px-5 py-4">
              <div className="skeleton h-3.5 w-20" />
              <div className="skeleton mt-2.5 h-8 w-14" />
              <div className="skeleton mt-2 h-3 w-16" />
            </div>
          ))}
        </div>

        {/* Toolbar */}
        <div className="mb-4 flex items-center justify-between gap-3">
          <div className="skeleton h-9 w-64 rounded-[var(--radius-md)]" />
          <div className="skeleton h-4 w-48" />
        </div>

        {/* Grid */}
        <div className="card overflow-hidden">
          <div className="grid" style={{ gridTemplateColumns: "180px repeat(7, minmax(112px, 1fr))" }}>
            <div className="px-3 py-3" />
            {Array.from({ length: 7 }).map((_, i) => (
              <div key={i} className="px-2 py-3 text-center" style={{ borderLeft: "1px solid var(--border)" }}>
                <div className="skeleton mx-auto h-3 w-8" />
                <div className="skeleton mx-auto mt-1.5 h-3.5 w-6" />
              </div>
            ))}
          </div>
          {Array.from({ length: 7 }).map((_, r) => (
            <div
              key={r}
              className="grid border-t hairline"
              style={{ gridTemplateColumns: "180px repeat(7, minmax(112px, 1fr))" }}
            >
              <div className="flex items-center gap-2.5 px-3 py-3">
                <div className="skeleton size-8 rounded-full" />
                <div className="flex-1 space-y-1.5">
                  <div className="skeleton h-3 w-24" />
                  <div className="skeleton h-2.5 w-10" />
                </div>
              </div>
              {Array.from({ length: 7 }).map((_, c) => (
                <div key={c} className="px-1.5 py-1.5" style={{ borderLeft: "1px solid var(--border)" }}>
                  {(r + c) % 3 === 0 && <div className="skeleton h-9 w-full rounded-[8px]" />}
                </div>
              ))}
            </div>
          ))}
        </div>
      </div>
    </AppShell>
  );
}
