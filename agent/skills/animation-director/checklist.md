# Checklist for one teaching animation

Tick item by item. Write failures as "which item → how it is now → change it to".

## A. What it explains

- [ ] You can write one sentence "one can say after watching", and the picture really explains it.
- [ ] The core relation (the most important formula, comparison or process) corresponds to a geometric quantity on screen that changes, not only in readouts.
- [ ] Each control matches an assumption that can be changed; removing any control would leave one thing unexplained.
- [ ] The default state is the "question state", not the answer.
- [ ] Animation is used for processes, causes or structures; when it is only a table, make it a static figure plus one parameter.
- [ ] Real numbers (from cases, slides, textbooks) appear on screen; made-up data is marked "illustrative".

## B. Understandable

- [ ] Instructions are one action per sentence.
- [ ] Each switch points out where to look (a box, a highlight, the rest dimmed).
- [ ] Axes and layout stay put while switching; only the quantity being explained changes; log axes are labelled.
- [ ] A consistent colour table: one concept, one colour; no more than 4 semantic colours; formulas and picture share colours.
- [ ] No cut-off text, no overlapping labels; big numbers change units or use scientific notation.
- [ ] Screenshots checked at desktop side-by-side width, phone 390px and dark mode.

## C. How it moves

- [ ] States are joined by tweens or morphs, not jump cuts.
- [ ] What moves comes from the concept itself; no breathing, floating or glows unrelated to it.
- [ ] One action takes 1 to 3 seconds and pauses once it lands; autoplay is slow enough to read.
- [ ] Continuous animation stops when not visible (scrolled out of view, tab hidden).

## D. Code (interactive + exportable)

- [ ] All randomness seeded; nothing reads the real clock directly to drive the picture (`Date.now`, positions computed from `performance.now`).
- [ ] Every state has a name, `preset(name)` covers every name the step-by-step explanation uses, and switching syncs control positions and readouts.
- [ ] `reset()` restores every initial state.
- [ ] Elements on the canvas that may be asked about or pointed to are registered as clickable elements with stable plain-words labels.
- [ ] Controls all have names (slider label, button text, segment label) so timeline scripts can find them by name.
- [ ] Colours are taken from theme variables at every draw, so switching light and dark follows by itself.

## E. Video clips (after export)

- [ ] Frame count = duration × fps; resolution and frame rate right; silent (audio is left to editing).
- [ ] `--verify` determinism ✓.
- [ ] Contact sheet of sampled frames: at each caption the picture talks about the same thing; focus boxes point right.
- [ ] A reasonable share of still frames and longest still stretch (teaching explanations usually 35% to 60%, longest within about 2.5 seconds); per-second motion has no long stretches of 0.
- [ ] Text is clear at the target size (body text at least about 24 pixels high for 1080p landscape, larger for portrait); nothing falls into the caption safe area.
- [ ] Captions stay long enough to read: Chinese characters ÷ 4.5 + 1.5 seconds, English letters ÷ 15 + 1.5 seconds, and no less than 1.8 seconds.
- [ ] The cursor and press ripple appear only around interactions and never cover key numbers.
- [ ] Numbers stated consistently: picture, captions and voice-over agree (for example "grew 9 times" and "grew to 9 times").
- [ ] An independent review watched it and its clear problems were dealt with.
