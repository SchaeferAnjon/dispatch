import { useState } from "react";
import type { View } from "../types";
import { Icon } from "./icons";

// Bottom tab bar for narrow screens. Five tabs is the most a thumb can aim at; the
// rest of the views live behind 更多.
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
  const [more, setMore] = useState(false);
  const inMore = view === "quota" || view === "table" || view === "trash" || view === "archive" || MORE.some((m) => m.v === view);
  return (
    <>
      {more && (
        <div className="m-sheet-bg" onClick={() => setMore(false)}>
          <div className="m-sheet" onClick={(e) => e.stopPropagation()}>
            {MORE.map((m) => (
              <button key={m.v} className={(view === m.v || (view === "quota" && m.v === "stats") || (["table", "trash", "archive"].includes(view) && m.v === "board")) ? "on" : ""} onClick={() => { setView(m.v); setMore(false); }}><Icon name={m.icon} size={18} />{m.label}</button>
            ))}
          </div>
        </div>
      )}
      <nav className="m-nav">
        {TABS.map((t) => (
          <button key={t.v} className={view === t.v ? "on" : ""} onClick={() => { setView(t.v); setMore(false); }}>
            <Icon name={t.icon} size={20} />{t.label}
            {t.v === "inbox" && badge > 0 && <i className="m-badge">{badge}</i>}
          </button>
        ))}
        <button className={inMore || more ? "on" : ""} onClick={() => setMore(!more)}><Icon name="board" size={20} />更多</button>
      </nav>
    </>
  );
}
