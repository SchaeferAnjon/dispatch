# Troubleshooting

> What this page is for: every entry is written as "symptom → cause → what to do". Start by searching a keyword from the symptom in the search box at the top of the page.

## The app opens empty, or shows a red error in English

**Symptom**: the workbench is blank, first-run setup does not appear, or there is a red English error at the top of the page (`SyntaxError`, `bd: command not found`, `no beads database found`).

**Cause**: Dispatch's logic lives in a Python CLI and the app ships no interpreter. It looks for a Python from Homebrew and then the system (it needs **3.9 or newer**); when none is found it shows the "Environment check" page. The other case is a missing dependency (bd, dolt, herdr) or no task board yet, where a notice with an "Open first-run setup" button appears at the top.

**What to do**:

1. On the "Environment check" page, look at the items marked ✗, click "Copy install command", paste it into Terminal, and click "Check again" when it is done. To force a specific interpreter, set `DISPATCH_PYTHON=/path/to/python3` before launching. On a brand-new Mac without the Xcode Command Line Tools the system `python3` and `git` are placeholders; `xcode-select --install` installs them.
2. Reopen Dispatch and go through step 1 ("Install dependencies") and step 3 ("The task board") of first-run setup.
3. If it still fails, run `python3 /Applications/Dispatch.app/Contents/Resources/cli/dispatch.py init status --json` in a terminal to see the actual error.

## Sessions do not show up

**Symptom**: an Agent is clearly running in a terminal but it is not on the workbench or the sessions page; or the session page stays on "Indexing…".

**Cause**: the session may have been grouped under a different project name, the Agent's record path may not be the default one, the first index has to read the whole history, or the CLI never started at all (see the entry above).

**What to do**:

- The first open has to read the whole history, so give it a minute or two; `dispatch index` rebuilds it by hand.
- Check Settings → Projects → Workspace roots: sessions outside those folders are grouped by git root or by folder, so they may turn up under "Other folders and ungrouped", or the project name may be a folder name.
- On the sessions page, set the Agent filter to "All" and the mode to "Recent"; loose sessions are folded at the bottom of the list.
- OpenCode, ZCode and Hermes sessions come from their own databases (`~/.local/share/opencode/opencode.db`, `~/.zcode/cli/db/db.sqlite`, `~/.hermes/state.db`); with no process running, or no write in the last 30 minutes, they do not count as live sessions, though the history is still readable.
- `dispatch list --local -q KEYWORD` queries the index directly.

## The session state is wrong: it says "Running" when it stopped, or never says "Needs you"

**Symptom**: the state in the session list does not match what you see in the terminal; the workbench has no "Needs confirmation".

**Cause**: the running / needs-you judgment comes from Claude Code's hook reports and from Herdr. Without hooks installed (Claude Code was not ticked at step 4 of first-run setup), or with the session running in Warp / iTerm / Terminal rather than Herdr, the only thing left to go on is the write time of the transcript file.

**What to do**: run step 4 of first-run setup again; take the session "Into Herdr" (from the session header or the right-click menu); make sure Herdr is running (the `herdr` command exists and tmux is resident).

## A reply was not delivered

**Symptom**: after clicking "Send" it says "The connection is unavailable right now", "unconfirmed" or "delivery unknown", or your message never shows up in the original terminal.

**Cause**: a reply is only delivered to the original session on the chosen Mac, and a Herdr terminal has to match both the session ID and the foreground process; nothing is written into the input while the Agent is executing or waiting for a permission confirmation. The Codex desktop app relies on the local IPC interface of its current version, so an incompatible version or a session that is not open will fail.

**What to do**:

- Read the state line above the reply box: it says where the session is. If it is in another terminal, click "Take into Herdr, then send"; if the original terminal is closed, use "Resume on the Mac and send"; if it is running, use "Queue message" or "Interrupt and send".
- When it is stopped at a confirmation box, clear the confirmation first with the keys above (⏎, y, 1 and so on).
- "Check delivery" queries the receipt again; the same message is never sent twice.
- When the Codex desktop app asks you to reconnect, open that session in the desktop app and try again.
- In a terminal other than Ghostty, "Jump to session" can only give you a hint, but replies still go through Herdr.

## The phone cannot connect

**Symptom**: scanning the code gives "cannot connect", or copying the link on the settings page reports "the web service is not running on …".

**Cause**: the web version is served by `dispatch serve` (port 7799), which has to keep running. The current .app does not bundle a script that installs it as a resident job, so `serve url` reports an error when it finds the service down, although the QR code is still drawn. The other common cause is that the phone is not on Tailscale, or that Tailscale is not installed on the Mac, so the service is bound to the local network address while the phone is on a different Wi-Fi.

**What to do**:

1. Run `dispatch serve` in a terminal on the Mac (in the foreground, keeping that window open), then scan again.
2. To keep it resident: `app/scripts/serve-setup.sh` in the repository installs a launchd job (labeled `dev.schaefer.dispatch-serve`); running it once from the source folder is enough. This is a known thing to improve, see [Known limits](26-limits.md).
3. On the phone, confirm Tailscale is connected and on the same tailnet as the Mac; without Tailscale, make sure both are on the same Wi-Fi.
4. After changing which machine the "Phone version runs on", you have to open the new link once more on the phone.
5. When an old link stops working, scan the code again: the token is in `~/tasks/.dispatch/serve.json`.

## Phone notifications never arrive

**Symptom**: an Agent replied or is waiting for confirmation, but the phone stays silent.

**Cause**: one of three things: no channel is configured (neither `BARK_KEY` nor `NTFY_URL`, so only the Mac's system notifications are sent); `dispatch serve` is not running ("an Agent replied" and "needs your confirmation" are checked by it every 20 seconds); or the Bark or ntfy app does not have notification permission, or ntfy is not subscribed to that topic.

**What to do**:

1. Settings → Phone notifications: check whether "Current channel: ntfy / Bark" appears; if not, enter the key or the topic URL and save.
2. Click "Send a test notification", or run `dispatch notify "test" "body"` in a terminal: if the phone receives it, the channel works.
3. Confirm `dispatch serve` is running (see the entry above). `dispatch notify-watch --json` runs one check by hand and shows the `sent` count and the `skipped` reasons.
4. Check that the four event switches are on; replies older than 6 hours are not pushed; the first time you turn it on, history is not replayed; scheduled sessions and sessions on the other machine are not pushed.
5. Give Bark / ntfy notification permission in the phone's system settings, and subscribe to the same topic inside the ntfy app.

## The quota is empty, says "No quota data available", or is stale

**Symptom**: some Agent has no numbers on the quota page, or it warns that the data is old.

**Cause**: Claude Code's quota comes from the official usage endpoint, which needs to read the login state on this machine (the Claude Code credentials in the keychain; the first time, macOS asks whether "python3 wants to access the keychain", and denying it means the data cannot be read). Codex and ZCode read their own local state files, so without a login or an installation there is nothing. Agents that are not installed are still listed, just with no data.

**What to do**: choose "Always Allow" in the keychain prompt; make sure that Agent is signed in and has been used at least once; click "Refresh quota"; and collapse "No quota data" if you only want to see the ones that have data. When the numbers on the two machines disagree, read the note on the card, since the same account should read the same on both.

## Summaries are not generated, a key error appears, or you need to set a Zhipu or OpenAI key

**Symptom**: a project's "Where it stands" is empty, a session has no summary, the unread summary in "Needs me" is permanently "Writing…", or it reports "No key" or "Summaries are turned off in Settings".

**Cause**: the summary model comes from Settings → Sessions → Model for summaries: subscription models go through a Claude Code subscription (the `claude` command has to be signed in), and API-key models use `ZHIPU_API_KEY`, `KIMI_API_KEY`, `MINIMAX_API_KEY` or `OPENAI_API_KEY` from `dispatch env`. A DeepSeek key is never picked automatically even if it exists (it is disabled in the code). And a use that is switched off in the table of uses is never generated.

**What to do**:

- Pick a model in Settings; if it says "No key", paste the key in the input box below and save; or run `echo "sk-…" | dispatch env set ZHIPU_API_KEY --stdin --note "summaries"` in a terminal.
- When using Zhipu through the Coding Plan endpoint, make sure the key and the endpoint match; the pay-as-you-go endpoint reports an insufficient balance.
- Check that the matching switch in the table of uses is on; `dispatch summarize providers` shows what is available, and `dispatch session-summary run <key> --force` runs one by hand so you can see the error.

## Updating fails

**Symptom**: "Check for updates" reports an error, or "Update to vX" ends in a failure message.

**Cause**: the GitHub endpoint is rate-limited or the network is down; the updater only replaces `/Applications/Dispatch.app`, so an installation anywhere else looks like no installation at all; a failure in the step that restarts the web service after the replacement is reported as an update failure (even though the app was in fact replaced); and there is no package for Intel machines.

**What to do**: try again later, or download the zip by hand from [Releases](https://github.com/SchaeferAnjon/dispatch/releases) and overwrite; keep the app in `/Applications`; after a failure message, check the version number on the settings page, and if it is already the new one, nothing is wrong. `dispatch update check --json` in a terminal shows the detailed error.

## Gatekeeper: "cannot be opened because the developer cannot be verified"

**Symptom**: the first launch is blocked.

**Cause**: the package is not signed and notarized with an Apple developer certificate.

**What to do**: run `xattr -dr com.apple.quarantine /Applications/Dispatch.app`, or use System Settings → Privacy & Security → "Open Anyway". You may have to do it again after every manual update (an in-app update clears the quarantine flag by itself). After the CLI runs for the first time, a `__pycache__` appears inside the .app, which makes `codesign --verify` complain but does not affect anything; it only means permissions for automation, notifications and the like may be asked for once more.

## Herdr is not running

**Symptom**: delegating, creating a session, "Into Herdr" and the terminal buttons all report errors; "Needs confirmation" never shows up.

**Cause**: Herdr depends on a resident tmux session; it is not installed, not started, or step 1 of first-run setup failed.

**What to do**: run `brew install herdr tmux`; run steps 1 and 4 of first-run setup again (step 4 confirms Herdr is running and reports the result); run `herdr` in a terminal and see whether it can list tabs. Automatic switching only works with Ghostty; other terminals work, but "Jump to session" only gives you a hint.

## The two Macs fail to sync

**Symptom**: after joining, the tasks disagree, "syncs both ways every 2 minutes" never happens, a move is stuck on "Pre-checking…", or the other machine stays "unreachable right now".

**Cause**: ssh does not work (Remote Login is off, the public key was not installed, Tailscale is offline or the machine is asleep); the Dolt remote API port is not reachable; both sides changed the same task and produced a conflict; or the move pre-check found a Git conflict.

**What to do**:

1. On the hub, confirm System Settings → General → Sharing → Remote Login is on, and that Tailscale is online on both. In a terminal, `ssh user@address echo ok` should return without a password.
2. Settings → Machines → "Check again"; use "Check now" at step 3 of first-run setup to test the reverse connection.
3. `dispatch rules status` and `dispatch init status --json` show the board and rule state; on a single machine, `rules sync` exits with "nothing to sync", which is not an error.
4. When a move hits a conflict, commit or stash on both sides first, then move; use `--force` only when you are sure you want to overwrite the other side.
5. If the other machine is not labeled "moved to" after a move: joining over the local network (without Tailscale) does not label it automatically, so run `dispatch moves mark <id> --to <machine>` by hand.

## The Agents do not change after a rules sync

**Symptom**: you changed GLOBAL.md and synced, but the running session still follows the old rules.

**Cause**: changing the rules does not reload sessions that are already open.

**What to do**: open a new session; `dispatch rules status` confirms that the managed block in every entry has been updated.

## The project name is wrong, or one project was split in two

**Symptom**: the same code appears under two project names, or the project name is one segment of a path.

**Cause**: grouping is resolved by rules: manual link > home folder > direct subfolder of a workspace root > a project name the task board already knows appearing in the path > git root > folder name. A session opened in a subfolder may end up under the subfolder's name.

**What to do**: add the parent folder of your code to the workspace roots; right-click existing sessions and use "Link project…" to set it by hand; group tasks with the `project:<name>` label. Changing the display name does not affect grouping.

## An edit was blocked: "another session changed this file in the last 30 minutes"

**Symptom**: an edit inside Claude Code is refused by a hook.

**Cause**: the edit lock hook (installed at step 4 of first-run setup) refuses an edit when another session changed the same file within 30 minutes, so that two Agents do not overwrite each other. On a single machine, a `/clear` or a second window can trigger it once too.

**What to do**: `dispatch editing` shows who is changing what; once you are sure nobody else is, try again or wait a moment; if you do not want this protection, remove the two edit-guard entries from the hooks in `~/.claude/settings.json`.

## A desktop Mac's screen never sleeps

**Symptom**: after installing Dispatch on a Mac mini or an iMac, the screen no longer locks automatically.

**Cause**: on a machine without a battery, Dispatch uses `caffeinate` to prevent sleep, and there is no switch for it yet.

**What to do**: quit Dispatch when you are not using it; see [Known limits](26-limits.md).
