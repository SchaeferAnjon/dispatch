import { describe, expect, it } from "vitest";
import { mobileArgs, shapeState } from "../src/core/mobile";

describe("mobile args", () => {
  it("maps the popover's operations to the CLI", () => {
    expect(mobileArgs("state")).toEqual(["mobile", "status", "--json"]);
    expect(mobileArgs(undefined)).toEqual(["mobile", "status", "--json"]);
    expect(mobileArgs("pair")).toEqual(["mobile", "pair", "--json", "--inline"]);
    expect(mobileArgs("pair", "p-1a2b3c")).toEqual(["mobile", "pair", "--json", "--inline", "--replace", "p-1a2b3c"]);
    expect(mobileArgs("revoke", "p-1a2b3c")).toEqual(["mobile", "revoke", "p-1a2b3c", "--json"]);
    expect(mobileArgs("install")).toEqual(["chatd", "install", "--json"]);
    expect(mobileArgs("on")).toEqual(["mobile", "on", "--json"]);
    expect(mobileArgs("off")).toEqual(["mobile", "off", "--json"]);
    expect(mobileArgs("another-port")).toEqual(["mobile", "config", "port", "0", "--json"]);
  });
  it("refuses ids that could be read as options, and unknown operations", () => {
    expect(mobileArgs("revoke", "--all")).toBeUndefined();
    expect(mobileArgs("revoke", "")).toBeUndefined();
    expect(mobileArgs("revoke")).toBeUndefined();
    expect(mobileArgs("pair", "-x")).toEqual(["mobile", "pair", "--json", "--inline"]);
    expect(mobileArgs("serve")).toBeUndefined();
  });
});

describe("mobile state", () => {
  const raw = {
    name: "Karl's MacBook",
    running: true,
    chatd: true,
    devices: [
      { id: "p-old", status: "paired", device_name: "iPad", paired_at: 10 },
      { id: "p-new", status: "paired", device_name: "Karl's iPhone", paired_at: 20, last_seen: 30 },
      { id: "p-wait", status: "pending" },
    ],
  };
  it("lists the paired phones, newest first", () => {
    const s = shapeState(raw);
    expect(s.phones.map((p) => p.name)).toEqual(["Karl's iPhone", "iPad"]);
    expect(s).toMatchObject({ running: true, chatd: true, name: "Karl's MacBook" });
    expect(s.pair).toBeUndefined();
  });
  it("reports whether the code on screen was taken", () => {
    expect(shapeState(raw, "p-wait").pair).toEqual({ id: "p-wait", status: "pending", name: "iPhone" });
    expect(shapeState(raw, "p-new").pair).toEqual({ id: "p-new", status: "paired", name: "Karl's iPhone" });
    expect(shapeState(raw, "p-gone").pair).toBeUndefined();
  });
  it("survives an empty answer", () => {
    expect(shapeState(null)).toEqual({ running: false, access: "off", problem: undefined, chatd: false, name: "", phones: [], pair: undefined });
  });
  it("says off, on, and why it is on but not running (task-lj06.19)", () => {
    expect(shapeState({ access: "on", running: true }).access).toBe("on");
    expect(shapeState({ access: "maybe" }).access).toBe("off");
    const s = shapeState({ access: "on", running: false, problem: { reason: "port_in_use", port: 7788, message: "Another program is already using port 7788.", fix: "Quit it." } });
    expect(s.problem).toEqual({ reason: "port_in_use", port: 7788, message: "Another program is already using port 7788.", fix: "Quit it." });
    expect(shapeState({ access: "on", problem: null }).problem).toBeUndefined();
    expect(shapeState({ access: "on", problem: { reason: "x" } }).problem).toBeUndefined();
  });
});
