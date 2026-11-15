# Interactive animation → video clips

The same animation lets students play with it and plays back deterministically, frame by frame, as a video following a script. Below, one common way of writing it serves as the example: one module per topic (`demo.init(root, kit)`), where kit is the project's own small library providing Canvas, sliders, segments, buttons, readouts and presets. Other frameworks follow the same three layers: replace the clock, register the controls, capture frame by frame.

The three files below live in the project that makes the animations. When the project does not have them yet, write them there following this section (a few hundred lines, handed to whoever implements it); file names may follow the project's habits.

## 1. Three files

| File | Purpose |
| --- | --- |
| `kit-timeline.js` | Timeline mode: virtual clock, control registry, script compiler, player, timecodes and SRT. Does not change the animation's own library |
| `clip.html` | The clip page: loads the animation module, lays it out by layout, exposes `window.__clip.frame(i)`; without `render=1` it is a preview page (play, scrub, tick "operate it myself" to play directly) |
| `tools/export-clip.mjs` | The export tool: starts its own read-only static server, captures frame by frame with headless Chromium, assembles with ffmpeg, writes the timecode JSON, SRT and cover |

### How timeline mode stays deterministic

1. **Replace the clock**: the page's `requestAnimationFrame`, `performance.now`, `Date.now`, `setTimeout`, `setInterval` and `Math.random` are all replaced by virtual versions. kit's `loop` and `tween` are written as usual and do not know they are being driven.
2. **Advance frame by frame**: frame i is exactly at time i / fps. Advancing to frame i applies, in order, every event whose first frame with "time ≥ t" falls here, updates drags in progress, then moves the virtual clock to i / fps and runs one round of callbacks. Jumping back rebuilds the animation and replays from frame 0, so jumping to any frame gives the same result as playing in order.
3. **Register controls**: wrap `kit.slider / segmented / button / readout` before handing kit to `demo.init`; scripts find controls by name (a slider's label, a button's text, a segment's label).
4. **Find positions without coordinates**: `focus` and the cursor look things up first by kit's clickable element labels (`hit:pixels`), then by control name; the same script points at the same thing in landscape, portrait and narrow columns.
5. **No CSS animation on the page**: the clip page turns off all CSS transitions and animations; focus boxes, the cursor and press ripples are drawn on virtual time.

Note: once the page's clock is replaced, Playwright's `waitForFunction`, which relies on page timers, hangs; the export tool polls for readiness from the Node side.

## 2. Script format

```json
{
  "module": "/<path of the animation module>.js",
  "title": "Gradient descent: step by step down the steepest slope",
  "subtitle": "θ := θ − α · ∂ℒ/∂θ",
  "duration": 28, "fps": 30, "seed": 1, "poster": 12,
  "output": { "layout": "captioned", "theme": "dark", "subtitles": false },
  "words": [ { "text": "learning", "start": 0.12, "end": 0.48 } ],
  "events": [
    { "t": 0,   "do": "reset" },
    { "t": 0,   "do": "caption", "text": "Goal: find the θ with the smallest loss, the bottom of the bowl." },
    { "t": 0.4, "do": "focus", "target": "canvas:1", "dur": 2.6 },
    { "t": 4.6, "do": "click", "name": "Take a step" },
    { "word": "learning", "do": "slider", "name": "Learning rate α", "to": 0.15, "dur": 1.2 }
  ]
}
```

| Event `do` | Fields | What it does |
| --- | --- | --- |
| `preset` | `name` | calls the animation's `preset(name)` (a state of the step-by-step explanation) |
| `reset` | | calls `reset()` |
| `slider` | `name, to, dur` | moves the slider to `to` within `dur` seconds (log sliders interpolate logarithmically), firing the animation's onInput every frame |
| `segment` | `name, value` | switches a segment |
| `click` | `name` | clicks a button (found by its current text or its original name) |
| `draw` | `canvas, path, dur` | presses on canvas number `canvas`, drags along `path`, releases; points are `[x, y]` (0..1 relative to the canvas) or `"hit:label"` |
| `hover` | `canvas, path or at, dur` | moves without pressing (triggers magnifiers and hover readouts) |
| `caption` | `text, until?` | an explanation caption; goes into the SRT and timecodes; without `until` it lasts until the next one |
| `focus` | `target, dur` | an attention box: `hit:label` / `slider:name` / `seg:name` / `button:name` / `readout:key` / `canvas:number[@x,y,w,h]` |
| `camera` | `rect or null, dur` | pushes in on a part of the stage (0..1); null pulls back |
| `mark` | `label` | goes into the timecodes only, for aligning in editing |

Times: `"t": seconds`, or `"word": "a word of the voice-over"` (with `nth` for which occurrence and `offset` to move earlier or later). With `words` (word or character timings), compilation converts them to seconds and then frames; a word that cannot be found is an error.

The `output` field: `layout` (`stage` animation only; `captioned` a right column with the title and key points, those already said greyed and those not yet said hidden), `theme` (`light` / `dark`), `subtitles` (captions burnt in at the bottom of the stage layout), `chrome` (`full` with controls; `canvas` the canvas only), `arrange` (`side` controls right of the canvas; `stack` canvas on top; landscape defaults to side, portrait to stack), `width / height / scale / safeBottom`.

## 3. Export

```sh
node tools/export-clip.mjs <script.json> [--out exports/name.mp4] [--theme light|dark] [--layout stage|captioned]
     [--size 1920x1080] [--fps 30] [--scale 2] [--subtitles] [--chrome full|canvas] [--safe-bottom 0]
     [--stills 0,1.5,3] [--verify] [--crf 16]
```

- Layout is in CSS pixels and screenshots are multiplied by `--scale` (default 2 for landscape, 2.5 for portrait), so text in 1080p is twice its size on the web page.
- The stage width is found automatically: widths are tried from wide to narrow within the available area until the first that fits; when nothing fits, everything shrinks; with room to spare it grows by at most 1.2x.
- `--stills` renders only the PNGs at these moments; use it to check while writing the script.
- `--verify` cold-renders 4 frames on a fresh page (first, 1/3, 2/3, last) and compares them pixel by pixel with the export.
- Preview: while the site's server runs, open `clip.html?script=<script path>.json` to play, scrub, and tick "operate it myself" to really click and drag.

### Output specification

| File | Specification |
| --- | --- |
| `<name>.mp4` | H.264, yuv420p, silent, `-g fps` one keyframe per second (editing software seeks by second without freezing), frame count = round(duration × fps), faststart |
| `<name>.timeline.json` | `version, duration, fps, frames, seed, title, module, width, height, theme, layout, video`; `markers[] = {t, frame, kind, label, word?, dur?}`; `captions[] = {t0, t1, text}`; `stats = {stillFramePairs, stillRatio, longestStill, renderSeconds}` |
| `<name>.srt` | written when there are captions, on the same frames as the picture |
| `<name>.jpg` | the cover, taken at `poster` seconds (default half the length, at most 3 seconds) |

Speed (an M-series Mac, 1080p, 30fps): about 70 to 230 milliseconds per frame (PNG screenshots), 1 to 3 minutes for a 30-second clip.

## 4. Watching it

1. Contact sheet: `ffmpeg -i x.mp4 -vf "fps=2/3,scale=640:-1,tile=4x5" -frames:v 1 sheet.jpg`.
2. The still share and longest still stretch in the export log; motion area per second (scaled to 192×108 greyscale, the share of pixels differing by more than 12 between neighbouring frames, averaged per second), to find stretches where nothing moves for a whole second.
3. Determinism ✓.
4. Watch once at full speed against part E of `checklist.md`.

## 5. Known limits

- **Changing the animation can break scripts**: scripts find things by control name and preset name. When the animation changes (a button renamed, a preset deleted), export fails and lists the existing controls (for example "No button 'Auto step'; there are: Take a step, Start over"), so it never silently makes a wrong clip, but the script needs changing. Scripts written against clickable element labels and presets survive changes best.
- **Pages only**: WebGL canvases and video elements are untested; content in an `<iframe>` is captured but its clock is not controlled.
- **Screenshots are the bottleneck**: PNG takes 70 to 230 milliseconds per frame; for more speed, switch to JPEG screenshots or parallel pages (each replaying from the start to its own starting point).
- **Turning explanation steps into scripts automatically is not done yet**: when a topic has screen-by-screen explanation data (one voice-over sentence, one preset, the readouts and controls to look at per screen), a timeline script can be generated directly: one caption + preset per screen, with readouts and controls turned into focus.

## 6. Connecting to video pipelines

The core produces only the standard set of files above. Connections to specific editing software or voice-over pipelines are written as **deployment-level adapters** (not in the open-source core).

### General editing software

Put the mp4 above the voice-over track as B-roll, add markers from the `.timeline.json` markers, and import the `.srt` as a caption track or drop it (when the voice-over pipeline makes its own captions).

### Voice-over video software

Voice-over video software (such as Better Vlogger) usually centres on the "script": each voice-over line has start and end times and word timestamps, and B-roll can hang on a line. To connect, write a small adapter at the deployment level, outside the animation core:

1. Read the line's duration and word timings, shifted to the start of the line; take the aspect ratio and frame rate from the script's settings (9:16 is 1080×1920).
2. Build the full script from an animation script template (events anchored with `word` on the voice-over's words): stage layout, no burnt-in captions, about 520 pixels at the bottom of portrait video left free for burnt-in captions.
3. Call the export with `--verify`.
4. Write the line's B-roll entry and put the clip into that software's asset folder under the file name it expects; changes to the script go through that software's own interface, never by editing its data files directly from outside.
5. Clips themselves are silent and carry no "AI generated" mark; that software adds those at final export by its own conventions.
