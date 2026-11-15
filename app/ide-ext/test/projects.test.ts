import { describe, expect, it } from "vitest";
import { cloneProgressFile, createArgs, projectsArgs } from "../src/core/projects";

describe("projects", () => {
  it("reads the registry and the page", () => {
    expect(projectsArgs(undefined)).toEqual(["projects", "--json"]);
    expect(projectsArgs("registry")).toEqual(["projects", "--json"]);
    expect(projectsArgs("sidebar")).toEqual(["projects", "--sidebar", "--json"]);
    expect(projectsArgs("page")).toEqual(["projects-view", "--json"]);
    expect(projectsArgs("project", "kanban")).toEqual(["projects-view", "--project", "kanban", "--json"]);
    expect(projectsArgs("project", "会议记录")).toEqual(["projects-view", "--project", "会议记录", "--json"]);
    expect(projectsArgs("host", "kiwi-mac-mini")).toEqual(["projects-view", "--host", "kiwi-mac-mini", "--json"]);
  });

  it("reads and sets a project's own look (its Customize page)", () => {
    expect(projectsArgs("custom", "kanban")).toEqual(["project-custom", "show", "kanban", "--json"]);
    expect(projectsArgs("look", "kanban", { icon: "symbol", symbol: "rocket" })).toEqual(["project-custom", "look", "kanban", "--icon", "symbol", "--symbol", "rocket", "--json"]);
    expect(projectsArgs("look", "kanban", { emoji: "🚀", color: "teal" })).toEqual(["project-custom", "look", "kanban", "--emoji=🚀", "--color", "teal", "--json"]);
    expect(projectsArgs("look", "kanban", { picture: "/Users/me/p/icon.png" })).toEqual(["project-custom", "look", "kanban", "--picture=/Users/me/p/icon.png", "--json"]);
    expect(projectsArgs("look", "kanban", { color: "none" })).toEqual(["project-custom", "look", "kanban", "--color", "none", "--json"]);
    for (const bad of [{}, { icon: "letters" }, { symbol: "--x" }, { picture: "icon.png" }, { color: "#fff" }, { emoji: "a b" }]) {
      expect(projectsArgs("look", "kanban", bad)).toBeUndefined();
    }
    expect(projectsArgs("look", "-x", { icon: "folder" })).toBeUndefined();
    expect(projectsArgs("custom", "--json")).toBeUndefined();
  });

  it("turns one tool on or off for one agent in one project", () => {
    expect(projectsArgs("tool", "kanban", { server: "github", engine: "codex", on: false })).toEqual(["project-custom", "tool", "kanban", "--server", "github", "--engine", "codex", "--off", "--json"]);
    expect(projectsArgs("tool", "kanban", { server: "db", engine: "claude-code", on: true })).toEqual(["project-custom", "tool", "kanban", "--server", "db", "--engine", "claude-code", "--on", "--json"]);
    for (const bad of [{ server: "-x", engine: "codex", on: true }, { server: "g", engine: "cursor", on: true }, { server: "g", engine: "codex", on: "yes" }, { server: "a b", engine: "codex", on: true }]) {
      expect(projectsArgs("tool", "kanban", bad)).toBeUndefined();
    }
  });

  it("turns a project's ready copies on or off", () => {
    expect(projectsArgs("copies", "kanban", { auto: false })).toEqual(["project-custom", "copies", "kanban", "--auto", "off", "--json"]);
    expect(projectsArgs("copies", "kanban", { auto: true })).toEqual(["project-custom", "copies", "kanban", "--auto", "on", "--json"]);
    expect(projectsArgs("copies", "kanban", { auto: "no" })).toBeUndefined();
  });

  it("registers a folder", () => {
    expect(projectsArgs("add", "/Users/me/Projects/x")).toEqual(["projects-view", "add", "/Users/me/Projects/x", "--json"]);
    expect(projectsArgs("new", "/Users/me/Projects/y", "y")).toEqual(["projects-view", "new", "/Users/me/Projects/y", "--name", "y", "--json"]);
  });

  it("renames a project on the window only", () => {
    expect(projectsArgs("rename", "demo · current", "Demo two")).toEqual(["projects-view", "rename", "demo · current", "--name=Demo two", "--json"]);
    expect(projectsArgs("rename", "demo", "")).toEqual(["projects-view", "rename", "demo", "--name=", "--json"]);
    expect(projectsArgs("rename", "demo", "-x")).toEqual(["projects-view", "rename", "demo", "--name=-x", "--json"]);
    expect(projectsArgs("rename", "--all", "x")).toBeUndefined();
    expect(projectsArgs("rename", "", "x")).toBeUndefined();
    expect(projectsArgs("rename", "demo", "x".repeat(81))).toBeUndefined();
    expect(projectsArgs("rename", "demo", "a\nb")).toBeUndefined();
  });

  it("renames a project itself, its tasks and the rest moving along, after a check that only counts", () => {
    expect(projectsArgs("renameKeyCheck", "ALG", "Quillbench")).toEqual(["projects-view", "rename", "ALG", "--name=Quillbench", "--key", "--dry-run", "--json"]);
    expect(projectsArgs("renameKey", "ALG", "Quillbench")).toEqual(["projects-view", "rename", "ALG", "--name=Quillbench", "--key", "--json"]);
    expect(projectsArgs("renameKey", "ALG", "")).toBeUndefined();
    expect(projectsArgs("renameKey", "ALG", "-x")).toBeUndefined();
    expect(projectsArgs("renameKey", "ALG", "a#b")).toBeUndefined();
    expect(projectsArgs("renameKey", "--all", "x")).toBeUndefined();
  });

  it("opens another Mac's session", () => {
    expect(projectsArgs("open", "8ebbcdf5-2a9a-4664", "kiwi-mac-mini")).toEqual(["projects-view", "open", "8ebbcdf5-2a9a-4664", "--on", "kiwi-mac-mini", "--json"]);
  });

  it("refuses anything else", () => {
    expect(projectsArgs("add", "relative/path")).toBeUndefined();
    expect(projectsArgs("add", "/x", "--force")).toBeUndefined();
    expect(projectsArgs("project", "--all")).toBeUndefined();
    expect(projectsArgs("project", "")).toBeUndefined();
    expect(projectsArgs("open", "abc; rm -rf /", "mini")).toBeUndefined();
    expect(projectsArgs("open", "8ebbcdf5", "--x")).toBeUndefined();
    expect(projectsArgs("delete", "kanban")).toBeUndefined();
  });

  it("asks Add project's three ways", () => {
    expect(createArgs("defaults", undefined, "/tmp")).toEqual(["projects-view", "defaults", "--json"]);
    expect(createArgs("create", { name: "Notes app" }, "/tmp")).toEqual(["projects-view", "new", "--name=Notes app", "--json"]);
    expect(createArgs("create", { name: "讲书", parent: "/Users/me/Code" }, "/tmp")).toEqual(["projects-view", "new", "--name=讲书", "--parent", "/Users/me/Code", "--json"]);
    expect(createArgs("create", { name: "x", parent: "~/Code", machine: "mini" }, "/tmp")).toEqual(["projects-view", "new", "--name=x", "--parent", "~/Code", "--on", "mini", "--json"]);
    expect(createArgs("clone", { address: "https://github.com/octocat/Hello-World", progressId: "abc-12345678" }, "/tmp/")).toEqual([
      "projects-view", "clone", "https://github.com/octocat/Hello-World", "--progress-file", "/tmp/dispatch-clone-abc-12345678.json", "--json"]);
    expect(createArgs("clone", { address: "git@github.com:o/r.git", name: "Mine", parent: "/p", progressId: "abcdefgh" }, "/tmp")).toEqual([
      "projects-view", "clone", "git@github.com:o/r.git", "--name=Mine", "--progress-file", "/tmp/dispatch-clone-abcdefgh.json", "--parent", "/p", "--json"]);
  });

  it("refuses requests that are not what the dialog sends", () => {
    expect(createArgs("create", { name: "" }, "/tmp")).toBeUndefined();
    expect(createArgs("create", { name: "a\nb" }, "/tmp")).toBeUndefined();
    expect(createArgs("create", { name: "x", parent: "relative" }, "/tmp")).toBeUndefined();
    expect(createArgs("create", { name: "x", machine: "--x" }, "/tmp")).toBeUndefined();
    expect(createArgs("clone", { address: "--upload-pack=touch /tmp/x", progressId: "abcdefgh" }, "/tmp")).toBeUndefined();
    expect(createArgs("clone", { address: "https://a b", progressId: "abcdefgh" }, "/tmp")).toBeUndefined();
    expect(createArgs("clone", { address: "https://x/y" }, "/tmp")).toBeUndefined();
    expect(createArgs("clone", { address: "https://x/y", progressId: "../../etc/x" }, "/tmp")).toBeUndefined();
    expect(createArgs("clone", { address: "https://x/y", progressId: "abcdefgh", name: "-x" }, "/tmp")).toBeUndefined();
    expect(createArgs("delete", {}, "/tmp")).toBeUndefined();
    expect(cloneProgressFile("/tmp", "abc/../x1234567")).toBeUndefined();
  });
});
