# The library of explanatory animation grammars

29 in all: huashu-art-motion's 9 explainer grammars (A1 to A9, with measured parameters) + 20 explanation techniques researched online (B1 to B20). Each lists: the core technique, what it suits (machine learning / hardware / maths / physics / biomedicine / history and humanities), one practice to borrow directly, interactive or video only, real cases.

One animation uses one grammar; an explainer video may change grammar between segments, but never mixes them within one.

## Choose first: what is this concept doing

| The concept's shape | First choice | Alternatives | Examples |
| --- | --- | --- | --- |
| a mechanism turning step by step into something else | A1 3b1b | B20 maths visualization community | backpropagation, matrix multiplication, the Fourier transform, energy conversion in photosynthesis |
| scale, "what is inside" | A4 Kurzgesagt | B6 3D teardown | the GPU memory hierarchy, cell to molecule, cosmic scale, city to street |
| how a parameter affects the result, readers try it themselves | B1 explorable explanation | B3 interactive long read, B4 simulation sandbox | learning rate, quantization bits, interest rates, R₀, pendulum length |
| a chain of reasoning or causes | A6 whiteboard | B12 derivation on paper | proofs, physics derivations, causes of historical events |
| an algorithm or process step by step | B9 algorithm stepper | B5 coding adventure | convolution sliding window, sorting, branch divergence, DNA replication, administrative procedures |
| numbers, trends, comparisons | A3 financial chart | B11 data talk, B10 scrollytelling | energy comparisons, growth of model size, GDP, incidence |
| an invisible structure taken apart | B6 3D teardown | B17 medical animation | a GPU chip, a hard disk, the heart, an engine |
| an argument with real records, screenshots, quotations | A5 Vox | B10 scrollytelling | the text of papers, historical documents, news evidence |
| history in time and place | B16 map history | B7 history narrative | battles, trade routes, the spread of epidemics |
| lists, stages, key lines, chapters | A8 kinetic type | A2 product launch | "three reasons", "five stages" |
| what a model really computes inside | B15 model explainer | B13 Distill interactive article | CNN features per layer, Transformer attention, protein folding |
| a presenter leading the way, with feeling | A9 presenter | A7 story | the history of a field, scientists' stories |

---

## A. huashu-art-motion's 9 explainer grammars

Source: <https://github.com/alchaincyf/huashu-art-motion>, the animation grammar cards under `references/` and reference 09 on video animation grammar (each card has first-hand reference links and measured parameters).

### A1 3Blue1Brown: continuing by morphing
- **Core technique**: a pure black background holding only the one thing being explained; Transform turns the previous concept directly into the next; colour = the concept's name (unchanged throughout); easing almost always smooth (6t⁵−15t⁴+10t³); each animation 1 to 3 seconds followed by a 1-second pause; almost no cuts.
- **Suits**: ML: a neural network's forward pass, attention, gradient descent, matrix transformations. Hardware: matrix multiplication tiled down to Tensor Cores. Maths: linear transformations, Fourier series, probability distributions. Physics: superposition of waves, phase space. Biomedicine: enzyme rate curves morphing. History and humanities: rarely (no objects to morph).
- **Borrow**: make switches between presets morphs: a 28×28 pixel grid collapsing into a column of 784 input neurons; the W in the formula and the connections on screen in the same blue.
- **Form**: mainly video; the principle applies directly to interactive tweens.
- **Cases**: <https://www.youtube.com/@3blue1brown>; "But what is a neural network?" <https://www.youtube.com/watch?v=aircAruvnKk>; "Transformers, the tech behind LLMs" <https://www.youtube.com/watch?v=wjZofJX0v4M>; "But what is the Fourier Transform?" <https://www.youtube.com/watch?v=spUNpyF58BY>.

### A2 Product launch interface
- **Core technique**: a dark background with soft light spots, one thing per screen; text rising out of blur; interface in frosted-glass cards, settling with a light bounce; big numbers landing as the value is said.
- **Suits**: ML: announcing model specs (parameter count, context length). Hardware: chip specs (TOPS, power). Also "course goals" or "three things in this lesson" in any subject.
- **Borrow**: when a topic has only one key number, draw no chart: count up a big number that lands when the voice-over says it.
- **Form**: video.
- **Cases**: Apple events <https://www.apple.com/apple-events/>.

### A3 Financial chart (Economist style)
- **Core technique**: axes first, then the data grows, finally mark only one thing; bars from 0, truncated axes stated; source at the lower left; illustrative data gets a corner mark.
- **Suits**: ML: model size and error rate by year. Hardware: energy per operation (an addition vs a DRAM access), Moore's law. Physics: fitting experimental data. Biomedicine: incidence, dose-response curves. History and humanities: population, GDP, election results.
- **Borrow**: an energy comparison bar chart shows the log axis first (labelled "log"), the bars grow one by one, and finally only the DRAM bar is marked "×541".
- **Form**: video; the interactive version is a chart with draggable parameters.
- **Cases**: huashu `动画语法/t3_finance_chart.md`; Hans Rosling, "200 Countries, 200 Years, 4 Minutes" <https://www.youtube.com/watch?v=jbkSRLYSojo> (see also B11).

### A4 Kurzgesagt: flat popular science, travelling through scale
- **Core technique**: flat, no outlines, glowing colours; the camera pushes and pulls logarithmically between scales (the same zoom factor every frame); diving into an object to see the world inside; the picture always moving gently.
- **Suits**: ML: from a data centre to one GPU to one SM. Hardware: the memory hierarchy (distance and latency of registers, shared memory, L2, DRAM). Physics: cosmic scale, atomic structure. Biomedicine: body to cell to molecule, the immune system. History and humanities: rarely.
- **Borrow**: use one "dive in" for the memory hierarchy: from a top view of the chip push into one SM, then into the register file, pausing at each layer to mark capacity and latency.
- **Form**: video; the interactive version can zoom with the scroll wheel.
- **Cases**: <https://www.youtube.com/@kurzgesagt>.

### A5 Vox: collage on a research desk
- **Core technique**: the argument laid out on a desk of real material (screenshots, clippings, photos), the camera moving like an investigative reporter's eye; red lines connecting evidence; a highlighter sweep → a red circle → push in; elements stepping at 12fps, the camera smooth.
- **Suits**: ML: one concluding sentence or one table from a paper. Hardware: numbers from a vendor's white paper. History and humanities: archives, letters, newspapers. Biomedicine: clinical trial reports.
- **Borrow**: when a page of the slides or a paper comes up, put a screenshot of the original page on screen and have the highlighter box only the half-sentence the voice-over is reading.
- **Form**: video.
- **Cases**: <https://www.youtube.com/@Vox>.

### A6 Hand-drawn whiteboard (RSA Animate)
- **Core technique**: a sentence said, a sentence written, a hand drawing icons and arrows on a big whiteboard; the camera pans across the board following the argument and finally pulls back to see the whole picture; black lines plus one accent colour.
- **Suits**: ML: the causal chain of a training process. Maths: proofs. Physics: derivations. History and humanities: ideas, social causes. Biomedicine: chains of pathological mechanisms.
- **Borrow**: the summary animation at the end of a lesson: all topics written on one big board in the order taught, finally pulled back into one map.
- **Form**: video.
- **Cases**: RSA ANIMATE "Changing Education Paradigms" <https://www.youtube.com/watch?v=zDZFcDGpL4U>; Minute Physics <https://www.youtube.com/@minutephysics>.

### A7 Story with stick figures
- **Core technique**: the voice-over is the lead and the picture is like reaction images for it; poses cut fast in 0.1 seconds and then hold; jokes land by cutting to a reaction close-up and holding; seven tenths of the frames completely still.
- **Suits**: first-person segments in any subject such as "mistakes students often make" or "my first experiment going wrong".
- **Borrow**: for a common misconception (such as "zero training error means a good model"), a character first confident, then frozen on seeing the test error.
- **Form**: video.
- **Cases**: TheOdd1sOut <https://www.youtube.com/@theodd1sout>.

### A8 Kinetic type
- **Core technique**: the words are the actors, key words slam in on the stress, the main word big enough to read at a glance, one focus per screen; fast in, faster out.
- **Suits**: lists, stages, key lines, chapter cards and exam point summaries in any subject.
- **Borrow**: the first 5 seconds of each lesson slam in one line, "This lesson answers one question: …", as the hook of the whole explainer video.
- **Form**: video.
- **Cases**: huashu `动画语法/y5_kinetic_type.md`.

### A9 Presenter-style popular science
- **Core technique**: a presenter character links paper, charts and key words; layouts vary (presenting side-on, full-screen numbers, left-right comparison, stepping into the chart, reaction close-ups); numbers land as they are said.
- **Suits**: the history of a field or an industry (how the GPU went from a gaming card to an AI card), scientists' stories.
- **Borrow**: assign layouts in the storyboard first; do not fix "person left, chart right" for the whole film.
- **Form**: video (the character needs its own assets).
- **Cases**: huashu `动画语法/y6_presenter_explainer.md`.

---

## B. 20 explanation techniques researched online

### B1 Explorable explanation
- **Core technique**: the reader changes an assumption and sees the consequence at once; the author provides a guided path, not an empty sandbox; numbers in the text can themselves be dragged.
- **Suits**: ML: learning rate, regularization strength. Hardware: bit width and energy. Physics: pendulum length and period. Economics: tax rate and revenue. Biomedicine: vaccine coverage and herd immunity.
- **Borrow**: make the key numbers of the step-by-step explanation draggable inline numbers, with the animation following as they are dragged (a Tangle-style reactive document).
- **Form**: interactive.
- **Cases**: Bret Victor <http://worrydream.com/ExplorableExplanations/>; collection <https://explorabl.es/>; Nicky Case, "The Evolution of Trust" <https://ncase.me/trust/>, "Parable of the Polygons" <https://ncase.me/polygons/>.

### B2 Games and social simulations (Nicky Case style)
- **Core technique**: a small playable game first has readers choose by intuition, then reveals the rule; cute characters, minimal rules; each chapter adds one new rule.
- **Suits**: ML: reinforcement learning, multi-agent systems. History and humanities: cooperation and betrayal, how segregation forms. Biomedicine: the spread of infectious disease. Economics: markets.
- **Borrow**: "each chapter adds only one rule": split one animation into several presets, each adding only one mechanism (first no regularization, then L2, then more data).
- **Form**: interactive.
- **Cases**: <https://ncase.me/trust/>, <https://ncase.me/polygons/>.

### B3 Interactive long read (Bartosz Ciechanowski style)
- **Core technique**: one long article starting from the simplest model, the same 3D or 2D model recurring with only one more detail per section; every figure can be dragged and turned; text and figures match one to one.
- **Suits**: Hardware: how a GPU works, memory. Physics: mechanical watches, GPS, bicycle dynamics. Biomedicine: organs. ML: a network growing from one neuron to a layer.
- **Borrow**: one lesson uses the same animation skeleton throughout (for example the same grid going from pixels to convolution to pooling), instead of a new way of drawing for each topic.
- **Form**: interactive.
- **Cases**: "Mechanical Watch" <https://ciechanow.ski/mechanical-watch/>, "GPS" <https://ciechanow.ski/gps/>, "Bicycle" <https://ciechanow.ski/bicycle/>.

### B4 Simulation sandbox (PhET, Primer)
- **Core technique**: a full physics or biology simulation in which readers change parameters and watch group behaviour; Primer runs simulations with many small characters (blobs) and ends with statistical charts.
- **Suits**: Physics: circuits, waves, mechanics. Biomedicine: natural selection, populations. ML: genetic algorithms, the noise of stochastic gradients. History and humanities: migration models.
- **Borrow**: show SGD's randomness with many small balls starting at once from different sample orders, finally drawing the distribution of where they land.
- **Form**: interactive (PhET) and video (Primer).
- **Cases**: PhET <https://phet.colorado.edu/>; Primer <https://www.youtube.com/@PrimerBlobs>.

### B5 Coding adventure (Sebastian Lague style)
- **Core technique**: "I want to make X" → the naive way → see where it fails → improve step by step; every step has a running picture; failure and debugging are part of the story.
- **Suits**: ML: the whole road from linear regression to polynomials to regularization. Hardware: from scalar loops to vector instructions to GPUs. Physics: fluid simulation. Computer graphics, algorithms.
- **Borrow**: topics of the "why do we need X" kind first show the naive way failing (M=9 overfitting), then the improvement.
- **Form**: video.
- **Cases**: <https://www.youtube.com/@SebastianLague>; The Coding Train <https://www.youtube.com/@CodingTrain>.

### B6 3D teardown (Branch Education style)
- **Core technique**: a detailed 3D model taken apart layer by layer from outside in, the camera circling; each layer labelled with name and size; key parts zoomed to the microscopic.
- **Suits**: Hardware: GPU architecture, SSDs, CPU pipelines. Physics: engines, motors. Biomedicine: organs, virus structure. Engineering: bridges, buildings.
- **Borrow**: for the structure of an SM, peel from the whole GPU to an SM, then to the warp scheduler and register file, pausing at each layer to mark quantities (such as "64K 32-bit registers per SM").
- **Form**: video (the interactive version can be a rotatable exploded view).
- **Cases**: <https://www.youtube.com/@BranchEducation>; "How do Graphics Cards Work? Exploring GPU Architecture" <https://www.youtube.com/watch?v=h9Z4oGN89MU>.

### B7 History narrative animation (OverSimplified, Kings and Generals)
- **Core technique**: OverSimplified tells causes with stick figures and humorous narration; Kings and Generals advances battles day by day with maps and troop arrows. The timeline is always visible.
- **Suits**: History and humanities: wars, revolutions, dynasties. History of science: the development of a field (AI's winters). Hardware: industry history.
- **Borrow**: for historical topics such as "the hardware lottery", put an always-visible timeline at the bottom, with events landing on it by year.
- **Form**: video.
- **Cases**: <https://www.youtube.com/@OverSimplified>, <https://www.youtube.com/@KingsandGenerals>.

### B8 Hand-drawn repetition (StatQuest style)
- **Core technique**: simple hand drawings added step by step; the same picture recurs within a section, one element more each time; the presenter says "let us review" and runs through the whole logic again; intuition comes before each term.
- **Suits**: ML and statistics: cross-validation, regularization, gradient descent, decision trees. Biomedicine: statistical tests. Any formula derivation that needs repeated reinforcement.
- **Borrow**: end each topic's video by replaying the three steps on the same picture (a fast version) as the summary.
- **Form**: video.
- **Cases**: <https://www.youtube.com/@statquest>.

### B9 Algorithm stepper (VisuAlgo, Bostock)
- **Core technique**: every step of the algorithm has an explicit state; the current line of pseudocode is highlighted; previous step, next step, autoplay; every read and write of the data structure is drawn.
- **Suits**: ML: the convolution sliding window, layer-by-layer computation in backpropagation, k-means. Hardware: pipelines, branch divergence, cache replacement. Maths: the Euclidean algorithm. Biomedicine: DNA replication, protein synthesis. History and humanities: how a bill becomes law.
- **Borrow**: make branch divergence a stepper: one warp of 32 lanes, the if part and the else part running in series, lanes not taken greyed out, the pseudocode beside it highlighted in sync.
- **Form**: interactive.
- **Cases**: VisuAlgo <https://visualgo.net/en>; Mike Bostock, "Visualizing Algorithms" <https://bost.ocks.org/mike/algorithms/>; Red Blob Games, "A* pathfinding" <https://www.redblobgames.com/pathfinding/a-star/introduction.html>.

### B10 Scrollytelling
- **Core technique**: the figure is pinned on screen while text scrolls up, each paragraph triggering a state of the figure; readers set the pace by scrolling.
- **Suits**: ML: a decision tree splitting level by level. History and humanities: news features, long histories. Biomedicine: how a disease progresses. Data journalism.
- **Borrow**: this is exactly the structure "click a step of the explanation, the animation switches to a preset"; the timeline script's event table is scrollytelling's trigger table, and each can be converted into the other.
- **Form**: interactive (as a video, it triggers by time).
- **Cases**: R2D3, "A visual introduction to machine learning" <https://r2d3.us/visual-intro-to-machine-learning-part-1/>; The Pudding <https://pudding.cool/>; NYT, "Snow Fall" <https://www.nytimes.com/projects/2012/snow-fall/>.

### B11 Data talk (Hans Rosling style)
- **Core technique**: the presenter stands before an animated bubble chart playing by year, pointing at one dot and telling its story; one chart carries the whole argument.
- **Suits**: ML: models moving by year on a plane of accuracy and compute. History and humanities: national development, population. Biomedicine: life expectancy and income.
- **Borrow**: make "more precision costs more" a bubble chart: compute on the x-axis, error rate on the y-axis, a year slider playing, model dots appearing year by year.
- **Form**: works as video or interactive.
- **Cases**: a clip from the BBC's "The Joy of Stats" <https://www.youtube.com/watch?v=jbkSRLYSojo>.

### B12 Derivation on paper (Welch Labs, Steve Brunton)
- **Core technique**: handwritten derivations alternating with live footage or animation; Welch Labs mixes paper, real objects and animation and stresses "think for yourself first"; Brunton writes on a glass board as he talks.
- **Suits**: Maths: calculus and linear algebra derivations. ML: the chain rule of backpropagation. Physics: control theory. Engineering.
- **Borrow**: make solutions to hand calculations a derivation animation written line by line, pausing after each line, with key variables in the same colours as on screen.
- **Form**: video.
- **Cases**: Welch Labs <https://www.youtube.com/@WelchLabs>; Steve Brunton <https://www.youtube.com/@Eigensteve>.

### B13 Distill interactive article
- **Core technique**: paper-level rigour plus interactive figures; readers adjust parameters to see optimization paths, embeddings, features; the caption is the manual; the stress is on "distilling" research into an understandable form.
- **Suits**: ML: momentum, how to read t-SNE, feature visualization. Maths: optimization. Research methods.
- **Borrow**: under each interactive figure, one caption line "drag X to see Y"; the caption is the only instruction.
- **Form**: interactive.
- **Cases**: "Why Momentum Really Works" <https://distill.pub/2017/momentum/>; "How to Use t-SNE Effectively" <https://distill.pub/2016/misread-tsne/>; "Feature Visualization" <https://distill.pub/2017/feature-visualization/>.

### B14 Narrative animated shorts (TED-Ed)
- **Core technique**: open with a question, finish in 3 to 5 minutes of hand-drawn or flat animation; each film by a different animator in varied styles; end with a question to think about.
- **Suits**: introductory concepts in any subject: history and humanities, biomedicine, physics, philosophy.
- **Borrow**: open each explainer video with a concrete question ("Why can't a phone run a large model?") and end with a question that can be checked in the animation itself.
- **Form**: video.
- **Cases**: <https://www.youtube.com/@TEDEd>.

### B15 Model explainer (Polo Club Explainer, TF Playground)
- **Core technique**: a real small model runs in the browser; readers click any neuron or layer to see its intermediate results; everything from input to output is visible.
- **Suits**: ML: CNNs, Transformers, MLPs. Biomedicine: physiological models. Physics: circuit simulation.
- **Borrow**: in the convolution topic, clicking any output cell draws its 3×3 receptive field on the input and the element-wise multiply-add.
- **Form**: interactive.
- **Cases**: CNN Explainer <https://poloclub.github.io/cnn-explainer/>; Transformer Explainer <https://poloclub.github.io/transformer-explainer/>; TensorFlow Playground <https://playground.tensorflow.org/>.

### B16 Map history
- **Core technique**: the map is the stage; as time advances, borders, arrows and population dots change on it; scale and date always visible.
- **Suits**: History and humanities: wars, empires, trade, migration. Biomedicine: the spread of epidemics. ML: the geography of data centres and chip supply chains.
- **Borrow**: for the semiconductor supply chain (lithography machines, fabs, packaging), use a map with flow arrows.
- **Form**: video.
- **Cases**: Kings and Generals <https://www.youtube.com/@KingsandGenerals>; Asianometry (semiconductor industry history) <https://www.youtube.com/@Asianometry>.

### B17 Medical animation (Osmosis, Nucleus, Armando's hand drawings)
- **Core technique**: Osmosis explains pathology on a fast hand-drawn whiteboard; Nucleus shows surgery and drug action in realistic 3D; Armando Hasudungan covers a whole system on one page of coloured drawings. All stress accurate anatomical position and clear causal chains.
- **Suits**: Biomedicine: pathophysiology, pharmacology, anatomy. Also any "structure + function" topic (hardware's "structure + data flow" likewise).
- **Borrow**: on a structure diagram, one colour flowing shows the "flow" (blood flow, data flow), turning red where it is blocked, with a count.
- **Form**: video.
- **Cases**: Osmosis <https://www.youtube.com/@osmosis>; Nucleus Medical Media <https://www.youtube.com/@NucleusMedicalMedia>; Armando Hasudungan <https://www.youtube.com/@ArmandoHasudungan>.

### B18 Experiments plus animation (Veritasium, Steve Mould, AlphaPhoenix)
- **Core technique**: first ask viewers a counter-intuitive question and let them guess; then demonstrate with a real experiment; finally explain the invisible part with animation; AlphaPhoenix writes his own simulation code to compare with the experiment.
- **Suits**: Physics: counter-intuitive phenomena. Biomedicine: experimental design. ML: phenomena where intuition and results disagree (double descent, where more parameters bring lower test error).
- **Borrow**: "guess first, then watch": when the animation opens, have the student pick a prediction first (will α=0.15 converge or diverge?), then play.
- **Form**: video (the guessing part can be an interactive quiz).
- **Cases**: <https://www.youtube.com/@veritasium>; <https://www.youtube.com/@SteveMould>; <https://www.youtube.com/@AlphaPhoenixChannel>.

### B19 Real circuits plus whiteboard (Ben Eater, Computerphile)
- **Core technique**: Ben Eater builds an 8-bit computer on breadboards wire by wire, with an oscilloscope and LEDs showing signals; Computerphile explains by hand on printer paper. Physical signals one can see.
- **Suits**: Hardware: logic gates, clocks, buses, memory. Network protocols. Also any "physical process one can see".
- **Borrow**: for pipelines and clocks, a row of LED-like cells lighting up and going out on the clock beat, pausing at each beat.
- **Form**: video.
- **Cases**: <https://www.youtube.com/@BenEater>; <https://www.youtube.com/@Computerphile>.

### B20 Code animation communities (the manim community, Motion Canvas, Remotion)
- **Core technique**: explanation animations written as code: manim (Python, maths), Motion Canvas (TypeScript generator functions as the timeline, `waitUntil` on voice-over markers), Remotion (React, `useCurrentFrame()`, the same component embeddable in an interactive web page). In common: the picture is a function of time, reproducible and parameterizable.
- **Suits**: engineering explainer videos in any subject; especially maths, ML, algorithms.
- **Borrow**: Motion Canvas's idea of "time events": events in the script get names, and editing moves only the time points behind the names. Our timeline scripts anchoring on voice-over with `word` follow the same idea.
- **Form**: mainly video; Remotion Player is interactive.
- **Cases**: Manim Community <https://www.manim.community/>; Motion Canvas <https://motioncanvas.io/>; Remotion showcase <https://www.remotion.dev/showcase>; Reducible <https://www.youtube.com/@Reducible> (computer science with manim).

---

## Quick reference by subject

| Subject | Common concepts | Recommended grammars |
| --- | --- | --- |
| Machine learning | gradient descent, overfitting, regularization | A1, B1, B8, B13 |
| Machine learning | inside CNNs, Transformers | B15, A1 |
| Machine learning | quantization, pruning | A3 (bit width vs precision vs energy), B1 (drag the bit width to see the error) |
| Hardware | the GPU memory hierarchy | A4, B6 |
| Hardware | branch divergence, pipelines, SIMT | B9, B19 |
| Hardware | energy of moving data | A3, B11 |
| Maths | linear transformations, Fourier, proofs | A1, B12, A6 |
| Physics | mechanics, electromagnetism, waves | B4, B18, B3 |
| Biomedicine | pathological mechanisms, anatomy, pharmacology | B17, A4, B6 |
| Biomedicine | infectious disease, populations | B2, B4, B16 |
| History and humanities | battles, empires, trade | B16, B7 |
| History and humanities | ideas, causes, social mechanisms | A6, B2, A5 |
| Any subject | chapter openings, lists, summaries | A8, A2, B8 |
