import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ImportSkillDialog, NewSkillDialog } from "./Skills";

const noop = async () => {};

describe("skills create / import dialogs", () => {
  it("new-skill dialog carries the SKILL.md template fields and a mount picker", () => {
    const html = renderToStaticMarkup(<NewSkillDialog busy={false} onCancel={() => {}} onSave={noop} />);
    expect(html).toContain("新建技能");
    expect(html).toContain("技能名");
    expect(html).toContain("触发条件");
    expect(html).toContain("关键约束");
    expect(html).toContain("Claude Code");
    expect(html).toContain("Codex");
  });

  it("import dialog asks for a repo, an optional name and subdirectory", () => {
    const html = renderToStaticMarkup(<ImportSkillDialog busy={false} onCancel={() => {}} onSave={noop} />);
    expect(html).toContain("从 GitHub 导入技能");
    expect(html).toContain("仓库地址");
    expect(html).toContain("子目录");
    expect(html).toContain("LICENSE");
  });
});
