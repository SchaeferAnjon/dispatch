# Session page

> What this page is for: the session page is where you watch every step an Agent takes and reply directly. This chapter covers how to filter the list, every tab of the session details, every button on the reply box (queue, interrupt, withdraw, resume, take into Herdr, confirmation keys), plus split view, detached windows and going back.

![Sessions](../../assets/shot-session.png)

## Left: the session list

- Search box: titles, folders, task IDs, session ID prefixes.
- Four modes: **Recent** (the default), **★ Tracked** (starred, followed long-term, never archived automatically), **Archived** (archived by hand or idle beyond the number of days in Settings), and **Scheduled or script** (started by a schedule, a script or another Agent through the programmatic interface; shown only when there are any).
- Filter by Agent: All, Claude Code, Codex, pi, ZCode, OpenCode, Hermes. To the right is the row count under the current filter.
- Each row: avatar, ★, title (running ones highlighted green; answered-and-unseen ones carry a blue dot; ones missing from the Dispatch index whose process is still alive are labeled "running / open"), the project color block and name, this Mac / machine name, "moved to / moved from …", the origin (terminal, desktop app, VS Code, SDK and so on), "N turns" of conversation, the subagent count and the time; the line below shows its current action or latest progress, and below that the open tasks it is linked to.
- Loose sessions with no title and at most one sentence fold into "Loose sessions" at the bottom.
- The first open has to read the whole history and shows "Indexing…"; after that, a session you have seen opens instantly and only the new part is fetched.

Click "⇤ Hide list" to give the conversation the full page (remembered per device).

## Right: one session

### Header

"‹ Sessions" or "‹ Back to <previous page>", the avatar, this Mac / machine name, the title, and `folder · branch · session ID`; on the right: "Project · <name> ›" to go back to the project page, "⊞ Split", "Into Herdr" (when the session lives in another terminal), "Open <Agent> session ↗" (opens or resumes it in the original Agent on that Mac), "Copy resume command" (paste it in a terminal and press Enter to carry on) and the ⋯ menu.

Below the header:

- **Summary** (when there is one): a paragraph written by a model covering the goal, what was done and what is still missing; on a phone it folds to one line by default, tap to open.
- **Live state row**: a green dot means running; the text is the current state ("Running Bash…", "Replying…", "Thinking…") along with the time of the last activity; if the connection drops it shows "Updates interrupted; showing the last state".
- **Session info** (collapsed): start time, latest time, origin, turn count, reply count and size, tool call statistics, and the list of subagents.

### Tabs

| Tab | Contents |
|:--|:--|
| Conversation | The timeline. Your messages, the Agent's thinking (collapsed, click for the full text), tool call cards (name, key arguments, state ✓ ✗ …, click for all arguments and output; editing tools render as an `Update(path) +N −M` diff, with small changes expanded by default), consecutive tool calls folded into a single "Ran N commands ›" line, inline images, and system events (subagent finished, hook notifications). While the session is running, the new part is fetched every 1.5 seconds and the view follows the bottom; scroll up and it stops following, and "Jump to latest ↓" appears in the bottom right. Two switches at the top right: "Conclusions only" (shows just your questions and the last reply of each turn) and "Tool calls" (shows or hides the tool cards; anything currently running is always shown). |
| Images & artifacts | The images, PDFs, HTML, audio, video and text attached to or produced by this session, previewed in one place. HTML is previewed in an isolated iframe with external network access disabled. The per-file limit is 20 MB. |
| Files | "Files this session changed": every change recorded from the editing tool calls, collapsed per file and shown as a diff. Files changed with terminal commands are not here; the "Current git changes in the folder" section below shows the uncommitted diff of the whole workspace (the changes of every session in that folder, not just this one), with a patch you can expand per file, truncated above 100 KB. Right-click a file to open it, reveal it in Finder or copy its path. |
| Tasks & outcomes | The tasks this session is explicitly linked to (originating / participating) and the outcomes; "N more tasks mentioned in the conversation" is a hint only and does not mean ownership. |
| Subagents | The subagents this session spawned, each its own conversation; click one for its complete record and the files it changed. "Dispatch calls" lists the tool calls that spawned them. |

### The reply box

The reply box is always at the bottom, with a state line describing the connection:

- "Connecting to the original session…" → once connected, it shows where the original session is (a Herdr tab, the Codex desktop app and so on).
- When it is connected and the Agent is Claude Code, you can switch the **permission mode** (Ask every time, Auto-accept edits, Plan mode, Skip permissions; the same as Shift+Tab in the terminal) and the **model** (the same as `/model`, not switchable while it is running).

Input:

- Just type; <kbd>⌘⏎</kbd> sends; ⤢ enlarges the box. Drafts are saved per session.
- Typing `/` pops up the menu of available commands (built-in commands, skills, custom commands); ↑↓ to pick, ⏎ or Tab to insert.
- 📷 sends an image: on a phone you can take a photo or pick from the library, and on a Mac you can paste directly. Images are stored on the Mac the session lives on; Claude Code receives them as attachments, other Agents receive a path. Large images are scaled down to at most 2000 pixels.
- The send button's label follows the state: **Send** (idle), **Queue message** (running: it joins the queue and the Agent sees it at the end of this turn), **Confirm delivery** (the last send got no receipt).
- **Interrupt and send** (appears while it is running): press Esc to interrupt the current turn first, then send this message.

After you send:

- An accepted message appears above the box as "You · <note>" with its text; with several, it says "N queued, handled in order at the end of this turn". The line disappears once the message enters the conversation.
- With Claude Code, the last message still in the queue can be **withdrawn** (taken back, not sent) or **withdrawn and edited** (put back in the input box to fix and send again).
- When delivery is uncertain, "Confirm delivery" and "Checked, keep editing" appear; clicking send again never sends a duplicate, and one message is only ever sent once.

When the original session is not running or not inside Herdr, the state line offers the matching button:

- **Take into Herdr, then send**: the session is in Warp, iTerm, Terminal or the VS Code extension. The idle process over there is stopped, the same conversation is resumed with `--resume` inside Herdr on that Mac, and then your message is sent. Once a session from the VS Code extension has been taken over, going back to VS Code means resuming it again. While it is running the button is disabled; wait for it to stop.
- **Resume on the Mac and send / Resume this session on the Mac**: the original terminal is already closed. A new tab is opened in Herdr on the Mac to resume the same record, and once it is up, the message you typed is sent. On a phone it is a single tap.
- **Reconnect**: check once more.

When an Agent is stopped at a confirmation box (trusted folder, permission, hook review and so on):

- Claude Code / pi / Codex terminal sessions: above the reply box you see "It is waiting for confirmation on the Mac" and the last 14 lines of that screen, with a row of keys ↑ ↓ ⏎ Esc y n 1 2 3 below that go straight to the original terminal.
- Codex desktop app: it shows what it is waiting for (wants to run a command, wants to change a file, is requesting a permission, is asking a question, wants you to choose), and you can "Approve", "Approve for this session" or "Decline"; a question can be answered by picking an option or writing your own and hitting "Answer"; "Wants you to choose" and MCP requests have to be handled inside the desktop app. While it is running there is an "Interrupt" button.

The limits on replying: a message is only delivered to the original session on the chosen Mac; a Herdr terminal has to match both the session ID and the foreground process; and nothing is written into the input while a command is executing or a permission prompt is waiting. Send receipts are stored locally at `~/tasks/.dispatch/reply-receipts.sqlite` and are never copied across machines.

## Split view, detached windows, new windows

![Split view](../../assets/shot-split.png)

- **⊞ Split**: the current session goes on the left, and you click another one in the list to fill the highlighted pane; "2 panes" and "4 panes" switch the layout; each pane is an independent session page (its own record, reply box and polling), ✕ closes one pane, and "Leave split view" returns to a single page.
- **⧉ Detach** (top bar): move the current page into its own window, while the original window goes back a step or to its project.
- **Right-click → Open in New Window**, or <kbd>⌘</kbd>-click a project, session or task: opens a new window directly.
- **Back**: the "‹ Back to <previous page>" button in the top bar, or "‹ Sessions" in the session header. Coming from the workbench takes you back to the workbench, coming from a project takes you back to that project, and the scroll position is remembered.

## The right-click menu (sessions)

Open and reply, open in new window, open the session in a terminal, mark as read / mark as unread (back into "Needs me" for later), star: track long-term / unstar, archive / unarchive (which turns it into tracked), mark as a scheduled session / restore as a normal session, rename… (changes only the name shown in Dispatch), link project… (shows that project's name afterward without moving the working folder), summarize this session with a model / summarize again, copy resume command, delegate, move to <machine> and carry on. When right-clicking is awkward, use "More" at the end of the row.

## New session (⌘N)

Pick the Mac it runs on (offline ones cannot be picked), the Agent (the ones whose conversation you can read and answer in Dispatch: Claude Code, Codex, pi, OpenCode, Hermes), the working folder (type a path, pick it in Finder, or browse below, with a list of recent ones) and the first message (you can paste images, 📷 adds an image and 📎 adds a file, both stored on the Mac it runs on, where the Agent reads them with Read). After "Create and send", the Agent starts inside Herdr on the chosen Mac, reusing the existing logins and permission settings; this Mac switches to the terminal Herdr lives in, or you can stay in Dispatch and watch.
