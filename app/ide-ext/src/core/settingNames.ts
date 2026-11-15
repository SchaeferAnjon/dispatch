// The extension's settings as they read in the editor window's Settings (task-d5n3c): "Command Location" and
// "Tab: Delay" instead of "Cli Path" and "Tab: Debounce Ms". A value someone set under the old name still counts.
// No vscode import here, so vitest can run it from app/.

export const COMMAND_LOCATION = "commandLocation";
export const TAB_DELAY = "tab.delay";

/** Old names that still count when the new one is not set. */
export const RETIRED: Readonly<Record<string, string>> = {
  [COMMAND_LOCATION]: "cliPath",
  [TAB_DELAY]: "tab.debounceMs",
};

/** The value of `key` in the "dispatch" section, falling back to the name it had before. */
export function settingValue<T>(get: (key: string) => T | undefined, key: string): T | undefined {
  const value = get(key);
  if (value !== undefined && value !== null && value !== "") return value;
  const old = RETIRED[key];
  if (!old) return value;
  const before = get(old);
  return before !== undefined && before !== null && before !== "" ? before : value;
}
