// The rule every card that shows by itself keeps (kanban task-lj06.21): a tip or the first welcome never sits on a
// message box or the switches round it. The IDE places them that way (dispatchToursModel.ts KEEP_CLEAR); this checks
// the result on every screenshot an end-to-end run takes, so a fourth time fails a run instead of a person's typing.

/** What is kept clear: the same list as the IDE's KEEP_CLEAR. */
export const KEEP_CLEAR = [
  ".interactive-input-part",
  ".new-chat-input-container", ".new-chat-input-area", ".new-chat-bottom-container",
  ".sessions-chat-session-type-picker", ".chat-input-notification-widget",
  ".dispatch-home-tabs",
];

/** The cards that show by themselves: tips, and the What's new welcome that opens after setup. */
export const AUTO_CARDS = [".dispatch-tour", ".monaco-hover.dispatch-whats-new-auto"];

function overlaps(a, b) {
  return a.left < b.left + b.width && b.left < a.left + a.width && a.top < b.top + b.height && b.top < a.top + a.height;
}

/** Each card that covers a kept-clear control: [{ card, control, card_box, control_box }]. */
export function coveredPairs(cards, controls) {
  const out = [];
  for (const c of cards) {
    for (const k of controls) {
      if (overlaps(c.box, k.box)) out.push({ card: c.sel, control: k.sel, card_box: c.box, control_box: k.box });
    }
  }
  return out;
}

/** An expression for the page: the visible cards and controls, with their boxes. */
export function measureScript() {
  return `(() => {
    const seen = el => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none' && Number(s.opacity) > 0.05; };
    const box = el => { const r = el.getBoundingClientRect(); return { left: Math.round(r.left), top: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) }; };
    const all = sels => sels.flatMap(sel => [...document.querySelectorAll(sel)].filter(seen).map(el => ({ sel, box: box(el) })));
    return JSON.stringify({ cards: all(${JSON.stringify(AUTO_CARDS)}), controls: all(${JSON.stringify(KEEP_CLEAR)}) });
  })()`;
}
