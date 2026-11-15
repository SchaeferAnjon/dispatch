import { describe, expect, it } from "vitest";
import { awakeMode, awakeSetting, awakeState, computerAllowAllArgs, pageSettings, settingsCall, settingsPatch, shapeSnapshot } from "../src/core/settingsPage";

describe("settings page", () => {
  it("reads every shared setting and keeps only the page's", () => {
    expect(settingsCall("get")).toEqual({ args: ["settings", "--json"] });
    expect(pageSettings({ notify_reply: 1, notify_attention: 0, notify_done: "1", session_archive_days: 30 })).toEqual({
      notify_reply: true,
      notify_attention: false,
      notify_done: true,
      notify_needs_you: true,
      notify_desktop: false,
      notify_mac_finished: true,
      notify_mac_needs_you: true,
      notify_mac_stopped: false,
      notify_sound: "default",
    });
    expect(pageSettings(undefined).notify_reply).toBe(true);
    // banners on this Mac: off until turned on, and the wizard's value when it was
    expect(pageSettings({}).notify_desktop).toBe(false);
    expect(pageSettings({ notify_desktop: 1 }).notify_desktop).toBe(true);
  });

  it("saves only the notification switches (phone and this Mac), as 0 or 1", () => {
    const c = settingsCall("save", { notify_reply: false, notify_done: 1 });
    expect(c.args).toEqual(["settings", "--save", "--json"]);
    expect(JSON.parse(c.input!)).toEqual({ notify_reply: 0, notify_done: 1 });
    expect(JSON.parse(settingsCall("save", { notify_desktop: true }).input!)).toEqual({ notify_desktop: 1 });
    expect(() => settingsPatch({ session_archive_days: 3 })).toThrow("bad setting");
    expect(() => settingsPatch({ notify_reply: 2 })).toThrow("bad value");
    expect(() => settingsPatch({ notify_reply: "1" })).toThrow("bad value");
    expect(() => settingsPatch({})).toThrow("nothing to save");
    expect(() => settingsCall("rm")).toThrow();
  });

  it("reads and saves which kinds ring on this Mac and the sound", () => {
    const v = pageSettings({ notify_mac_finished: 0, notify_mac_stopped: 1, notify_sound: "Glass" });
    expect([v.notify_mac_finished, v.notify_mac_needs_you, v.notify_mac_stopped, v.notify_sound]).toEqual([false, true, true, "Glass"]);
    expect(pageSettings({ notify_sound: "$(rm -rf)" }).notify_sound).toBe("default");
    expect(JSON.parse(settingsCall("save", { notify_mac_stopped: true, notify_sound: "Ping" }).input!)).toEqual({ notify_mac_stopped: 1, notify_sound: "Ping" });
    expect(() => settingsPatch({ notify_sound: "--rm" })).toThrow("bad value");
    expect(() => settingsPatch({ notify_sound: 3 })).toThrow("bad value");
  });

  it("reads keep awake the way the CLI holds it (while an agent works or a phone is connected)", () => {
    expect(awakeMode("display")).toBe("display");
    expect(awakeMode("nonsense")).toBe("system");
    expect(awakeMode(undefined)).toBe("system");
    expect(awakeSetting("off")).toBe("off");
    expect(awakeSetting("always")).toBeUndefined();
    expect(awakeState({ ok: true, mode: "display", holding: true, reason: "working", working: 2, running: true }))
      .toEqual({ mode: "display", holding: true, reason: "working", working: 2, running: true });
    expect(awakeState({ mode: "off", holding: "yes", reason: "lunch", working: -1 }))
      .toEqual({ mode: "off", holding: false, reason: "", working: 0, running: true });
    expect(awakeState(undefined)).toEqual({ mode: "system", holding: false, reason: "", working: 0, running: true });
});

  it("shapes the one-go read the way each page's own call did, without values", () => {
    const raw = {
      ok: true,
      parts: {
        notify: { ok: true, value: { notify_reply: 0, session_archive_days: 30 } },
        awake: { ok: true, value: { mode: "display", holding: true, reason: "working", working: 2 } },
        mobile: { ok: true, value: { access: "on", running: true, devices: [] } },
        soul: { ok: true, value: { path: "/x/SOUL.md", on: true, content: "c" } },
        keys: { ok: true, value: [{ name: "A_KEY", note: "n", project: "", length: 40, masked: "sk-…abcd" }] },
        mcp: { ok: true, value: { servers: [{ name: "browser", scope: "user", env: ["TOKEN=secret"], command: "x" }], configs: {} } },
        autonomy: { ok: false, code: 1, error: "broke" },
        neat: { ok: true, value: { ok: false, error: "nope" } },
        inventory: { ok: true, value: { skills: [] } },
        plugins: { ok: true, value: { plugins: [], settings: "" } },
        builtins: { ok: true, value: { rules: { path: "/x/dispatch.md" }, skills: [], agents: [] } },
      },
    };
    const out = shapeSnapshot(raw, (r) => ({ shaped: r }));
    expect((out.notify as Record<string, unknown>).notify_reply).toBe(false);
    expect(out.awake).toEqual({ mode: "display", holding: true, reason: "working", working: 2, running: true });
    expect(out.mobile).toEqual({ shaped: raw.parts.mobile.value });
    expect(out.keys).toEqual([{ name: "A_KEY", note: "n", project: "", length: 40 }]);
    expect(JSON.stringify(out.keys)).not.toContain("sk-");
    expect(out.mcp).toEqual({ servers: [{ name: "browser", scope: "user", builtin: false }] });
    expect(out.mcpFull).toEqual(raw.parts.mcp.value);
    expect("autonomy" in out).toBe(false);
    expect("neat" in out).toBe(false);
    expect(out.inventory).toEqual({ skills: [] });
    expect(out.builtins).toEqual(raw.parts.builtins.value);
    expect(shapeSnapshot(undefined, (r) => r)).toEqual({});
  });
});

describe("computerAllowAllArgs", () => {
  it("reads without an argument, sets on or off, and refuses anything else", () => {
    expect(computerAllowAllArgs(undefined)).toEqual(["computer", "allowed", "--json"]);
    expect(computerAllowAllArgs(true)).toEqual(["computer", "allowed", "--all", "on", "--json"]);
    expect(computerAllowAllArgs(false)).toEqual(["computer", "allowed", "--all", "off", "--json"]);
    expect(() => computerAllowAllArgs("on")).toThrow();
  });
});
