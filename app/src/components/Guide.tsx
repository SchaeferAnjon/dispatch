import { useEffect, useState } from "react";
import type { View } from "../types";

// One sentence per view, shown under the title until dismissed. Plain words,
// no product jargon: what you see here and what to do with it.
export const VIEW_INTRO: Partial<Record<View, string>> = {
  home: "从最近会话接着工作：查看正在执行的操作、未读回复，再进入对话、文件和任务。",
  inbox: "未读回复在读到最新后自动移出；明确的确认请求和被卡住的任务单独保留。Agent 复核不计入你的待处理数量。",
  board: "所有任务，三列对应工作进度：待办 → 进行中 → 已完成；Agent 复核单独记录。卡片上的「源自」是它属于哪条线。你只需要看，认领和推进都由 Agent 做。",
  table: "和看板同一份任务，换成表格，适合排序和扫一眼。",
  graph: "任务是一根线：左边是源头，右边是它派生出来的。悬停或点一个节点，整条线高亮。",
  projects: "按项目看：每个项目有多少任务在做、已完成和待 Agent 复核，参与过哪些 Agent，对应哪个文件夹。",
  folders: "按文件夹看：这个目录下你和哪些 Agent 聊过、每次聊了什么（开头那句话就是主题），点进去看完整聊天记录。",
  agents: "查看已检测到的会话与来源；运行状态优先使用实际活动，只有进程信息时标为未知。",
  sessions: "Claude Code 和 Codex 会话持续更新；读对话、查看实时操作与工作区差异，也可打开原会话。",
  skills: "技能池：每个技能给哪些 Agent 挂着。改 SKILL.md 就是改 Agent 的做事方法。",
  rules: "这台电脑上所有 Agent 都遵守的规则，只有这一份；改完自动同步到 Claude Code、Codex、ZCode。",
  pitfalls: "踩过的坑和解法。每个 Agent 新开会话时会自动读到，所以同一个坑不会踩第二次。",
};

const STEPS: { title: string; body: string; view: View }[] = [
  { title: "从会话接着工作", body: "工作台显示最近会话、正在执行的操作和未读回复。点开一条会话，就能读到最新进展。", view: "home" },
  { title: "什么会出现在「等我」", body: "新回复会进入未读列表，读到最新后自动清除；在原 Agent 里继续回复，也会被识别。仅在原应用中查看，暂时无法同步已读。明确的确认请求仍需处理。", view: "inbox" },
  { title: "对话、操作与文件放在一起", body: "会话页持续刷新。向上翻历史时不会强制跳回底部；「实时活动」显示工具操作，「文件」展示当前工作区差异和会话中的编辑记录。", view: "sessions" },
  { title: "任务记录交付过程", body: "看板按待办、进行中、已完成排列。完成由 Agent 记录，互审独立进行；你无需再点击一次完成。", view: "board" },
  { title: "知识供下一次工作使用", body: "技能、规则和踩坑记录供各个 Agent 共用，避免重复解释和重复犯错。", view: "skills" },
];

export function useIntro(view: View): [string | null, () => void] {
  const key = `dispatch-intro-off-${view}`;
  const [off, setOff] = useState<boolean>(() => { try { return localStorage.getItem(key) === "1"; } catch { return false; } });
  useEffect(() => { try { setOff(localStorage.getItem(key) === "1"); } catch { setOff(false); } }, [key]);
  const text = VIEW_INTRO[view];
  return [off || !text ? null : text!, () => { try { localStorage.setItem(key, "1"); } catch { /* ignore */ } setOff(true); }];
}

export function ViewIntro({ view }: { view: View }) {
  const [text, dismiss] = useIntro(view);
  if (!text) return null;
  return <div className="view-intro"><span>{text}</span><button className="btn ghost sm" onClick={dismiss} title="知道了，以后不显示">知道了</button></div>;
}

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
