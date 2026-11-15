import { describe, expect, it } from "vitest";
import { engineOf, installArgs } from "../src/core/skillInstall";

describe("find skills install", () => {
  it("mounts for the engine the page shows", () => {
    expect(engineOf("agent-host-opencode").id).toBe("opencode");
    expect(engineOf("agent-host-codex")).toEqual({ id: "codex", label: "Codex" });
    expect(engineOf("agent-host-claude").id).toBe("claude");
    expect(engineOf(undefined).id).toBe("claude");
    expect(installArgs({ name: "pdf", source: "pool" }, [engineOf("agent-host-opencode").id])).toEqual(["skills", "enable", "pdf", "--agent", "opencode"]);
  });

  it("mounts a pool skill for the page's engine", () => {
    expect(installArgs({ name: "pdf", source: "pool" }, ["claude"])).toEqual(["skills", "enable", "pdf", "--agent", "claude"]);
  });

  it("imports a public skill from its repo under its skill id", () => {
    expect(installArgs({ name: "PDF OCR", skill_id: "pdf-ocr", source: "skills.sh", repo: "someone/skills" }, ["codex"])).toEqual(
      ["skills", "install", "someone/skills", "--as", "pdf-ocr", "--agent", "codex", "--json"]);
    expect(installArgs({ name: "tool", source: "github", repo: "me/x", subpath: "skills/tool" }, ["claude"])).toContain("--path");
  });

  it("refuses a result without a real repo", () => {
    expect(installArgs({ name: "x", source: "skills.sh", repo: "not a repo; rm -rf" }, ["claude"])).toBeUndefined();
  });
});
