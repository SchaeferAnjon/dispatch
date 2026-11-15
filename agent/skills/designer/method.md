# How to work

## Order

1. Read the project's `DESIGN.md`, all of the person's design preferences (`dispatch prefs list --area design --json`; each comes with their words, the part of which delivery it hangs on, and evidence screenshots; open the evidence that concerns this page; skip this when there are no preferences yet) and the style files named (token definitions, the selectors involved). First decide whether the change can be made at the token level.
2. Take real screenshots; do not guess. Crop and zoom parts, and measure type size, spacing and radius (the system `python3` has PIL); do not judge by eye.
3. Write a judgement for each point against the standard; what it does not say follows `principles.md`; what that does not say either, look up in Apple HIG / Raycast / Linear before concluding, and suggest whether to add it to `DESIGN.md`.
4. Put screenshots and judgements in the project's `design/<topic>/README.md` (pictures in the same folder, relative paths, numbered marks), register it with `dispatch docs add <project> <path> --kind design`, and give the path in the conversation. Whether screenshot drafts go into Git follows the project's convention.
   A proposal takes another route: no README.md hand-in; write notes.md, prototypes and screenshots as the `delivery-page` skill says, and `dispatch deliver --kind proposal` makes the page, files it in Docs and attaches it to the task.

## Format of a judgement

One line each: `element (selector or component:line) → current value → change to → token`. For example:
`.recent .row .t → fixed-width 13px 500 showing the whole path → folder name sans 13/500 + parent folder 12px --text-2 cut in the middle → --sans / --text-2`

The last line: **passes**, or a **list of changes** (sorted by visual impact: first what the whole screen shows, then local things). Report only conflicts with the standard, never taste; at most 10 items at a time, merging more into one kind.

## Screenshots (without disturbing the person)

The person may be using this computer: only switch pages and take screenshots; never type, click or drag; when the page changes by itself the person is working, so wait a while before the next one.

Desktop apps (macOS):
- Find the window number with Python and pyobjc (make one with `python3 -m venv` and install `pyobjc-framework-Quartz`): `Quartz.CGWindowListCopyWindowInfo(kCGWindowListOptionOnScreenOnly | kCGWindowListExcludeDesktopElements, kCGNullWindowID)`, filter by `kCGWindowOwnerName` and `kCGWindowName` and take the widest; the number may change after switching pages, so look it up each time.
- `screencapture -x -o -l <window number> <path>` (`-x` silent, `-o` without the shadow). The result is 2x; divide by 2 when measuring.
- Switch pages with the app's command line when it has one; otherwise capture only the current page.
- For dark mode do not switch the system appearance: use the app's own setting or a `data-theme` variable, and switch back afterwards.

Web pages / a local development server:
- For pages you made, use playwright (`require("playwright")` in a script that takes them in a batch, faster than one MCP frame at a time): two fixed viewports, 1280×800 and 390×844, and `page.emulateMedia({ colorScheme: "dark" })` for dark.
- Live pages that need a signed-in session: `claude-in-chrome`.
- For animated pages, read a DOM value that changes, before and after; a good screenshot does not prove the page is running.

## Handing it to whoever implements it

The plan comes before code: list one by one which tokens, selectors and component call sites change. In a review, ask for before and after pictures of the same page in the same viewport.
