import { useEffect, useMemo, useState } from "react";
import type { Api } from "../api";
import { INTERNAL_MEMORY_PREFIX } from "../projectFlags";
import { composeWiki, parsePitfall, projectColor, slugify, WIKI_KINDS, type Pitfall, type WikiKind } from "../derive";
import type { Memory } from "../types";
import { Markdown } from "./Markdown";
import { useItemMenu, useViewMenuExtras } from "./ContextMenu";

interface Props { api: Api; projects: string[]; version: number; onSelectTask: (id: string) => void; onDone: (m: string) => void; onError: (m: string) => void }

const KINDS = Object.keys(WIKI_KINDS) as WikiKind[];
// The body row says what the text is, not the kind again (the badge above already does).
const BODY_LABEL: Record<WikiKind, string> = { pit: "现象", win: "做法", retro: "做了", howto: "步骤" };
type Filter = "useful" | WikiKind | "all" | "plain";

// The wiki: every Agent's pits, wins, retros and howtos, stored as bd memories.
// `dispatch prime` injects only the current project's entries at session start;
// the rest is searched on demand — so this view is the place to browse everything.
export function PitfallsView({ api, projects, version, onSelectTask, onDone, onError }: Props) {
  const [memories, setMemories] = useState<Memory[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [q, setQ] = useState("");
  // Retros are generated at every task close and outnumber everything; browse the hand-written kinds by default.
  const [filter, setFilter] = useState<Filter>("useful");
  const [editing, setEditing] = useState<Pitfall | null>(null);
  const [adding, setAdding] = useState<WikiKind | null>(null);

  const load = async () => {
    try { setMemories(await api.memories()); setLoaded(true); } catch (e) { onError(String(e)); }
  };
  useEffect(() => { load(); }, [version]);

  // Dispatch's own bookkeeping (project 收藏/归档) shares the memory store but is not knowledge.
  const all = useMemo(() => memories.filter((m) => !m.key.startsWith(INTERNAL_MEMORY_PREFIX)).map(parsePitfall), [memories]);
  const counts = useMemo(() => {
    const c: Record<string, number> = { all: 0, plain: 0 };
    for (const k of KINDS) c[k] = 0;
    for (const p of all) { if (p.kind) { c[p.kind]++; c.all++; } else c.plain++; }
    return c;
  }, [all]);
  const items = useMemo(() => {
    const qq = q.trim().toLowerCase();
    return all.filter((p) => (filter === "all" ? !!p.kind : filter === "useful" ? !!p.kind && p.kind !== "retro" : filter === "plain" ? !p.kind : p.kind === filter) && (!qq || p.raw.toLowerCase().includes(qq) || p.key.toLowerCase().includes(qq))).reverse();
  }, [all, q, filter]);

  const save = async (key: string, value: string) => {
    try { await api.remember(key, value); onDone("已记录。同项目的 Agent 下次会话启动会看到"); setAdding(null); setEditing(null); await load(); } catch (e) { onError(String(e)); }
  };
  const forget = async (key: string) => {
    try { await api.forget(key); onDone("已删除"); await load(); } catch (e) { onError(String(e)); }
  };
  useItemMenu("wiki", (key) => {
    const p = all.find((x) => x.key === key);
    if (!p) return null;
    return { title: p.key, items: [
      ...(p.kind ? [{ label: "编辑", onClick: () => setEditing(p) }] : []),
      { label: "复制内容", onClick: () => api.copy(p.raw).then(() => onDone("已复制")) },
      { label: "复制 key", onClick: () => api.copy(p.key).then(() => onDone("已复制")) },
      ...(p.task ? [{ label: `打开任务 ${p.task}`, onClick: () => onSelectTask(p.task) }] : []),
      ...(p.project ? [{ label: `只看 ${p.project} 的条目`, onClick: () => setQ(p.project) }] : []),
      "-",
      { label: "删除", danger: true, onClick: () => forget(p.key) },
    ] };
  }, [all, api]);
  useViewMenuExtras([
    { label: "记一个坑", onClick: () => setAdding("pit") },
    { label: "记一件做对的事", onClick: () => setAdding("win") },
    { label: "记一个方法", onClick: () => setAdding("howto") },
    { label: "刷新", onClick: () => void load() },
  ], []);

  return (
    <div className="pit-wrap">
      <div className="pit-head">
        <label className="search" style={{ width: 280 }}>🔍<input placeholder="搜：关键词、项目、任务 ID…" value={q} onChange={(e) => setQ(e.target.value)} /></label>
        <button className={`chip${filter === "useful" ? " on" : ""}`} onClick={() => setFilter("useful")} title="坑、做对、方法：手写的经验，不含自动复盘">常用 {counts.all - counts.retro}</button>
        <button className={`chip${filter === "all" ? " on" : ""}`} onClick={() => setFilter("all")}>全部 {counts.all}</button>
        {KINDS.map((k) => <button key={k} className={`chip${filter === k ? " on" : ""}`} onClick={() => setFilter(k)}>{WIKI_KINDS[k].label} {counts[k]}</button>)}
        {counts.plain > 0 && <button className={`chip${filter === "plain" ? " on" : ""}`} onClick={() => setFilter("plain")}>其他记忆 {counts.plain}</button>}
        <span className="spacer" />
        <button className="btn primary" onClick={() => setAdding("pit")}>＋ 记一个坑</button>
        <button className="btn ghost" onClick={() => setAdding("win")}>＋ 做对的事</button>
        <button className="btn ghost" onClick={() => setAdding("howto")}>＋ 方法</button>
      </div>
      <p className="pit-hint">所有 Agent 共用的知识库（Beads memory）。会话启动时 <span className="mono">dispatch prime</span> 只注入当前项目 + 通用条目；其余 Agent 用 <span className="mono">dispatch wiki search 关键词</span> 按需查。任务收尾 <span className="mono">dispatch done --retro</span> 会自动生成一条复盘。</p>
      {!loaded && <div className="empty">载入中…</div>}
      {loaded && items.length === 0 && <div className="empty">还没有记录。</div>}
      <div className="pit-list">
        {items.map((p) => (
          <div key={p.key} data-menu="wiki" data-id={p.key} className={`pit ${p.kind ?? "plain"}`}>
            <div className="pit-top">
              <span className={`kind ${p.kind ?? "plain"}`}>{p.kind ? WIKI_KINDS[p.kind].label : "记忆"}</span>
              <span className="mono key">{p.key}</span>
              {p.project && <span className="tag"><span className="proj" style={{ background: projectColor(p.project) }} />{p.project}</span>}
              {p.task && <button className="link mono" onClick={() => onSelectTask(p.task)}>{p.task}</button>}
              <span className="spacer" />
              <span className="pit-actions">{p.kind && <button className="btn ghost sm" onClick={() => setEditing(p)}>编辑</button>}<button className="btn ghost sm danger" onClick={() => forget(p.key)}>删除</button></span>
            </div>
            <div className="pit-row"><span className={`lbl ${p.kind === "pit" ? "trap" : p.kind ?? "plain"}`}>{p.kind ? BODY_LABEL[p.kind] : "记忆"}</span><Markdown src={p.text} className="compact" /></div>
            {p.kind && WIKI_KINDS[p.kind].fields.map((f) => p.fields[f.label] ? (
              <div key={f.name} className="pit-row"><span className={`lbl ${f.name === "fix" || f.name === "good" ? "fix" : f.name === "bad" ? "trap" : "plain"}`}>{f.label.replace(/[【】]/g, "")}</span><Markdown src={p.fields[f.label]} className="compact" /></div>
            ) : null)}
          </div>
        ))}
      </div>
      {(adding || editing) && (
        <WikiDialog initial={editing} kind={editing?.kind ?? adding ?? "pit"} projects={projects} onCancel={() => { setAdding(null); setEditing(null); }} onSave={save} />
      )}
    </div>
  );
}

function WikiDialog({ initial, kind: kind0, projects, onCancel, onSave }: { initial: Pitfall | null; kind: WikiKind; projects: string[]; onCancel: () => void; onSave: (key: string, value: string) => Promise<void> }) {
  const [kind, setKind] = useState<WikiKind>(kind0);
  const [text, setText] = useState(initial?.text ?? "");
  const [fields, setFields] = useState<Record<string, string>>(() => {
    const f: Record<string, string> = {};
    if (initial?.kind) for (const d of WIKI_KINDS[initial.kind].fields) f[d.name] = initial.fields[d.label] ?? "";
    return f;
  });
  const [project, setProject] = useState(initial?.project ?? "");
  const [task, setTask] = useState(initial?.task ?? "");
  const [key, setKey] = useState(initial?.key ?? "");
  const [busy, setBusy] = useState(false);
  const def = WIKI_KINDS[kind];
  const finalKey = key.trim() || `${def.prefix}${slugify(text)}`;
  const submit = async () => {
    if (!text.trim() || busy) return;
    setBusy(true);
    try { await onSave(finalKey, composeWiki(kind, text, fields, project, task)); } finally { setBusy(false); }
  };
  const textHint: Record<WikiKind, string> = { pit: "踩到了什么（现象 + 原因），例如：Tauri 命令写成同步 fn 会在主线程跑，UI 直接冻住", win: "什么做法被证明是对的，例如：邮件草稿停在发送界面等用户确认", retro: "这个任务做了什么", howto: "一套可复用的步骤 / 命令" };
  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onCancel()}>
      <div className="dialog" role="dialog" aria-label="知识库" onKeyDown={(e) => { if (e.key === "Escape") onCancel(); if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) submit(); }}>
        <h3>{initial ? "编辑" : "记一条"}{!initial && <span className="chips" style={{ marginLeft: 10 }}>{KINDS.map((k) => <button key={k} className={`chip${kind === k ? " on" : ""}`} onClick={() => setKind(k)}>{WIKI_KINDS[k].label}</button>)}</span>}</h3>
        <label>{def.label}<textarea autoFocus value={text} onChange={(e) => setText(e.target.value)} placeholder={textHint[kind]} /></label>
        {def.fields.map((f) => (
          <label key={f.name}>{f.label.replace(/[【】]/g, "")}<textarea value={fields[f.name] ?? ""} onChange={(e) => setFields({ ...fields, [f.name]: e.target.value })} placeholder={f.hint} /></label>
        ))}
        <div className="row">
          <label>项目<input list="pit-projects" value={project} onChange={(e) => setProject(e.target.value)} placeholder="kanban" /><datalist id="pit-projects">{projects.map((p) => <option key={p} value={p} />)}</datalist></label>
          <label>关联任务<input value={task} onChange={(e) => setTask(e.target.value)} placeholder="task-9lo" /></label>
          <label>key<input value={key} onChange={(e) => setKey(e.target.value)} placeholder={finalKey} disabled={!!initial} /></label>
        </div>
        <div className="foot">
          <button className="btn ghost" onClick={onCancel}>取消</button>
          <button className="btn primary" disabled={!text.trim() || busy} onClick={submit}>保存 ⌘⏎</button>
        </div>
      </div>
    </div>
  );
}
