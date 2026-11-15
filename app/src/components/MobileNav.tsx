import { useEffect, useState } from "react";
import type { View } from "../types";
import { Icon } from "./icons";
import { useT } from "../i18n";

// Bottom tab bar for narrow screens. Five tabs is the most a thumb can aim at; the
// rest of the views live behind 更多, a bottom sheet of rows (the same sheet the ⌘K panel
// becomes on a phone). Above the tabs App's bottom bar turns into a fixed strip of buttons:
// the page's main action and 操作 (styles.css, "==== agents-knowledge ====").
const TABS: { v: View; icon: string; label: string }[] = [
  { v: "home", icon: "home", label: "工作台" },
  { v: "projects", icon: "project", label: "项目" },
  { v: "inbox", icon: "inbox", label: "等我" },
  { v: "sessions", icon: "chat", label: "会话" },
];
const MORE: { v: View; icon: string; label: string }[] = [
  { v: "board", icon: "board", label: "全部任务" },
  { v: "discuss", icon: "discuss", label: "讨论" },
  { v: "agents", icon: "agent", label: "Agent 状态" },
  { v: "stats", icon: "chart", label: "统计与额度" },
  { v: "graph", icon: "graph", label: "脉络" },
  { v: "skills", icon: "skill", label: "技能" },
  { v: "rules", icon: "rule", label: "规则与资料" },
  { v: "pitfalls", icon: "pit", label: "知识库" },
  { v: "settings", icon: "gear", label: "设置" },
  { v: "overview", icon: "home", label: "总览" },
];

export function MobileNav({ view, setView, badge }: { view: View; setView: (v: View) => void; badge: number }) {
  const t = useT();
  const [more, setMore] = useState(false);
  const inMore = view === "quota" || view === "table" || view === "trash" || view === "archive" || MORE.some((m) => m.v === view);
  const isOn = (m: View) => view === m || (view === "quota" && m === "stats") || (["list", "table", "trash", "archive"].includes(view) && m === "board");
  useEffect(() => {
    if (!more) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setMore(false); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [more]);
  return (
    <>
      {more && (
        <div className="m-sheet-bg" onClick={() => setMore(false)}>
          <div className="m-sheet" role="dialog" aria-label={t("更多")} onClick={(e) => e.stopPropagation()}>
            <div className="m-sheet-h">{t("更多")}</div>
            {MORE.map((m) => (
              <button key={m.v} className={isOn(m.v) ? "on" : ""} aria-current={isOn(m.v) ? "page" : undefined} onClick={() => { setView(m.v); setMore(false); }}><Icon name={m.icon} size={18} filled={isOn(m.v)} /><span>{t(m.label)}</span></button>
            ))}
          </div>
        </div>
      )}
      <nav className="m-nav">
        {TABS.map((tab) => (
          <button key={tab.v} className={view === tab.v ? "on" : ""} aria-current={view === tab.v ? "page" : undefined} onClick={() => { setView(tab.v); setMore(false); }}>
            <Icon name={tab.icon} size={20} filled={view === tab.v} />{t(tab.label)}
            {tab.v === "inbox" && badge > 0 && <i className="m-badge">{badge}</i>}
          </button>
        ))}
        <button className={inMore || more ? "on" : ""} aria-expanded={more} onClick={() => setMore(!more)}><Icon name="more" size={20} filled={inMore || more} />{t("更多")}</button>
      </nav>
    </>
  );
}
