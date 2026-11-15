---
name: computer-use
description: "Use when you need another app on this Mac (Notes, Finder, the Simulator, design tools, software without an interface of its own): dispatch computer asks the person first, clicks and types only in that one app, shows what it does at the top of the screen, and the person stops it with one click. For web pages use the built-in-browser skill, not this."
---

# computer-use: using other apps on this Mac

`dispatch computer` lets you operate **one** app on this Mac once the person allows it. It is the slowest and widest tool, so it comes last:

1. The service has an MCP server or a command line: use that (`dispatch mcp presets`, `dispatch mcp list` show what there is).
2. It is a web page: use the built-in browser (the built-in-browser skill).
3. A shell can do it: run the command.
4. Only when none of these works, use `dispatch computer`.

Talk to the person in the language they use with you.

## What the person sees

- At `start` a small window appears: your icon, "Claude wants to use Notes", the reason you wrote, what you will be able to do, and three buttons, Don't Allow / Always Allow / Allow. You can act only after they click Allow. Always Allow means that app is never asked about again: the next `start` for it is `running` at once (`dispatch computer allowed` lists those apps, `--forget <app>` asks again). With Settings › Agents › "Use other apps without asking" on (`dispatch computer allowed --all on`), no app is asked about; the refused apps below stay refused.
- While you work, a bar sits at the very top of the screen: who uses which app, the last step, and a Stop button. Clicking Stop or pressing Esc anywhere stops you at once.
- Pointing at the bar unfolds it: on top a live picture of that app's window (only that window, shown only on this Mac, never recorded or sent; it needs Screen Recording permission, and without it the space says in plain words how to turn it on), with a circle where you last clicked; below, every step of this run (looked, clicked what, typed what, pressed what, with times, newest first; a password only says "filled in a password"). Moving away folds it, a click pins it.
- Each run's steps are kept as one page (a small picture of the window per step, when Screen Recording is allowed), filed in this session's Docs at the end with a title such as "Claude used Notes: 7 steps". `stop` prints the page's path: **put it in your reply to the person**.
- Ten minutes without a command, the app quitting, or your `stop` also end it. To use it again, `start` again, which asks again unless the person chose Always Allow for that app.

## Commands

```bash
dispatch computer check                      # whether it can be used (macOS Accessibility permission), in plain words
dispatch computer apps                       # the open apps, and those agents may not use
dispatch computer start Notes --why "paste the meeting notes into a new note"   # asks the person first; write --why as one sentence that reassures them
dispatch computer look                       # what is in the window, numbered: [3] button "New Note"
dispatch computer look --shot                # also a picture of the window (needs Screen Recording; the list works without it)
dispatch computer look --frames              # each item's position: @x,y width x height (points from the first window's top left)
dispatch computer click "New Note"           # click by name; when names repeat use the number: click 3
dispatch computer click 120,340              # click a position (the same coordinates as look --frames); refused when it is not on this app
dispatch computer click "report.pdf" --double   # double-click (open a file); --right right-clicks
dispatch computer drag "report.pdf" "Archive"    # drag: each end is a name, a number or x,y, such as a file into a folder
dispatch computer menu                       # the menu bar's menus (in the language the app shows: on a Chinese Mac 文件, 编辑)
dispatch computer menu File                  # what is in that menu, with shortcuts; greyed-out items say so
dispatch computer menu File "New Folder"     # pick an item (or write "File > New Folder")
dispatch computer fill "Search" "budget"     # type into an input
dispatch computer type "first line"          # type into the app (without bringing it to the front)
dispatch computer press Return               # press a key: Return, Tab, Up, Down, cmd+a, cmd+s …
dispatch computer scroll down 5
dispatch computer stop                       # done: give the app back to the person
dispatch computer status
```

All take `--json`. The rhythm is the browser's: `look` → one step → `look` again to confirm. Once the window changes the old numbers are void; `look` again.

### Work in the background as much as possible

The person may be using the computer, so do in the background whatever can be done there, without taking the front or moving the mouse:

| In the background (does not disturb the person) | Brings that app to the front for a moment |
|---|---|
| `look`, `click` by name or number (buttons, links, rows), `fill`, `menu` (mostly), `type` into a text field, `scroll` | `press` keys, clicking a position, double-click, right-click, `drag`, menu items greyed out in the background, `type` into something that is not a text field |

For a step that needs the front, the bar says "Needs Finder in front for a moment"; within a second afterwards the person's own front app is given back and the mouse returns to where it was. Several such steps in a row share that one moment. So: **click by name rather than by position, and use the menu rather than shortcuts**.

An exception: while you type a name into a one-line field (Finder's new folder, a rename), the app stays in front until the field is finished (or ten seconds pass without anything), because the field closes as soon as Finder leaves the front. Type names in one go: `type "name"` then `press Return` right away.

Some apps jump to the front by themselves (Finder opening a new window); such a step is marked "in front for a moment" too and the front is given back the same way.

## Rules

- **Ask once per piece of work**: write clearly in `--why` what you will do. When the person says Don't Allow or presses Stop, do not ask about that again: tell them how far you got and which step they need to do themselves, or ask what they want.
- **Only that one app**: to switch apps, `stop` first, then `start` the new one (the person is asked again).
- **Leave Esc alone**: Esc is the person's stop key, and `press Esc` is refused. To close something that popped up, click its Cancel or Close button.
- **The Apple menu and Services are off limits**: they act on the whole Mac or other apps (shutting down, logging out, System Settings).
- **Never type passwords, pay or change system settings for the person**: at a sign-in box, a payment or a permission dialog, stop and ask them to handle it. Terminal, code editors, Dispatch itself, System Settings and password managers are never allowed (they can do far more than one app).
- `stop` when you are done; do not leave the bar on the screen.

## When something goes wrong

| State that comes back | What it means | What to do |
|---|---|---|
| `needs-permission` | macOS does not yet let the app you run in (Dispatch IDE or a terminal) operate other apps | The person already sees a window with Open Settings; ask them in one sentence to turn it on in System Settings > Privacy & Security > Accessibility, then `start` again |
| `denied` | The person did not agree, or nobody answered within five minutes | Do not ask again; say what you wanted to do and let them decide |
| `refused` | Agents may not use this app | Tell the person the reason and find another way |
| `not-found` | No app has that name | `dispatch computer apps` shows the exact names |
| `stopped` | The person pressed Stop or Esc (`reason: person`) | Stop, report your progress (with the path of the page to look back at), and wait for them |
| `screen-locked` | The screen is locked: apps show no windows and nobody can click Allow | Tell the person the screen is locked and to try once it is unlocked; `start` again when they say so |
| `not-this-app` | The position you clicked is not on that app (another window covers it, or the window moved) | `look --frames` again and work out the position, or use the name |
| "A window from macOS itself is open" | The person has a system password or question window in front of them | Do not push; do the step that needs the front once they have dealt with it |
| `look --shot` says there is no picture | No Screen Recording permission | The list is usually enough; when a picture is really needed, ask them to turn on System Settings > Privacy & Security > Screen Recording |
