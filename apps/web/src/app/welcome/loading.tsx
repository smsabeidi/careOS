/* Loading mirror for /welcome.
 *
 * Deliberately untranslated: it holds no words. A skeleton that mirrors the real
 * layout means the greeting, the checklist and the buttons arrive in the space
 * they already occupy, so nothing jumps under somebody's thumb on the first
 * screen they ever see. Four-state doctrine, docs/10 §8. */

export default function Loading() {
  return (
    <main className="flex min-h-dvh items-center justify-center px-4 py-10 sm:py-14" aria-busy="true">
      <div className="w-full max-w-xl">
        <div className="mb-8 flex flex-col gap-5">
          <div className="skeleton h-11 w-11 rounded-[var(--radius-md)]" />
          <div className="flex flex-col gap-2.5">
            <div className="skeleton h-9 w-64 rounded-[var(--radius-sm)]" />
            <div className="skeleton h-5 w-full rounded-[var(--radius-xs)]" />
            <div className="skeleton h-5 w-3/4 rounded-[var(--radius-xs)]" />
          </div>
        </div>

        <div className="card flex flex-col gap-5 p-5 sm:p-6">
          <div className="flex flex-col gap-1.5">
            <div className="skeleton h-4 w-40 rounded-[var(--radius-xs)]" />
            <div className="skeleton h-2 w-full rounded-full" />
          </div>
          <ul className="flex flex-col gap-2">
            {[0, 1, 2].map((i) => (
              <li key={i} className="flex items-center gap-3.5 py-3">
                <div className="skeleton h-10 w-10 shrink-0 rounded-[var(--radius-md)]" />
                <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                  <div className="skeleton h-4 w-1/2 rounded-[var(--radius-xs)]" />
                  <div className="skeleton h-3.5 w-4/5 rounded-[var(--radius-xs)]" />
                </div>
              </li>
            ))}
          </ul>
          <div className="skeleton h-12 w-full rounded-[var(--radius-md)]" />
        </div>
      </div>
    </main>
  );
}
