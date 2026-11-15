# How to work

Four kinds of work: design, review, scripting and export, handing over. All start from the real picture.

## 1. Designing a topic's animation

1. **A one-sentence goal**: write down "the sentence one can say after watching", usually the topic's one-sentence summary.
2. **Find the core relation**: the topic's most important formula, comparison or process. Decide which geometry draws it (area, length, count, position, shade of colour).
3. **Choose the grammar**: by the selection table in `grammar.md`, decide whether the concept is "a mechanism turning step by step into something else", "scale", "process steps", "comparing data", "taking a structure apart", "an argument with real records" or "historical time and place". One animation uses one grammar.
4. **The aha frame**: draw (or describe clearly) the picture at the moment of understanding. For a new direction, compare three versions of the same frame first.
5. **List the states**: 3 to 6 states worth seeing, each with a short English name (`small`, `diverge`, `m9`), the first being the "question state". How each morphs into the next.
6. **Controls and readouts**: each control matches an assumption that can be changed; readouts hold only numbers for checking, long text goes into the readout bar, not the canvas.
7. **Clickable elements**: everything on the canvas a student might ask about or a video script might point to is registered as a clickable element with a plain-words label (for example a registry like `hits.add({label, value, ...})`). Labels stay stable: timeline scripts find positions by them.
8. **Test it yourself**: really drag every control, really click every button, really switch every state, and the pixels change each time; screenshots at narrow phone width in dark mode; go through `checklist.md`.

## 2. Reviewing existing animations

1. **Look at the real picture**: open each one and capture the start, after 1 second of rest, after each preset state, and narrow phone width in dark mode. Read a value that changes (a canvas pixel hash or a readout) to judge "is it moving when opened" and "did it change after switching". A good screenshot does not mean it runs.
2. **Score against the principles** (out of 10): serves the topic (is the relation drawn as geometry) 3, attention cues 2, segmenting and path 2, readable from zero (captions, text and numbers fit) 2, motion (moving at the right moments, morphs continuing) 1. 8 or more = it holds up as a video too.
3. **Write only the one thing most worth changing**: pick the change with the most impact, the fix concrete down to "draw what, where, changing with what", naming which practice of which grammar.
4. **Top 5 overall problems**: group the animations' problems, sort by impact, give each group one fix and the matching principle numbers.
5. Judgement format (one line per animation):

```
| # | Topic | Score | The one thing most worth changing | Fix |
| 09 | Gradient descent | 8 | the step α×gradient cannot be seen before it is taken | draw the arrow's length as α×|gradient|, dragging α lengthens it live, red once it overshoots the bottom of the bowl |
```

## 3. Writing a timeline script and exporting

1. **Voice-over first**: one action per sentence (3b1b: the animation starts when the sentence says the action verb, and stops about 1 second after the sentence lands). Clips of 3 to 8 seconds have 2 to 5 actions; a whole explanation 20 to 40 seconds, 5 to 8 sentences.
2. **Map the voice-over to events**: one `caption` per sentence; actions use `preset`, `slider`, `segment`, `click`, `draw`, `hover`; each sentence's point gets a `focus` box (prefer `hit:label`, independent of layout); when word-level voice-over timings exist, events use `word` rather than `t`. Format in `pipeline.md`.
3. **Stills first**: `--stills` gives a few frames at each sentence's key moment; check that boxes point right and no text is cut off.
4. **Render**: pick the layout (`stage` animation only, `captioned` key points in a right column), light or dark, and aspect ratio; add `--verify`.
5. **Watch it** (never skip):
   - Contact sheet of sampled frames: one frame every 1.5 seconds on one sheet; does the picture talk about the same thing as each sentence?
   - The export tool's share of "neighbouring frames that did not change at all" and the longest still stretch: teaching explanations usually 35% to 60%, the longest stillness no more than about 2.5 seconds; when longer, add a small motif action there (such as a magnifier sweeping slowly) or shorten the pause.
   - Motion area per second (the share of pixels changing between neighbouring frames each second): find stretches of the film where nothing moves for a whole second.
   - Determinism ✓.
   - Watch once at full speed: can the captions be read in time, do the focus boxes keep up with the voice-over?
6. **Independent review**: have someone (a person or agent) who took no part look only at the mp4 and the contact sheet, find problems by the video part of `checklist.md`, and check logic and how numbers are stated.

## 4. Handing over to a video pipeline

- The core output is in standard formats: H.264 yuv420p mp4 (silent, frame count exactly duration × fps, one keyframe per second) + `.timeline.json` (which frame each event and caption lands on) + `.srt` + a cover jpg. Any editing software can use them.
- Connections to a personal workflow (some editing software, some voice-over pipeline) are written as deployment-level adapters: read that side's script and word timings → generate the script → call the core export → write the asset entries that side understands. Core code never imports an adapter.
- Details of the connection and known gaps are in `pipeline.md`.

## Do not disturb the person

The person may be using this computer: take review screenshots with a headless browser, never switch their windows; do not write state to the site's services (block write requests); remote machines are read only.
