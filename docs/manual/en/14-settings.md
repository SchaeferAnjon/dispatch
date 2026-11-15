# Settings

> What this page is for: what every card and every switch on the settings page means, and its default. Most settings are stored on the shared task board (so both Macs agree, and `dispatch settings` on the command line reads and writes the same copy); the ones marked "This Mac" affect only the local machine.

## Language

**Interface language**: Follow system, 中文, English, Deutsch. Following the system picks automatically based on the macOS or browser language; a choice takes effect immediately and applies to the phone web version as well.

## Sessions

- **Archive ordinary sessions after this many days without activity** (30 by default, 0 = never): starred (tracked) sessions are unaffected; archived ones are still available under "Archived" on the sessions page and in ⌘K.
- **Model for summaries**: the dropdown lists the available models, each labeled "Subscription", "Key set" or "No key". Subscription models (such as `claude:haiku`, which goes through a Claude Code subscription) need no key and count against your usage; API-key models (Zhipu, Kimi, MiniMax, OpenAI) use the keys under "Environment". Picking a model with no key reveals an input box, and the key you paste is saved to this machine's `dispatch env`. Left empty = chosen automatically: the `SUMMARY_MODEL` environment variable, then the first available model.
- **The table of uses**: where summaries appear, one switch per row, with the token count, time and model of the last run on the right. The uses are: session summary, project status, dispatch here, discussion conclusion, insight report, memory summary, device scan, and semantic search indexing (which only accepts ZHIPU_API_KEY). **They are all on by default**; if you do not want content leaving the machine, turn them off here. From the terminal, `dispatch summarize uses` shows the table and `dispatch settings summary_uses '{"session":0}'` changes it.
- **Treat sessions started by a script or another Agent through the SDK as scheduled sessions** (on by default): scheduled sessions never enter "Needs me", never send notifications and never appear on the workbench; you find them under "Scheduled or script" on the sessions page. A session you marked by hand keeps your marking.

## Phone notifications

See [Phone → Notifications](20-phone.md#push-notifications-to-your-phone). This card holds: the Bark key, the ntfy topic URL (saved into `dispatch env` as `BARK_KEY` / `NTFY_URL`; with both configured, ntfy wins), four event switches (an Agent replied, an Agent is waiting for your confirmation or asking a question, a task finished, only you can do it) and "Send a test notification".

## Projects

- **Workspace roots** (`~/Projects` by default, one per line): each direct subfolder of these folders counts as one project. Anywhere else, the git repository root decides the project, or the containing folder if there is no repository.
- Only folders with tasks, with outcomes, or manually linked count as real projects; the rest are just "folders".

## Discussions

The persona of each member of "Discuss an idea" and the rules of the room, which go into their system prompts; each round only adds the new messages. Leave them empty for the defaults.

- **The rules of the room**: how long a turn may be, when small talk is fine, and when to answer only SKIP (not shown).
- **The personas of Claude / Codex / pi**: one sentence each, on what they focus on, how they express themselves, and what they habitually question.

## Workbench

- **Archive finished tasks after this many days** (0 by default = never automatically): tasks finished longer ago than this get an archive mark and leave the Done column and its counts; the board keeps its "Archive finished over 30 days ago" button.
- **Projects expanded by default** (2 by default): the rest collapse to one line, and projects waiting for your reply or a confirmation are always expanded.

## This Mac

- **Appearance**: Follow system, Light, Dark; affects only the windows on this machine.
- **Phone access**: an embedded QR code (the link carries a login token, so one scan is enough) and "Copy link". With two machines you can choose which one the "Phone version runs on": pick the one that stays put, so the phone still works when you take this Mac with you; after switching machines you have to open the link once more on the phone.
- **Screen access**: "Set up" installs noVNC and its background service and turns on Tailscale HTTPS (the equivalent of `dispatch screen setup`), listing the result of each step; the Screen Sharing switch itself you have to flip in System Settings → General → Sharing. Once set up, the link and "Copy screen link" appear.
- **Version and updates**: "Current vX, latest vY". "Check for updates" queries the GitHub releases; when there is a new version, "Update to vY" downloads the zip for your architecture, replaces `/Applications/Dispatch.app`, clears the quarantine flag and restarts automatically, keeping your permissions and login state. The web version can only show the version. From the terminal: `dispatch update check|apply [--no-relaunch]`.
- **First-run setup**: "Open first-run setup" returns to the six-step wizard, where every step can be run again.
- **Machines**: every Mac in `~/tasks/.dispatch/hosts.json`: the online dot, the name, "Rename" (pushed to every known machine), "Check again" (clears the cache and probes over ssh again) and "Delete" (click twice; after that this Mac stops trying to reach it). "Connect another Mac…" opens first-run setup.

## The bottom

"Save" and "Restore". Stored on the shared task board, so both Macs agree. Right-clicking empty space offers "Check for updates".

## The command-line equivalents

```sh
dispatch settings                      # show everything
dispatch settings session_archive_days 60
dispatch settings summary_model claude:haiku
dispatch settings summary_uses '{"session": 0, "project": 0}'
dispatch summarize providers | uses | set-key zhipu
dispatch update check | apply
dispatch screen status | setup
dispatch serve url | qr | host <machine>
dispatch hosts [rename <id|local|name> <new name>]
dispatch init status | run <step>
```
