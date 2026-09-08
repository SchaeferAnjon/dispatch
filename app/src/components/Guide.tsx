import { useEffect, useState } from "react";
import type { View } from "../types";

// The tour follows the product's one axis: a project has conversations, a
// conversation spins off tasks, tasks add up to outcomes.
const STEPS: { title: string; body: string; view: View }[] = [
  { title: "一切从项目开始", body: "工作台按项目排列。每张卡片是这个项目此刻的情况：等你回的会话、在跑的会话、进行中的任务和最新成果。☆ 收藏置顶，做完的项目可以归档。", view: "home" },
  { title: "项目里有会话、任务、成果和目录", body: "点进一个项目：会话是工作发生的地方，任务由会话延伸出来并明确关联，多个任务和会话汇成一项成果。目录页能打开文件夹或在那里新建会话。", view: "projects" },
  { title: "「等我」只放需要你动手的事", body: "未读回复读到最新后自动移出，在原 Agent 里继续回复也会被识别；明确的确认请求单独列出。被卡住的任务和 Agent 互审不算在红点里。", view: "inbox" },
  { title: "会话页：对话、操作、文件和回复", body: "对话持续刷新，向上翻历史不会被拉回底部。「实时活动」是工具操作，「文件」是工作区差异，底部可直接回复原会话。", view: "sessions" },
  { title: "任务和知识给下一次用", body: "任务由 Agent 建、认领、记进展、收尾；看板只是全局视角。技能、规则、踩坑记录所有 Agent 共用。⌘K 随时搜项目、会话、任务。", view: "board" },
];

export function Tour({ onClose, onGo }: { onClose: () => void; onGo: (v: View) => void }) {
  const [i, setI] = useState(0);
  const s = STEPS[i];
  useEffect(() => { onGo(s.view); }, [i]);
  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dialog tour" role="dialog" aria-label="导览" onKeyDown={(e) => { if (e.key === "Escape") onClose(); if (e.key === "ArrowRight" || e.key === "Enter") setI(Math.min(STEPS.length - 1, i + 1)); if (e.key === "ArrowLeft") setI(Math.max(0, i - 1)); }}>
        <div className="tour-step muted small">{i + 1} / {STEPS.length}</div>
        <h3>{s.title}</h3>
        <p>{s.body}</p>
        <div className="tour-dots">{STEPS.map((_, k) => <i key={k} className={k === i ? "on" : ""} onClick={() => setI(k)} />)}</div>
        <div className="foot">
          <button className="btn ghost" onClick={onClose}>跳过</button>
          {i > 0 && <button className="btn" onClick={() => setI(i - 1)}>上一步</button>}
          {i < STEPS.length - 1 ? <button className="btn primary" autoFocus onClick={() => setI(i + 1)}>下一步</button> : <button className="btn primary" autoFocus onClick={onClose}>开始用</button>}
        </div>
      </div>
    </div>
  );
}


// Every page in one screen: what it is for, one line each. Click to go.
const PAGES: { view: View; icon: string; title: string; body: string }[] = [
  { view: "home", icon: "home", title: "工作台", body: "按项目看此刻：等你回的、在跑的、进行中的任务、最新成果。" },
  { view: "projects", icon: "project", title: "项目", body: "一个项目的全部记录：会话、任务、成果、目录。" },
  { view: "inbox", icon: "inbox", title: "等我", body: "只放需要你动手的：未读回复、等待确认、被卡住的任务。" },
  { view: "sessions", icon: "chat", title: "会话", body: "每段对话的全文、工具操作、改过的文件、产出；可直接回复或迁到另一台。" },
  { view: "board", icon: "board", title: "全部任务", body: "看板与表格。任务由 Agent 建和收尾，这里是全局视角；右键有全部操作。" },
  { view: "graph", icon: "graph", title: "脉络", body: "任务之间的派生、依赖、包含关系。" },
  { view: "agents", icon: "agent", title: "Agent 状态", body: "哪个 Agent 在哪台机器上做什么；派活、手机看屏幕。" },
  { view: "stats", icon: "chart", title: "统计与额度", body: "各 Agent 的额度、用量、工具、模型，以及跨 Agent 的复盘洞察。" },
  { view: "skills", icon: "skill", title: "技能", body: "所有 Agent 共用的技能池，给谁挂、改内容。" },
  { view: "rules", icon: "rule", title: "规则与资料", body: "一份 GLOBAL.md 同步到每个 Agent；常用资料和密钥入口。" },
  { view: "pitfalls", icon: "pit", title: "知识库", body: "坑、做对的事、方法、复盘；Agent 开工前会查。" },
  { view: "settings", icon: "gear", title: "设置", body: "工作区根目录、外观、手机与屏幕访问、更新、接入另一台电脑。" },
];

export function Overview({ onClose, onGo, onTour }: { onClose: () => void; onGo: (v: View) => void; onTour: () => void }) {
  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dialog overview" role="dialog" aria-label="页面总览" onKeyDown={(e) => { if (e.key === "Escape") onClose(); }}>
        <header><div><h3>Dispatch 有哪些页面</h3><p>项目 → 会话 → 任务 → 成果，是贯穿全部页面的一条线。点一项直接过去。</p></div><button className="btn ghost" aria-label="关闭" onClick={onClose}>✕</button></header>
        <div className="overview-grid">
          {PAGES.map((p) => <button key={p.view} className="overview-card" onClick={() => { onGo(p.view); onClose(); }}><b>{p.title}</b><span>{p.body}</span></button>)}
        </div>
        <div className="foot"><span className="muted small">任何地方右键都有该对象的操作；⌘K 搜索，⌘1–9 切页面。</span><span className="spacer" /><button className="btn" onClick={() => { onClose(); onTour(); }}>看一遍导览</button><button className="btn primary" onClick={onClose}>知道了</button></div>
      </div>
    </div>
  );
}
