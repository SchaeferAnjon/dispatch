import { useEffect, useMemo, useState, type ReactNode } from "react";
import type { Api } from "../api";
import { INTERNAL_MEMORY_PREFIX } from "../projectFlags";
import { composeWiki, parsePitfall, projectColor, slugify, WIKI_KINDS, type Pitfall, type WikiKind } from "../derive";
import type { Memory } from "../types";
import { Markdown } from "./Markdown";
import { useItemMenu, useViewMenuExtras } from "./ContextMenu";
import { useLocale, useT } from "../i18n";
import { EmptyView, ListDetail, Meta, Row, Sep, Tabs, Tag, useListKeyboard, type TagColor } from "./primitives";
import { About, DetailHead, DetailSection, SearchField, revealDetail } from "./PageParts";
import { useShellHeader } from "./Shell";
import { Icon } from "./icons";

interface Props { api: Api; projects: string[]; version: number; onSelectTask: (id: string) => void; onDone: (m: string) => void; onError: (m: string) => void }

const KINDS = Object.keys(WIKI_KINDS) as WikiKind[];
// The body row says what the text is, not the kind again (the badge above already does).
const BODY_LABEL: Record<WikiKind, string> = { pit: "现象", win: "做法", retro: "做了", howto: "步骤" };
type Filter = "useful" | WikiKind | "all" | "plain";

// The wiki: every Agent's pits, wins, retros and howtos, stored as bd memories.
// `dispatch prime` injects only the current project's entries at session start;
// the rest is searched on demand — so this view is the place to browse everything.
export function PitfallsView({ api, projects, version, onSelectTask, onDone, onError }: Props) {
  const t = useT();
  const [memories, setMemories] = useState<Memory[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [q, setQ] = useState("");
  // Retros are generated at every task close and outnumber everything; browse the hand-written kinds by default.
  const [filter, setFilter] = useState<Filter>("useful");
  const [editing, setEditing] = useState<Pitfall | null>(null);
  const [adding, setAdding] = useState<WikiKind | null>(null);

  const load = async () => {
    try { setMemories(await api.memories()); } catch (e) { onError(String(e)); } finally { setLoaded(true); }  // a failed read is an empty page with an error, not 「载入中…」 forever
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
    try { await api.remember(key, value); onDone(t("已记录。同项目的 Agent 下次会话启动会看到")); setAdding(null); setEditing(null); await load(); } catch (e) { onError(String(e)); }
  };
  // Two clicks to delete: the button is revealed on hover, one slip should not lose a note.
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);
  const forget = async (key: string) => {
    if (pendingDelete !== key) { setPendingDelete(key); window.setTimeout(() => setPendingDelete((k) => (k === key ? null : k)), 4000); return; }
    setPendingDelete(null);
    try { await api.forget(key); onDone(t("已删除")); await load(); } catch (e) { onError(String(e)); }
  };
  useItemMenu("wiki", (key) => {
    const p = all.find((x) => x.key === key);
    if (!p) return null;
    return { title: p.key, items: [
      ...(p.kind ? [{ label: t("编辑"), onClick: () => setEditing(p) }] : []),
      { label: t("复制内容"), onClick: () => api.copy(p.raw).then(() => onDone(t("已复制"))) },
      { label: t("复制 key"), onClick: () => api.copy(p.key).then(() => onDone(t("已复制"))) },
      ...(p.task ? [{ label: t("打开任务 {id}", { id: p.task }), onClick: () => onSelectTask(p.task) }] : []),
      ...(p.project ? [{ label: t("只看 {project} 的条目", { project: p.project }), onClick: () => setQ(p.project) }] : []),
      "-",
      { label: t("删除"), danger: true, onClick: () => forget(p.key) },
    ] };
  }, [all, api]);
  useViewMenuExtras([
    { label: t("记一个坑"), onClick: () => setAdding("pit") },
    { label: t("记一件做对的事"), onClick: () => setAdding("win") },
    { label: t("记一个方法"), onClick: () => setAdding("howto") },
    { label: t("重新读取知识库"), onClick: () => void load() },
  ], []);

  const locale = useLocale();
  useShellHeader({
    subtitle: t("{n} 条", { n: counts.all + counts.plain }),
    actions: <button className="btn sm" onClick={() => setAdding("pit")} title={t("记一个坑、一件做对的事或一个方法")} aria-label={t("记一条")}><Icon name="plus" size={14} /><span className="ak-hd-lbl">{t("记一条")}</span></button>,
  }, [counts.all, counts.plain, locale]);
  const [picked, setPicked] = useState<string | null>(null);
  const cur = items.find((p) => p.key === picked) ?? items[0] ?? null;
  useListKeyboard(items.map((p) => p.key), cur?.key ?? null, setPicked, { enabled: !adding && !editing });
  const KIND_COLOR: Record<WikiKind, TagColor | undefined> = { pit: "orange", win: "green", howto: "blue", retro: undefined };
  const kindTag = (p: Pitfall) => <Tag color={p.kind ? KIND_COLOR[p.kind] : undefined}>{p.kind ? t(WIKI_KINDS[p.kind].label) : t("记忆")}</Tag>;
  // The first line of the text, without markdown marks, is the row title.
  const headline = (p: Pitfall) => (p.text.split("\n").find((l) => l.trim()) ?? p.key).replace(/[#*`>_]/g, "").trim();

  const tabs = (
    <Tabs items={[
      { key: "useful" as Filter, label: t("常用"), count: counts.all - counts.retro, title: t("坑、做对、方法：手写的经验，不含自动复盘") },
      { key: "all" as Filter, label: t("全部"), count: counts.all },
      ...KINDS.map((k) => ({ key: k as Filter, label: t(WIKI_KINDS[k].label), count: counts[k] })),
      ...(counts.plain > 0 ? [{ key: "plain" as Filter, label: t("其他记忆"), count: counts.plain }] : []),
    ]} value={filter} onChange={setFilter}
      right={<span className="ak-tools"><SearchField value={q} onChange={setQ} placeholder={t("搜：关键词、项目、任务 ID…")} /></span>} />
  );

  const detail = cur ? (
    <div className="ak-detail" data-menu="wiki" data-id={cur.key}>
      <DetailHead crumb={[t("知识库"), cur.project]} title={headline(cur)} tag={kindTag(cur)}
        actions={<>
          {cur.kind && <button className="btn sm" title={t("编辑 {key}", { key: cur.key })} onClick={() => setEditing(cur)}>{t("编辑")}</button>}
          <button className="btn sm ghost" onClick={() => api.copy(cur.raw).then(() => onDone(t("已复制")))}>{t("复制内容")}</button>
          <button className={`btn sm ghost danger${pendingDelete === cur.key ? " confirm" : ""}`} title={t("删除 {key}", { key: cur.key })} onClick={() => forget(cur.key)}>{pendingDelete === cur.key ? t("再点一次确认删除") : t("删除")}</button>
        </>} />
      <Meta rows={[
        ["key", <span className="mono sel-text">{cur.key}</span>],
        ...(cur.project ? [[t("项目"), <span className="ak-proj"><span className="proj" style={{ background: projectColor(cur.project) }} />{cur.project}</span>] as [ReactNode, ReactNode]] : []),
        ...(cur.task ? [[t("关联任务"), <button className="link mono" onClick={() => onSelectTask(cur.task)}>{cur.task}</button>] as [ReactNode, ReactNode]] : []),
      ]} />
      <Sep />
      <DetailSection title={cur.kind ? t(BODY_LABEL[cur.kind]) : t("记忆")}><div className="akd-md"><Markdown src={cur.text} className="compact" /></div></DetailSection>
      {cur.kind && WIKI_KINDS[cur.kind].fields.map((f) => cur.fields[f.label] ? (
        <DetailSection key={f.name} title={t(f.label.replace(/[【】]/g, ""))}><div className="akd-md"><Markdown src={cur.fields[f.label]} className="compact" /></div></DetailSection>
      ) : null)}
    </div>
  ) : null;

  return (
    <>
      <ListDetail className="ak-page ak-wiki" tabs={tabs} detail={detail}>
        {!loaded && <p className="akd-note ak-pad">{t("载入中…")}</p>}
        {loaded && items.length === 0 && <EmptyView icon="book" title={q ? t("没有匹配的记录") : t("还没有记录。")} description={t("踩了坑、做对了什么、摸出一套方法，都记在这里，所有 Agent 共用。")} actions={<button className="btn sm" onClick={() => setAdding("pit")}>{t("记一条")}</button>} />}
        {items.map((p) => (
          <Row key={p.key} id={p.key} data-menu="wiki" data-id={p.key} selected={cur?.key === p.key} onClick={() => { setPicked(p.key); revealDetail(); }} onOpen={() => p.kind && setEditing(p)}
            icon={<Icon name="book" filled={cur?.key === p.key} />} title={headline(p)} tooltip={p.key}
            accessories={[kindTag(p), ...(p.task ? [<span className="mono">{p.task}</span>] : [])]} />
        ))}
        {loaded && <About summary={t("关于知识库")}><p>{t("所有 Agent 共用的知识库（Beads memory）。会话启动时 dispatch prime 只注入当前项目 + 通用条目；其余 Agent 用 dispatch wiki search 关键词 按需查。任务收尾 dispatch done --retro 会自动生成一条复盘。")}</p></About>}
      </ListDetail>
      {(adding || editing) && (
        <WikiDialog initial={editing} kind={editing?.kind ?? adding ?? "pit"} projects={projects} onCancel={() => { setAdding(null); setEditing(null); }} onSave={save} />
      )}
    </>
  );
}

function WikiDialog({ initial, kind: kind0, projects, onCancel, onSave }: { initial: Pitfall | null; kind: WikiKind; projects: string[]; onCancel: () => void; onSave: (key: string, value: string) => Promise<void> }) {
  const t = useT();
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
  const textHint: Record<WikiKind, string> = { pit: t("踩到了什么（现象 + 原因），例如：Tauri 命令写成同步 fn 会在主线程跑，UI 直接冻住"), win: t("什么做法被证明是对的，例如：邮件草稿停在发送界面等用户确认"), retro: t("这个任务做了什么"), howto: t("一套可复用的步骤 / 命令") };
  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onCancel()}>
      <div className="dialog" role="dialog" aria-label={t("知识库")} onKeyDown={(e) => { if (e.key === "Escape") onCancel(); if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) submit(); }}>
        <h3>{initial ? t("编辑") : t("记一条")}{!initial && <span className="chips" style={{ marginLeft: 10 }}>{KINDS.map((k) => <button key={k} className={`chip${kind === k ? " on" : ""}`} onClick={() => setKind(k)}>{t(WIKI_KINDS[k].label)}</button>)}</span>}</h3>
        <label>{t(def.label)}<textarea autoFocus value={text} onChange={(e) => setText(e.target.value)} placeholder={textHint[kind]} /></label>
        {def.fields.map((f) => (
          <label key={f.name}>{t(f.label.replace(/[【】]/g, ""))}<textarea value={fields[f.name] ?? ""} onChange={(e) => setFields({ ...fields, [f.name]: e.target.value })} placeholder={t(f.hint)} /></label>
        ))}
        <div className="row">
          <label>{t("项目")}<input list="pit-projects" value={project} onChange={(e) => setProject(e.target.value)} placeholder="kanban" /><datalist id="pit-projects">{projects.map((p) => <option key={p} value={p} />)}</datalist></label>
          <label>{t("关联任务")}<input value={task} onChange={(e) => setTask(e.target.value)} placeholder="task-9lo" /></label>
          <label>key<input value={key} onChange={(e) => setKey(e.target.value)} placeholder={finalKey} disabled={!!initial} /></label>
        </div>
        <div className="foot">
          <button className="btn ghost" onClick={onCancel}>{t("取消")}</button>
          <button className="btn primary" disabled={!text.trim() || busy} onClick={submit}>{t("保存 {mod}⏎")}</button>
        </div>
      </div>
    </div>
  );
}
