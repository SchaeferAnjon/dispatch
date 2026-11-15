import { describe, expect, it } from "vitest";
import { keysCall, newKeyEvents, parseKeyEvents } from "../src/core/keys";

const FAKE = "fake-test-value-0123456789";

describe("keysCall", () => {
  it("lists, and reads one value as text", () => {
    expect(keysCall("list")).toEqual({ args: ["env", "list", "--json"] });
    expect(keysCall("reveal", { name: "FAKE_KEY" })).toEqual({ args: ["env", "get", "FAKE_KEY"], text: true });
  });

  it("saves the value on stdin, never as an argument", () => {
    const c = keysCall("save", { name: "FAKE_KEY", value: `  ${FAKE}\n`, note: "Demo -x", project: "" });
    expect(c.input).toBe(FAKE);
    expect(c.args.join(" ")).not.toContain(FAKE);
    expect(c.args).toEqual(["env", "set", "FAKE_KEY", "--by", "settings", "--json", "--note=Demo -x", "--project=", "--stdin"]);
  });

  it("changes only the purpose and project when no value is given", () => {
    expect(keysCall("save", { name: "FAKE_KEY", note: "line one\nline two", project: "kanban" })).toEqual({
      args: ["env", "set", "FAKE_KEY", "--by", "settings", "--json", "--note=line one line two", "--project=kanban"],
      input: "",
    });
  });

  it("refuses names and changes that are not ones", () => {
    expect(() => keysCall("reveal", { name: "--all" })).toThrow();
    expect(() => keysCall("save", { name: "1ABC", value: "x" })).toThrow();
    expect(() => keysCall("save", { name: "A", value: "two\nlines" })).toThrow();
    expect(() => keysCall("undo", { change: "envc-../../x" })).toThrow();
    expect(() => keysCall("rm -rf")).toThrow();
    expect(keysCall("undo", { change: "envc-ab23cd45" }).args).toEqual(["env", "undo", "envc-ab23cd45", "--by", "settings", "--json"]);
    expect(keysCall("remove", { name: "FAKE_KEY" }).args).toEqual(["env", "unset", "FAKE_KEY", "--by", "settings", "--json"]);
  });
});

describe("key events", () => {
  const line = (id: string, op = "set") => JSON.stringify({ id, op, name: "FAKE_KEY", note: "Demo", project: "", by: "agent", at: "2026-10-09T00:00:00", created: true });

  it("reads the lines it can and skips the rest", () => {
    const evs = parseKeyEvents(`${line("envc-aaaaaaaa")}\nnot json\n{"half": \n${line("envc-bbbbbbbb", "unset")}\n`);
    expect(evs.map(e => [e.id, e.op])).toEqual([["envc-aaaaaaaa", "set"], ["envc-bbbbbbbb", "unset"]]);
  });

  it("gives each event once, also after the file is trimmed and rewritten", () => {
    const seen = new Set<string>();
    expect(newKeyEvents(line("envc-aaaaaaaa"), seen)).toHaveLength(1);
    expect(newKeyEvents(`${line("envc-aaaaaaaa")}\n${line("envc-cccccccc")}`, seen).map(e => e.id)).toEqual(["envc-cccccccc"]);
    // trimmed: the oldest line gone, a new one at the end
    expect(newKeyEvents(`${line("envc-cccccccc")}\n${line("envc-dddddddd")}`, seen).map(e => e.id)).toEqual(["envc-dddddddd"]);
    expect(newKeyEvents("", seen)).toEqual([]);
  });
});
