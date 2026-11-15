import { describe, expect, it } from "vitest";
import { COMMAND_LOCATION, settingValue, TAB_DELAY } from "../src/core/settingNames";

// task-d5n3c: the editor window's Settings showed "Dispatch: Cli Path" and "Tab: Debounce Ms"; the settings are
// "Command Location" and "Tab: Delay" now, and a value set under the old name still counts.
describe("settingValue", () => {
  const read = (values: Record<string, unknown>) => (key: string) => values[key] as never;

  it("reads the new name first", () => {
    expect(settingValue(read({ commandLocation: "/x/dispatch.py", cliPath: "/old" }), COMMAND_LOCATION)).toBe("/x/dispatch.py");
    expect(settingValue(read({ "tab.delay": 400, "tab.debounceMs": 100 }), TAB_DELAY)).toBe(400);
  });

  it("falls back to what was set under the old name", () => {
    expect(settingValue(read({ commandLocation: "", cliPath: "/old/dispatch.py" }), COMMAND_LOCATION)).toBe("/old/dispatch.py");
    expect(settingValue(read({ "tab.debounceMs": 100 }), TAB_DELAY)).toBe(100);
  });

  it("is empty when neither is set", () => {
    expect(settingValue(read({ commandLocation: "" }), COMMAND_LOCATION)).toBe("");
    expect(settingValue(read({}), TAB_DELAY)).toBeUndefined();
  });
});
