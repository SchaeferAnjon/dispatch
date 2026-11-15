import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import { __setPlatformForTests } from "../platform";
import { EmptyView, Meta, Meter, Row, Section, Shortcut, Tag } from "./primitives";
import { ActionPanel } from "./ActionPanel";

describe("primitives", () => {
  afterEach(() => __setPlatformForTests(null));

  it("spells shortcuts with the platform's modifier", () => {
    __setPlatformForTests("mac");
    expect(renderToStaticMarkup(<Shortcut k="K" />)).toBe('<span class="kbds"><kbd class="kbd">⌘</kbd><kbd class="kbd">K</kbd></span>');
    __setPlatformForTests("windows");
    expect(renderToStaticMarkup(<Shortcut k="K" shift />)).toBe('<span class="kbds"><kbd class="kbd">Ctrl</kbd><kbd class="kbd">⇧</kbd><kbd class="kbd">K</kbd></span>');
  });

  it("renders a row with its id, selection and accessories", () => {
    const html = renderToStaticMarkup(<Section title="在跑" count={1}><Row id="s1" selected title="开发者账号申请" accessories={[<Tag color="green">在跑</Tag>, "3m"]} data-session="local:claude-code:s1" /></Section>);
    expect(html).toContain('<div class="lsec">在跑<span class="n">1</span></div>');
    expect(html).toContain('data-row-id="s1"');
    expect(html).toContain('class="lrow sel"');
    expect(html).toContain('aria-selected="true"');
    expect(html).toContain('data-session="local:claude-code:s1"');
    expect(html).toContain('<span class="tag green">在跑</span>');
    expect(html).toContain('<span class="acc-i">3m</span>');
  });

  it("renders one line (no subtitle) and keeps tags grey by default", () => {
    expect(renderToStaticMarkup(<Row title="x" />)).toContain('<div class="lrow-main"><span class="t">x</span></div>');
    expect(renderToStaticMarkup(<Tag>P2</Tag>)).toBe('<span class="tag">P2</span>');
  });

  it("clamps the meter and shows value/max", () => {
    expect(renderToStaticMarkup(<Meter value={2} max={8} />)).toContain('style="width:25%"');
    expect(renderToStaticMarkup(<Meter value={9} max={8} />)).toContain('style="width:100%"');
    expect(renderToStaticMarkup(<Meter value={0} max={0} />)).toContain("0/0");
  });

  it("renders the empty state and the detail key/value grid", () => {
    const html = renderToStaticMarkup(<EmptyView icon="chat" title="没有会话" description="新建一个" />);
    expect(html).toContain('class="empty-view"');
    expect(html).toContain("<b>没有会话</b>");
    expect(renderToStaticMarkup(<Meta rows={[["主机", "小蓝"]]} />)).toContain('<span class="k">主机</span><span class="v">小蓝</span>');
  });
});

describe("ActionPanel", () => {
  const base = { projects: [], rows: [], issues: [], me: "me", archiveDays: 30, onProject: () => {}, onSession: () => {}, onTask: () => {}, onClose: () => {} };
  it("lists the action sections in order and hides search-only ones until the user types", () => {
    const html = renderToStaticMarkup(<ActionPanel {...base} sections={[
      { title: "Harbor 迁移", items: [{ label: "查看并回复", icon: "reply", onClick: () => {} }] },
      { title: "导航", items: [{ label: "新建会话", hint: "⌘N", onClick: () => {} }] },
      { title: "页面", searchOnly: true, items: [{ label: "转到设置", onClick: () => {} }] },
      { title: "空的", items: [] },
    ]} />);
    expect(html.indexOf("Harbor 迁移")).toBeLessThan(html.indexOf("导航"));
    expect(html).toContain("查看并回复");
    expect(html).toContain('<kbd class="kbd">⌘</kbd><kbd class="kbd">N</kbd>');
    expect(html).not.toContain("转到设置");
    expect(html).not.toContain("空的");
    // The first row starts selected.
    expect(html).toMatch(/class="lrow sel"[^>]*>.*查看并回复/);
  });
});
