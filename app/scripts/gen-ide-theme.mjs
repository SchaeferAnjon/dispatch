// Dispatch IDE's colour themes, generated from Dispatch's own tokens (design/douyin-inspiration 5A.2,
// DESIGN.md「颜色」: "Dispatch IDE 的配色主题从这份 token 生成，不单独维护").
//
// Reads the custom properties of app/src/styles.css: the `:root{…}` blocks before the first @media
// are the light values, `:root[data-theme="dark"]{…}` overrides them for dark. Writes
//   app/ide-ext/themes/dispatch-light.json   VS Code color theme "Dispatch Light" (uiTheme vs)
//   app/ide-ext/themes/dispatch-dark.json    VS Code color theme "Dispatch Dark"  (uiTheme vs-dark)
//   app/ide-ext/themes/ide-defaults.json     the IDE settings the bridge writes on first start (fonts from --mono)
// Colours come out as #rrggbb / #rrggbbaa: oklch() is converted to sRGB (clamped to the gamut),
// rgba() keeps its alpha, color-mix(in oklch, X p%, transparent) is X at alpha p.
//
// Usage: node app/scripts/gen-ide-theme.mjs [--check]   (--check: exit 1 when the files on disk are stale)
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
export const APP = path.resolve(here, "..");
export const CSS = path.join(APP, "src", "styles.css");
export const OUT = path.join(APP, "ide-ext", "themes");

// ---- reading the tokens ------------------------------------------------------------------------

/** The bodies of every `<selector>{…}` block at the top level of the file whose selector matches. */
function blocks(css, selector) {
  const out = [];
  let i = 0;
  while ((i = css.indexOf(selector + "{", i)) !== -1) {
    const start = i + selector.length + 1;
    let depth = 1, j = start;
    for (; j < css.length && depth; j++) depth += css[j] === "{" ? 1 : css[j] === "}" ? -1 : 0;
    out.push({ at: i, body: css.slice(start, j - 1) });
    i = j;
  }
  return out;
}

function props(body, into = {}) {
  const clean = body.replace(/\/\*[\s\S]*?\*\//g, "");
  for (const m of clean.matchAll(/--([\w-]+)\s*:\s*([^;]+?)\s*(?:;|$)/g)) into[m[1]] = m[2].trim();
  return into;
}

/** {light, dark}: raw token values (strings) as styles.css writes them. */
export function readTokens(css) {
  const media = css.indexOf("@media");
  const light = {};
  for (const b of blocks(css, ":root")) if (media === -1 || b.at < media) props(b.body, light);
  const darkBlock = blocks(css, ':root[data-theme="dark"]')[0];
  if (!darkBlock) throw new Error('styles.css has no :root[data-theme="dark"] block');
  const dark = props(darkBlock.body, { ...light });
  return { light, dark };
}

// ---- colour maths ------------------------------------------------------------------------------

const clamp01 = (x) => Math.min(1, Math.max(0, x));
const gammaEncode = (c) => (c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055);

/** oklch → sRGB 0..1 (Björn Ottosson's matrices), clamped per channel. */
export function oklchToRgb(L, C, h) {
  const a = C * Math.cos((h * Math.PI) / 180), b = C * Math.sin((h * Math.PI) / 180);
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ].map((c) => clamp01(gammaEncode(c)));
}

const hex2 = (x) => Math.round(clamp01(x) * 255).toString(16).padStart(2, "0");
/** [r,g,b] 0..1 and alpha → #rrggbb (alpha 1) or #rrggbbaa. */
export const toHex = ([r, g, b], alpha = 1) => "#" + hex2(r) + hex2(g) + hex2(b) + (alpha >= 1 ? "" : hex2(alpha));

/** One CSS colour value → {rgb, alpha}; `vars` resolves var(--x). */
export function parseColor(value, vars, seen = new Set()) {
  const v = value.trim();
  let m;
  if ((m = v.match(/^var\(--([\w-]+)\)$/))) {
    if (seen.has(m[1]) || !(m[1] in vars)) throw new Error(`cannot resolve --${m[1]}`);
    return parseColor(vars[m[1]], vars, new Set([...seen, m[1]]));
  }
  if ((m = v.match(/^#([0-9a-f]{3,8})$/i))) {
    let h = m[1];
    if (h.length <= 4) h = [...h].map((c) => c + c).join("");
    const n = (i) => parseInt(h.slice(i, i + 2), 16) / 255;
    return { rgb: [n(0), n(2), n(4)], alpha: h.length === 8 ? n(6) : 1 };
  }
  if ((m = v.match(/^oklch\(\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)\s*\)$/))) return { rgb: oklchToRgb(+m[1], +m[2], +m[3]), alpha: 1 };
  if ((m = v.match(/^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/))) {
    return { rgb: [+m[1] / 255, +m[2] / 255, +m[3] / 255], alpha: m[4] === undefined ? 1 : +m[4] };
  }
  // color-mix(in <space>, X p%, transparent): X at alpha p (interpolating with transparent keeps the hue)
  if ((m = v.match(/^color-mix\(in \w+\s*,\s*(.+?)\s+([\d.]+)%\s*,\s*transparent\s*\)$/))) {
    const c = parseColor(m[1], vars, seen);
    return { rgb: c.rgb, alpha: c.alpha * (+m[2] / 100) };
  }
  throw new Error(`unsupported colour: ${v}`);
}

// ---- the mapping -------------------------------------------------------------------------------
// A value is "token", "token@P" (the token at P% opacity), "#rrggbb[aa]" (a literal), or
// "light|dark" when the two themes differ. CLEAR is a transparent colour.
const CLEAR = "#00000000";

/** The table in 5A.2, key by key. Tests check that every key here ends up in both themes. */
export const TABLE = {
  // --bg: the editor and what floats on it
  "editor.background": "bg", "editorGutter.background": "bg", "tab.activeBackground": "bg", "editorWidget.background": "bg",
  // --bg-2: the shell around the editor
  "sideBar.background": "bg-2", "activityBar.background": "bg-2", "titleBar.activeBackground": "bg-2", "statusBar.background": "bg-2",
  "editorGroupHeader.tabsBackground": "bg-2", "panel.background": "bg-2", "tab.inactiveBackground": "bg-2",
  // --sel: selected rows
  "list.activeSelectionBackground": "sel", "list.inactiveSelectionBackground": "sel",
  // editor.selectionBackground: the table says --sel, but --sel on --bg is 3% apart in light and nearly
  // invisible for selected text. It takes styles.css's ::selection instead (--fill 30%, the same as --ring).
  "editor.selectionBackground": "ring",
  "list.hoverBackground": "sel@60", "toolbar.hoverBackground": "sel@60",
  // --text / --text-2
  "foreground": "text", "editor.foreground": "text", "sideBar.foreground": "text", "activityBar.foreground": "text", "tab.activeForeground": "text",
  "descriptionForeground": "text-2", "tab.inactiveForeground": "text-2", "activityBar.inactiveForeground": "text-2",
  "editorLineNumber.foreground": "text-2", "sideBarSectionHeader.foreground": "text-2",
  // --hair: no lines between the panes, like the main app (the faces differ by --bg / --bg-2)
  "sideBar.border": CLEAR, "panel.border": CLEAR, "widget.border": CLEAR, "editorGroup.border": CLEAR,
  "titleBar.border": CLEAR, "statusBar.border": CLEAR, "activityBar.border": CLEAR,
  // inputs: --chip-2 for inputs and dropdowns, --bg-2 for the quick input (it floats, like a popover)
  "input.background": "chip-2", "dropdown.background": "chip-2", "quickInput.background": "bg-2",
  "input.border": "hair-2", "focusBorder": "ring",
  // the one filled button, the quiet one, badges
  "button.background": "fill", "button.foreground": "fill-text",
  "button.secondaryBackground": "chip", "badge.background": "blue", "activityBarBadge.background": "blue",
  "terminal.background": "term-bg",
  "gitDecoration.addedResourceForeground": "green", "gitDecoration.modifiedResourceForeground": "orange",
  "gitDecoration.deletedResourceForeground": "red", "gitDecoration.untrackedResourceForeground": "green",
  "editorError.foreground": "red", "editorWarning.foreground": "orange", "editorInfo.foreground": "blue",
  "diffEditor.insertedTextBackground": "green@12", "diffEditor.removedTextBackground": "red@12",
};

/** Keys the table does not name, each on the nearest token (the reason where it is not obvious). */
export const EXTRA = {
  // editor
  "editorCursor.foreground": "text",
  "editor.lineHighlightBackground": "chip-2", // the input ground: a band just visible on --bg
  "editor.lineHighlightBorder": CLEAR,
  "editor.inactiveSelectionBackground": "fill@15", // half of the active selection
  "editor.selectionHighlightBackground": "sel@60", // same word elsewhere: the hover ground
  "editor.wordHighlightBackground": "sel@60", "editor.wordHighlightStrongBackground": "sel",
  "editor.findMatchBackground": "orange@40", "editor.findMatchHighlightBackground": "orange@20", // search hits: the status colour for "look here"
  "editorLineNumber.activeForeground": "text",
  "editorIndentGuide.background1": "hair", "editorIndentGuide.activeBackground1": "text-2@40",
  "editorWhitespace.foreground": "hair",
  "editorBracketMatch.background": "sel", "editorBracketMatch.border": CLEAR,
  "editorOverviewRuler.border": CLEAR,
  "editorRuler.foreground": "hair",
  "editorStickyScroll.background": "bg", "editorStickyScrollHover.background": "sel@60",
  "breadcrumb.background": "bg", "breadcrumb.foreground": "text-2", "breadcrumb.focusForeground": "text", "breadcrumb.activeSelectionForeground": "text",
  "minimap.background": "bg",
  "editorGutter.addedBackground": "green", "editorGutter.modifiedBackground": "orange", "editorGutter.deletedBackground": "red",
  "diffEditor.insertedLineBackground": "green@6", "diffEditor.removedLineBackground": "red@6",
  "diffEditor.border": CLEAR, "diffEditor.diagonalFill": "hair",
  // widgets that float over the editor (find, suggest, hover): the popover ground and the card outline
  "editorWidget.foreground": "text", "editorWidget.border": "hair",
  "editorSuggestWidget.background": "bg-2", "editorSuggestWidget.border": "hair", "editorSuggestWidget.foreground": "text",
  "editorSuggestWidget.selectedBackground": "sel", "editorSuggestWidget.highlightForeground": "blue",
  "editorHoverWidget.background": "bg-2", "editorHoverWidget.border": "hair",
  "widget.shadow": "#0000001a|#00000073", // --shadow-diffuse's first layer (.10 light, .45 dark)
  "scrollbar.shadow": CLEAR,
  // Agents window (designer review 2026-09-27): the user's bubble is --msg-bg, the folder / harness chips
  // are outlined in --hair-2, the Agents cards and the docked panel in --hair, inline code on --chip
  "chat.requestBubbleBackground": "msg-bg", "chat.requestBubbleHoverBackground": "msg-bg",
  "commandCenter.inactiveBorder": "hair-2", "agentsPanel.border": "hair", "textPreformat.background": "chip",
  // Code - OSS 1.139's modern layout floats the panes as cards: DESIGN.md 卡片 outline (--hair 50%), not foreground 15%
  "surface.border": "hair@50", "editor.border": "hair@50", "modernPanel.border": "hair@50", "modernActivityBar.border": "hair@50",
  // tabs: the active one is the editor's own ground, no borders or top line
  "tab.border": CLEAR, "tab.activeBorder": CLEAR, "tab.activeBorderTop": CLEAR, "tab.unfocusedActiveBorderTop": CLEAR,
  "tab.hoverBackground": "sel@60", "tab.unfocusedActiveBackground": "bg", "tab.unfocusedActiveForeground": "text",
  "tab.unfocusedInactiveBackground": "bg-2", "tab.unfocusedInactiveForeground": "text-2", "tab.unfocusedHoverBackground": "sel@60",
  "editorGroupHeader.tabsBorder": CLEAR, "editorGroupHeader.border": CLEAR, "editorGroupHeader.noTabsBackground": "bg-2",
  // side bar, activity bar (the rail: --sel under the chosen icon, no bar at its edge), panel
  "sideBarTitle.foreground": "text-2", "sideBarSectionHeader.background": "bg-2", "sideBarSectionHeader.border": CLEAR,
  "activityBar.activeBackground": "sel", "activityBar.activeBorder": CLEAR, "activityBar.activeFocusBorder": CLEAR,
  "activityBarBadge.foreground": "#ffffff", "badge.foreground": "#ffffff",
  "panelTitle.activeForeground": "text", "panelTitle.inactiveForeground": "text-2", "panelTitle.activeBorder": "text",
  "panelSectionHeader.background": "bg-2", "panelSection.border": CLEAR,
  "tree.indentGuidesStroke": "hair", "tree.inactiveIndentGuidesStroke": "hair@50",
  "sash.hoverBorder": "text-2@40",
  // lists
  "list.activeSelectionForeground": "text", "list.inactiveSelectionForeground": "text", "list.hoverForeground": "text",
  "list.focusBackground": "sel", "list.focusForeground": "text", "list.focusOutline": CLEAR, "list.inactiveFocusOutline": CLEAR,
  "list.focusAndSelectionOutline": CLEAR, "list.highlightForeground": "blue", "list.dropBackground": "sel",
  "list.errorForeground": "red", "list.warningForeground": "orange",
  // title bar, status bar: page-name grey on the shell ground
  "titleBar.activeForeground": "text-2", "titleBar.inactiveBackground": "bg-2", "titleBar.inactiveForeground": "text-2@60",
  "statusBar.foreground": "text-2", "statusBar.noFolderBackground": "bg-2", "statusBar.noFolderForeground": "text-2",
  "statusBar.debuggingBackground": "bg-2", "statusBar.debuggingForeground": "orange", "statusBar.debuggingBorder": CLEAR,
  "statusBar.focusBorder": CLEAR, "statusBarItem.hoverBackground": "sel@60", "statusBarItem.activeBackground": "sel",
  "statusBarItem.remoteBackground": "bg-2", "statusBarItem.remoteForeground": "text-2",
  "statusBarItem.errorBackground": "bg-2", "statusBarItem.errorForeground": "red",
  "statusBarItem.warningBackground": "bg-2", "statusBarItem.warningForeground": "orange",
  "statusBarItem.prominentBackground": "chip", "statusBarItem.prominentForeground": "text",
  "commandCenter.background": "chip-2", "commandCenter.foreground": "text-2", "commandCenter.border": CLEAR,
  // inputs, dropdowns, checkboxes, key caps
  "input.foreground": "text", "input.placeholderForeground": "text-2",
  "inputOption.activeBackground": "sel", "inputOption.activeBorder": CLEAR, "inputOption.activeForeground": "text",
  "inputValidation.errorBackground": "bg-2", "inputValidation.errorBorder": "red@40", "inputValidation.errorForeground": "text",
  "inputValidation.warningBackground": "bg-2", "inputValidation.warningBorder": "orange@40",
  "inputValidation.infoBackground": "bg-2", "inputValidation.infoBorder": "blue@40",
  "dropdown.border": "hair-2", "dropdown.foreground": "text", "dropdown.listBackground": "bg-2",
  "checkbox.background": "chip-2", "checkbox.border": "hair-2", "checkbox.foreground": "text",
  "keybindingLabel.background": "chip-2", "keybindingLabel.foreground": "text", "keybindingLabel.border": CLEAR, "keybindingLabel.bottomBorder": CLEAR,
  "quickInput.foreground": "text", "quickInputList.focusBackground": "sel", "quickInputList.focusForeground": "text",
  "quickInputTitle.background": "bg-2", "pickerGroup.foreground": "text-2", "pickerGroup.border": "hair",
  // buttons (hover: the filled one a little lighter, the quiet one a step up from --chip to --hair)
  "button.hoverBackground": "fill@85", "button.border": CLEAR,
  "button.secondaryForeground": "text", "button.secondaryHoverBackground": "hair",
  "button.separator": "fill-text@40",
  // menus (DESIGN.md 弹层: --bg-2 ground, --hair outline)
  "menu.background": "bg-2", "menu.foreground": "text", "menu.selectionBackground": "sel", "menu.selectionForeground": "text",
  "menu.border": "hair", "menu.separatorBackground": "hair",
  "menubar.selectionBackground": "sel@60",
  // notifications and dialogs
  "notifications.background": "bg-2", "notifications.foreground": "text", "notifications.border": "hair",
  "notificationCenterHeader.background": "bg-2", "notificationToast.border": "hair",
  "notificationsErrorIcon.foreground": "red", "notificationsWarningIcon.foreground": "orange", "notificationsInfoIcon.foreground": "blue",
  // text, links, progress, scroll bars (DESIGN.md: --text-2 25%, hover 40%)
  "textLink.foreground": "blue", "textLink.activeForeground": "blue", "errorForeground": "red",
  "textCodeBlock.background": "chip-2", "textBlockQuote.background": "chip-2", "textBlockQuote.border": "hair", "textPreformat.foreground": "text",
  "textSeparator.foreground": "hair",
  "progressBar.background": "fill",
  "scrollbarSlider.background": "text-2@25", "scrollbarSlider.hoverBackground": "text-2@40", "scrollbarSlider.activeBackground": "text-2@50",
  "icon.foreground": "text-2",
  // status colours the chat panel and the testing / chart views read
  "charts.foreground": "text", "charts.lines": "hair", "charts.blue": "blue", "charts.green": "green", "charts.orange": "orange",
  "charts.red": "red", "charts.purple": "purple", "charts.yellow": "orange",
  "testing.iconPassed": "green", "testing.iconFailed": "red", "testing.iconErrored": "red", "testing.iconQueued": "orange",
  "gitDecoration.ignoredResourceForeground": "text-2@60", "gitDecoration.conflictingResourceForeground": "red",
  "gitDecoration.renamedResourceForeground": "green", "gitDecoration.stageModifiedResourceForeground": "orange",
  "gitDecoration.stageDeletedResourceForeground": "red", "gitDecoration.submoduleResourceForeground": "text-2",
  "problemsErrorIcon.foreground": "red", "problemsWarningIcon.foreground": "orange", "problemsInfoIcon.foreground": "blue",
  "editorInlayHint.background": "chip-2", "editorInlayHint.foreground": "text-2",
  "editorCodeLens.foreground": "text-2", "editorLink.activeForeground": "blue",
  "peekView.border": "hair", "peekViewEditor.background": "bg", "peekViewResult.background": "bg-2", "peekViewTitle.background": "bg-2",
  "peekViewResult.selectionBackground": "sel", "peekViewEditor.matchHighlightBackground": "orange@30", "peekViewResult.matchHighlightBackground": "orange@30",
  "welcomePage.background": "bg", "walkThrough.embeddedEditorBackground": "chip-2",
  "settings.headerForeground": "text", "settings.modifiedItemIndicator": "blue",
  "settings.dropdownBackground": "chip-2", "settings.textInputBackground": "chip-2", "settings.numberInputBackground": "chip-2",
  "settings.checkboxBackground": "chip-2", "settings.focusedRowBackground": "sel@60", "settings.rowHoverBackground": "sel@40",
  "debugToolBar.background": "bg-2", "debugToolBar.border": "hair",
  // keys a theme that does not name them gets in VS Code's own blue (#007acc, #75beff, #3399cc): the stone
  // blue where the colour means something, a grey ground where it only marks a hover, orange for "modified"
  "chat.workingProgressStableIconForeground": "blue", "chat.requestCodeBorder": "hair",
  "chat.slashCommandBackground": "blue-muted", "chat.slashCommandForeground": "blue",
  "editor.hoverHighlightBackground": "sel@60", "terminal.hoverHighlightBackground": "sel@60",
  "editorOverviewRuler.rangeHighlightForeground": "blue@60",
  "tab.activeModifiedBorder": "orange", "tab.inactiveModifiedBorder": "orange@50",
  "tab.unfocusedActiveModifiedBorder": "orange@50", "tab.unfocusedInactiveModifiedBorder": "orange@25",
  "symbolIcon.enumeratorMemberForeground": "blue", "symbolIcon.fieldForeground": "blue",
  "symbolIcon.interfaceForeground": "blue", "symbolIcon.variableForeground": "blue",
  "terminalSymbolIcon.argumentForeground": "blue", "terminalSymbolIcon.optionValueForeground": "blue",
  "debugIcon.continueForeground": "blue", "debugIcon.pauseForeground": "blue", "debugIcon.stepBackForeground": "blue",
  "debugIcon.stepIntoForeground": "blue", "debugIcon.stepOutForeground": "blue", "debugIcon.stepOverForeground": "blue",
  "debugView.valueChangedHighlight": "blue@60",
  "terminalCommandDecoration.successBackground": "dark:green",
  // the rest of VS Code's own blues (#2677cb drop targets, #40a6ff merge "incoming", #75beff / #007acc light bulb,
  // #179fff / #0431fa brackets, #0b216f active line number): a drop target lies over a large area, so the selection grey
  // at the hover strength, see-through over the editor (DESIGN.md: no large blocks of a semantic colour); "incoming" keeps the stone blue
  "editorGroup.dropBackground": "sel@60", "panelSection.dropBackground": "sel@60",
  "sideBar.dropBackground": "sel@60", "terminal.dropBackground": "sel@60",
  "merge.incomingHeaderBackground": "blue@50", "merge.incomingContentBackground": "blue@20",
  "editorOverviewRuler.incomingContentForeground": "blue@50", "mergeEditor.conflict.input2.background": "blue@20",
  "editorLightBulbAutoFix.foreground": "blue", "chart.line": "blue",
  "editorBracketHighlight.foreground1": "orange", "editorBracketHighlight.foreground2": "purple",
  "editorBracketHighlight.foreground3": "blue",
  "editorActiveLineNumber.foreground": "text",
  "editor.snippetTabstopHighlightBackground": "sel", "editor.snippetFinalTabstopHighlightBorder": "hair-2",
  "debugTokenExpression.type": "blue", "debugTokenExpression.boolean": "purple",
  // the terminal is a command block (DESIGN.md: always black), so both themes use the dark text and ANSI colours
  "terminal.foreground": "#fafaf9", "terminalCursor.foreground": "#fafaf9", "terminal.selectionBackground": "#ffffff40",
  "terminal.border": CLEAR, "terminal.tab.activeBorder": CLEAR,
  "terminal.ansiBlack": "#0c0a09", "terminal.ansiBrightBlack": "#79716b",
  "terminal.ansiWhite": "#d6d3d1", "terminal.ansiBrightWhite": "#fafaf9",
  "terminal.ansiRed": "dark:red", "terminal.ansiBrightRed": "dark:red",
  "terminal.ansiGreen": "dark:green", "terminal.ansiBrightGreen": "dark:green",
  "terminal.ansiYellow": "dark:orange", "terminal.ansiBrightYellow": "dark:orange",
  "terminal.ansiBlue": "dark:blue", "terminal.ansiBrightBlue": "dark:blue",
  "terminal.ansiMagenta": "dark:purple", "terminal.ansiBrightMagenta": "dark:purple",
  "terminal.ansiCyan": "dark:blue", "terminal.ansiBrightCyan": "dark:blue", // no cyan token: the link blue
};

/**
 * Syntax (5A.2): one neutral scheme. Keywords --text (the table's 500 has no TextMate equivalent,
 * VS Code only knows bold = 700, which DESIGN.md does not allow), strings --green, numbers --orange,
 * comments --text-2, types --blue, functions --purple. No italics (DESIGN.md 字体).
 */
export const SYNTAX = [
  ["Comments", ["comment", "punctuation.definition.comment", "string.comment"], "text-2"],
  ["Keywords", ["keyword", "keyword.control", "keyword.operator.new", "keyword.operator.expression", "storage", "storage.type", "storage.modifier", "variable.language"], "text"],
  ["Strings", ["string", "string.quoted", "string.template", "punctuation.definition.string", "markup.inline.raw", "markup.inserted"], "green"],
  ["Numbers and constants", ["constant.numeric", "constant.language", "constant.character", "constant.other", "support.constant", "variable.other.constant", "string.regexp", "markup.changed"], "orange"],
  ["Types", ["entity.name.type", "entity.name.class", "entity.name.namespace", "support.type", "support.class", "entity.other.inherited-class", "storage.type.primitive", "entity.name.tag", "markup.underline.link"], "blue"],
  ["Functions", ["entity.name.function", "support.function", "meta.function-call entity.name.function", "entity.other.attribute-name"], "purple"],
  ["Variables", ["variable", "variable.parameter", "variable.other", "meta.definition.variable", "punctuation", "meta.brace"], "text"],
  ["Headings", ["markup.heading", "entity.name.section"], "text", "bold"],
  ["Bold", ["markup.bold"], "text", "bold"],
  ["Removed", ["markup.deleted", "invalid"], "red"],
];

// ---- building ----------------------------------------------------------------------------------

/** Resolve one mapping value for a theme. */
function colour(spec, vars, darkVars) {
  let s = spec;
  if (s.includes("|")) s = s.split("|")[vars === darkVars ? 1 : 0];
  let from = vars;
  if (s.startsWith("dark:")) { from = darkVars; s = s.slice(5); }
  if (s.startsWith("#")) return s.toLowerCase();
  const [name, pct] = s.split("@");
  if (!(name in from)) throw new Error(`no token --${name}`);
  const c = parseColor(from[name], from);
  return toHex(c.rgb, c.alpha * (pct === undefined ? 1 : +pct / 100));
}

export function buildTheme(kind, tokens) {
  const vars = tokens[kind], darkVars = tokens.dark;
  const colors = {};
  for (const [k, v] of Object.entries({ ...EXTRA, ...TABLE })) colors[k] = colour(v, vars, darkVars);
  const sorted = Object.fromEntries(Object.keys(colors).sort().map((k) => [k, colors[k]]));
  return {
    $schema: "vscode://schemas/color-theme",
    name: kind === "dark" ? "Dispatch Dark" : "Dispatch Light",
    type: kind,
    semanticHighlighting: true,
    colors: sorted,
    tokenColors: SYNTAX.map(([name, scope, token, fontStyle]) => ({
      name, scope, settings: { foreground: colour(token, vars, darkVars), ...(fontStyle ? { fontStyle } : {}) },
    })),
  };
}

/**
 * What the bridge writes into the IDE's user settings the first time it runs (5A.2, 5A.3, 5A.4), only
 * for keys the user has not set. `theme` is written as a group, and only when no theme key is set.
 */
export function buildDefaults(tokens) {
  return {
    version: 3,
    theme: {
      "window.autoDetectColorScheme": true,
      "workbench.preferredLightColorTheme": "Dispatch Light",
      "workbench.preferredDarkColorTheme": "Dispatch Dark",
      "workbench.colorTheme": "Dispatch Dark",
    },
    settings: {
      // --mono (the workbench already uses the system font, which is --sans on macOS)
      "editor.fontFamily": tokens.light.mono,
      "terminal.integrated.fontFamily": tokens.light.mono,
      "editor.fontSize": 13,
      "editor.lineHeight": 20,
      "workbench.iconTheme": "vs-minimal",
      "workbench.tree.renderIndentGuides": "onHover",
      "window.titleBarStyle": "custom",
      "workbench.activityBar.location": "default",
      // the command center (back / forward and the ⌘P box) stays; the Dispatch Agent button sits next to it
      "window.commandCenter": true,
    },
    // earlier versions turned these off (the command center; the new session page's easter egg, now
    // Dispatch's blocks swarm): an IDE that still has the old value gets the new one
    replaces: { "window.commandCenter": false, "sessions.developerJoy.enabled": false },
    // the Agents window (its own profile): Claude and Codex on the user's own logins, no GitHub (design/copilot-app §8.5 A)
    agents: {
      "chat.disableAIFeatures": false,
      "chat.agentHost.allowSignedOutWhenUsable": true,
      "chat.agentHost.codexAgent.enabled": true,
      "chat.agentHost.byokModels.enabled": false,
      "chat.automations.enabled": true,
      // terminal Claude Code / Codex sessions of the last 7 days show in the Agents window and can be continued there
      'chat.agentSessions.showExternal': 'last7Days',
      "workbench.hover.delay": 500,
      // VS Code's easter egg (its logos raining over the new-session page)
      // the new session page's easter egg: Dispatch IDE draws Dispatch's blocks swarm there (140-new-session-swarm.patch)
      "sessions.developerJoy.enabled": true,
    },
  };
}

export function generate(css = fs.readFileSync(CSS, "utf8")) {
  const tokens = readTokens(css);
  const json = (o) => JSON.stringify(o, null, 2) + "\n";
  return {
    "dispatch-light.json": json(buildTheme("light", tokens)),
    "dispatch-dark.json": json(buildTheme("dark", tokens)),
    "ide-defaults.json": json(buildDefaults(tokens)),
  };
}

/** Where the IDE's workbench theme service reads Dispatch Light / Dark before the theme's extension is loaded. */
export const INITIAL = path.resolve(APP, "..", "ide", "vscode", "src", "vs", "workbench", "services", "themes", "common", "dispatchThemeColors.ts");

/**
 * The two themes' colours as a TypeScript module for the IDE. A window paints its first frame before the
 * extensions are read; the theme service then uses the copy it stored last time, and without one (a new profile,
 * the first editor window, the other scheme than last time) VS Code's built-in colours: its blue status bar and
 * focus outline for as long as the extensions take, seconds on a busy Mac. With these it paints Dispatch's own.
 */
export function generateInitialColors(css = fs.readFileSync(CSS, "utf8")) {
  const tokens = readTokens(css);
  const map = (colors) => Object.entries(colors).map(([k, v]) => `\t\t'${k}': '${v}',`).join("\n");
  const entry = (kind) => {
    const t = buildTheme(kind, tokens);
    return `\t'${t.name}': {\n\t\ttype: '${kind}',\n\t\tcolors: {\n${map(t.colors).replace(/^/gm, "\t")}\n\t\t},\n\t},`;
  };
  return `/*---------------------------------------------------------------------------------------------
 *  Dispatch IDE: generated by app/scripts/gen-ide-theme.mjs from app/src/styles.css, do not edit.
 *  Dispatch Light / Dark's colours for a window's first frame, before the theme's extension is read
 *  (workbenchThemeService.ts): without them a window with no stored copy of the theme paints VS Code's
 *  built-in colours, a blue status bar and focus outline, until the extensions are loaded.
 *--------------------------------------------------------------------------------------------*/

export interface IDispatchThemeInitialColors {
	readonly type: 'light' | 'dark';
	readonly colors: { readonly [id: string]: string };
}

export const DISPATCH_THEME_INITIAL_COLORS: { readonly [settingsId: string]: IDispatchThemeInitialColors | undefined } = {
${entry("light")}
${entry("dark")}
};

/** The Dispatch theme for a colour scheme ('light' | 'dark' | 'hcLight' | 'hcDark'): where a theme that is not there falls back to. */
export function dispatchFallbackTheme(scheme: string): string {
	return scheme === 'light' || scheme === 'hcLight' ? 'Dispatch Light' : 'Dispatch Dark';
}
`;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const files = generate();
  const check = process.argv.includes("--check");
  let stale = 0;
  fs.mkdirSync(OUT, { recursive: true });
  const targets = Object.entries(files).map(([name, text]) => [path.join(OUT, name), text]);
  if (fs.existsSync(path.dirname(INITIAL))) targets.push([INITIAL, generateInitialColors()]);
  for (const [p, text] of targets) {
    const same = fs.existsSync(p) && fs.readFileSync(p, "utf8") === text;
    if (check) { if (!same) { stale++; console.error(`stale: ${path.relative(process.cwd(), p)}`); } continue; }
    if (!same) fs.writeFileSync(p, text);
    console.log(`${same ? "unchanged" : "wrote"} ${path.relative(process.cwd(), p)}`);
  }
  if (stale) process.exit(1);
}
