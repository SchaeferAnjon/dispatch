import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ProjectFactsView } from "./ProjectHub";

// Markdown needs a browser DOM (DOMPurify); the view's own markup is what this test checks.
vi.mock("./Markdown", () => ({ Markdown: ({ src }: { src: string }) => <pre>{src}</pre> }));

const noop = () => {};
const view = (over: Partial<Parameters<typeof ProjectFactsView>[0]>) => renderToStaticMarkup(<ProjectFactsView name="TUTOR" doc={{ path: "/Users/x/TUTOR/FACTS.md", content: "## 服务器\n\n**Lakenet**\n- 入口 https://ai.example", exists: true }} keys={[{ name: "LAB_LAKENET_API_KEY", note: "Lakenet Managed AI", masked: "nw-…t-1", length: 11, project: "TUTOR" }]} draft={null} busy={false} err="" onEdit={noop} onChange={noop} onCancel={noop} onSave={noop} onOpenPath={noop} onCopy={noop} {...over} />);

describe("ProjectFactsView", () => {
  it("shows the project's FACTS.md and the keys tied to it, names and notes only", () => {
    const html = view({});
    expect(html).toContain("~/TUTOR/FACTS.md");
    expect(html).toContain("Lakenet");
    expect(html).toContain("LAB_LAKENET_API_KEY");
    expect(html).toContain("Lakenet Managed AI");
    expect(html).not.toContain("nw-…t-1");
    expect(html).toContain("dispatch env get LAB_LAKENET_API_KEY");
    expect(html).toContain(">编辑<");
  });

  it("explains how to start when the project has no FACTS.md and no keys yet", () => {
    const html = view({ doc: { path: "/Users/x/TUTOR/FACTS.md", content: "", exists: false }, keys: [] });
    expect(html).toContain("还没有 FACTS.md");
    expect(html).toContain(">建一份<");
    expect(html).toContain("dispatch env set 名 值 -P TUTOR");
  });

  it("switches to the editor while a draft is open", () => {
    const html = view({ draft: "## 服务器\n" });
    expect(html).toContain("编辑项目常用信息");
    expect(html).toContain(">保存<");
  });
});
