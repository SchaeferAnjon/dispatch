import { describe, expect, it } from "vitest";
import { marked } from "marked";
import "./components/Markdown";

describe("markdown strikethrough", () => {
  it("keeps single tildes (home paths) as text and still strikes ~~double~~", () => {
    const html = marked.parse("写进 ~/.zcode/cli/config.json 的 plugins；技能扫 ~/.claude/skills、~/.agents/skills，和 ~~旧的~~", { async: false }) as string;
    expect(html.split("<del>").length - 1).toBe(1);
    expect(html).toContain("~/.zcode/cli/config.json");
    expect(html).toContain("<del>旧的</del>");
  });
});
