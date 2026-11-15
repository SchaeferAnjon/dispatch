# Agent status

> What this page is for: which Agent is doing what on which machine. This chapter covers the machine bar, each Agent's card, the session origin icons, the edit conflict warning, the delegation relationships, and how to delegate and watch a screen from here.

## The machine bar

The row at the top of the page is every Mac in `hosts.json`: the online dot, the name, the IP, and the overlay network type (Tailscale, Netbird, ZeroTier). The buttons after each one appear according to what it supports:

- **Delegate**: start an Agent in Herdr on that machine and hand a task to it (pick the Agent, the model, the folder and the first prompt).
- **See and control its screen** (when the other machine has Screen Sharing on): opens in the system Screen Sharing app.
- **Copy the phone screen link ⧉** (when that machine has noVNC configured): send it to your phone and open it, with the phone on Tailscale.
- **Open on phone ⧉** (this machine): copies the Dispatch web link.
- **View screen ⧉** (when this machine has noVNC configured): copies this machine's screen link for a phone or the other Mac; opening it on this machine gives you a screen inside a screen.
- RustDesk, Moonlight, UU Remote: an entry point appears when they are detected.

Right-click a machine: delegate, copy the ssh address, copy the IP, view the screen. Right-click empty space: delegate on one of the machines.

The "Running apps" line below lists the Agent applications that were detected.

## Agent cards

One card per Agent that is online or has tasks under its name: avatar, name, id, the time of the last write, and a state chip ("N running", "N idle", "N with a process but no session").

- **Origin row**: this Agent's sessions counted by origin: ⌘ terminal, ▣ desktop app, ◧ editor, ✉ chat, ⏱ scheduled, with a pulsing dot when something is running.
- **Session list**: active sessions (running or with activity in the last hour) are listed directly; older ones fold into "Earlier sessions · N". Each row: the origin icon, the title, the state, the source app or "Session log", the machine, and the last activity; "Editing:" lists the files changed in the last 30 minutes, in **red** when several sessions are changing the same file (`dispatch editing` shows this too); below that are the in-progress tasks it is linked to. On the right are "Into Herdr" (when it is running in another terminal) and "Open" (switch to the app the session lives in).
- **Linked tasks in progress · N**: the tasks under its name, with "← who handed it over".
- **Delegation relationships**: Handed out N (what it gave to others), Self-handed N (handed to another session of its own), Received N (what others handed to it).

Two collapsed sections at the bottom: "Scheduled sessions · N" (never counted as running, unread or notified) and "Agents with no activity detected · N".

## Agents in the sidebar

The Agent group in the left sidebar lists the online Agents: one state line ("N in progress", "claimed a task, session idle", "session idle", "claimed a task, not running") and either the first task under its name or the counts by origin. Click an Agent to switch to the table view showing only its tasks.
