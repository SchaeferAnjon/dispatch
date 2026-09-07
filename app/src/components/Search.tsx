import { useEffect, useMemo, useRef, useState } from "react";
import { conversationProject, conversationSummary, sessionLifecycle } from "../activity";
import { actorOf, durSince, projectColor, projectOf, relTime, statusLabel } from "../derive";
import type { Activity, Issue } from "../types";
import { Avatar } from "./ui";

interface Props {
  archiveDays: number;
  projects: string[];
  rows: Activity[];
  issues: Issue[];
  me: string;
  onProject: (name: string) => void;
  onSession: (id: string) => void;
  onTask: (id: string) => void;
  onClose: () => void;
}

type Hit = { kind: "project"; key: string; name: string } | { kind: "session"; key: string; a: Activity } | { kind: "task"; key: string; i: Issue };

// One search box for the whole app (⌘K): projects, conversations and tasks in one
// list, so the user never has to know which view a thing lives in first.
export function SearchPalette({ archiveDays, projects, rows, issues, me, onProject, onSession, onTask, onClose }: Props) {
  const [q, setQ] = useState("");
  const [cursor, setCursor] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => { input.current?.focus(); }, []);

  const hits = useMemo<Hit[]>(() => {
    const qq = q.trim().toLowerCase();
    if (!qq) return [];
    const words = qq.split(/\s+/).filter(Boolean);
    const has = (s: string) => { const t = s.toLowerCase(); return words.every((w) => t.includes(w)); };
    const ps = projects.filter((p) => has(p)).slice(0, 5).map((name) => ({ kind: "project", key: `p:${name}`, name }) as Hit);
    const ss = rows.filter((a) => has(`${a.title} ${a.cwd} ${conversationProject(a)} ${a.overview ?? ""}`)).slice(0, 8).map((a) => ({ kind: "session", key: `s:${a.host ?? "local"}:${a.session_id}`, a }) as Hit);
    const ts = issues.filter((i) => has(`${i.title} ${i.id} ${i.assignee ?? ""} ${projectOf(i)} ${i.description ?? ""}`)).sort((a, b) => Number(b.status !== "closed") - Number(a.status !== "closed") || b.updated_at.localeCompare(a.updated_at)).slice(0, 8).map((i) => ({ kind: "task", key: `t:${i.id}`, i }) as Hit);
    return [...ps, ...ss, ...ts];
  }, [q, projects, rows, issues]);
  useEffect(() => { setCursor(0); }, [q]);

  const pick = (h: Hit) => {
    if (h.kind === "project") onProject(h.name);
    else if (h.kind === "session") onSession(h.a.session_id);
    else onTask(h.i.id);
    onClose();
  };
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") { e.preventDefault(); onClose(); }
    if (e.key === "ArrowDown") { e.preventDefault(); setCursor((c) => Math.min(hits.length - 1, c + 1)); }
    if (e.key === "ArrowUp") { e.preventDefault(); setCursor((c) => Math.max(0, c - 1)); }
    if (e.key === "Enter" && hits[cursor]) { e.preventDefault(); pick(hits[cursor]); }
  };
  const groups: { kind: Hit["kind"]; label: string }[] = [{ kind: "project", label: "项目" }, { kind: "session", label: "会话" }, { kind: "task", label: "任务" }];

  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dialog palette" role="dialog" aria-label="搜索" onKeyDown={onKey}>
        <label className="search palette-input">🔍<input ref={input} placeholder="搜项目、会话、任务…" value={q} onChange={(e) => setQ(e.target.value)} /><kbd>esc</kbd></label>
        {q.trim() && hits.length === 0 && <div className="empty">没有匹配的项目、会话或任务</div>}
        {!q.trim() && <div className="palette-hint muted small">输入关键词；↑↓ 选择，⏎ 打开。项目名、会话标题或目录、任务标题或 ID 都能搜。</div>}
        <div className="palette-list">
          {groups.map(({ kind, label }) => {
            const list = hits.filter((h) => h.kind === kind);
            if (!list.length) return null;
            return (
              <section key={kind}>
                <h4>{label} <span className="muted">{list.length}</span></h4>
                {list.map((h) => {
                  const idx = hits.indexOf(h);
                  const cls = `palette-row${idx === cursor ? " on" : ""}`;
                  if (h.kind === "project") return <div key={h.key} className={cls} onMouseEnter={() => setCursor(idx)} onClick={() => pick(h)}><span className="proj" style={{ background: projectColor(h.name) }} /><b>{h.name}</b><span className="muted small">进入项目</span></div>;
                  if (h.kind === "session") return <div key={h.key} className={cls} onMouseEnter={() => setCursor(idx)} onClick={() => pick(h)}><Avatar actor={actorOf(h.a.agent, me)} size={20} /><span className="t"><b>{h.a.starred && "★ "}{h.a.title}</b><span className="sub">{conversationSummary(h.a)}</span></span><span className="muted small right">{sessionLifecycle(h.a, archiveDays) === "archived" && <span className="st sm open">已归档</span>} {conversationProject(h.a)} · {durSince(h.a.last_at)}前</span></div>;
                  const st = statusLabel(h.i);
                  return <div key={h.key} className={cls} onMouseEnter={() => setCursor(idx)} onClick={() => pick(h)}><span className={`st sm ${st.cls}`}>{st.text}</span><span className="t"><b>{h.i.title}</b></span><span className="muted small right mono">{h.i.id} · {relTime(h.i.updated_at)}</span></div>;
                })}
              </section>
            );
          })}
        </div>
      </div>
    </div>
  );
}
