import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, PROJECT_FLAGS_KEY, SETTINGS_KEY, parseProjectFlags, parseSettings, rankProjects, serializeProjectFlags, serializeSettings, settingsPatch, withProjectFlag, newSessionTarget } from "./projectFlags";

describe("project flags", () => {
  it("parses only true known fields from the shared memory", () => {
    const flags = parseProjectFlags([{ key: "pit-x", value: "【坑】" }, { key: PROJECT_FLAGS_KEY, value: JSON.stringify({ a: { starred: true, archived: false, x: 1 }, b: { archived: true }, c: { starred: false }, d: "bad" }) }]);
    expect(flags).toEqual({ a: { starred: true }, b: { archived: true } });
    expect(parseProjectFlags([])).toEqual({});
    expect(parseProjectFlags([{ key: PROJECT_FLAGS_KEY, value: "nope" }])).toEqual({});
  });

  it("merges changes and drops empty entries, serialising in a stable order", () => {
    let flags = withProjectFlag({}, "ReadAloud", { starred: true });
    flags = withProjectFlag(flags, "kanban", { archived: true });
    expect(serializeProjectFlags(flags)).toBe('{"ReadAloud":{"starred":true},"kanban":{"archived":true}}');
    flags = withProjectFlag(flags, "ReadAloud", { starred: false });
    expect(flags).toEqual({ kanban: { archived: true } });
  });

  it("keeps the checker's test command suggestion inactive until the person decides", () => {
    const flags = parseProjectFlags([{ key: PROJECT_FLAGS_KEY, value: JSON.stringify({ kanban: { test_cmd_suggested: "cd app && npm test && npm run test:py" } }) }]);
    expect(flags.kanban).toEqual({ test_cmd_suggested: "cd app && npm test && npm run test:py" });
    expect(flags.kanban.test_cmd).toBeUndefined();
    // 同意: the person's click sets test_cmd; the suggestion is retired
    const agreed = withProjectFlag(flags, "kanban", { test_cmd: "cd app && npm test && npm run test:py" });
    expect(agreed.kanban).toEqual({ test_cmd: "cd app && npm test && npm run test:py", test_cmd_dismissed: "cd app && npm test && npm run test:py" });
    // 不用: not offered again, and a star elsewhere keeps it
    const no = withProjectFlag(withProjectFlag(flags, "kanban", { test_cmd_dismissed: "cd app && npm test && npm run test:py" }), "kanban", { starred: true });
    expect(no.kanban.test_cmd).toBeUndefined();
    // 不用 covers the project: a later, different guess is not asked again
  });

  it("ranks starred first and sets archived aside without reordering the rest", () => {
    const list = [{ name: "a" }, { name: "b" }, { name: "c" }, { name: "d" }];
    const { active, archived } = rankProjects(list, { c: { starred: true }, b: { archived: true }, d: { starred: true, archived: true } });
    expect(active.map((p) => p.name)).toEqual(["c", "a"]);
    expect(archived.map((p) => p.name)).toEqual(["b", "d"]);
  });

  it("reads and writes the task auto-archive days, defaulting to off", () => {
    expect(DEFAULT_SETTINGS.task_archive_days).toBe(0);
    expect(parseSettings([]).task_archive_days).toBe(0);
    expect(parseSettings([{ key: SETTINGS_KEY, value: JSON.stringify({ task_archive_days: 14 }) }]).task_archive_days).toBe(14);
    expect(parseSettings([{ key: SETTINGS_KEY, value: JSON.stringify({ task_archive_days: -1 }) }]).task_archive_days).toBe(0);
    expect(JSON.parse(serializeSettings({ ...DEFAULT_SETTINGS, task_archive_days: 7 })).task_archive_days).toBe(7);
  });
  it("silently ignores retired checker settings from old boards", () => {
    for (const check_mode of ["independent", "manual", "self", "unknown"]) {
      const settings = parseSettings([{ key: SETTINGS_KEY, value: JSON.stringify({ check_mode, check_model: "claude:sonnet", gate_sig: "old", summary_uses: { check: 1, session: 0 } }) }]);
      expect(settings).not.toHaveProperty("check_mode");
      expect(settings).not.toHaveProperty("check_model");
      expect(settings.summary_uses).toEqual({ session: 0 });
      expect(serializeSettings(settings)).not.toContain("check_mode");
    }
  });
  it("saves only what changed, so an untouched or unknown setting is never reset", () => {
    const prev = { ...DEFAULT_SETTINGS, summary_uses: { session: 1 } };
    expect(settingsPatch(prev, prev)).toEqual({});
    expect(settingsPatch(prev, { ...prev, list_density: "compact" })).toEqual({ list_density: "compact" });
    expect(settingsPatch(prev, { ...prev, summary_uses: { session: 0 } })).toEqual({ summary_uses: { session: 0 } });
  });
  it("keeps the list density, comfortable by default", () => {
    expect(parseSettings([]).list_density).toBe("comfortable");
    expect(parseSettings([{ key: SETTINGS_KEY, value: JSON.stringify({ list_density: "compact" }) }]).list_density).toBe("compact");
    expect(parseSettings([{ key: SETTINGS_KEY, value: JSON.stringify({ list_density: "huge" }) }]).list_density).toBe("comfortable");
    expect(JSON.parse(serializeSettings({ ...DEFAULT_SETTINGS, list_density: "compact" })).list_density).toBe("compact");
  });
});

describe("new session target on Windows paths", () => {
  it("keeps a home-relative folder when the owner is another machine", () => {
    expect(newSessionTarget("mac2", { host: "local", cwd: "C:/Users/x/Projects/kanban" }, "local")).toEqual({ initialHost: "mac2", initialCwd: "~/Projects/kanban" });
    expect(newSessionTarget("mac2", { host: "local", cwd: "c:\\Users\\x\\Projects\\kanban" }, "local")).toEqual({ initialHost: "mac2", initialCwd: "~/Projects/kanban" });
    expect(newSessionTarget("mac2", { host: "local", cwd: "C:/Users/x" }, "local")).toEqual({ initialHost: "mac2", initialCwd: "~" });
    expect(newSessionTarget("mac2", { host: "local", cwd: "D:/work" }, "local")).toEqual({ initialHost: "mac2", initialCwd: undefined });
    expect(newSessionTarget("mac2", { host: "local", cwd: "/Users/x/Projects/kanban" }, "local")).toEqual({ initialHost: "mac2", initialCwd: "~/Projects/kanban" });
  });
});

describe("IDE settings (⌘K and Tab completion in Dispatch IDE)", () => {
  it("default to Tab completion on with a $0.50 daily cap", () => {
    expect(DEFAULT_SETTINGS.ide_tab_completion).toBe(true);
    expect(DEFAULT_SETTINGS.ide_tab_daily_cap_usd).toBe(0.5);
  });
  it("round-trip through the board memory as the CLI stores them (0/1 for switches)", () => {
    const raw = JSON.stringify({ ide_tab_completion: 1, ide_tab_daily_cap_usd: 0.25, ide_edit_model: "codex:default" });
    const s = parseSettings([{ key: "dispatch-settings", value: raw }]);
    expect(s).toMatchObject({ ide_tab_completion: true, ide_tab_daily_cap_usd: 0.25, ide_edit_model: "codex:default" });
    expect(JSON.parse(serializeSettings(s))).toMatchObject({ ide_tab_completion: 1 });
    expect(settingsPatch(s, { ...s, ide_tab_completion: false })).toEqual({ ide_tab_completion: 0 });
  });
});
