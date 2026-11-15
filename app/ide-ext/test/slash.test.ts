import { describe, expect, it } from "vitest";
import { parseSlashTable, slashArgs } from "../src/core/slash";

describe("dispatch.slash", () => {
  it("asks the CLI for one known engine", () => {
    expect(slashArgs("codex")).toEqual(["slash", "--engine", "codex", "--json"]);
    expect(slashArgs("claude")).toEqual(["slash", "--engine", "claude", "--json"]);
    expect(slashArgs("pi")).toBeUndefined();
    expect(slashArgs(undefined)).toBeUndefined();
    expect(slashArgs("codex; rm -rf /")).toBeUndefined();
  });

  it("keeps well-formed rows and cleans the rest", () => {
    const t = parseSlashTable({
      engine: "codex",
      name: "Codex",
      rows: [
        { name: "context", why: "/context is a Claude Code command", where: "Start a Claude Code session to use it", go: "" },
        { name: "diff", why: "Codex has /diff only in its terminal", where: "Changes in the side pane shows the diff", go: "changes" },
        { name: "config", why: "x", where: "y", go: "customizations:harnessSettings" },
        { name: "usage", why: "x", where: "Here it is /status", go: "alias:status" },
        { name: "evil", why: "x", where: "y", go: "javascript:alert(1)" },
        { name: "", why: "x" },
        { name: "no-why", why: "" },
        null,
      ],
    });
    expect(t?.engine).toBe("codex");
    expect(t?.rows.map((r) => r.name)).toEqual(["context", "diff", "config", "usage", "evil"]);
    expect(t?.rows.find((r) => r.name === "diff")?.go).toBe("changes");
    expect(t?.rows.find((r) => r.name === "config")?.go).toBe("customizations:harnessSettings");
    expect(t?.rows.find((r) => r.name === "evil")?.go).toBe("");
  });

  it("rejects an answer that is not a table", () => {
    expect(parseSlashTable(undefined)).toBeUndefined();
    expect(parseSlashTable({ rows: [] })).toBeUndefined();
    expect(parseSlashTable("x")).toBeUndefined();
  });
});
