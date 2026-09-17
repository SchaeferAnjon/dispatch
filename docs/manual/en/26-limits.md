# Known limits

> What this page is for: an honest list of the known rough edges in the current version (v0.7.29), drawn from a read of the source. Going through it before you install saves a fair amount of troubleshooting time. It changes with each version.

## Things that will stop a new user

- **Python 3.12+ is a hard requirement, but the app neither checks for it nor installs it.** The app calls the `python3` on your PATH; the 3.9 that comes with macOS fails outright on two pieces of syntax in the CLI, the first-run wizard never appears, and what you see is an empty workbench. The fix: `brew install python@3.12` or newer, see [Troubleshooting](24-troubleshooting.md).
- **Only an Apple silicon package.** The releases currently hold only `macos-apple-silicon.zip`; on an Intel Mac, build from source (`cd app && npm ci && npm run tauri build`, which needs Node.js, Rust and the Xcode Command Line Tools). The in-app updater says so plainly on an Intel Mac and never installs a package for the wrong architecture.
- **A missing dependency gives you a bare traceback, not a readable message.** When bd, git or herdr are not on the PATH, some commands raise a raw Python exception; with no task board, `dispatch prime` fails and puts an English bd error at the top of every Claude Code session. Running steps 1 and 3 of first-run setup avoids this.
- **Phone access needs `dispatch serve` running, and the script that installs it as a resident job is not bundled in the .app.** The settings page draws the QR code regardless. Workarounds: run `dispatch serve` in the foreground in a terminal, or run `app/scripts/serve-setup.sh` from the source folder.

## About "no content is sent to a model"

The website and the README say "your documents and conversations are not sent to any model by default", and in the current version that sentence is **not accurate**:

- Automatic session summaries are on by default (one or two sessions are summarized every 3 minutes, and older sessions are gradually filled in), and all eight entries in the table of uses (session summary, project status, dispatch here, discussion conclusion, insight report, memory summary, device scan, semantic search indexing) are on by default.
- With no API key at all, as long as Claude Code is installed, `claude -p` is run through your Claude Code subscription to write the summaries.
- Opening the "Agent memories" page, a project's "Review" page or the task details (semantic search) fires a request without asking first.

To keep everything on the machine: Settings → Sessions → turn off every entry in the table of uses, leave "Model for summaries" empty, and configure no key.

## Where the interface text and the implementation disagree

- The "one-time login token" mentioned under "Phone access" is in fact a long-lived static token plus a cookie that lasts a year, with the token stored in `~/tasks/.dispatch/serve.json`. Do not post the link anywhere public.
- Without Tailscale, the web service binds to the local network address, so any device on the same Wi-Fi can reach port 7799 (protected by the token).
- There is no master switch called "automatic summaries" in Settings, only the table of uses.
- The README lists DeepSeek as an available summary model, but the code disables it (so summaries do not work for someone with only a DeepSeek key).
- The skill pool can only mount on Claude Code and Codex; ticking pi, ZCode, Gemini or OpenCode mounts no skills at all.
- The dependency table at step 1 of first-run setup includes tmux, which the README's dependency list leaves out.

## If you only have one kind of Agent installed

- The default Agent for a new session, for delegating and for discussions is Claude Code / Claude, regardless of what is installed locally; Agents that are not installed still appear in the dropdown.
- The quota page lists every Agent, and the ones that are not installed show "no data".
- The insight report is always generated with `claude -p`, ignoring "Model for summaries"; without Claude Code installed it reports "No such file: claude".
- The move conflict helper is hard-coded to pi plus a GLM model, which needs a Zhipu key.

## Side effects of the Claude Code hooks

- Step 4 of first-run setup **unconditionally overwrites** any existing `statusLine` setting in your `~/.claude/settings.json`, with no backup; the status line script hard-codes the author's claude-hud plugin, so someone else's status line may come out blank.
- The hook commands depend on `~/.local/bin/dispatch` (the link created at step 2), so skipping step 2 produces an error at the start of every session.
- The edit lock hook is installed by default: an edit is refused when another session changed the same file within 30 minutes, and on a single machine a `/clear` or a second window gets blocked once too.
- Even a warm prime hook cache takes a few seconds, and when the other machine is offline it may wait for the ssh timeout.

## Other

- **A desktop Mac's screen never sleeps**: on a Mac without a battery, the resident app uses `caffeinate` to keep the screen awake, and there is no switch for it.
- **Ghostty is the only terminal it knows**: "Jump to session" and the automatic switching when you reply to the original session were only built for Ghostty; iTerm2, Terminal and Warp users can use the Herdr path but have to switch windows by hand.
- **The skill pool path is hard-coded** to `~/.cc-switch/skills`.
- **`BEADS_DIR` only takes effect locally, and only partly**: the remote commands and the sync scripts still hard-code `~/tasks/.beads`.
- **After a move with a local network join (no Tailscale)**, the other side is not labeled "moved away" automatically, so the session appears once on each machine.
- **The updater** only knows `/Applications/Dispatch.app`; its error text mentioning "the repository is private" is out of date; there is no checksum after the download; and a failure to restart the web service after a successful replacement is reported as an update failure.
- **Signing**: the package is signed with the author's development certificate and is not notarized; the first CLI run writes a `__pycache__` into the .app, which breaks signature verification, so permissions may be asked for again and again.
- **Performance**: the workbench refetches the comments of every in-progress task every 10 seconds; the activity scan walks every transcript every 3 seconds; and the insight cache recomputes everything on any session write. With a lot of sessions you will feel it.
- **`dispatch env` only generates the autoload file for fish** (`env.fish`), so zsh and bash users need `eval "$(dispatch env export)"`.
- **Index read limits**: 500 rows for the local session list and 200 for a remote one; older entries show neither unread marks nor an inferred running state.
- **The workspace Git diff** may include changes made by other sessions.
- **Attachments**: only files explicitly attached to or linked from the current session can be read, 20 MB each; an HTML artifact that depends on external libraries has to be run inside its original project.
- **"Possible conflict" is a static check**, not a complete semantic proof.
- **The global shortcuts also fire inside input boxes**.
- ChatGPT web sessions are not supported, and there is no way to get a read receipt out of the original Agent app.
