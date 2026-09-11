import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ProjectFactsView } from "./ProjectHub";

// Markdown needs a browser DOM (DOMPurify); the view's own markup is what this test checks.
vi.mock("./Markdown", () => ({ Markdown: ({ src }: { src: string }) => <pre>{src}</pre> }));

const noop = () => {};
const view = (over: Partial<Parameters<typeof ProjectFactsView>[0]>) => renderToStaticMarkup(<ProjectFactsView name="HIWI" doc={{ path: "/Users/x/HIWI/FACTS.md", content: "## 服务器\n\n**Netways**\n- 入口 https://ai.example", exists: true }} keys={[{ name: "THBW_NETWAYS_API_KEY", note: "Netways Managed AI", masked: "nw-…t-1", length: 11, project: "HIWI" }]} draft={null} busy={false} err="" onEdit={noop} onChange={noop} onCancel={noop} onSave={noop} onOpenPath={noop} onCopy={noop} {...over} />);

describe("ProjectFactsView", () => {
  it("shows the project's FACTS.md and the keys tied to it, names and notes only", () => {
    const html = view({});
    expect(html).toContain("~/HIWI/FACTS.md");
    expect(html).toContain("Netways");
    expect(html).toContain("THBW_NETWAYS_API_KEY");
    expect(html).toContain("Netways Managed AI");
    expect(html).not.toContain("nw-…t-1");
    expect(html).toContain("dispatch env get THBW_NETWAYS_API_KEY");
    expect(html).toContain(">编辑<");
  });

  it("explains how to start when the project has no FACTS.md and no keys yet", () => {
    const html = view({ doc: { path: "/Users/x/HIWI/FACTS.md", content: "", exists: false }, keys: [] });
    expect(html).toContain("还没有 FACTS.md");
    expect(html).toContain(">建一份<");
    expect(html).toContain("dispatch env set 名 值 -P HIWI");
  });

  it("switches to the editor while a draft is open", () => {
    const html = view({ draft: "## 服务器\n" });
    expect(html).toContain("编辑项目常用信息");
    expect(html).toContain(">保存<");
  });
});
