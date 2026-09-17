# Two Macs

> What this page is for: how to join the second Mac, what syncs, how to move projects and sessions to the other machine, filtering by machine, and what it looks like when one of them is offline.

## Joining

The first Mac to finish first-run setup is the **hub**: the task board (a Dolt database), the rules and the skills all live on it. On the second Mac:

1. On the hub, open System Settings → General → Sharing → **Remote Login** (joining needs SSH).
2. Install Dispatch on the second Mac, pick "Another Mac already runs Dispatch" at step 3 of first-run setup, and enter the hub's `user@address`: the local IP on the same Wi-Fi, or the Tailscale address when you are out (the page can pick one from the Tailscale list). You can also click "Connect another Mac…" under Settings → Machines.
3. Enter the hub's login password once (used once, never stored) and Dispatch copies the local public key over, so both sides then connect without one; if you would rather not type the password, click "Let the local agent do it" and an Agent does it in a terminal.
4. Click "Connect and join". After joining, the page shows "Joined &lt;name&gt;; syncs both ways every 2 minutes".
5. "Check now" tests whether the hub can reach back to this Mac (which it needs in order to merge this machine's sessions); if it fails, the page tells you where to turn on Remote Login.

If this Mac already has a board and you want to join instead: use "Switch to another Mac's task board…" at step 3, and the local board is stopped and kept under a new name (`~/tasks/.beads.retired-DATE`), never deleted.

## What syncs

| Content | How |
|:--|:--|
| The task board (tasks, outcomes, knowledge base, settings, project stars and archives) | Both ways every 2 minutes (the Dolt remote API) |
| The shared rules GLOBAL.md, FACTS.md, PROFILE.md | `dispatch rules push\|pull\|auto`, with the app's timer reconciling every half hour |
| The skill pool | Copied from the hub at step 5 of first-run setup; after that the `dispatch rules` commands sync it |
| Session records | Not copied. Each stays on its own machine, and Dispatch reads the other machine's list and details over ssh (the remote list is capped at 200 rows) |
| Keys (dispatch env) | Not synced; configured on each machine separately |
| Send receipts, phone tokens | Not synced |

An "All / machine A / machine B" row appears at the top of the sidebar: pick one and the tasks, sessions, quota and stats all follow it, while "All" merges both. The phone has the same picker at the top. The machine bar at the top of the "Agent status" page lets you delegate and view screens.

## Moving a project

"Move to &lt;machine&gt;" in the project page header:

1. **Pre-check**: Git and file differences, and which tools are missing; a conflict is refused (only `--force` overwrites the other side's changes).
2. Once you confirm, the folder (including uncommitted changes), the Git history, the running sessions and the whole history are carried over, and the other machine picks up right where you left off.
3. The move runs in the background, with a progress bar on the project card and the project page (switching pages or refreshing does not lose it); `dispatch project-moves` shows the progress.
4. When it is done, the project's Mac becomes that machine, and new sessions start there by default.

From the command line:

```sh
dispatch project <project name> --move-to <machine id or name> [--dry-run] [--background] [--keep-original]
dispatch project <project name> --owner <machine|local|none>     # records ownership only, moves no files
```

## Moving a single session

Right-click a session → "Move to &lt;machine&gt; and carry on", or:

```sh
dispatch move <session id prefix> --to <machine> [--prompt "extra instructions"] [--no-files] [--dry-run]
```

After the other side takes over, both machines have a copy in their session list: the original is labeled "moved to &lt;machine&gt;" and the new one "moved from &lt;machine&gt;"; the original session is stopped by default (`--keep-original` leaves it running). Claude Code and Codex are supported; pi keeps its sessions in its own database and cannot be moved yet. `dispatch resume <id> --on <machine>` says which machine to resume on.

## What it looks like when one is offline

- The top of the workbench says "&lt;machine&gt; unreachable right now" and keeps what was already read; opening a session on the other machine tells you "This session lives on &lt;machine&gt;, which cannot be reached right now, because its Tailscale is offline or it is asleep. It will load once that Mac is back."
- Offline machines cannot be picked in the machine dropdown of a new session; picking an offline machine on a configuration page (skills, rules, memories) shows the reason ("Tailscale is off on this Mac" or "&lt;machine&gt; is offline").
- The task board: each side reads and writes locally and merges both ways once back online; changing the same task on both sides can produce a Dolt conflict, see [Troubleshooting](24-troubleshooting.md#the-two-macs-fail-to-sync).
- Quota: one account shares a single quota across both machines and they do not add up; when one side's reading is stale, the card says so.

## Managing machines

Settings → Machines: rename (pushed to every known machine), check again, delete. `dispatch hosts` lists this machine and the others, the overlay network type, the remote desktop capabilities and the recommended route; `dispatch hosts rename <id|local|name> <new name>`. `dispatch --host <id> <any subcommand>` runs a command on the other machine.
