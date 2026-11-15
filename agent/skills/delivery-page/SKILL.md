---
name: delivery-page
description: "Use when delivering anything the person will look at (an interface change, a visible bug fix, a design proposal): put screenshots, notes and prototypes in one folder, and dispatch deliver makes one HTML page from a single template, files it in Docs, attaches it to the task and opens it in Dispatch's side pane. Deliveries and design proposals use the same template; no hand-written pages."
---

# delivery-page: the standard for delivery pages

Every delivery has one layout (decided by the person on 2026-09-29). It comes from the designer's hand-written onboarding proposal (type sizes, sections, red diagnosis boxes, embedded prototypes, a recommendation with Choose A / B), plus the "Where" of implementation deliveries (the whole screenshot with every numbered box; clicking a line zooms to that spot, Whole picture goes back, Enlarge fills the window), plus a table of contents on the left. On 2026-10-01 the person picked direction A, "look at the picture right there": "What changed", "Scenes", "Before and after" and "Evidence" each work like "Where", with the section's own viewfinder; clicking a line zooms into and highlights that numbered box on the section's own picture, so you check things where you read them. Deliveries no longer each look different: **there is one template (`template.html`) and one generator (`dispatch deliver`).** An implementation delivery and a proposal differ only in the header word (built by / drafted by) and whether there is a "Recommendation" section. README.md is source data only, never the delivery.

Write the notes and everything on the page in the person's language (the language they write to you in).

```bash
dispatch ide e2e run <scenario> --out design/<name>/impl          # real clicks, real screenshots: screenshots, steps.json, the Where boxes
# write design/<name>/impl/notes.md (format below)
dispatch deliver <task> --from design/<name>/impl --model "Opus 5.5 · high" --show
dispatch deliver <task> --from design/<name>/redesign --kind proposal --model "Fable 5.1 · high" --show   # a design proposal
```

`deliver` does four things: it makes `<folder>/index.html` from `template.html` (self-contained; pictures and prototypes are referenced by relative path in the same folder); files it in the project's Docs (a delivery as delivered, a proposal as a design); attaches it to the task's deliverables; and with `--show` opens it in Dispatch Agent's side pane, or only prints the path when the side pane is not open. A proposal also puts the task in Waiting for you for the person to pick (as `dispatch flow finish` does). Optional: `--title` (default: the `#` line of notes.md), `--test-log <file>` (test output goes into the evidence block, repeatable), `--out` (the page's file name, default index.html).

The header says who built or drafted it, with model and effort together (`"Opus 5.5 · high"`, `"Fable 5.1 · max"`): the person compares drafts by different models. A missing `--model` is an error.

index.html is always generated. A prototype may not be called index.html (overwriting it is refused unless `--force`); prototypes live in the same folder with names like `proto-a.html` or `prototype.html`.

## How the page looks (the generator and template handle it; you write no CSS)

- At the top: the title (in the person's words), one line "Built by / Drafted by: model · effort" with the date, Auto / Light / Dark on the right, and the result as bullets below.
- A table of contents on the left (page 1080 wide and up): one line per `##` section, the current one highlighted, a click scrolls there; a section with two or more subsections unfolds them while it is current. A button at the column's top right (beside "Contents") folds the column away so the page takes the room, leaving only that button to bring it back; the page remembers the choice for the next delivery page (decided by the person on 2026-11-07). When narrow (the side pane at 420, or under 1080) it folds into a Contents bar at the top of the page; it opens to the same list and closes once something is picked.
- The viewfinder (the same in every section): one picture (or two for before and after) with all numbered boxes, and the section's lines below or beside it. Clicking a numbered line zooms the section's own picture to that box and dims the rest; clicking again or Whole picture goes back; Enlarge fills the window and Esc comes back; the boxes on the picture can be clicked too. There are three kinds of line, told apart at a glance:
  - Lines with a picture: a black round number in front, the same as the box's number.
  - Lines with a record (JSON, a log): a record icon in front and Record on the right; a click opens the record in the section (the top-level numbers plus the whole text), Close folds it.
  - Lines with words only: no number, grey, No picture on the right, not clickable.
- The layout follows only the page's own size, wherever it is opened:
  - A picture with its words (the viewfinder and its lines, the diagnosis and its notes, a tall picture with words) follows the page's shape (decided by the person on 2026-11-07: 横屏左右，竖屏上下): when the page is landscape and 900 or wider, the picture is left and the words right, and the picture stays in view while you read down the words; when the page is portrait (or narrower than 900) the words go under the picture. It changes as the window changes.
  - 1000 and up: before and after sit side by side, one number finds its box on both, each zoomed to its own box; galleries two or three columns; four-column cards four or two columns; a diagnosis stacked on a wide portrait page puts its notes in two columns.
  - Under 1000 (a side pane of 420 to 700 counts): pairs and galleries stack, pictures take the full width, picture and lines follow each other (before, after, lines); clicking a line scrolls the picture into view when it is out of sight; under 600 a table row becomes a card.
  - Text uses the available width (at most 1600 with the contents); paragraphs limit their own line length; on a wide screen a tall picture on its own is narrowed and centred instead of sitting at its original size; one with a partner (a pair, words beside it) sits next to the partner.
- Light and dark follow the system, with Auto / Light / Dark at the top right; colours come only from DESIGN.md's tokens; red and green boxes are drawn only on screenshots; diagnosis note numbers share their box's colour, other numbers are black dots.

## The fixed order of sections

The page uses this order; your order in notes.md may differ and the generator puts it right ("Where" always first; "Evidence", "Not done" and "Recommendation" always last; sections of one kind keep their order from the notes). A section with nothing in it is left out entirely, never an empty heading. Chinese headings (`## 在哪`, `## 改了什么` …) are understood too.

| Order | Section (`##` heading) | Delivery | Proposal | Component |
|---|---|---|---|---|
| 0 | Opening (the bullets under the `#` title) | required | required | result bullets |
| 1 | `## Where: <the feature's name>` | required | when there are real screenshots | Where |
| 2 | `## Diagnosis` | for bug fixes | required | screenshot + numbered red boxes + notes with the same numbers |
| 3 | `## What changed` | required | no | list |
| 4 | `## Who does what at this moment` | when agent / command line / window work together | no | four columns |
| 5 | `## Scenes` | when there are several states | not again when the prototype has them | state strip |
| 6 | `## Before and after` | when there is an old interface to compare | when comparing the draft with the real thing | side by side |
| 7 | `## Direction A: name` `## Direction B: name` | no | required, one section each | direction block with the prototype |
| 8 | Other `##` (background, decided for you …) | as needed | as needed | paragraphs, tables |
| 9 | `## Evidence` | required | no | evidence block |
| 10 | `## Not done` | required; write "nothing" when there is nothing | as needed | grey list |
| 11 | `## Recommendation` | no | required | recommendation card + comparison table + Choose A / B |

## How to write each section

- **Opening**: the first line is `# Title`, in the person's words, without internal labels such as "delivery a", "3.2" or "group C"; leave task ids out too (they are removed). Under the title comes the result as bullets (`- `, one thing per bullet, one or two sentences): what now works, what the person needs to know, what they need to decide. Result first; no process, no long paragraphs.
- **Where**: write the heading as `## Where: slash command menu`; the page shows only the feature's name. Without a name in the heading, the page title is used. Below it a numbered list, one line each: "what it is · where · how to get there". The page draws every numbered box on the whole real screenshot; clicking a line zooms to that spot, Whole picture goes back, Enlarge fills the window. Where the boxes come from is under "Pictures".
- **What changed**: one thing per line, what the person can see first. A line that can be seen on a screenshot links what to look at to the picture and the box number; a line with a raw record links the record file; what can only be said in words is written as words (do not force a picture that only looks related):

  ```
  - [The usage bar in the title bar](01-window.png#mark=1): one segment per engine; a segment past 80% fills in.
  - [Add account](02-panel.png#mark=3): the official sign-in happens in a temporary folder.
  - [The background index's performance record](benchmark.json)
  - [The frame checking the first read's progress](steps.json#step=5)
  - Tool calls are parsed only on lines with the task prefix.
  ```

  `picture#mark=n` is the box numbered n on that picture; do not copy boxes again: they are found in `<picture>.boxes.json`, `00-where.json`, then the marks of `steps.json`. Without `#mark` it is the whole picture. `steps.json#step=5` is step 5's screenshot with the box it marked, `steps.json#mark=2` the second mark. Files such as `.json`, `.txt` and `.log` are record lines. The page numbers lines 1, 2, 3 in order and draws the boxes with the lines' numbers. A section without a single linked line is a plain list. The same works in "Evidence" and other plain sections; the result bullets and "Not done" never become viewfinders.
- **Who does what at this moment**: four `### Agent: one sentence`, `### Command line: …`, `### Window: …`, `### You: …`, each with a sentence or two.
- **Scenes**: one `### name` per state, with a list below: `- Normal: ![](01.png) note`, `- When it appears: ![](02.png) note`, `- After opening: …`. Wide pictures get one viewfinder with a row of tabs on top (pick the state, then click its lines); narrow ones (the side pane kind) get several viewfinders side by side. To show only part of a picture use `01.png#crop=x,y,w,h` (it only decides what is shown first; box coordinates always refer to the original picture). When a state's picture has `<picture>.boxes.json`, every box becomes a line by itself (`"what": "…"` in the box is the line's words; with a single box the state's note is used); to write lines yourself, add `- [Rename](05.png#mark=1)` in the same list or one right after it, and the line follows its picture's tab.
- **Before and after**: the standard form is a label and a picture, one subheading per group, two lines each:

  ```
  ### 1. Before hovering
  - Design 1A: ![design](ref-1a.png#crop=800,0,840,1000) the chosen direction
  - Built 1B: ![built](real-1b.png#crop=0,0,832,1160) the current build
  ```

  The labels are words such as "Before / After / Design / Prototype / Built / Real / Now" (or their Chinese forms); whatever the section is called, two or more pictures with such labels form a pair: side by side on a wide page, stacked on a narrow one. A label on one line with the picture on the next (indented two spaces, or after an empty line and indented) works too, and so do labels as their own lines or list with each picture as its own paragraph after it. A heading with "compare" or "side by side" also counts as this section.
  Both pictures need boxes: write a `<picture>.boxes.json` for each, marking the spot that changed, with the same number for the same spot on both pictures (the format as in the diagnosis). Without boxes `dispatch deliver` reminds you. The page makes the group's lines from the numbers; clicking one moves both pictures to that number, each zoomed to its own box; a line's words come from the box's `"what"`, else from the group's subheading. To write lines yourself, add `- [From Looking… to the read count](before-index.jpg#mark=2)` in the same list or right after it (the number is looked up on both pictures). Where one side lacks the number, that side shows the whole picture with "Not marked on this picture"; coordinates are never guessed.
- **Diagnosis**: one real screenshot followed by a numbered list; the boxes are in `<picture>.boxes.json`. Notes and boxes on one picture share number and colour; pointing at a note lights its box. A sentence about the picture may follow it in the same paragraph. Parts that already exist and can be used as they are get a green box (`"color": "green"`).
- **Direction A / Direction B**: the heading is exactly `## Direction A: name`; the name is what the person picks in Waiting for you (at most 4 English words or 8 Chinese characters, in the interface's language). One sentence of introduction, then subheadings (`### A1 Agents found`; a letter plus a number, or `1.`, gets a black numbered dot), each with notes and the prototype. The recommended direction gets a "Recommended" tag by itself.
- **Evidence**: test output in a code block (folded beyond 24 lines); commits and build names as a list; the build name, scenario and step count of `steps.json` go into the evidence block by themselves. A frame from the run is written as `[the frame checking the read progress](steps.json#step=5)`, raw data as `[synthetic performance test](benchmark.json)`, and opens in the section when clicked; a test count without its own log is plain words; never invent a place for it to point to.
- **Not done**: list it as it is, one line each, saying what and why; no categories, and do not make tasks for the person. When there really is nothing, write "nothing".
- **Recommendation**: the first sentence says "I recommend B, …" and why, optionally with one more paragraph; then a Markdown comparison table (the first column is what is compared, one column per direction). The page puts Choose A / Choose B after the table: opened from Dispatch's side pane (`--show`) a click really records the choice (the bridge only lets `dispatch flow pick <this task> <A-F> --reason …` through) and shows a Remembered card and "Preference remembered"; opened in an ordinary browser it only demonstrates and writes nothing.

Other rules for the words:

- Words from the interface (button names, states) are quoted ("Save"); backticks only for commands, paths and code (the page sets backticks in a fixed-width font).
- No dashes in the page's text: use commas, colons, full stops or split the sentence; interface wording follows the project's language rules.
- The first paragraph under a `##` is the section's lead-in (grey), so make it one sentence saying what the section is about.

## Pictures

- Screenshots: `*.png`, referenced in the notes as `![caption](01-xxx.png)`; referencing a picture or prototype that is not there is an error. An implementation delivery needs at least one real screenshot.
- Pictures are laid out by their shape (the cropped part when there is `#crop`): wide whole-window screenshots get the caption below; narrow, tall pictures (the side pane at 420) get the caption beside them (below on a narrow page) and are narrowed and centred without a caption; a list where every line is `![](picture) caption` becomes a gallery, two columns of wide pictures or three of narrow ones; a paragraph ending in a colon followed by a picture becomes that picture's caption.
- `00-where.json`: the Where boxes, drawn on a real screenshot (the page draws the red boxes and numbers itself; burn no boxes or words into the screenshot): `{"image": "01-xxx.png", "items": [{"n", "box": [x, y, w, h], "what", "where", "how", "image"?: "another screenshot"}]}`, in screenshot pixels; an item may be on another screenshot (with its own image). A folder made by an e2e run needs none: it is made from the marks in `steps.json`, with each box on the frame of its moment. With only a screenshot, `dispatch annotate <screenshot> -o <folder>/00-where-is-what.png --box x,y,w,h --note "what · where · how" … --where`, and the json points at the original screenshot. An older picture with the boxes already drawn gets `"drawn": true` (the page only zooms, drawing nothing). With none of these the Where picture shows whole and the notes do not follow clicks.
- `<picture>.boxes.json`: for the diagnosis, before and after, scenes and lines with `#mark=n`; the numbered boxes on this picture `{"size": [w, h], "items": [{"n", "box": [x, y, w, h], "color": "red|green", "what"?: "the line's words"}]}`.
- A wrong link keeps the line's words: a number missing on the picture shows the whole picture and `dispatch deliver` prints "Note: notes.md line N: …"; a linked file missing from the folder is an error like a missing picture; a record that cannot be read shows Record unavailable.
- `steps.json`: the output of `dispatch ide e2e run`; its build name, scenario and step count go into the evidence block by themselves.

## Prototypes (design proposals)

The clickable prototypes of a proposal are HTML the designer writes, in the same folder; the page embeds each in its direction and keeps it clickable. No whole hand-written pages.

- One prototype per file (`proto-a.html`), or several screens in one file picked by the address (`prototype.html#scene=a1`). Each file is complete HTML with its own styles and scripts, works offline and loads nothing from the internet.
- Embedding: `![Agents found](proto-a.html#size=1440x887)`; a sentence after it is the caption. `size=width x height` is the prototype's own size (a whole window is 1440 × 887); the page scales it to the page's width, with Fit / 1:1 at the top right (1:1 scrolls sideways) and Enlarge (fills the window, Esc closes). Other parameters after `#` (`scene=a1`) are passed to the prototype as they are. In a labelled list such as `- Normal: ![](a.html#size=…)` it becomes a state tab like a screenshot.
- A prototype can also live inside notes.md: a fenced block ```` ```prototype 640x360 name ```` with HTML (a fragment or a whole document); the page wraps it with the tokens and the theme listener.
- Following the page's light and dark: the page adds `#theme=light|dark` to the prototype's address and sends `{type:"dispatch-theme", theme}` when the theme changes. Put these lines in the prototype:

  ```js
  addEventListener("message", e => { if (e.data && e.data.type === "dispatch-theme") document.documentElement.dataset.theme = e.data.theme; });
  const m = location.hash.match(/theme=(light|dark)/); if (m) document.documentElement.dataset.theme = m[1];
  ```

  Write dark styles under `:root[data-theme="dark"]`. A light/dark switch inside the prototype is redundant.
- When its size is not known in advance, a prototype can tell the page after its content changed: `parent.postMessage({type:"dispatch-size", w, h}, "*")` (w and h of its content), and the page lays it out again; otherwise `#size=` is used.
- Prototypes run in a sandboxed frame (scripts and forms work; reading the page and opening windows do not): do not count on localStorage, `fetch` or `window.top`.
- Give each numbered area `data-part="<area name>"`, so a preference the person states about one area hangs on that area.

## Before handing it in

- Open the generated page yourself (side pane or browser) at 420, 800, 1200 and 1600 wide, in light and dark: click every numbered line of each viewfinder (the box lights in the right place), Whole picture, Enlarge and Esc; check that both pictures of a before/after pair move together; in scenes, switch tabs first and then click lines; open and fold record lines; jump through the contents; click inside a prototype when there is one; click Choose A on a proposal. Deal with every "Note" `dispatch deliver` prints.
- For a delivery about how the interface looks, have the designer review screenshots of the generated page; take them again after fixes.
- `scripts/preview.sh <folder>` takes headless Chrome screenshots at 420 / 800 / 1200 / 1600 in light and dark in one go.
