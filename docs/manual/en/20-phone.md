# Phone

> What this page is for: how to open Dispatch on a phone, what you can and cannot do there, how to resume a session that is no longer running, how to press keys when a confirmation box is in the way, how notifications reach your phone, and how to see the Mac's screen.

![Phone version](../../assets/shot-phone.png)

## Connecting

Your phone has to be able to reach the Mac that runs Dispatch. **Tailscale** is the recommended way: install it on both, sign in with the same account, and the phone connects on any network; without Tailscale the web service binds to the local network address and only works on the same Wi-Fi. **Never expose the service to the public internet.**

1. On the Mac, open Settings → This Mac → **Phone access**: there is an embedded QR code, and the link carries a login token, so one scan is enough for the browser to remember it (the cookie lasts a year). You can also "Copy link" and send it to the phone, or run `dispatch serve url` / `dispatch serve qr` in a terminal.
2. Open the link in the phone's browser; the interface lays itself out for phone width, and you can add it to the home screen and use it like an app.
3. With two Macs, Settings lets you choose which one the "Phone version runs on": pick the one that stays put. After switching machines you have to open the new link once on the phone.

The web version is served by `dispatch serve` (port 7799, configured in `~/tasks/.dispatch/serve.json`). If the link cannot be copied, or scanning the code gives you "cannot connect", the service is not running: run `dispatch serve` in a terminal on the Mac and leave it in the foreground, or install it as a resident launchd job, see [Troubleshooting](24-troubleshooting.md#the-phone-cannot-connect).

## What you can do

The same interface: four tabs along the bottom (Workbench, Projects, Needs me, Sessions), with All tasks, Discussions, Agent status, Stats & quota, Threads, Skills, Rules & docs, Knowledge base, Settings and Overview under "More". The machine picker is at the top.

- See where each project stands, the full text of a session, the tool calls, the file changes and the images.
- **Reply to the original session**: the reply box at the bottom of the session page is the same as on the desktop: queue message, interrupt and send, withdraw, send an image (camera or library), the / command menu, and switching the permission mode and the model.
- **New session** ("New session" on the workbench): start a new session on one of the Macs, with images and files.
- Tasks: read them, comment, tick acceptance criteria, drag states (right-click becomes a long press of about half a second).
- Tick off "Only you can" items, star and archive projects and sessions, change settings (language, summaries, archive days).
- Look at the quota, the stats and the insight reports (HTML reports open on the phone through the web service).

## What you cannot do

- Update the app: Settings only shows the version, and "Update" has to happen in Dispatch.app on the Mac.
- Pick a folder in Finder, open a local file, or reveal something in Finder: those buttons do not appear in the web version.
- The "Set up" for screen access has to happen on the Mac (after which the phone can view the screen).
- Show system notifications: a browser cannot raise them, which is what the pushes below are for.

## Resuming when the session is not running

Open a session on the phone and the state line above the reply box tells you where the original session is now:

- **In Herdr and idle**: just send.
- **In another terminal or in VS Code**: "Take into Herdr, then send", and Dispatch stops the idle process over there on the Mac, resumes the same session with `--resume` inside Herdr, and then sends what you typed.
- **The original terminal is already closed**: "Resume on the Mac and send" or "Resume this session on the Mac" opens a new tab in Herdr on the Mac to resume the same record, and sends your message once it is up. A single tap, with nobody at the Mac.
- **It is running**: you can "Queue message" or "Interrupt and send".

## Pressing keys when a confirmation box is in the way

When an Agent is stopped at a confirmation box for a trusted folder, a permission or a hook review, the phone shows "It is waiting for confirmation on the Mac" above the reply box along with the last 14 lines of that screen, and a row of keys below: ↑ ↓ ⏎ Esc y n 1 2 3, each sent straight to the original terminal with one tap. Once the confirmation is through, the reply box becomes usable again by itself.

Confirmations from the Codex desktop app (wants to run a command, wants to change a file, is requesting a permission, is asking a question) appear as buttons: Approve, Approve for this session, Decline, Answer.

## Push notifications to your phone

The web version cannot raise system notifications, so pushes go through an app on your phone:

- **Bark** (iOS, free on the App Store): the key on its home screen after installation (or the whole `https://api.day.app/…` address).
- **ntfy** (iOS / Android, free and open source): subscribe to a topic, whose URL looks like `https://ntfy.sh/your-topic` (a self-hosted server works too).

On the Mac, go to Settings → **Phone notifications**, enter the Bark key or the ntfy topic URL, and click "Save" (it is stored in `dispatch env` as `BARK_KEY` / `NTFY_URL`; with both configured, ntfy wins; "Clear" removes it). Then there are four event switches, all on by default:

| Event | When it pushes | Notes |
|:--|:--|:--|
| An Agent replied (turn over, not yet seen) | A turn finished and the reply is unread | The body carries the start of the reply, and tapping it goes straight into the session |
| An Agent is waiting for your confirmation or asking a question | Stopped at a permission prompt or a question | High priority |
| A task finished (dispatch done) | When an Agent closes a task | Tapping it opens the task page |
| Only you can do it (dispatch need-you) | An Agent noted something you must do yourself | High priority |

How it works:

- The first two are checked by the web service (`dispatch serve`) **every 20 seconds**, so the desktop app does not have to be open, but `dispatch serve` does have to be running. The last two are pushed by the `dispatch done` / `dispatch need-you` commands themselves, at the moment they happen.
- Tapping a notification opens the matching session or task page directly.
- Turning it on for the first time does not replay history: when the state file `~/tasks/.dispatch/notify-watch.json` does not exist, the current state is simply recorded and nothing is sent.
- With no channel configured, only this Mac's system notifications are shown (raised by the desktop app itself); replies older than 6 hours are not pushed; and the same confirmation box only rings once.
- To test: "Send a test notification", or `dispatch notify "title" "body"` on the command line; `dispatch notify-watch --json` runs one check by hand and prints how many pushes it sent.

If nothing arrives, see [Troubleshooting](24-troubleshooting.md#phone-notifications-never-arrive).

## Viewing the screen (noVNC)

When you need to see the whole Mac screen and click some dialog:

1. On the Mac, Settings → Screen access → "Set up" (the equivalent of `dispatch screen setup`): it installs noVNC and the websockify background service and turns on Tailscale Serve HTTPS. The page lists the result of every step, plus "One step left".
2. System Settings → General → Sharing, turn on "Screen Sharing" (only you can do this step).
3. "Copy screen link" and send it to the phone, or use "View screen ⧉" on the workbench or the Agent status page. Open it in the phone's browser and sign in with this Mac's user name and login password to see and control the screen. The phone has to be on Tailscale.

Opening your own screen link on the same Mac gives you a screen inside a screen; it is meant for a phone or the other Mac. `dispatch screen status` shows the state.

## With two Macs, which one the phone uses

The phone needs only one Mac; pick the one that stays on (a Mac mini, say). In Settings, under phone access, set "The phone version runs on" to it. The QR code and link then point there, and that Mac also shows the sessions of the other one.

If the entry saved on the phone still points at the laptop, there is nothing to change by hand: the next time it is opened, the laptop takes the phone to the always-on Mac and signs it in. Once there, add the new page to the home screen or bookmark it again. Links in notifications open the always-on Mac directly too. When that Mac cannot be reached for a moment, the laptop keeps serving the phone itself.
