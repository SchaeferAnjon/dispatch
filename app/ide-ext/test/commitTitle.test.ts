import { describe, expect, it } from "vitest";
import { commitTitle, withoutTaskId } from "../src/core/commitTitle";

describe("commit titles", () => {
  it("drop the task id the subject ends with", () => {
    expect(commitTitle("3304090", "Minecraft in the browser (task-tik)")).toBe("3304090 Minecraft in the browser");
    expect(commitTitle("6456821", "井字棋网页小游戏 tictactoe.html（task-f3z）\n\nbody")).toBe("6456821 井字棋网页小游戏 tictactoe.html");
    expect(commitTitle("abc1234", "")).toBe("abc1234");
    expect(withoutTaskId("fix (see issue-12)")).toBe("fix (see issue-12)");
  });
});
