import { useEffect, useMemo, useState } from "react";
import type { Api } from "../api";
import { composePitfall, parsePitfall, projectColor, slugify, type Pitfall } from "../derive";
import type { Memory } from "../types";
import { Markdown } from "./Markdown";

interface Props { api: Api; projects: string[]; version: number; onSelectTask: (id: string) => void; onDone: (m: string) => void; onError: (m: string) => void }

export function PitfallsView({ api, projects, version, onSelectTask, onDone, onError }: Props) {
  const [memories, setMemories] = useState<Memory[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [q, setQ] = useState("");
  const [showAll, setShowAll] = useState(false);
  const [editing, setEditing] = useState<Pitfall | null>(null);
  const [adding, setAdding] = useState(false);

  const load = async () => {
    try { setMemories(await api.memories()); setLoaded(true); } catch (e) { onError(String(e)); }
  };
  useEffect(() => { load(); }, [version]);

  const items = useMemo(() => {
    const all = memories.map(parsePitfall);
    const qq = q.trim().toLowerCase();
    return all.filter((p) => (showAll || p.isPit) && (!qq || p.raw.toLowerCase().includes(qq) || p.key.toLowerCase().includes(qq)));
  }, [memories, q, showAll]);

  const save = async (key: string, value: string) => {
    try { await api.remember(key, value); onDone("已记录，所有 Agent 下次会话启动就能看到"); setAdding(false); setEditing(null); await load(); } catch (e) { onError(String(e)); }
  };
  const forget = async (key: string) => {
    try { await api.forget(key); onDone("已删除"); await load(); } catch (e) { onError(String(e)); }
  };

  return (
    <div className="pit-wrap">
      <div className="pit-head">
        <label className="search" style={{ width: 300 }}>🔍<input placeholder="搜坑：关键词、项目、任务 ID…" value={q} onChange={(e) => setQ(e.target.value)} /></label>
        <button className={`chip${showAll ? " on" : ""}`} onClick={() => setShowAll(!showAll)}>{showAll ? "显示全部记忆" : "只看踩坑"}</button>
        <span className="muted mono small">{items.length} 条</span>
        <span className="spacer" />
        <button className="btn primary" onClick={() => setAdding(true)}>＋ 记一个坑</button>
      </div>
      <p className="pit-hint">存在 Beads 的 memory 里（<span className="mono">bd remember</span>）。每个 Agent 新会话启动时 <span className="mono">bd prime</span> 会把这些全部注入上下文；随时可用 <span className="mono">bd memories 关键词</span> 搜。</p>
      {!loaded && <div className="empty">载入中…</div>}
      {loaded && items.length === 0 && <div className="empty">还没有记录。踩到坑就点右上角记下来。</div>}
      <div className="pit-list">
        {items.map((p) => (
          <div key={p.key} className={`pit${p.isPit ? "" : " plain"}`}>
            <div className="pit-top">
              <span className="mono key">{p.key}</span>
              {p.project && <span className="tag"><span className="proj" style={{ background: projectColor(p.project) }} />{p.project}</span>}
              {p.task && <button className="link mono" onClick={() => onSelectTask(p.task)}>{p.task}</button>}
              <span className="spacer" />
              <button className="btn ghost sm" onClick={() => setEditing(p)}>编辑</button>
              <button className="btn ghost sm danger" onClick={() => forget(p.key)}>删除</button>
            </div>
            {p.isPit ? (
              <>
                <div className="pit-row"><span className="lbl trap">坑</span><Markdown src={p.trap} className="compact" /></div>
                {p.fix && <div className="pit-row"><span className="lbl fix">解法</span><Markdown src={p.fix} className="compact" /></div>}
              </>
            ) : (
              <div className="pit-row"><span className="lbl">记忆</span><Markdown src={p.raw} className="compact" /></div>
            )}
          </div>
        ))}
      </div>
      {(adding || editing) && (
        <PitfallDialog initial={editing} projects={projects} onCancel={() => { setAdding(false); setEditing(null); }} onSave={save} />
      )}
    </div>
  );
}

function PitfallDialog({ initial, projects, onCancel, onSave }: { initial: Pitfall | null; projects: string[]; onCancel: () => void; onSave: (key: string, value: string) => Promise<void> }) {
  const [trap, setTrap] = useState(initial?.trap ?? "");
  const [fix, setFix] = useState(initial?.fix ?? "");
  const [project, setProject] = useState(initial?.project ?? "");
  const [task, setTask] = useState(initial?.task ?? "");
  const [key, setKey] = useState(initial?.key ?? "");
  const [busy, setBusy] = useState(false);
  const finalKey = key.trim() || `pit-${slugify(trap)}`;
  const submit = async () => {
    if (!trap.trim() || busy) return;
    setBusy(true);
    try { await onSave(finalKey, composePitfall(trap, fix, project, task)); } finally { setBusy(false); }
  };
  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onCancel()}>
      <div className="dialog" role="dialog" aria-label="记一个坑" onKeyDown={(e) => { if (e.key === "Escape") onCancel(); if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) submit(); }}>
        <h3>{initial ? "编辑" : "记一个坑"}</h3>
        <label>踩到了什么（现象 + 原因）<textarea autoFocus value={trap} onChange={(e) => setTrap(e.target.value)} placeholder="例如：Tauri 命令写成同步 fn 会在主线程跑，UI 直接冻住" /></label>
        <label>怎么解的<textarea value={fix} onChange={(e) => setFix(e.target.value)} placeholder="例如：全部改 async fn + spawn_blocking" /></label>
        <div className="row">
          <label>项目<input list="pit-projects" value={project} onChange={(e) => setProject(e.target.value)} placeholder="kanban" /><datalist id="pit-projects">{projects.map((p) => <option key={p} value={p} />)}</datalist></label>
          <label>关联任务<input value={task} onChange={(e) => setTask(e.target.value)} placeholder="task-9lo" /></label>
          <label>key<input value={key} onChange={(e) => setKey(e.target.value)} placeholder={finalKey} disabled={!!initial} /></label>
        </div>
        <div className="foot">
          <button className="btn ghost" onClick={onCancel}>取消</button>
          <button className="btn primary" disabled={!trap.trim() || busy} onClick={submit}>保存 ⌘⏎</button>
        </div>
      </div>
    </div>
  );
}
