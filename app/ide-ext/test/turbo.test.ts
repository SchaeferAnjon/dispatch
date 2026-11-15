import { describe, expect, it } from "vitest";
import { turboArgs } from "../src/core/turbo";

const RID = "tb-1002-1430-ab12";

describe("turbo args", () => {
  it("maps the Timeline tab's operations to the CLI", () => {
    expect(turboArgs(undefined)).toEqual(["turbo", "timeline", "--json"]);
    expect(turboArgs("timeline")).toEqual(["turbo", "timeline", "--json"]);
    expect(turboArgs("plan", "Fix the setup page and the docs", "/Users/me/.dispatch/assistant")).toEqual(
      ["turbo", "plan", "--cwd", "/Users/me/.dispatch/assistant", "--json", "--text=Fix the setup page and the docs"]);
    expect(turboArgs("plan", "-rf words stay words")).toEqual(["turbo", "plan", "--json", "--text=-rf words stay words"]);
    // task-o8wx: the agent and model picked in the input box split the job
    expect(turboArgs("plan", "Two things", "/Users/me/.dispatch/assistant", { engine: "opencode", model: "deepseek/deepseek-flash" })).toEqual(
      ["turbo", "plan", "--cwd", "/Users/me/.dispatch/assistant", "--engine", "opencode", "--model", "deepseek/deepseek-flash", "--json", "--text=Two things"]);
    expect(turboArgs("plan", "Two things", "", { engine: "gemini", model: "x" })).toEqual(["turbo", "plan", "--json", "--text=Two things"]);
    expect(turboArgs("plan", "Two things", "", { engine: "codex", model: "--evil" })).toBeUndefined();
    expect(turboArgs("start", RID)).toEqual(["turbo", "start", RID, "--json"]);
    expect(turboArgs("pause", RID)).toEqual(["turbo", "pause", RID, "--json"]);
    expect(turboArgs("replan", RID, { atATime: 6 })).toEqual(["turbo", "replan", RID, "--json", "--at-a-time", "6"]);
    expect(turboArgs("replan", RID, { cwd: "/Users/me/Projects/kanban", engine: "opencode", model: "deepseek/deepseek-flash" })).toEqual(
      ["turbo", "replan", RID, "--json", "--cwd", "/Users/me/Projects/kanban", "--engine", "opencode", "--model", "deepseek/deepseek-flash"]);
    expect(turboArgs("answer", RID, 3, "Allow once")).toEqual(["turbo", "answer", RID, "3", "--json", "--text=Allow once"]);
    expect(turboArgs("answer", RID, "land", "Bring it in now")).toEqual(["turbo", "answer", RID, "land", "--json", "--text=Bring it in now"]);
    expect(turboArgs("add", RID, "Also update the README")).toEqual(["turbo", "add", RID, "--json", "--text=Also update the README"]);
    expect(turboArgs("config")).toEqual(["turbo", "config", "--json"]);
    expect(turboArgs("config", { engine: "opencode", model: "deepseek/deepseek-flash" })).toEqual(
      ["turbo", "config", "--engine", "opencode", "--model", "deepseek/deepseek-flash", "--json"]);
    expect(turboArgs("switch", RID, { engine: "codex" })).toEqual(["turbo", "switch", RID, "--engine", "codex", "--json"]);
    expect(turboArgs("switch", RID, { engine: "opencode", model: "deepseek/deepseek-flash" })).toEqual(
      ["turbo", "switch", RID, "--engine", "opencode", "--model", "deepseek/deepseek-flash", "--json"]);
  });
  it("refuses what is not a Timeline operation", () => {
    expect(turboArgs("start", "tb-1; rm -rf ~")).toBeUndefined();
    expect(turboArgs("start")).toBeUndefined();
    expect(turboArgs("plan", "")).toBeUndefined();
    expect(turboArgs("plan", "job", "relative/folder")).toBeUndefined();
    expect(turboArgs("replan", RID, {})).toBeUndefined();
    expect(turboArgs("replan", RID, { atATime: 99 })).toBeUndefined();
    expect(turboArgs("replan", RID, { engine: "gemini" })).toBeUndefined();
    expect(turboArgs("replan", RID, { model: "--dangerous" })).toBeUndefined();
    expect(turboArgs("answer", RID, "../x", "yes")).toBeUndefined();
    expect(turboArgs("config", { engine: "bash" })).toBeUndefined();
    expect(turboArgs("run", RID)).toBeUndefined();
    expect(turboArgs("step", RID, 1, "x")).toBeUndefined();
    expect(turboArgs("switch", RID, { engine: "gemini" })).toBeUndefined();
    expect(turboArgs("switch", RID, { engine: "codex", model: "-x" })).toBeUndefined();
    expect(turboArgs("switch", "tb-x", { engine: "codex" })).toBeUndefined();
  });
});
