/**
 * The mount point — one import in `shell.tsx`, and the whole tree hangs off it (ST-232).
 *
 * The command bar is deliberately NOT woven into the shell: the shell decides what a role
 * sees on their rail, and the bar is a surface of its own with its own flags, its own
 * server actions and its own client island. `AppShell` gains one line; everything else
 * about the bar lives under this directory and can be reviewed, flagged off, or removed
 * without touching navigation.
 *
 * The gate is server-side and absolute. `front_door.command_bar` is read from Postgres
 * here, and when it is off this returns null — no overlay, no button, no keyboard
 * listener, no bundle for the island, and no teaser telling anyone about a feature they
 * do not have. The drafting flag is read at the same moment and passed down, so a bar
 * with the lane off never renders a control it cannot honour.
 *
 * @trace ST-232, ST-233, docs/designs/intelligent-front-door.md W1
 */
import { commandBarFlags } from "./flags";
import { CommandBar } from "./command-bar";

export async function CommandBarMount() {
  const flags = await commandBarFlags();
  if (!flags.bar) return null;
  return <CommandBar actionsEnabled={flags.actions} />;
}
