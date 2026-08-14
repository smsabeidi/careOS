/**
 * The two switches this tree obeys, read where switches are read: in Postgres.
 *
 * `front_door.command_bar` and `front_door.actions` are INDEPENDENT (migration 0057 ships
 * both dark, with reasons). The bar can answer questions with the drafting lane still off,
 * and turning the lane off never takes the bar down. Both are resolved server-side through
 * `app.feature_enabled`, whose default here is FALSE: an unprovisioned tenant gets nothing,
 * not a preview. When the bar is off the mount renders NOTHING — no teaser, no disabled
 * button, no keyboard shortcut listener — and when the lane is off the composer is a
 * question box that never mentions drafting.
 *
 * Cached per request: `AppShell` renders on every authenticated page, and one flag is not
 * worth two round trips per navigation.
 *
 * @trace ST-232, ST-233, migration 0026 (app.feature_enabled), migration 0057
 */
import { cache } from "react";
import { supabaseServer } from "@/lib/supabase/server";

export const FLAG_COMMAND_BAR = "front_door.command_bar";
export const FLAG_ACTIONS = "front_door.actions";

export type CommandBarFlags = {
  /** The bar itself: the overlay, the trigger, the keyboard path. */
  bar: boolean;
  /** The drafting lane: NL → scheduling draft → ai_proposal. */
  actions: boolean;
};

async function readFlag(key: string): Promise<boolean> {
  try {
    const supabase = await supabaseServer();
    const { data, error } = await supabase.schema("app").rpc("feature_enabled", {
      p_key: key,
      p_default: false,
    });
    return !error && data === true;
  } catch {
    // A flag that cannot be read is a flag that is off. Failing open would ship an
    // unreleased surface on the day the RPC is unavailable.
    return false;
  }
}

export const commandBarFlags = cache(async (): Promise<CommandBarFlags> => {
  const [bar, actions] = await Promise.all([readFlag(FLAG_COMMAND_BAR), readFlag(FLAG_ACTIONS)]);
  return { bar, actions };
});
