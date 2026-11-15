# Templates

Field names in the templates are suggestions; when the project has its own fields, follow the project. The examples come from different subjects; they work in any subject.

## 1. Learning script: first time, one step per screen

Five kinds of screen, each doing only one thing:

| type | Purpose | What it holds | Rules |
| --- | --- | --- | --- |
| `ask` | pose a question, guess first | one question + 2 to 4 clickable guesses + the screen that reveals it | answerable in 30 seconds; not revealed on the spot |
| `show` | explain + look | at most 3 sentences + one figure or one animation state | one focus; only one reading highlighted; formulas appear only here |
| `try` | hands on | one sentence of task: "guess first … then drag to …" | better when it can read the state to judge whether it was done |
| `check` | one question to confirm | refers to one quiz question or calculation step | once every 3 to 4 screens; a wrong answer gets an explanation, nobody is blocked |
| `bridge` | landing and exit | a one-sentence summary + one blank in the exam's language + the next topic's opening question | the last screen of the lesson |

Length: high priority 6 to 10 screens, medium 4 to 6, low none (straight to the reference page).

How to write the screen-by-screen table (used for both reviews and planning):

| Screen | What this screen says (the words) | What to look at | What the student does | How it leads on |
| --- | --- | --- | --- | --- |

**Example one (maths, the chain rule, excerpt)**

| Screen | Says | Looks at | Does | Leads on |
| --- | --- | --- | --- | --- |
| 1 ask | A balloon's radius grows by 2 cm a second. At the moment the radius is 10 cm, how fast does its volume grow? | a growing balloon, marked r = 10 | guess: about 80 / about 2,500 / about 25,000 cubic cm a second | not revealed |
| 2 show | Volume follows the radius, the radius follows time. Joining the two changes means multiplying the two rates. | two gears: t turns r, r turns V | nothing | "What is V's rate of change with r?" |
| 3 try | V = 4/3·πr³; for each small change in r, V changes by 4πr² as much. What is it at r = 10? | a radius slider reading dV/dr | drag to r = 10, read about 1,257 | "Now multiply by dr/dt = 2." |
| 4 show | 1,257 × 2 ≈ 2,513 cubic cm a second. That is the chain rule: dV/dt = dV/dr · dr/dt. | the formula's three parts in colours matching the gears | nothing | one question to confirm |
| 5 check | And at a radius of 5 cm? | | fill in a number (about 628) | "Two gears are done; what about three?" |

**Example two (medicine, a drug's half-life, excerpt)**

| Screen | Says | Looks at | Does | Leads on |
| --- | --- | --- | --- | --- |
| 1 ask | A drug's half-life is 6 hours. 400 mg taken at 8 in the morning: how much is left at 8 the next morning? | a timeline | guess: 0 / 25 mg / 100 mg / 200 mg | not revealed |
| 2 try | Every 6 hours half is left. Drag the timeline and watch the dose change. | a dose bar halving over time | drag to 24 hours, read 25 mg | "Why not 400 − 4 × 100 = 0?" |
| 3 show | Because each time what goes is "half of what is left", not a fixed 100 mg. 24 hours are 4 half-lives: 400 × (1/2)⁴ = 25. | halving and fixed-amount curves side by side | nothing | a common mistake and one question |

**Example three (humanities, weighing sources, excerpt)**

| Screen | Says | Looks at | Does | Leads on |
| --- | --- | --- | --- | --- |
| 1 ask | Two documents describe the same meeting in July 1914: the minutes taken that day, and a memoir written twenty years later. They disagree. Which do you trust first? | excerpts of both side by side | pick: the minutes / the memoir / neither | not revealed |
| 2 show | Trust first the one closer to the event with the simpler purpose. The memoir was written after the war by an author defending himself. | author, date and purpose of both in three columns | nothing | "But are minutes always reliable?" |
| 3 check | What might the minutes leave out? | four options | pick | "That is the difference between primary and secondary sources; next lesson we use it to read a paper." |

## 2. Reference page: looking things up after learning

Four parts following the learning process; blocks fold into one heading line by default:

| Part | Block | High | Medium | Low |
| --- | --- | --- | --- | --- |
| Activate | on this page you only need to know (1 to 3 items), how it is examined, time | yes | yes | yes |
| | new symbols on this page (how to read, meaning, a real number) | when there are new symbols | same | same |
| Build | why (picking up the last page's question, then one sentence of focus) | 2 paragraphs | 1 paragraph | 1 paragraph |
| | analogy (mapping, where it breaks, what it leads to) | yes | yes | one sentence |
| | running example (real numbers) | yes | short | no |
| | step-by-step explanation ⇄ animation | 4 to 6 steps | 2 to 3 steps | no |
| Retrieve | common mistakes | 2 to 4 | 1 to 2 | no |
| | quiz | 3 questions | 3 questions | ≤ 1 question |
| | graded calculation questions | 4 levels | ≤ 1 | no |
| | compared with the original | yes | yes | key places |
| Transfer and review | one-sentence summary | yes | yes | yes |
| | exam language: skeleton → model answer → write your own | 2 to 3 questions | ≤ 1 | terms |
| | Feynman (explain + write) | yes | no | no |
| | review cards | 3 | 1 | no |
| | links before and after | yes | yes | yes |

## 3. Quizzes

```js
{ type: 'choice', why: true,
  q: 'Why …?',
  options: ['real misconception 1', 'the correct answer', 'real misconception 2', 'real misconception 3'],
  answer: 1,
  explain: 'One or two sentences: why the right one is right.',
  whyWrong: ['Misconception 1 is wrong because …', '', 'Misconception 2 is wrong because …', 'Misconception 3 is wrong because …'] }
```

- Kinds: "why" (causes, trade-offs), "which" (telling two close concepts apart), "what happens if" (change one condition, how does the result change), fill in one number (one step only).
- Distractors come from three places: common mistakes, students' real questions, frequent errors in marking. No options ruled out at a glance, no "all of the above".
- Examples:
  - Maths: "Differentiating f(x) = (3x + 1)², why is it not 2(3x + 1)?" Distractors: "because the square turns into a cube", "because the constant 1 must be differentiated too"; correct: "the inner part 3x + 1 changes too, so multiply by its derivative 3".
  - Medicine: "After blood loss a patient's heart rate rises; the most direct reason?" Distractors: "heart muscle damage", "a raised temperature"; correct: "blood pressure falls and baroreceptors trigger the sympathetic nerves".
  - Humanities: "Why is the narrator of The Great Gatsby called unreliable?" Distractors: "he is a fictional character", "he speaks in the first person"; correct: "he admits he favours Gatsby, and knows key events only by hearsay".

## 4. Short answers in the exam's language: a skeleton per command word

| Command word | Full-mark structure | Skeleton |
| --- | --- | --- |
| Define | one sentence of definition + one example | `___ is ___. For example, ___.` |
| Explain / Describe | mechanism → cause → one number → consequence | `___ works by ___. This is because ___. For example, ___. Therefore ___.` |
| Compare / Discuss and compare | dimension by dimension as the question names them, one set of numbers each, one sentence of conclusion | `In terms of ___, A ___ whereas B ___. In terms of ___, ___. Overall, ___.` |
| Sketch | axis names and units, shape, key points labelled, one sentence of explanation | `x-axis: ___, y-axis: ___. The ___ curve ___, with its minimum at ___.` |
| Compute / Estimate | formula → substitution → result with units → one sentence of meaning | `___ = ___ = ___ (unit), which means ___.` |
| Evaluate / Assess (humanities) | claim → evidence → counter-argument → conclusion | `The claim that ___ is largely ___ because ___. However, ___. On balance, ___.` |

Every high-priority question has all five parts:

```js
{ q: 'the question (phrased like the sample exam)', pts: 4, kind: 'compare',
  frame: 'the skeleton, blanks written ___',
  a: 'a full-mark model answer (about 1 mark per minute of writing)',
  points: ['one marking point each', '…'],
  weak: { a: 'a typical low-mark answer', why: 'why it lost marks: only a conclusion, no numbers, missed a dimension the question named', score: '1/4' } }
```

Three levels on the page: fill in the skeleton → write once after reading the model answer → write on a blank page; each level can be marked.

## 5. Feynman follow-ups

The beginner's follow-ups come a few times by difficulty: two fixed questions plus one misconception:

1. "Can you give a real example? Ideally with numbers."
2. "How would you explain it to someone who has never learned it?"
3. A misconception (pick one from the common mistakes, say it in a beginner's voice, see whether the student can correct it):
   - Maths: "So the derivative is the slope divided by x, right?"
   - Medicine: "The half-life is 6 hours, so after 12 hours it is all gone, right?"
   - Humanities: "The memoir was written by someone who was there, so it is the most reliable, right?"
   - Machine learning: "The gradient is negative, so make the parameter smaller, right?"
4. For harder topics add: "Why does this step hold?", "How is it different from ___?", "What happens if the parameter is too big or too small?", "Here are two easy numbers; can you calculate it?"

Afterwards: write 3 sentences in the exam's language and mark them against the marking points; points not covered become review cards.

## 6. Common mistakes

```js
{ wrong: 'You might think …', right: 'In fact …', tell: 'Tell at a glance: …' }
```

Examples:
- Medicine: You might think high blood pressure means the heart is working harder. In fact it can also be narrower vessels and higher resistance. Tell at a glance: see whether cardiac output or peripheral resistance changed.
- Maths: You might think (a + b)² = a² + b². In fact 2ab is missing. Tell at a glance: try a = b = 1; the left side is 4, the right side 2.
- Humanities: You might think "the Renaissance" was an event in one year. In fact it was a process across two or three centuries. Tell at a glance: ask "from which year to which year"; when no single year answers, it is a process.

## 7. Choosing figures

| What it explains | Which figure | Examples |
| --- | --- | --- |
| what something looks like, what it is made of | structure diagram + a zoomed detail + labels | a cell's structure; an image's pixel grid; a poem's metre |
| the steps of a process | flow chart, one verb per box, what passes written on the arrows | a training loop; filtration, reabsorption and secretion in the nephron; the legislative process |
| how one quantity changes with another | a curve; draggable parameters as small multiples (3 to 4 values side by side) | learning rate and convergence; drug concentration over time; supply and demand |
| a trade-off between two forces | two curves + three regions marked | training and test error; the therapeutic window (effective and toxic concentrations) |
| order and overlap in time | Gantt chart or timeline | multiprocessor scheduling; the July Crisis day by day; a clinical course |
| data flow and cost | a layered diagram spread by distance, each layer marked with its cost | the memory hierarchy and energy; a supply chain; nerve signal conduction |
| comparing two methods or concepts | a comparison table, rows being the dimensions the question names | two algorithms; two diagnostic methods; two schools of history |
| the structure of a formula | the formula in colours, each part the same colour as in the figure | the chain rule; Henderson-Hasselbalch; Bayes' theorem |
| symbols and units | a symbol card: a ladder of prefixes, easily confused units side by side, a real number in each cell | 10⁹ and 2³⁰; mmHg and kPa; calendar eras |
| the structure of a whole lesson | a concept map with relations written on the edges | each lesson's summary; links blanked out in review |

When to animate: when the point is "one quantity changes and another follows", and that process of change is itself the topic. When not to: static structure, pure numeric comparison, diagrams with made-up proportions; static figures are clearer for these and faster to review.

## 8. TEACHING.md template (in the project root)

Write concrete values, not adjectives. At most 10 lines per section.

```markdown
# <course or project> teaching standard

One sentence: for whom, about what, with what goal (for example: students starting from zero passing a 90-minute closed-book written exam).

## Students
Where they start (what they can and cannot do), the language of teaching, the language of the exam, what they fear, what kind of explanation they like (in the students' words).

## Exam
Format, duration, how marks are split, question types and command words, where sample questions are, what may be brought.

## Levels
How many levels, the share of each, how much to write for each, where the evidence comes from (sample questions, the syllabus, assignments).

## Explaining
How to choose the running example; which scene analogies use; what comes before what; the length of learning mode and reference pages.

## Terms and formulas
How a term is written the first time (for example: explained in one language with the original term in brackets); formula typesetting; which original is authoritative; how estimates and extra material are marked.

## Plain words
Phrases and fixed patterns this course especially avoids; length limits.

## Known sticking points
Common sticking points drawn from question records, and how to write to prevent them.

## Grounds
Links to outside material and research.
```
