# Known limitations

> What this page is for: an honest list of what still limits the current version (v0.7.34). The problems found by the full source review of 2026-09-17 were fixed one by one between v0.7.29 and v0.7.34; what was fixed is listed at the end, and only what still holds stays here. Updated with each version.

## Installation and distribution

- **Apple silicon package only.** The releases hold only `macos-apple-silicon.zip`; on an Intel Mac, build from source (`cd app && npm ci && npm run tauri build`, which needs Node.js, Rust and the Xcode Command Line Tools). The in-app updater says so plainly on an Intel Mac and never installs a package for the wrong architecture.
- **Not notarized by Apple.** Gatekeeper blocks the first launch; allow it once as described in [Quick start](01-quickstart.md).
- **Needs Python 3.9 or newer.** Every Mac with the Xcode Command Line Tools or Homebrew has it; with neither, the app shows an "Environment check" page that lists what is missing and how to install it.

## Scope

- **Skill mounting supports Claude Code and Codex only.** pi, ZCode, Gemini CLI and OpenCode show sessions and tasks, but the skill pool is not mounted for them.
- **Replying to the original session**: sessions inside Herdr have everything (queue, interrupt, withdraw, key presses). A session opened directly in Ghostty can queue and interrupt; one in Terminal.app or iTerm2 can only queue, not interrupt (the iTerm2 path follows its scripting interface; the author's Mac has no iTerm2, so it is untested); a session in a VS Code extension has to be taken into Herdr first.
- **Model names in the dropdowns are written into the interface** (reply box, delegate, discuss); a new model appears only after an app update. Typing a custom model name is unaffected.
- **Index limits**: 500 sessions in the local list, 200 from another Mac; older entries show no unread state or inferred running state.
- **Workspace Git diffs** may include other sessions' changes.
- **Attachments**: only files explicitly attached or linked in the current session can be read, 20 MB per image and 50 MB per other file; HTML outputs that depend on external libraries have to be run in their own project.
- **"Potential conflict" is a static check**, not a full semantic proof.
- ChatGPT web sessions are not connected; there is no "read" receipt from the original agent app.

## Two Macs

- **The hub's sync port (3309) listens on every interface.** Dolt's remotesapi cannot be bound to one address; it is protected by the sync user's password. Do not forward this port to the internet.
- When the two Macs run different versions, saving settings on the older one drops the newer settings it does not know (for example the phone notification switches). Updating both together avoids this.

## Phone

- The pairing QR code and link carry a long-lived token (kept in `~/tasks/.dispatch/serve.json`; after one scan the phone remembers it in a cookie): it is only shown on the settings page, do not post it anywhere public. Links inside notifications use a single-use login code valid for 24 hours.
- Without Tailscale the service listens on this Mac only by default; with "allow LAN" ticked, every device on the same Wi‑Fi can reach port 7799 (the token is still required). Turn it off on public Wi‑Fi.
- The web version cannot show system notifications; pushes need Bark or ntfy.

## Fixed between v0.7.29 and v0.7.34 (for readers of older notes)

- The CLI runs on the system's Python 3.9; the app finds an interpreter itself and shows a self-check page when the environment is incomplete; a missing bd / git / herdr or a missing board gives one readable line instead of a traceback.
- Model use is opt-in: first-run setup has "Models & summaries" where you choose off, the Claude Code subscription or an API key, and tick the specific uses; nothing is sent by default. DeepSeek is no longer disabled in code, it is a setting.
- Phone access is turned on with one click in Settings (the background service ships with the app); no QR code is drawn for an address nothing answers on; the log carries no token and is readable by you only.
- First-run setup no longer overwrites your Claude Code status line (it is kept and forwarded) and backs up settings.json first; hooks use absolute paths; the edit guard is optional and off by default; you sign the board with this Mac's account name.
- New session, delegate and discuss default to an agent you have, the others are greyed out; the quota page lists only installed agents; insight reports use the summary model you chose.
- Keep-awake is a per-Mac setting that prevents system sleep only by default; Terminal.app / iTerm2 are supported; the skill pool location adapts (cc-switch's folder when present, else `~/.agents/skill-pool`); commands sent to the other Mac use that Mac's own board folder; LAN-paired Macs mark moved sessions too.
- The updater works wherever the app is installed, uses the public download address when the API is rate-limited, and verifies SHA256 before installing; every ssh, child process and phone request has a timeout; the app is single-instance, has a content security policy, ships its fonts and no longer writes `__pycache__` into the .app.
- Performance: `prime` is faster; the workbench fetches comments only when a task changes; insights are cached per session.
- `dispatch env` also writes `env.sh` for zsh / bash, and secret files are written atomically.
