# Detection tools (none installed; ask the person before installing)

| Tool | What it gives | How to run |
|---|---|---|
| impeccable (pbakaus) | `detect` uses no AI: 61 deterministic rules scan a folder / HTML / URL for an "AI look" (side colour bars, purple gradients, cards in cards, glows, bouncy easing), with JSON output for CI; `normalize` tidies scattered type sizes and radii; `audit`, `polish`, `typeset` and `quieter` are the matching design actions | `npx impeccable detect <folder or URL> --json`; install: `npx impeccable install` or `/plugin marketplace add pbakaus/impeccable` |
| Vercel web-design-guidelines | reviews code against an interface guideline (interaction, motion, layout, content, forms, performance, design, wording), reporting file:line; put its AGENTS.md in the repository and Codex follows it while writing code | `npx skills add vercel-labs/agent-skills --skill web-design-guidelines` |
| emilkowalski/skills | apple-design, review-animations, improve-animations: choosing easing, durations, shadows and borders | `npx skills@latest add emilkowalski/skills` |
| ibelick/ui-skills | fixing-accessibility (focus, ARIA, contrast), fixing-motion-performance | `npx skills add ibelick/ui-skills` |
| axe-core + @axe-core/playwright | automatic assertions on contrast, focus and ARIA, in desktop app webviews and web pages | `npm i -D @axe-core/playwright`, then `new AxeBuilder({ page }).analyze()` in a playwright script |
| Anthropic frontend-design | the upstream SKILL.md has a full list of anti-patterns (rows of rounded shadowed cards, letter-spaced uppercase small titles, "A · B · C" metadata strings, fixed-width data labels, arrows after links) | read the upstream original https://github.com/anthropics/skills/tree/main/skills/frontend-design |

Not recommended: ui-ux-pro-max (a generic style library; noise for a product with its own design language), taste-skill (leans to landing pages). Figma Design Lint is no use when the project does not use Figma.

References for people: Apple HIG (Typography, Layout, Lists and tables, Sidebars, Materials), Radix Colors, Linear's long post on its redesign, interfaces.rauno.me, Refactoring UI.
