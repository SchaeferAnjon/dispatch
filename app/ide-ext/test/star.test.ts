import { describe, expect, it } from "vitest";
import { starAction, starState, STAR_TEXT } from "../src/core/star";

describe("GitHub star question", () => {
  it("is due only when the CLI says so, and only opens the project's own page", () => {
    expect(starState({ due: true, url: "https://github.com/SchaeferAnjon/dispatch" })).toEqual({ due: true, url: "https://github.com/SchaeferAnjon/dispatch" });
    expect(starState({ due: "yes" }).due).toBe(false);
    expect(starState({ due: true, url: "https://evil.example/x" }).url).toBe("https://github.com/SchaeferAnjon/dispatch");
    expect(starState(undefined)).toEqual({ due: false, url: "https://github.com/SchaeferAnjon/dispatch" });
  });

  it("asks in plain words, once, and a closed notification counts as later", () => {
    expect(STAR_TEXT.message).toMatch(/only time we ask/);
    expect(starAction(STAR_TEXT.star)).toBe("open");
    expect(starAction(STAR_TEXT.later)).toBe("later");
    expect(starAction(undefined)).toBe("later");
  });
});
