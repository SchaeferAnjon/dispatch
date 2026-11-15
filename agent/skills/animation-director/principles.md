# Principles (for any subject)

In one sentence: **one action explains one thing, relations are drawn as geometry, ask before showing, one focus per screen, one codebase both to play with and to play back.**

Each: the reason (source) → how to use it → a counter-example. The examples cross several subjects; swap them when the course changes.

## What to explain

### 1. Every action has a teaching purpose
- Reason: the 3Blue1Brown FAQ, "every motion on screen should be intentional, with an identifiable purpose"; Mayer's coherence principle: people learn better with irrelevant material removed.
- Use: first write one sentence "one can say after watching". Every control and every moving thing answers "which quantity or relation does it make visible"; when it cannot, delete it.
- Counter-example: an animation about the hardware lottery (research directions decided by hardware) where cells flash, but the loop "hardware → popularity → the next generation of hardware" is never drawn.

### 2. Draw the core relation as geometry
- Reason: 3b1b, "colour = concept, morphs continue"; Distill's interactive figures; Ciechanowski's interactive long reads: the conclusion can be seen in the figure, not only in the numbers beside it.
- Use: the topic's most important formula has an area, length, count or position that changes with it. The readout bar is only for checking. Physics: kinetic energy ½mv² drawn as an area with v as its side; economics: total revenue drawn as a price × quantity rectangle; history: migration drawn as flow arrows with widths in proportion.
- Counter-example: dragging the "sample count" slider changes only the MB in the readout; the picture stays still.

### 3. Ask before showing
- Reason: short videos need "a hook in the first 3 seconds" (lemo-opuscar DIRECTOR.md); Veritasium lets viewers guess wrong first; 3b1b writes the question before the demonstration.
- Use: the default state stops at "the moment there is a problem": overfitting stops at a wildly swinging high-order curve, a pendulum at a large angle (where the small-angle approximation fails), an epidemic model on the eve of exponential growth with R₀ > 1. The first step of the step-by-step explanation asks; the later presets answer one by one.
- Counter-example: it opens on the answer state, "the fit looks good".

### 4. Animate where the change itself is the knowledge
- Reason: Mayer: animation does not necessarily teach better than static pictures; a whiteboard animation experiment (Türkay 2016) found no advantage in understanding. Animation's value lies in processes, causes and taking structures apart.
- Use: animate processes (an algorithm step by step, cell division, a battle advancing), causes (a parameter changes → the result changes), structures (taking apart a chip, a heart); a table or a definition gets a good static figure plus one draggable parameter.
- Counter-example: a comparison table made into an animation that flies in.

## Making it understandable

### 5. Attention cues: one focus per screen
- Reason: Mayer's signalling principle; Vox's highlighter and red circles, 3b1b's Indicate; huashu's three grammars independently arrive at "one focus per screen".
- Use: at each switch, give what to look at a brief box or highlight, keeping the rest still or dimmed. Instructions are one action per sentence.
- Counter-example: four lines of instructions at the top; after switching, nobody knows what changed.

### 6. Fix the skeleton, let only what changes change
- Reason: in huashu's art history speed-run, the window, table, cat and person barely move across 16 eras, so viewers can see that "what changes is the style".
- Use: axes, grids and legend positions stay put, ranges as fixed as possible; only the quantity being explained changes.
- Counter-example: axes rescale automatically; students think the curve changed when only the scale did.

### 7. Colour = concept, unchanged throughout
- Reason: 3b1b: beyond 3 to 4 semantic colours people cannot remember them; Vox uses only black, paper white and one red.
- Use: set a colour table (input, output, the true rule, the current action, comparison); symbols in formulas share colours with objects in the picture.
- Counter-example: within one lesson, blue is sometimes data and sometimes weights.

### 8. Structure first, then data, mark only one thing
- Reason: huashu's financial chart grammar; Economist-style charts: honest values, bars from 0, truncated axes stated.
- Use: axes first, then let the data grow, finally mark only one point. Log axes say "log", illustrative data says "illustrative".
- Counter-example: axes, curve, annotations and legend all appearing at once.

### 9. When it does not fit, have a way out
- Reason: huashu's final review of parameterized clips: "wherever something does not fit there must be a way out: shrink first, then fold, then make way, and only warn last".
- Use: long text goes into the readout bar; big numbers change units or use scientific notation; labels stagger by position; narrow screens change layout. Take screenshots on desktop, phone in dark mode, and landscape and portrait video.
- Counter-example: "150,528 numbers" cut off by the canvas's right edge; a readout showing 732254961559.4.

## How it moves

### 10. Transitions continue by morphing
- Reason: 3b1b's top transition is Transform, the previous object turning directly into the next; huashu: "a transition = the signature language of the next style".
- Use: states are always joined by tweens, morphing where possible: a greyscale grid splitting into three colour layers, threads merging into a warp, a cell dividing in two.
- Counter-example: clicking a button swaps the picture instantly.

### 11. Small motif loops, no decorative effects
- Reason: huashu, each scene is "a main action + 2 to 4 small loops taken from the motif"; 3b1b card: adding glows and gradient backgrounds turns it into "a tech-look slide deck".
- Use: what moves comes from the concept itself: data flowing along a bus, blood along vessels, samples flashing past one by one.
- Counter-example: making every card breathe for "movement".

### 12. Move at the joints, rest on the points
- Reason: huashu: Kurzgesagt almost never stops, storytime keeps seven tenths of its frames still; motion density is set by the grammar; 3b1b pauses about 1 second after each animation; lemo-opuscar reading time: Chinese characters ÷ 4.5 + 1.5 seconds, English letters ÷ 15 + 1.5 seconds.
- Use: one action takes 1 to 3 seconds and pauses 1 second or more once it lands; after a key point appears, pause long enough to read it; complete stillness over 2 seconds needs a reason.
- Counter-example: autoplay jumps to the next step before a number has been read.

### 13. Learners control the pace
- Reason: Mayer's segmenting principle; Bret Victor: explorable examples need a guided path from the author, not an empty sandbox.
- Use: on the web the main path is "step-by-step explanation + preset states", free play second; video clips of 3 to 8 seconds hold 2 to 5 actions.
- Counter-example: 8 steps played automatically in one go, with no pausing or going back.

## One codebase, two uses

### 14. Interactive and video share one codebase
- Reason: Bret Victor's explorable explanations; Remotion's Player embeds the same video component in a web page; Motion Canvas uses generator functions to make code the timeline; huashu and lemo-opuscar both write the picture as `render(t)`.
- Use: the animation stays interactive; the video is a timeline script moving the same slider and clicking the same button over time, exported frame by frame. Preset states are the storyboard, the step-by-step explanation is the voice-over, the timeline script is the edit list.
- Counter-example: a separate version drawn for the video, its numbers slowly drifting apart; screen recording.

### 15. One frame first
- Reason: huashu, "design one artful frame first, then make it move", comparing three versions of the same frame for a new direction; lemo-opuscar makes a style frame first.
- Use: draw the aha frame first (the moment the concept finally clicks) and let it decide layout, colours and type sizes, then add actions and controls.
- Counter-example: piling up controls first until the canvas is squeezed into a corner.

### 16. The reveal frame aligns with the voice-over's word
- Reason: huashu's voice-over pipeline: cues name "which word", not "which second", converted to frames before rendering; a word that cannot be found is rejected instead of silently drifting.
- Use: events use `word`, converted with the voice-over's word timings before export; a number lands at the moment it is said.
- Counter-example: seconds copied by hand; one cut in the voice-over and everything drifts.

### 17. Determinism
- Reason: huashu and lemo-opuscar both require all randomness to be seeded and the picture to depend only on t; Remotion's docs: `Math.random()` differs in each instance of a parallel render.
- Use: all randomness in the animation uses seeded generators; timeline mode replaces the page's clocks so frame i is exactly at i / fps; exports are checked by cold-rendering sampled frames.
- Counter-example: data points differ on every refresh, and screenshots no longer match the explanation.

### 18. The camera depends only on time; vectors are redrawn
- Reason: huashu: pushes, pulls and pans redraw the same world under a different camera, sharp even at 60x; never scale a rendered bitmap.
- Use: export at 2 to 2.5 times pixel density, so pushing in up to 1.5x stays sharp; larger push-ins are redrawn by viewport in the animation.
- Counter-example: enlarging the export 3x in editing software.

### 19. Make way for the caption band and the platform's interface
- Reason: huashu: grammars with text make way for the caption band rather than captions making way for the animation; burnt-in captions on portrait video sit at about 1400 to 1520 pixels.
- Use: leave a bottom safe area when exporting (about 520 for portrait, about 200 for landscape) and lay out content only above it.
- Counter-example: the key reading lands right under the captions.

### 20. Independent review plus measured acceptance
- Reason: before delivery huashu sends an agent that took no part to look only at the final cut, catching problems the maker missed in 3 rounds; QA measures motion, still frame pairs, jumps and determinism; lemo-opuscar's review loop: contact sheet, 0.2-second frame strips of key actions, one full-speed viewing.
- Use: for every clip, check the contact sheet, still share and longest stillness, and determinism, then have an independent review find problems by `checklist.md`; check logic and how numbers are stated.
- Counter-example: delivering after looking only at the first frame.

## Sources

- huashu-art-motion: <https://github.com/alchaincyf/huashu-art-motion> (references 01–12, animation grammar cards, scripts/engine)
- lemo-opuscar: <https://github.com/lemomo-ai/lemo-opuscar> (DIRECTOR.md, TECHNIQUE.md)
- 3Blue1Brown FAQ: <https://www.3blue1brown.com/faq>
- Mayer's principles of multimedia learning: <https://lucidea.com/blog/mayers-12-principles-of-multimedia-learning>
- Bret Victor, Explorable Explanations: <http://worrydream.com/ExplorableExplanations/>
- Distill, Research Debt: <https://distill.pub/2017/research-debt/>
- Remotion: <https://www.remotion.dev/docs/the-fundamentals>, <https://www.remotion.dev/docs/using-randomness>, <https://www.remotion.dev/docs/player>
- Motion Canvas: <https://motioncanvas.io/docs>
- A code-to-video workflow with Claude Opus 5.5 and its timings: <https://blog.laozhang.ai/en/posts/claude-opus-5-5-video-generation>
