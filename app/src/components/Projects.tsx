import { useEffect, useMemo, useState } from "react";
import type { Api } from "../api";
import { actorOf, projectColor, projectOf, relTime, statusLabel } from "../derive";
import type { Folder, Issue } from "../types";
import { Avatar, Pri } from "./ui";

interface Props { api: Api; me: string; issues: Issue[]; onSelect: (id: string) => void; onBoard: (project: string) => void; onFolder: () => void }

const AGENT_ORDER = ["claude-code", "codex", "pi", "zcode", "qoder", "qoder-ide"];

// A project is a label on the board; a folder is where the work happened.
// This view is the label side: tasks by status, who worked on them, and the
// folders whose name matches.
export function ProjectsView({ api, me, issues, onSelect, onBoard, onFolder }: Props) {
  const [folders, setFolders] = useState<Folder[]>([]);
  const [sel, setSel] = useState<string | null>(null);
  useEffect(() => { let alive = true; api.folders().then((f) => { if (alive) setFolders(f); }).catch(() => {}); return () => { alive = false; }; }, [api]);

  const projects = useMemo(() => {
    const m = new Map<string, Issue[]>();
    for (const i of issues) (m.get(projectOf(i)) ?? m.set(projectOf(i), []).get(projectOf(i))!).push(i);
    return [...m.entries()].map(([name, list]) => {
      const open = list.filter((i) => i.status !== "closed").length;
      const prog = list.filter((i) => i.status === "in_progress").length;
      const review = list.filter((i) => i.status === "closed" && !(i.labels ?? []).includes("reviewed")).length;
      const done = list.filter((i) => i.status === "closed").length;
      const last = list.reduce((a, i) => (i.updated_at > a ? i.updated_at : a), "");
      const agents = new Map<string, number>();
      for (const i of list) { const a = actorOf(i.assignee, me); if (a && a.kind !== "human") agents.set(a.id, (agents.get(a.id) ?? 0) + 1); }
      return { name, list, open, prog, review, done, last, agents };
    }).sort((a, b) => (a.name === "" ? 1 : b.name === "" ? -1 : b.last.localeCompare(a.last)));
  }, [issues, me]);
  useEffect(() => { if (!sel && projects[0]) setSel(projects[0].name); }, [projects, sel]);
  const cur = projects.find((p) => p.name === sel) ?? null;
  const curFolders = useMemo(() => (cur ? folders.filter((f) => f.name.toLowerCase() === cur.name.toLowerCase() || f.tasks.some((t) => cur.list.some((i) => i.id === t))) : []), [cur, folders]);
  const groups: { key: string; label: string; cls: string; items: Issue[] }[] = cur ? [
    { key: "prog", label: "进行中", cls: "prog", items: cur.list.filter((i) => i.status === "in_progress") },
    { key: "todo", label: "待办", cls: "open", items: cur.list.filter((i) => i.status === "open" || i.status === "blocked" || i.status === "deferred") },
    { key: "review", label: "已完成 · 待审", cls: "done", items: cur.list.filter((i) => i.status === "closed" && !(i.labels ?? []).includes("reviewed")) },
    { key: "rev", label: "已审核", cls: "rev", items: cur.list.filter((i) => i.status === "closed" && (i.labels ?? []).includes("reviewed")) },
  ] : [];

  return (
    <div className="proj-wrap">
      <div className="sess-side">
        <div className="sess-tools"><div className="muted small">{projects.length} 个项目 · 按最近更新排序</div></div>
        <div className="sess-items">
          {projects.map((p) => (
            <button key={p.name || "_"} className={`proj-item${sel === p.name ? " sel" : ""}`} onClick={() => setSel(p.name)}>
              <div className="l1"><span className="proj" style={{ background: projectColor(p.name) }} /><span className="t">{p.name || "未分项目"}</span><span className="ago mono">{p.last ? relTime(p.last) : ""}</span></div>
              <div className="l2">
                {p.prog > 0 && <span className="st sm prog">{p.prog} 在做</span>}
                {p.review > 0 && <span className="st sm done">{p.review} 待审</span>}
                <span className="muted">{p.open} 未完成 · {p.done} 已完成</span>
              </div>
              {p.agents.size > 0 && <div className="l3">{AGENT_ORDER.filter((a) => p.agents.has(a)).map((a) => { const ac = actorOf(a, me)!; return <span key={a} className="ag"><span className={`av ${ac.kind}`} style={{ width: 14, height: 14, fontSize: 7 }}>{ac.glyph}</span>{p.agents.get(a)}</span>; })}</div>}
            </button>
          ))}
        </div>
      </div>
      <div className="sess-main">
        {!cur && <div className="empty">还没有项目。任务用标签 <span className="mono">project:名字</span> 归类后会出现在这里。</div>}
        {cur && (
          <>
            <div className="sess-head">
              <span className="proj" style={{ background: projectColor(cur.name), width: 12, height: 12, borderRadius: 3 }} />
              <div style={{ minWidth: 0, flex: 1 }}>
                <div className="ttl">{cur.name || "未分项目"}</div>
                <div className="sub">{cur.list.length} 个任务 · {cur.open} 未完成 · 最近更新 {cur.last ? relTime(cur.last) : "—"}</div>
              </div>
              <button className="btn sm" onClick={() => onBoard(cur.name)}>在看板里筛选 ›</button>
            </div>
            <div className="sess-meta kv">
              <b>参与的 Agent</b><span>{cur.agents.size ? AGENT_ORDER.filter((a) => cur.agents.has(a)).map((a) => `${actorOf(a, me)!.name} ${cur.agents.get(a)} 项`).join(" · ") : "—"}</span>
              <b>对应文件夹</b><span className="task-links">{curFolders.length ? curFolders.map((f) => <button key={f.cwd} className="chip" onClick={onFolder} title={f.cwd}><span className="mono">{f.cwd.replace(/^\/Users\/[^/]+/, "~")}</span><span className="muted">{f.sessions} 会话</span></button>) : <span className="muted">没有同名目录的会话记录</span>}</span>
            </div>
            <div className="sess-body">
              {groups.filter((g) => g.items.length).map((g) => (
                <section key={g.key} className="proj-group">
                  <h4><span className={`st sm ${g.cls}`}>{g.label}</span><span className="muted">{g.items.length}</span></h4>
                  {g.items.map((i) => {
                    const a = actorOf(i.assignee, me); const st = statusLabel(i);
                    return (
                      <div key={i.id} className="proj-row opens" onClick={() => onSelect(i.id)} role="button" tabIndex={0}>
                        <Pri p={i.priority} />
                        <span className="t">{i.title}</span>
                        <span className="mono muted small">{i.id}</span>
                        {a ? <span className="who-i"><Avatar actor={a} />{a.name}</span> : <span className="muted small">未认领</span>}
                        <span className={`st sm ${st.cls}`}>{st.text}</span>
                        <span className="mono muted small right">{relTime(i.updated_at)}</span>
                      </div>
                    );
                  })}
                </section>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
