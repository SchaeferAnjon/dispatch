import { useEffect, useState } from "react";
import type { View } from "../types";

// One sentence per view, shown under the title until dismissed. Plain words,
// no product jargon: what you see here and what to do with it.
export const VIEW_INTRO: Partial<Record<View, string>> = {
  home: "每天打开先看这里：哪些 Agent 在跑、做到哪一步、额度还剩多少。额度是各 Agent 自己上报的——Claude Code 每答一句就更新，Codex 用一次才更新。",
  inbox: "需要你动手的都在这：Agent 答完等你回话的会话、Agent 说做完了等你验收的任务、被卡住的任务。别的页面可以不看，这页要看。",
  board: "所有任务，三列对应工作进度：待办 → 进行中 → 已完成；Agent 复核单独记录。卡片上的「源自」是它属于哪条线。你只需要看，认领和推进都由 Agent 做。",
  table: "和看板同一份任务，换成表格，适合排序和扫一眼。",
  graph: "任务是一根线：左边是源头，右边是它派生出来的。悬停或点一个节点，整条线高亮。",
  projects: "按项目看：每个项目有多少任务在做、已完成和待 Agent 复核，参与过哪些 Agent，对应哪个文件夹。",
  folders: "按文件夹看：这个目录下你和哪些 Agent 聊过、每次聊了什么（开头那句话就是主题），点进去看完整聊天记录。",
  agents: "每个 Agent 现在开着几个窗口、在哪个目录、在跑还是等你；「打开」直接切到那个窗口。",
  sessions: "所有聊天记录：Claude Code / Codex / ZCode 的每一次对话，按时间排。点开能看时间线、改了哪些文件、派了哪些子 Agent，还能一键复制恢复命令回到那次对话。",
  skills: "技能池：每个技能给哪些 Agent 挂着。改 SKILL.md 就是改 Agent 的做事方法。",
  rules: "这台电脑上所有 Agent 都遵守的规则，只有这一份；改完自动同步到 Claude Code、Codex、ZCode。",
  pitfalls: "踩过的坑和解法。每个 Agent 新开会话时会自动读到，所以同一个坑不会踩第二次。",
};

const STEPS: { title: string; body: string; view: View }[] = [
  { title: "这是一个观察窗，不是待办软件", body: "任务、进度、聊天记录都是各个 Agent（Claude Code、Codex、ZCode）自己写进来的。你在这里看，不需要建任务、认领任务。", view: "home" },
  { title: "每天先看「等你」", body: "Agent 答完等你回话、做完等你验收、或者被卡住——只有这些事需要你。数字变红就是有事。", view: "inbox" },
  { title: "任务在哪、从哪来", body: "「全部任务」是四列看板；「脉络」把任务连成线，看它怎么从一个想法分叉出来；「项目」和「文件夹」是两种分组方式。", view: "board" },
  { title: "聊天记录", body: "「聊天记录」列出每一次对话，能看时间线、改动、子 Agent，还能一键复制恢复命令回到那次对话。「文件夹」是按目录看聊天。", view: "sessions" },
  { title: "知识：技能、规则、踩坑", body: "技能决定 Agent 会做什么，规则决定它怎么做，踩坑让它别再犯。三样都是一份改、处处生效。", view: "skills" },
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
