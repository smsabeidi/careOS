/**
 * The shapes that cross the client/server line for the command bar (ST-232/ST-233).
 *
 * Declared here, away from any server module, so the client island can import them
 * without pulling a Supabase client into the browser bundle — and so the contract between
 * the two halves is one file a reviewer can read in a minute.
 *
 * Two properties are load-bearing and both are visible in the types themselves:
 *   · What the CLIENT sends is `EntityRef` — {type, id}. Never a name, never a note,
 *     never anything the server would have to trust (invariant 5).
 *   · What the SERVER returns carries display labels it has just re-read under RLS, plus
 *     enum-and-count evidence. No coordinate, no distance, no clinical detail (D-030).
 */

export type EntityType = "client" | "caregiver";

/** What travels from the browser: a reference. Content is refetched under RLS. */
export type EntityRef = { type: EntityType; id: string };

/** A reference plus the label the server just read for it. Labels are never cached. */
export type ContextEntity = EntityRef & { label: string };

/** One deterministic pre-flight finding, in words. Status is never colour alone (D-012). */
export type PreflightCheckView = {
  key: string;
  label: string;
  status: "pass" | "attention" | "unknown";
  finding: string;
};

/** The inert draft the bar renders. It is a record of a proposal, never an action. */
export type DraftCard = {
  proposalId: string;
  action: string;
  /** "Assign Sam Okafor to Doris Fenwick's visit" — one line, plain language. */
  headline: string;
  /** Agency-local wall clock, spelled out. */
  when: string;
  /** What approving will do, and what it will not. */
  effect: string;
  checks: PreflightCheckView[];
  /** The model's narration of the checks, or null on any degrade path. */
  narration: string | null;
  /** Why there is no narration, in plain language. Null when there is one. */
  narrationNote: string | null;
  /** Autonomy tier the draft was governed at, shown so the gate is visible. */
  tier: string;
  requiresHuman: boolean;
};

export type BrainCitationView = { n: number; title: string; source_ref: string | null };

/** Everything the composer can come back with. Every arm renders a state (four-state). */
export type CommandResult =
  | {
      kind: "answer";
      question: string;
      answer: string;
      abstained: boolean;
      citations: BrainCitationView[];
      provider: string;
      model: string;
    }
  | { kind: "draft"; draft: DraftCard }
  /** The platform declined to guess and asked one question back. */
  | { kind: "clarify"; message: string }
  /** Something did not run. The message says what was and was not written. */
  | { kind: "error"; message: string };
