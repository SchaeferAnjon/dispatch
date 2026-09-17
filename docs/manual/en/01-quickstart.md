# Five-minute start

> What this page is for: the complete path from download to seeing your first project, including getting past Gatekeeper, the eight steps of first-run setup, and the three things to do right after the workbench first appears.

## 0. Before you start

- A Mac running macOS 14 or newer.
- [Homebrew](https://brew.sh): first-run setup uses it to install Dolt, Beads, Herdr and tmux. If you do not have it, step 1 of first-run setup gives you the install command.
- **Python 3.9 or newer**. Every Mac with the Xcode Command Line Tools or Homebrew has it; Dispatch looks for it itself (Homebrew first, then the system one). With neither, the app is not blank: it shows an "Environment check" page that lists what is missing and gives install commands you can copy (`brew install python@3.12` or `xcode-select --install`).
- At least one Agent installed (one of Claude Code, Codex, pi, ZCode, Gemini CLI, OpenCode, Hermes), used once or twice on this machine, so that Dispatch has something to show the moment you open it.

## 1. Install

1. Download `Dispatch-<version>-macos-apple-silicon.zip` from [Releases](https://github.com/SchaeferAnjon/dispatch/releases/latest) (only the Apple silicon package is published right now; on an Intel machine you have to build from source, see [Known limits](26-limits.md)).
2. Double-click to unzip and drag **Dispatch.app** into Applications.
3. The package is not signed with an Apple developer certificate, so Gatekeeper stops the first launch. Take either route:
   - Open Terminal and paste:
     ```sh
     xattr -dr com.apple.quarantine /Applications/Dispatch.app
     ```
     then open the app again;
   - or double-click once, let it be blocked, then go to System Settings → Privacy & Security, scroll to the bottom and click "Open Anyway".
4. Once it opens, it goes straight into **first-run setup**.

## 2. First-run setup (eight steps, the last three optional)

The first launch walks you through it. Every step can be run again; "Skip and stop asking" in the top right takes you to the workbench now, and you can come back later through Settings → First-run setup → "Open first-run setup". The top of the page shows this Mac's name and its Tailscale or local network address.

### Step 1: Install dependencies

The page lists six things, with a ✓ for what it found and a ✗ for what is missing:

| Name | What it does | Required |
|:--|:--|:--|
| brew | macOS package manager; everything below is installed through it | Yes |
| dolt | The task board's database (with version history, so it can sync between two Macs) | Yes |
| bd | The task board itself (Beads), which Agents use to record tasks | Yes |
| herdr | The Agent multiplexer in your terminal; Dispatch uses it to delegate to Agents | Yes |
| tmux | Keeps Herdr resident in the background so Dispatch can delegate at any time | Yes |
| tailscale | Lets the two Macs reach each other when they are not on the same Wi-Fi; not needed with one Mac | No |

- Without Homebrew, the page gives you a one-line install command and a "Copy" button: paste it into a terminal and run it (it asks for an administrator password), then come back and click "Check again".
- With Homebrew, click "Install dolt, bd, herdr…" and Dispatch installs them one by one with brew, which can take a few minutes. Anything that fails shows why, along with a command you can run by hand in a terminal.

### Step 2: The terminal command

Click "Create the dispatch command" to link the CLI bundled with the app to `~/.local/bin/dispatch`. After that you can type `dispatch` directly in a terminal, and the Agent hooks rely on it too; the CLI is updated along with the app.

You can also do it by hand:

```sh
ln -sf /Applications/Dispatch.app/Contents/Resources/cli/dispatch.py ~/.local/bin/dispatch
```

Make sure `~/.local/bin` is on your PATH.

### Step 3: The task board

Pick one of two:

- **"Only this Mac, or this is the first one"**: click "Create the task board" to create a board at `~/tasks/.beads`. This Mac becomes the **hub** that other machines join.
- **"Another Mac already runs Dispatch"**: enter that machine's `user@address` (you can pick a machine from the Tailscale list and add the user name), enter its login password once (used once, never stored, only to install the public key), and click "Connect and join". This requires that the other machine has already been through first-run setup and has Remote Login turned on. If you would rather not type the password, click "Let the local agent do it" and Dispatch starts an Agent that finishes the job for you in a terminal.

After joining, the page shows "Joined &lt;name&gt;; syncs both ways every 2 minutes", and you can "Check now" whether the hub can reach back to this Mac (the hub needs that in order to merge this machine's sessions).

### Step 4: Agents

The page detects which Agents are installed on this machine and ticks the ones it found. Ticked Agents receive the same set of rules; Claude Code also gets hooks installed (session state, task board summary, edit mutual exclusion, quota). The Claude Code / Codex extensions in VS Code share the same records and the same hooks, so ticking the matching Agent is enough, and their sessions are labeled "VS Code". Click "Use these".

### Step 5: Rules and skills

Click "Prepare the rules and sync":

- If there are no shared rules yet and you have a `CLAUDE.md` / `AGENTS.md`, it is imported as the starting point; otherwise a slim template is written to `~/.agents/rules/GLOBAL.md`.
- If you joined a hub, GLOBAL.md and the skill pool are copied from the hub.
- Then GLOBAL.md is synced into each Agent's entry file (as a managed block), and the skill pool is mounted into the skill folders of Claude Code and Codex.

The page lists each Agent's entry path and sync state.

### Step 6: Models & summaries (optional)

Dispatch ships no model of its own. Session summaries, project status, memory summaries, insight reports and semantic search have to send excerpts of conversations or documents to a model, so nothing is sent until you choose. Three options:

- **Not now**: nothing is sent; the app works as usual, just without automatically written summaries.
- **Use the Claude Code subscription**: runs `claude -p` on this Mac, needs no API key, counts against your subscription quota.
- **Use an API key**: pick a provider and enter the key (kept only in `dispatch env` on this Mac); billed at that provider's prices.

With either of the last two, tick what it may be used for. Everything can be changed later under Settings → Summaries.

### Step 7: Phone & notifications (optional)

Click "Turn on phone access": this Mac keeps a small web service running (it starts at login); scan the QR code once with the phone's camera and it is remembered. Without Tailscale, tick "allow LAN" so the phone can connect. Push notifications to the phone (Bark / ntfy) are configured under Settings → Phone notifications, see [Phone](20-phone.md).

### Step 8: Review and improve (optional)

Pick an Agent with a command line and click "Send it to review and improve": it reads all the rules and skills shared by the Agents on this Mac, subtracts first (removing behavior rules written for older models, step-by-step recipes and anything that duplicates the global rules), keeps architectural constraints, safety boundaries and project knowledge, then edits and syncs directly. You can also use "Copy the prompt" and send it to any Agent. Worth doing even with a single Mac.

Only once the first five steps are ticked does the "Done" button at the bottom become clickable and take you to the workbench.

## 3. Three things to do right after the workbench appears

1. **Open a session and watch it land on the table**. Start Claude Code or Codex in a terminal as usual (or press <kbd>⌘N</kbd> in Dispatch for "New session" and pick a folder). Back on the Dispatch workbench, within a few seconds that session shows up under "Running" on the matching project card; when the Agent stops and waits for you, it turns into "Needs you". At the start of a new session the Agent receives a summary injected by `dispatch prime`, which is how it knows about the task board and the knowledge base.
2. **Check how projects are grouped**. Open Settings → Projects → "Workspace roots", which defaults to `~/Projects`: each direct subfolder of those folders counts as one project. If your code is somewhere else, add that root (one per line), otherwise sessions are grouped by git repository root or by the folder they sit in, and the project names may not be what you want.
3. **Decide whether summaries stay on**. Settings → Sessions → "Model for summaries": pick a subscription model (such as haiku through a Claude Code subscription) or paste an API key; the table of uses below it decides item by item whether "session summary", "project status" and the rest call a model. If you do not want any content leaving the machine, turn them all off. See [Settings](14-settings.md) for details.

Then take a quick look at:

- "Overview" at the bottom of the left sidebar: one line per page, and you can click into each.
- Settings → Phone access: scan the QR code if you want to use your phone, see [Phone](20-phone.md).
- If you have a second Mac, see [Two Macs](21-two-macs.md).
