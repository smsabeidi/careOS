/* ─────────────────────────────────────────────────────────────────────────────
   Vitest — the unit gate for the web app (docs/12 §4 "unit / pure logic")
   ───────────────────────────────────────────────────────────────────────────
   docs/12 puts the cheapest, fastest checks at the bottom of the pyramid and
   reserves pgTAP for anything the database decides. This runner covers the
   layer in between: the pure TypeScript that carries real consequence but has
   no SQL and no server — the offline clock queue, the location sampler, the
   deterministic exception ranking, the CAREOS_* → plain-language mapping, the
   i18n dictionaries, and the PHI minimizers that stand between a fact table
   and a model prompt.

   DELIBERATE CHOICES

   · `environment: "node"`. Nothing here renders a component, so jsdom would buy
     an 8 MB dependency and a slower boot for globals the two tests that need
     them can stub in four lines (see today/locate.test.ts). Add jsdom the day a
     component test actually exists, not before.

   · `include` is scoped to `src/**`. The Playwright suite lives in `e2e/` and
     owns files named `*.spec.ts`; Vitest never looks there, so the two runners
     cannot fight over a file or a reporter.

   · No `setupFiles`. Every global a test needs (indexedDB, geolocation,
     sessionStorage, window) is stubbed inside the file that needs it, so
     reading one test file tells you the whole environment it assumes. Shared
     setup that silently changes globals is how a suite starts passing for
     reasons nobody can name.

   · `restoreMocks` + `unstubGlobals`. A stubbed `navigator` or a faked timer
     that survives into the next file is a flake generator; Vitest tears both
     down between tests here rather than trusting each file to remember.

   · Coverage is v8, reported but NOT thresholded. A threshold on a suite this
     young would be a number chosen to match today's code rather than a
     standard, and docs/12 §9 gates releases on named journeys, not on a
     percentage. Thresholds land when the E2E layer does.
──────────────────────────────────────────────────────────────────────────── */

import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    exclude: ["node_modules/**", ".next/**", "e2e/**"],
    restoreMocks: true,
    unstubGlobals: true,
    unstubEnvs: true,
    coverage: {
      provider: "v8",
      reporter: ["text-summary", "html"],
      reportsDirectory: "./coverage",
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.test.ts", "src/**/*.d.ts"],
    },
  },
});
