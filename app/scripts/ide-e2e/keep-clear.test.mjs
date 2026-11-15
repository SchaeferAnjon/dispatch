import { expect, it } from "vitest";
import { AUTO_CARDS, coveredPairs, KEEP_CLEAR, measureScript } from "./keep-clear.mjs";

it("finds a tip on a session's message box, the third time the bug came back (task-lj06.21)", () => {
  // the report's screenshot at 1440 x 900: Getting started over the box's left half and its agent chip
  const cards = [{ sel: ".dispatch-tour", box: { left: 96, top: 712, width: 330, height: 140 } }];
  const controls = [{ sel: ".interactive-input-part", box: { left: 300, top: 760, width: 700, height: 110 } }];
  expect(coveredPairs(cards, controls)).toEqual([{ card: ".dispatch-tour", control: ".interactive-input-part", card_box: cards[0].box, control_box: controls[0].box }]);
});

it("a card beside the box passes", () => {
  const cards = [{ sel: ".dispatch-tour", box: { left: 12, top: 608, width: 320, height: 140 } }];
  const controls = [{ sel: ".interactive-input-part", box: { left: 300, top: 760, width: 700, height: 110 } }];
  expect(coveredPairs(cards, controls)).toEqual([]);
});

it("checks the same controls the IDE keeps clear and both cards that show by themselves", () => {
  expect(KEEP_CLEAR).toContain(".interactive-input-part");
  expect(KEEP_CLEAR).toContain(".new-chat-bottom-container");
  expect(AUTO_CARDS).toContain(".dispatch-tour");
  expect(AUTO_CARDS).toContain(".monaco-hover.dispatch-whats-new-auto");
  // the page script is one expression that answers JSON
  expect(() => new Function(`return ${measureScript()}`)).not.toThrow();
});
