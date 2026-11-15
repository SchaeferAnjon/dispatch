import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MORE, PRIMARY, Sidebar } from "./Sidebar";
import type { View } from "../types";

const EMPTY = { project: null, mine: false, urgent: false, agent: null, blocked: false, review: false };
const rail = (view: View, inbox = 0) => renderToStaticMarkup(<Sidebar info={null} view={view} setView={() => {}} inbox={inbox} agents={[]} filters={EMPTY} setFilters={() => {}} onAllTasks={() => {}} />);

describe("icon rail", () => {
  it("puts the workbench first and keeps every page one click or the ⋯ menu away", () => {
    expect(PRIMARY[0].v).toBe("home");
    const pages = [...PRIMARY, ...MORE].map((p) => p.v);
    for (const v of ["home", "projects", "inbox", "sessions", "board", "discuss", "graph", "agents", "stats", "skills", "rules", "pitfalls", "overview"] as View[]) expect(pages).toContain(v);
  });
  it("names each icon for hover and screen readers, with the 等我 count in the name and a dot on the icon", () => {
    const html = rail("home", 3);
    expect(html).toContain('data-tip="等我 · 3"');
    expect(html).toContain('<span class="rail-badge"></span>');
    expect(rail("home")).toContain('data-tip="等我"');
    expect(html).toContain('aria-label="设置"');
    expect(html.match(/aria-current="page"/g)).toHaveLength(1);
  });
  it("lights ⋯ when the page lives in its menu, and 全部任务 for every task layout", () => {
    expect(rail("skills")).toMatch(/class="rail-btn on"[^>]*aria-label="更多页面"/);
    expect(rail("table")).toMatch(/class="rail-btn on"[^>]*aria-label="全部任务"/);
  });
});
