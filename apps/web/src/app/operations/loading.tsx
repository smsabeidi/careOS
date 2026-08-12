import { AppShell } from "@/components/shell";
import { PageHeader } from "@/components/ui";

/**
 * Layout-mirroring skeleton for the live board (docs/10 §8, docs/17 §7.3).
 *
 * Five tiles, the explanatory line, and a table with its real column rhythm land in the
 * places they will occupy once the data arrives, so nothing jumps when it does. No
 * spinner wall, and — importantly for a board people watch — no number, count or claim
 * about the day until the day is actually known.
 */
export default function Loading() {
  return (
    <AppShell active="/operations">
      <div aria-busy="true" aria-label="Loading today's operations board">
        <PageHeader title="Operations" sub="Today" />

        {/* Five counters */}
        <div className="mb-3 grid grid-cols-2 gap-3 lg:grid-cols-5">
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="card px-5 py-4">
              <div className="flex items-start justify-between gap-3">
                <div className="skeleton h-3.5 w-20" />
                <div className="skeleton size-8 rounded-[10px]" />
              </div>
              <div className="skeleton mt-2.5 h-7 w-10" />
              <div className="skeleton mt-2 h-3 w-24" />
            </div>
          ))}
        </div>

        {/* The "where the numbers come from" line */}
        <div className="mb-6 space-y-1.5">
          <div className="skeleton h-3 w-full max-w-3xl" />
          <div className="skeleton h-3 w-2/3 max-w-xl" />
        </div>

        {/* The day's visit table */}
        <div className="card overflow-hidden">
          <div className="border-b px-5 py-3 hairline">
            <div className="skeleton h-3 w-40" />
          </div>
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="flex items-center gap-4 border-b px-5 py-3.5 last:border-0 hairline">
              <div className="skeleton h-3.5 w-28 shrink-0" />
              <div className="skeleton h-3.5 w-32 shrink-0" />
              <div className="skeleton h-3.5 w-36 shrink-0" />
              <div className="skeleton hidden h-3.5 w-36 shrink-0 sm:block" />
              <div className="skeleton ml-auto h-6 w-24 shrink-0 rounded-full" />
            </div>
          ))}
        </div>
      </div>
    </AppShell>
  );
}
