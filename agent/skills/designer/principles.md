# General principles (when the project's DESIGN.md does not cover it)

In one sentence: the system font, two greys, a few type sizes and radii, one thing per line, fixed-width only for what machines read.

## Type

- Desktop and web tools default to the system font stack: `-apple-system, BlinkMacSystemFont, "PingFang SC", "Segoe UI", "Microsoft YaHei UI", "Noto Sans CJK SC", system-ui, sans-serif`. `"PingFang SC"` must be written out: `system-ui` picks the CJK font by the first CJK language among the system's preferred languages, so with Japanese first, Chinese turns into Hiragino glyphs.
- Five or six type sizes are enough: 13 body / 12 secondary / 11 key caps and small badges / 15 page names / 17 detail titles / 22 large titles. The macOS HIG text styles are 26, 22, 17, 15, 13, 12, 11, 10, with 13 as the default. Chinese text goes no smaller than 12px; 10 and 11 are for Latin text and digits only.
- Weights 400, 500 and 600 only. Chinese emphasis is 500 (PingFang stops at Semibold; 700 does nothing); 600 only for titles of 15px and up.
- Line height: controls and lists 1.5, Chinese body text 1.5 to 1.65, titles 1.35. The HIG's 13/16 is for Latin-only labels; copied onto Chinese body text it is cramped.
- `letter-spacing` is always 0 (SF Pro has optical tracking built in); do not turn small titles into letter-spaced capitals, and never italicize Chinese (browsers fake an oblique).
- Mixing Chinese and Latin text: `text-autospace:normal` everywhere (W3C clreq: at most a quarter of a Chinese character's width between Chinese and Latin text or digits; supported since Safari 18.4, off by default in WebKit, so it must be written out), and `font-kerning:normal`. Number columns use `font-variant-numeric:tabular-nums`.
- `-webkit-font-smoothing:antialiased`: since macOS 10.14 the system turned subpixel antialiasing off while browsers still use it by default; only with this does text look as thin as native text.

## The fixed-width allow-list

Allowed: shell commands and their output, code blocks and inline code, diffs, commit hashes, key input fields.
Not allowed: folder names and path labels, project names, ids, times, avatar letters, counts, priorities, any label meant for people. A path shown to people is "file name 13px main colour + parent folder 12px secondary colour", with long paths cut in the middle. Evidence: Finder, VS Code and Raycast all show paths in proportional grey text.

## Colour

- Surfaces in 2 or 3 levels, text in 2, lines in 2, fills in 2, and one solid primary button colour (at most one per screen). Radix Colors' 12 steps map onto this: 1 to 2 backgrounds, 3 to 5 control fills, 6 to 8 borders, 9 solid, 11 to 12 text.
- Selection is a neutral grey, not the brand colour. List rows get no hover highlight and no `cursor:pointer`.
- Semantic colours go only into tags, dots and icons, and only for states: blue unread and links, green running and done, orange waiting for a confirmation and high priority, red blocked and errors. Default states show no tag (no tag for the default priority or "in progress"); a screen should have a single-digit number of coloured tags.
- Identity colours (people, projects, agents) appear only on avatars, with saturation kept at tag level so they do not compete with state colours.
- No hard-coded hex: everything goes through variables, and dark mode follows the variables by itself.

## Sizes

- Spacing in multiples of 4: 4, 8, 12, 16, 24, 32. Icon to title 12, title to subtitle 8, between accessories 10.
- Four radii: 5 tags and key caps / 6 buttons, menus, inputs / 8 list rows and cards / 12 popovers and dialogs. `999px` only for dots and badges.
- List rows 40 (34 when compact), page headers 56, footers 40, controls at least 28×28 (HIG); 12 around elements with borders, 24 around those without.
- One icon set: 16px, 1.5 stroke, round-capped lines; 16 in rows, 14 in chips, the 20 slot only for avatars; secondary colour, the main colour only in the selected row. States use 6 to 8px dots, not solid circles with ticks.

## List rows

`[icon or avatar 20] 12 [title 13/500, at most 60%] 8 [subtitle 13/400 secondary, one line, cut off] … [accessories ≤3, 12px secondary] [time 12px tabular-nums, fixed width, right-aligned]`
Accessory priority: a non-default state > a number > ownership; with a detail pane open on the right, drop one more and move the information into the detail (Raycast's List API rule). The subtitle is the latest sentence for people to read, not bookkeeping (ids, logs, durations go into the detail). Group headings 12px 500 secondary, with no background or border.

## Empty states

One 32px icon (thin stroke, 60% opacity), a title 13/500, one 12px secondary sentence of at most 46ch, at most one button. Never two heroes on one page.

## Input boxes (chat-like)

The box uses the surface colour, radius 12, a 1px hairline and a faint shadow, as wide as the content. Chips in the tool row are all 24 high, radius 6, 12px, icons 14; main colour when set, secondary when not; grouped by "where / how", at most 6. The status line under the box is 12px secondary; its state words are always fully visible, and names shrink first. Chips and the status line are not fixed-width.

## Common don'ts

Several entry points for one feature; boxes inside boxes, heavy borders, white pill backgrounds; full-screen overlays covering content; jumping, flashing, stalling, cut-off or overlapping things; long plain text or raw Markdown; showing internal bookkeeping and ids; a "redesign" that only changes colours; changing things nobody asked about on the side.

## Sources

- Apple HIG Typography (text styles and tracking table): https://developer.apple.com/design/human-interface-guidelines/typography
- Apple HIG Accessibility (28pt controls, spacing, 4.5:1 contrast): https://developer.apple.com/design/human-interface-guidelines/accessibility
- W3C clreq on spacing between Chinese and Latin text: https://www.w3.org/TR/clreq/ ; text-autospace: https://webkit.org/blog/16574/webkit-features-in-safari-18-4/
- system-ui picking the wrong CJK font: https://bugzilla.mozilla.org/show_bug.cgi?id=1418724
- PingFang weights: https://chinesemac.org/pages/osx11.html ; Ant Design's type guideline: https://ant.design/docs/spec/font-cn/
- font-smoothing: https://dbushell.com/2024/11/05/webkit-font-smoothing/
- Radix Colors' 12 steps: https://www.radix-ui.com/colors/docs/palette-composition/understanding-the-scale
- Raycast List API: https://developers.raycast.com/api-reference/user-interface/list
- Linear's 2026 refresh (fewer icons, warm greys, fewer dividers): https://linear.app/now/behind-the-latest-design-refresh
- Anthropic frontend-design's anti-pattern list: https://github.com/anthropics/skills/tree/main/skills/frontend-design

## The person's taste

What the person said they like and dislike is in the preference library: `dispatch prefs list --area design --json` (visible in Dispatch's Settings › Knowledge › Preferences; agents record it on the spot when the person says something is good or bad, with their words and evidence). Before reviewing any project, read all design preferences. When a preference conflicts with the project's `DESIGN.md`, `DESIGN.md` wins, but point the conflict out.
