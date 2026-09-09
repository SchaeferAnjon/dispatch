// Which modifier switches views with the digit keys. ⌘-digit is what macOS apps usually
// take, but it is also what people bind system-wide (window managers, input methods), so
// the choice lives on this Mac (localStorage), with an option to turn it off entirely.
export type ViewMod = "off" | "meta" | "ctrl" | "alt" | "ctrl+alt" | "meta+alt";
export const VIEW_MODS: [ViewMod, string][] = [["off", "关闭"], ["ctrl+alt", "⌃⌥ + 数字"], ["meta", "⌘ + 数字"], ["ctrl", "⌃ + 数字"], ["alt", "⌥ + 数字"], ["meta+alt", "⌘⌥ + 数字"]];
const KEY = "dispatch-view-shortcut";
export const DEFAULT_VIEW_MOD: ViewMod = "ctrl+alt";

export function loadViewMod(): ViewMod {
  try { const v = localStorage.getItem(KEY) as ViewMod | null; return v && VIEW_MODS.some(([m]) => m === v) ? v : DEFAULT_VIEW_MOD; } catch { return DEFAULT_VIEW_MOD; }
}
export function saveViewMod(m: ViewMod) { try { localStorage.setItem(KEY, m); } catch { /* per-device convenience only */ } }

export const modLabel = (m: ViewMod) => ({ off: "", meta: "⌘", ctrl: "⌃", alt: "⌥", "ctrl+alt": "⌃⌥", "meta+alt": "⌘⌥" }[m]);

// True when the event carries exactly the chosen modifiers (Shift never counts as a match).
export function viewShortcut(e: KeyboardEvent, m: ViewMod): number | null {
  if (m === "off" || e.shiftKey || !/^[1-9]$/.test(e.key)) return null;
  const want = { meta: [true, false, false], ctrl: [false, true, false], alt: [false, false, true], "ctrl+alt": [false, true, true], "meta+alt": [true, false, true] }[m];
  if (e.metaKey !== want[0] || e.ctrlKey !== want[1] || e.altKey !== want[2]) return null;
  return Number(e.key);
}
