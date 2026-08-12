import { AppShell } from "@/components/shell";
import { PageHeader } from "@/components/ui";

/**
 * Layout-mirroring skeleton (docs/10 §8): the two standing notes, the scope rail, the
 * inheritance ladder, the in-force panels and the editor land where they will sit, so the
 * page settles instead of jumping. No spinner wall, and no claim about which rules are in
 * force until they have actually been read.
 */
export default function Loading() {
  return (
    <AppShell active="/settings/visit-policy">
      <div aria-busy="true" aria-label="Loading the visit policy">
        <PageHeader title="Visit policy" sub="The rules every visit is measured against" />

        {/* Standing notes */}
        <div className="mb-6 grid gap-3 lg:grid-cols-2">
          {Array.from({ length: 2 }).map((_, i) => (
            <div key={i} className="card-inset px-5 py-4">
              <div className="skeleton h-3 w-64" />
              <div className="skeleton mt-2 h-3 w-full" />
              <div className="skeleton mt-2 h-3 w-4/5" />
            </div>
          ))}
        </div>

        {/* Scope rail */}
        <div className="mb-6">
          <div className="skeleton h-9 w-96 max-w-full rounded-[var(--radius-md)]" />
        </div>

        {/* Inheritance ladder */}
        <div className="mb-6">
          <div className="skeleton mb-3 h-4 w-52" />
          <div className="card px-5 py-4">
            {Array.from({ length: 3 }).map((_, i) => (
              <div key={i} className="mb-2 flex items-center gap-3 last:mb-0">
                <div className="skeleton h-3.5 w-40" />
                <div className="skeleton h-3 flex-1 max-w-xs" />
                <div className="skeleton h-6 w-40 rounded-full" />
              </div>
            ))}
          </div>
        </div>

        {/* In force now */}
        <div className="mb-6">
          <div className="skeleton mb-3 h-4 w-28" />
          <div className="grid gap-3 lg:grid-cols-2">
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="card px-5 py-4">
                <div className="skeleton h-4 w-36" />
                <div className="skeleton mt-2 h-3 w-full" />
                <div className="mt-3 flex flex-col gap-2">
                  {Array.from({ length: 4 }).map((__, j) => (
                    <div key={j} className="flex items-center justify-between gap-4">
                      <div className="skeleton h-3.5 w-40" />
                      <div className="skeleton h-3.5 w-24" />
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Editor */}
        <div className="skeleton mb-3 h-4 w-44" />
        <div className="card px-5 py-5">
          <div className="skeleton h-4 w-40" />
          <div className="mt-3 grid gap-4 sm:grid-cols-2">
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i}>
                <div className="skeleton h-3 w-32" />
                <div className="skeleton mt-2 h-11 w-full rounded-[var(--radius-md)]" />
                <div className="skeleton mt-2 h-3 w-4/5" />
              </div>
            ))}
          </div>
          <div className="mt-5 border-t pt-4 hairline">
            <div className="skeleton h-9 w-44 rounded-[var(--radius-sm)]" />
          </div>
        </div>
      </div>
    </AppShell>
  );
}
