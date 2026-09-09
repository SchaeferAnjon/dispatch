import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { Api } from "../api";
import { ProjectDocs } from "./ProjectHub";

const api = { on: async () => "{}", openPath: async () => {}, copy: async () => {} } as unknown as Api;
const docs = [
  { id: "a", title: "Dispatch 开源项目调研报告", kind: "调研", path: "/Users/x/Projects/kanban/design/oss-research-2026-09-09.md", size: 28259, mtime: 1788968349, source: "scan" },
  { id: "b", title: "Dispatch 全面复审 · 2026-09-08", kind: "复审", path: "/Users/x/Projects/kanban/design/review-2026-09-08.md", size: 31397, mtime: 1788903297, source: "scan" },
];

describe("ProjectDocs", () => {
  it("lists the project's research and review documents with kind and shortened path", () => {
    const html = renderToStaticMarkup(<ProjectDocs api={api} name="kanban" docs={docs} onReload={() => {}} />);
    expect(html).toContain("Dispatch 开源项目调研报告");
    expect(html).toContain("Dispatch 全面复审");
    expect(html).toContain(">调研<");
    expect(html).toContain(">复审<");
    expect(html).toContain("~/Projects/kanban/design/oss-research-2026-09-09.md");
    expect(html).toContain("登记文档…");
  });

  it("explains the empty state instead of an empty box", () => {
    const html = renderToStaticMarkup(<ProjectDocs api={api} name="kanban" docs={[]} onReload={() => {}} />);
    expect(html).toContain("还没有文档");
  });
});
