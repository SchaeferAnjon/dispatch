import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { Activity, Host, Issue, MoveJob } from '../types';
import type { Api } from '../api';
import { UNGROUPED_PROJECT, conversationProject, sessionLifecycle } from '../activity';
import { isNeedsYou, linkedSessions, originSession, projectGroups, projectHome, sourceTasks } from '../projectModel';
import { isArchived, isStarred, ownerHostId, newSessionTarget, rankProjects, type ProjectFlags, type ProjectOwner, projectLabel } from '../projectFlags';
import { actorOf, ago, columnOf, projectColor, projectOf, statusLabel } from '../derive';
import { ConversationRows } from './Workspace';
import { Markdown } from './Markdown';
import { MediaContext, MediaProvider, type AttachmentData } from './Media';
import { useOpenSession } from './SessionActions';
import { KINDS } from './Delegate';
import { MenuItem, MenuPanel } from './ContextMenu';

// A research / review / design write-up found in the project's folders or registered by hand.
type Doc = { id: string; title: string; kind: string; path: string; url?: boolean; html?: boolean; size?: number; mtime?: number; ext?: string; dir?: string; source?: string; host?: string; host_name?: string };
const shortPath = (p: string) => p.replace(/^\/(?:Users|home)\/[^/]+/, '~').replace('/Library/Mobile Documents/com~apple~CloudDocs', '/iCloud').replace('/Library/Mobile Documents/iCloud~md~obsidian/Documents', '/Obsidian');
const openExternal = (url: string) => import('@tauri-apps/plugin-opener').then((o) => o.openUrl(url)).catch(() => { window.open(url, '_blank'); });

// Images referenced relatively inside a document are read through the CLI (it only serves files
// next to the document); the Markdown component then renders them like conversation pictures.
function DocMedia({ api, project, id, dir, host, children }: { api: Api; project: string; id: string; dir?: string; host?: string; children: ReactNode }) {
  const read = useCallback((ref: string) => api.on(host || 'local', ['docs', 'read', project, id, '--asset', ref, '--json']).then((t) => { const d = JSON.parse(t.slice(Math.max(0, t.indexOf('{')))) as AttachmentData & { error?: string }; if (d.error) throw new Error(d.error); return d; }), [api, project, id, host]);
  const open = useCallback((ref: string) => { void api.openPath(/^\//.test(ref) ? ref : `${dir || ''}/${ref}`).catch(() => {}); }, [api, dir]);
  const value = useMemo(() => ({ read, open, thumb: () => undefined }), [read, open]);
  return <MediaContext.Provider value={value}>{children}</MediaContext.Provider>;
}

// The project's own short facts (FACTS.md in its folder: servers, logins, who to ask) and the keys tied to it.
// Agents read the file only on demand (`dispatch facts … -P <project>`); values of keys never show here.
type ProjectFactsDoc = { path: string; content: string; exists: boolean; legacy?: { heading: string; body: string }[] };
type ProjectKey = { name: string; note: string; masked: string; length: number; project?: string };
const FACTS_TEMPLATE = (name: string) => `# ${name} 常用信息\n\n> 只放这个项目才用的短事实，Agent 需要时 \`dispatch facts get -P ${name} <主题>\` 读。密码和 Key 不写这里，放「规则与资料 → 密钥与 API」并填项目名。\n\n## 服务器\n\n**示例服务**\n- 入口 / 登录方式 / 找谁开账号\n`;
export function ProjectFactsView({ name, doc, keys, draft, busy, err, onEdit, onChange, onCancel, onSave, onOpenPath, onCopy }: { name: string; doc: ProjectFactsDoc | null; keys: ProjectKey[] | null; draft: string | null; busy: boolean; err: string; onEdit: () => void; onChange: (t: string) => void; onCancel: () => void; onSave: () => void; onOpenPath: (p: string) => void; onCopy: (t: string) => void }) {
  const hasLegacy = !!doc?.legacy?.length;
  return <section className="project-facts" aria-label="项目常用信息">
    <div className="hub-tools"><b>常用信息</b><span className="chip">FACTS.md</span>{doc?.path && <code className="muted small doc-path" title={doc.path}>{shortPath(doc.path)}</code>}<span className="spacer" />
      {draft === null
        ? <>{doc?.exists && <button className="btn sm" onClick={() => onOpenPath(doc.path)}>在 Finder 打开</button>}<button className="btn sm" disabled={busy || !doc} onClick={onEdit}>{doc?.exists ? '编辑' : '建一份'}</button></>
        : <><button className="btn sm" disabled={busy} onClick={onCancel}>取消</button><button className="btn primary sm" disabled={busy} onClick={onSave}>{busy ? '保存中…' : '保存'}</button></>}</div>
    <p className="muted small">只属于这个项目的短事实：服务器入口、登录方式、找谁。Agent 不会每次注入，需要时才 <span className="mono">dispatch facts get -P {name} 主题</span> 读。</p>
    {err && <p className="err small" role="alert">{err}</p>}
    {draft !== null ? <textarea className="project-facts-editor" aria-label="编辑项目常用信息" value={draft} onChange={(e) => onChange(e.target.value)} spellCheck={false} />
      : doc === null ? <p className="empty">正在读…</p>
      : doc.content ? <div className="doc-reader"><Markdown src={doc.content} /></div>
      : <p className="empty">{doc.path ? '还没有 FACTS.md。' : '还不知道这个项目的目录（先在项目目录里开一次会话）。'}{hasLegacy && ' 全局 FACTS.md 里有这个项目的旧节，见下。'}</p>}
    {hasLegacy && draft === null && <details className="project-facts-legacy"><summary className="muted small">全局 FACTS.md 里的旧项目节 · {doc!.legacy!.length}（可搬进项目 FACTS.md）</summary>{doc!.legacy!.map((l) => <div key={l.heading}><h4>{l.heading}</h4><Markdown src={l.body} /></div>)}</details>}
    <div className="hub-tools project-keys-head"><b>密钥</b><span className="muted small">{keys ? `${keys.length} 个 · 只列名字和用途，值在「规则与资料 → 密钥与 API」` : '…'}</span></div>
    {keys && keys.length > 0 && <div className="project-keys">{keys.map((k) => <div className="hub-task project-key" key={k.name}><code className="mono">{k.name}</code><span className="muted small">{k.note || '（没写用途）'}</span><span className="spacer" /><button className="btn sm" title={`dispatch env get ${k.name}`} onClick={() => onCopy(`dispatch env get ${k.name}`)}>复制取用命令</button></div>)}</div>}
    {keys && keys.length === 0 && <p className="empty small">还没有登记到这个项目的密钥。在「规则与资料 → 密钥与 API」添加时项目填 <span className="mono">{name}</span>，或 <span className="mono">dispatch env set 名 值 -P {name}</span>。</p>}
  </section>;
}

export function ProjectFacts({ api, name, onDone }: { api: Api; name: string; onDone?: (m: string) => void }) {
  const [doc, setDoc] = useState<ProjectFactsDoc | null>(null); const [keys, setKeys] = useState<ProjectKey[] | null>(null);
  const [draft, setDraft] = useState<string | null>(null); const [busy, setBusy] = useState(false); const [err, setErr] = useState('');
  const parse = <T,>(t: string, fallback: T): T => { try { const i = Math.min(...[t.indexOf('{'), t.indexOf('[')].filter((x) => x >= 0)); return JSON.parse(t.slice(i)); } catch { return fallback; } };
  const load = useCallback(async () => {
    setErr('');
    const [d, k] = await Promise.allSettled([api.on('local', ['facts', 'show', '-P', name, '--json']), api.on('local', ['env', 'list', '-P', name, '--json'])]);
    setDoc(d.status === 'fulfilled' ? parse<ProjectFactsDoc>(d.value, { path: '', content: '', exists: false }) : { path: '', content: '', exists: false });
    setKeys(k.status === 'fulfilled' ? parse<ProjectKey[]>(k.value, []) : []);
    if (d.status === 'rejected') setErr(String(d.reason));
  }, [api, name]);
  useEffect(() => { setDoc(null); setKeys(null); setDraft(null); void load(); }, [load]);
  const save = async () => { if (draft === null) return; setBusy(true); setErr(''); try { await api.on('local', ['facts', 'write', '-P', name], draft); setDraft(null); onDone?.('已保存 FACTS.md（在项目目录，记得 commit）'); await load(); } catch (e) { setErr(String(e)); } finally { setBusy(false); } };
  return <ProjectFactsView name={name} doc={doc} keys={keys} draft={draft} busy={busy} err={err} onEdit={() => setDraft(doc?.content || FACTS_TEMPLATE(name))} onChange={setDraft} onCancel={() => setDraft(null)} onSave={() => void save()} onOpenPath={(p) => void api.openPath(p).catch(() => {})} onCopy={(t) => void api.copy(t).then(() => onDone?.('已复制')).catch(() => {})} />;
}

export function ProjectDocs({ api, name, docs, onReload }: { api: Api; name: string; docs: Doc[] | null; onReload: () => void }) {
  const [opened, setOpened] = useState<{ doc: Doc; text: string; dir?: string } | null>(null);
  const [err, setErr] = useState(''); const [path, setPath] = useState(''); const [kind, setKind] = useState('调研'); const [busy, setBusy] = useState(false);
  useEffect(() => { setOpened(null); setErr(''); setPath(''); }, [name]);
  const parse = (t: string) => { const d = JSON.parse(t.slice(Math.max(0, t.indexOf('{')))) as { error?: string; [k: string]: unknown }; if (d.error) throw new Error(d.error); return d; };
  const open = async (doc: Doc) => {
    setErr('');
    if (doc.url) { void openExternal(doc.path); return; }
    if (doc.html || doc.ext === 'html' || doc.ext === 'htm') {
      if (doc.host) { setErr(`这份文档在 ${doc.host_name || doc.host}，暂时只能在这里读 Markdown 文档`); return; }
      await api.openPath(doc.path).catch((e) => setErr(String(e))); return;
    }
    try { const d = parse(await api.on(doc.host || 'local', ['docs', 'read', name, doc.id, '--json'])); setOpened({ doc, text: String(d.text || ''), dir: d.dir as string | undefined }); } catch (e) { setErr(String(e)); }
  };
  const add = async () => { setBusy(true); setErr(''); try { parse(await api.on('local', ['docs', 'add', name, path.trim(), '--kind', kind, '--json'])); setPath(''); onReload(); } catch (e) { setErr(String(e)); } finally { setBusy(false); } };
  const remove = async (doc: Doc) => { setBusy(true); setErr(''); try { parse(await api.on('local', ['docs', 'rm', name, doc.id, '--json'])); onReload(); } catch (e) { setErr(String(e)); } finally { setBusy(false); } };
  const actions = (d: Doc) => <>{d.url ? <button className="btn sm" onClick={() => void openExternal(d.path)}>打开链接</button>
    : d.host ? <span className="muted small" title={d.path}>在 {d.host_name || d.host}</span>
    : <><button className="btn sm" onClick={() => void api.openPath(d.path).catch(() => {})}>在 Finder 打开</button><button className="btn sm" onClick={() => void api.copy(d.path).catch(() => {})}>复制路径</button></>}{d.source === 'registered' && <button className="btn sm" disabled={busy} onClick={() => void remove(d)}>移除登记</button>}</>;
  if (opened) {
    const d = opened.doc;
    return <div className="doc-reader"><div className="hub-tools"><button className="btn sm" onClick={() => setOpened(null)}>‹ 文档列表</button><span className="chip">{d.kind}</span><b>{d.title}</b><code className="muted small doc-path" title={d.path}>{shortPath(d.path)}</code>{d.host && <span className="chip" title={d.path}>{d.host_name || d.host}</span>}<span className="spacer" />{actions(d)}</div><DocMedia api={api} project={name} id={d.id} dir={opened.dir} host={d.host}><Markdown src={opened.text} /></DocMedia></div>;
  }
  return <div className="docs-tab">
    <form className="doc-add" onSubmit={(e) => { e.preventDefault(); void add(); }}><input aria-label="文档路径或 URL" placeholder="路径或 URL，例如 design/research-2026-09-09.md" value={path} onChange={(e) => setPath(e.target.value)} /><select aria-label="文档类型" value={kind} onChange={(e) => setKind(e.target.value)}>{['调研', '复审', '设计', '文档', '其他'].map((k) => <option key={k}>{k}</option>)}</select><button className="btn primary sm" disabled={busy || !path.trim()}>登记文档…</button></form>
    {err && <p className="err">{err}</p>}
    {docs === null ? <p className="empty">正在扫描这个项目的 design/、docs/、研究/…</p> : docs.length === 0 ? <p className="empty">还没有文档。调研、复审产出写到项目的 design/ 目录，或在这里登记一个路径 / URL。</p> : <div className="doc-list">{docs.map((d) => <div className="hub-task doc-row" key={d.id}><button className="link doc-title" onClick={() => void open(d)}>{d.title}</button><span className="chip">{d.kind}</span>{d.host && <span className="chip" title={d.path}>{d.host_name || d.host}</span>}<span className="muted small">{d.mtime ? new Date(d.mtime * 1000).toLocaleDateString('zh-CN') : ''}{d.size ? ` · ${d.size >= 1048576 ? `${(d.size / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(d.size / 1024))} KB`}` : ''}</span><code className="muted small doc-path" title={d.path}>{shortPath(d.path)}</code><span className="spacer" />{actions(d)}</div>)}</div>}
  </div>;
}

// 项目回顾: `dispatch here <project> --json` — one paragraph on where the project stands, the last
// two weeks as a day-grouped timeline, unfinished tasks, and the live sessions in this directory
// with a close-or-not verdict. Read-only; the CLI caches the model-written summary.
type ReviewKind = 'task' | 'done' | 'commit' | 'session';
type ReviewEntry = { ts: number; kind: ReviewKind; ref?: string; text: string; task?: string; task_title?: string; tasks?: { id: string; title: string }[]; host?: string };
type ReviewDay = { day: string; weekday: string; entries: ReviewEntry[] };
type ReviewTask = { id: string; title: string; status: string; assignee: string; acceptance_done: number; acceptance_total: number; last_at: number; last_note: string };
type ReviewSession = { agent: string; session_id: string; title: string; pane_id?: string; cwd?: string; source_app?: string; summary: string; state: string; last_at?: number; tasks: { id: string; title: string; status: string }[]; tasks_all_done: boolean; files_count: number; verdict: string; reason: string };
type ReviewData = { project: string; detected: boolean; cwd: string; timeline_days: number; summary: { text: string; at?: number; by?: string; cached?: boolean; error?: string; pending?: boolean }; timeline: ReviewDay[]; open_tasks: ReviewTask[]; sessions: ReviewSession[]; stale_hosts?: { name: string; age: number }[] };
const REVIEW_KIND: Record<string, string> = { task: '进展', done: '完成', commit: '提交', session: '会话' };
const REVIEW_STATE: Record<string, string> = { working: '在跑', idle: '等你', unknown: '未登记' };
const reviewStatus = (s: string) => s === 'closed' ? '已完成' : s === 'in_progress' ? '进行中' : s === 'blocked' ? '阻塞' : s === 'deferred' ? '搁置' : '待办';

const entryDate = (ts: number) => { const d = new Date(ts * 1000); const p = (n: number) => String(n).padStart(2, '0'); return `${p(d.getMonth() + 1)}-${p(d.getDate())}`; };

function ReviewTimeline({ timeline, onOpen, onTask }: { timeline: ReviewDay[]; onOpen: (id: string) => void; onTask: (id: string) => void }) {
  const [days, setDays] = useState(14);
  const [mode, setMode] = useState<'task' | 'time'>('task');
  const [openDays, setOpenDays] = useState<Record<string, boolean>>({});
  const [expandedDays, setExpandedDays] = useState<Record<string, boolean>>({});
  const [openGroups, setOpenGroups] = useState<Record<string, boolean>>({});
  const [expanded, setExpanded] = useState(false);   // 放大：去掉时间线框的高度上限，整页滚动
  const [expandedGroups, setExpandedGroups] = useState<Record<string, boolean>>({});
  // Newest-first is the contract, but sort defensively so the default-open day is always the latest.
  const sorted = useMemo(() => [...timeline].sort((a, b) => (a.day < b.day ? 1 : a.day > b.day ? -1 : 0)), [timeline]);
  const newest = sorted.length ? sorted[0].day : '';
  // Calendar days back from today (「3 天」 = today and the two before), not the three most recent days that had entries.
  const cutoff = useMemo(() => { const d = new Date(); d.setDate(d.getDate() - (days - 1)); const p = (n: number) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`; }, [days]);
  const shown = useMemo(() => sorted.filter((d) => d.day >= cutoff), [sorted, cutoff]);
  const hidden = Math.max(0, sorted.length - shown.length);
  const groups = useMemo(() => {
    const order: string[] = [];
    const map = new Map<string, { task: string; title: string; entries: ReviewEntry[] }>();
    const loose: ReviewEntry[] = [];
    for (const day of shown) for (const e of day.entries) {
      // A session tied to several tasks (`tasks`, from session:/session-origin: labels on each)
      // shows under every one of them — the same session row repeated, not just its last claim.
      const links = e.kind === 'session' && e.tasks?.length ? e.tasks : e.task ? [{ id: e.task, title: e.task_title || '' }] : [];
      if (!links.length) { loose.push(e); continue; }
      for (const { id, title } of links) {
        let g = map.get(id);
        if (!g) { g = { task: id, title: title || '', entries: [] }; map.set(id, g); order.push(id); }
        if (!g.title && title) g.title = title;
        g.entries.push(e);
      }
    }
    const list = order.map((k) => map.get(k)!);
    for (const g of list) g.entries.sort((a, b) => b.ts - a.ts);
    loose.sort((a, b) => b.ts - a.ts);
    if (loose.length) list.push({ task: '', title: '未挂任务', entries: loose });
    return list;
  }, [shown]);
  if (sorted.length === 0) return <p className="muted small">这段时间没有记录。</p>;
  const row = (e: ReviewEntry, key: string, withDate: boolean) => {
    const go = e.ref && (e.kind === 'session' || e.kind === 'task' || e.kind === 'done')
      ? () => (e.kind === 'session' ? onOpen(e.ref!) : onTask(e.ref!)) : null;
    return <li className={`review-entry${go ? ' clickable' : ''}`} key={key}
      role={go ? 'button' : undefined} tabIndex={go ? 0 : undefined}
      title={go ? (e.kind === 'session' ? '打开这段会话' : '打开这个任务') : undefined}
      onClick={go || undefined}
      onKeyDown={go ? (ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); go(); } } : undefined}>
      <span className={`review-kind k-${e.kind}`}>{REVIEW_KIND[e.kind] || e.kind}</span>
      {withDate && <span className="review-date mono">{entryDate(e.ts)}</span>}
      {e.kind === 'commit' && e.ref ? <code className="review-ref mono">{String(e.ref).slice(0, 7)}</code> : null}
      <span className="review-text clamp-2" title={e.text}>{e.text}</span>{e.host ? <span className="review-host muted small" title={`来自 ${e.host}`}>{e.host}</span> : null}
    </li>;
  };
  return <>
    <div className="review-seg-row">
      <span className="review-seg-label">最近</span>
      <div className="review-seg" role="group" aria-label="时间线显示范围">
        {[3, 7, 14].map((d) => <button key={d} type="button" className={days === d ? 'on' : ''} aria-pressed={days === d} onClick={() => setDays(d)}>{d} 天</button>)}
      </div>
      <span className="spacer" />
      <button type="button" className={`chip${expanded ? ' on' : ''}`} aria-pressed={expanded} onClick={() => setExpanded((v) => !v)} title={expanded ? '收回到小框里' : '去掉高度限制，整页滚动看'}>{expanded ? '还原' : '放大'}</button>
      <span className="review-seg-label">分组</span>
      <div className="review-seg" role="group" aria-label="时间线分组方式">
        <button type="button" className={mode === 'task' ? 'on' : ''} aria-pressed={mode === 'task'} onClick={() => setMode('task')}>按任务</button>
        <button type="button" className={mode === 'time' ? 'on' : ''} aria-pressed={mode === 'time'} onClick={() => setMode('time')}>按时间</button>
      </div>
    </div>
    {mode === 'time'
      ? <div className={`review-timeline${expanded ? " expanded" : ""}`}>{shown.map((day) => {
        const open = openDays[day.day] ?? (day.day === newest);
        const expanded = !!expandedDays[day.day];
        const entries = expanded ? day.entries : day.entries.slice(0, 4);
        return <details className="review-day" key={day.day} open={open} onToggle={(e) => { const now = e.currentTarget.open; setOpenDays((prev) => (prev[day.day] === now ? prev : { ...prev, [day.day]: now })); }}>
          <summary className="review-day-head"><span className="mono">{day.day}</span><span className="muted small">{day.weekday}</span><span className="muted small review-day-count">· {day.entries.length} 条</span></summary>
          <ol className="review-entries">{entries.map((e, i) => row(e, `${e.ts}-${i}`, false))}</ol>
          {day.entries.length > 4 && (expanded
            ? <button type="button" className="review-more" onClick={() => setExpandedDays((p) => ({ ...p, [day.day]: false }))}>收起</button>
            : <button type="button" className="review-more" onClick={() => setExpandedDays((p) => ({ ...p, [day.day]: true }))}>展开剩余 {day.entries.length - 4} 条</button>)}
        </details>;
      })}</div>
      : <div className={`review-timeline${expanded ? " expanded" : ""}`}>{groups.map((g) => {
        const key = g.task || '__none__';
        const open = openGroups[key] ?? true;
        const expanded = !!expandedGroups[key];
        const entries = expanded ? g.entries : g.entries.slice(0, 4);
        return <details className="review-day" key={key} open={open} onToggle={(e) => { const now = e.currentTarget.open; setOpenGroups((prev) => (prev[key] === now ? prev : { ...prev, [key]: now })); }}>
          <summary className="review-day-head">
            {g.task
              ? <button type="button" className="link task-title review-group-title" title="打开这个任务" onClick={(ev) => { ev.preventDefault(); ev.stopPropagation(); onTask(g.task); }}>{g.title || g.task}</button>
              : <span className="review-group-title">{g.title}</span>}
            <span className="muted small review-day-count">· {g.entries.length} 条</span>
          </summary>
          <ol className="review-entries">{entries.map((e, i) => row(e, `${e.ts}-${i}`, true))}</ol>
          {g.entries.length > 4 && (expanded
            ? <button type="button" className="review-more" onClick={() => setExpandedGroups((p) => ({ ...p, [key]: false }))}>收起</button>
            : <button type="button" className="review-more" onClick={() => setExpandedGroups((p) => ({ ...p, [key]: true }))}>展开剩余 {g.entries.length - 4} 条</button>)}
        </details>;
      })}</div>}
    {hidden > 0 && <button type="button" className="review-more review-hidden" onClick={() => setDays(14)}>还有更早的 {hidden} 天 · 显示全部</button>}
  </>;
}

export function ProjectReview({ api, data, busy, err, me, onOpen, onTask, onReload }: { api: Api; data: ReviewData | null; busy: boolean; err: string; me: string; onOpen: (id: string) => void; onTask: (id: string) => void; onReload: () => void }) {
  const openSession = useOpenSession();
  const [closed, setClosed] = useState<Record<string, boolean>>({}); const [confirming, setConfirming] = useState(''); const [closing, setClosing] = useState(''); const [actionErr, setActionErr] = useState<Record<string, string>>({});
  if (busy && !data) return <p className="empty">正在读这个项目此刻的样子…</p>;
  if (err && !data) return <p className="err" role="alert">{err}</p>;
  if (!data) return null;
  const summary = data.summary || {};
  const closeSession = async (s: ReviewSession) => {
    if (!s.pane_id) { onOpen(s.session_id); return; }
    setConfirming(''); setClosing(s.session_id); setActionErr((p) => ({ ...p, [s.session_id]: '' }));
    try { await api.on('local', ['agent', 'close', s.pane_id, '--json']); setClosed((p) => ({ ...p, [s.session_id]: true })); }
    catch (e) { setActionErr((p) => ({ ...p, [s.session_id]: String(e) })); }
    finally { setClosing(''); }
  };
  const restore = async (s: ReviewSession) => {
    setActionErr((p) => ({ ...p, [s.session_id]: '' }));
    await openSession({ session_id: s.session_id, agent: s.agent, host: 'local', host_name: '本机' });
    setClosed((p) => { const n = { ...p }; delete n[s.session_id]; return n; });
    onReload();
  };
  return <div className="review">
    <section className="review-block">
      <h3>现状</h3>
      {summary.pending ? <p className="muted small">正在读这个项目的会话和任务，写现状…</p>
        : summary.error ? <p className="muted small">还没有项目总结：{summary.error}</p>
        : summary.text ? <p className="review-summary">{summary.text}</p>
        : <p className="muted small">还没有项目总结。</p>}
      {!data.detected && <p className="muted small">任务板上没认出 <span className="mono">{data.project}</span>，按目录 {shortPath(data.cwd)} 看。</p>}
    </section>
    <section className="review-block">
      <h3>最近 {data.timeline_days} 天</h3>
      <ReviewTimeline key={data.project} timeline={data.timeline} onOpen={onOpen} onTask={onTask} />
    </section>
    <section className="review-block">
      <h3>还没做完 <span className="review-count">{data.open_tasks.length}</span></h3>
      {data.open_tasks.length === 0 ? <p className="muted small">没有未完成任务。</p>
        : <div className="review-tasks">{data.open_tasks.map((t) => <div className="review-task" key={t.id}>
          <div className="review-task-head">
            <span className={`review-mark${t.status === 'in_progress' ? ' prog' : ''}`} aria-hidden>{t.status === 'in_progress' ? '◐' : '○'}</span>
            <button className="link task-title" onClick={() => onTask(t.id)}>{t.title}</button>
            <code className="muted small review-ref">{t.id}</code>
          </div>
          <div className="review-task-meta">
            {t.acceptance_total > 0 && <span className="chip">{t.acceptance_done}/{t.acceptance_total} 验收</span>}
            {t.assignee && <span className="muted small">{actorOf(t.assignee, me)?.name || t.assignee}</span>}
            {t.last_at ? <span className="muted small">{ago(t.last_at)}</span> : null}
          </div>
          {t.last_note && <p className="review-note muted small">{t.last_note}</p>}
        </div>)}</div>}
    </section>
    <section className="review-block">
      <h3>本目录活会话 <span className="review-count">{data.sessions.length}</span></h3>
      {data.sessions.length === 0 ? <p className="muted small">这个目录下没有正在运行的会话。</p>
        : <div className="review-sessions">{data.sessions.map((s) => <div className="review-session" key={`${s.agent}:${s.session_id}`}>
          <div className="review-session-head">
            <span className={`review-mark${s.state === 'working' ? ' prog' : ''}`} aria-hidden>{s.state === 'working' ? '◐' : '○'}</span>
            <button className="link task-title" onClick={() => onOpen(s.session_id)}>{s.title || s.session_id.slice(0, 8)}</button>
            {closed[s.session_id]
              ? <span className="review-verdict closed">已关闭</span>
              : <button type="button" className={`review-verdict${s.verdict === '别关' ? ' hold' : ' ok'}${confirming === s.session_id ? ' confirm' : ''}`} disabled={closing === s.session_id} onClick={() => (s.verdict === '可关' ? (confirming === s.session_id ? void closeSession(s) : setConfirming(s.session_id)) : onOpen(s.session_id))} title={s.verdict === '可关' ? '关闭这个会话：关掉它的 Herdr 标签/进程，之后可点「恢复」续上' : '不安全的关闭，点开这段会话看看'}>{closing === s.session_id ? '关闭中…' : s.verdict === '可关' && confirming === s.session_id ? '确认关闭？' : s.verdict}</button>}
            <button type="button" className="review-restore" onClick={() => void restore(s)} title="在 Herdr 里恢复/打开这段会话">恢复</button>
          </div>
          <div className="review-task-meta">
            <span className="chip">{s.agent}</span>
            <span className="muted small">{REVIEW_STATE[s.state] || s.state}</span>
            {s.last_at ? <span className="muted small">{ago(s.last_at)}</span> : null}
            {s.files_count > 0 && <span className="muted small">动过 {s.files_count} 个文件</span>}
          </div>
          {s.summary && <p className="review-summary small">{s.summary}</p>}
          {s.reason && <p className="review-note muted small">{s.reason}</p>}
          {actionErr[s.session_id] && <p className="review-note err small">{actionErr[s.session_id]}</p>}
          {s.tasks.length > 0 && <div className="review-links">{s.tasks.map((t) => <button key={t.id} className="chip" onClick={() => onTask(t.id)}>{t.title} · {reviewStatus(t.status)}</button>)}</div>}
        </div>)}</div>}
    </section>
  </div>;
}

export function TaskRelations({issue,rows,api,onSaved,onOpen}:{issue:Issue;rows:Activity[];api:Api;onSaved:()=>void;onOpen:(id:string)=>void}) {
  const [edit,setEdit]=useState(false),[origin,setOrigin]=useState(''),[participants,setParticipants]=useState<string[]>([]),[busy,setBusy]=useState(false),[error,setError]=useState('');
  const ids=linkedSessions(issue);
  // The picker's option list is only needed while editing: computing it for every task on every
  // 3-second sync made long task lists scroll like mud.
  const options=useMemo(()=>edit?rows.filter((a,n,all)=>all.findIndex(x=>x.session_id===a.session_id)===n).sort((a,b)=>Number(conversationProject(b)===projectOf(issue))-Number(conversationProject(a)===projectOf(issue))):[],[edit,rows,issue]);
  const missing=ids.filter(id=>!options.some(a=>a.session_id===id));
  const save=async()=>{setBusy(true);setError('');try{const add=[...new Set([...participants,origin].filter(Boolean))].map(id=>'session:'+id);if(origin)add.push('session-origin:'+origin);await api.labels(issue.id,add,(issue.labels||[]).filter(l=>l.startsWith('session:')||l.startsWith('session-origin:')).filter(l=>!add.includes(l)));setEdit(false);onSaved();}catch(e){setError(String(e));}finally{setBusy(false);}};
  return <div className="task-relations"><div className="task-links">{ids.length?ids.map(id=><button key={id} className="chip" onClick={()=>onOpen(id)}>{originSession(issue)===id?'发起':'参与'} · {rows.find(a=>a.session_id===id)?.title||id.slice(0,8)} ↗</button>):<span className="muted small">没记录（Agent 建任务时通常会自动记）</span>}<button className="link" onClick={()=>{setOrigin(originSession(issue));setParticipants(ids);setEdit(!edit);}}>指定是哪次会话</button></div>{edit&&<div className="relation-editor"><label>发起会话<select aria-label="发起会话" value={origin} onChange={e=>setOrigin(e.target.value)}><option value="">暂不指定</option>{options.map(a=><option key={a.session_id} value={a.session_id}>{conversationProject(a)} · {a.title}</option>)}{missing.map(id=><option key={id} value={id}>{id}（历史会话）</option>)}</select></label><details><summary>参与会话 · 可选多个</summary><div className="relation-options">{options.map(a=><label key={a.session_id}><input type="checkbox" checked={participants.includes(a.session_id)} onChange={e=>setParticipants(old=>e.target.checked?[...old,a.session_id]:old.filter(x=>x!==a.session_id))}/>{a.title}</label>)}</div></details><button className="btn primary sm" disabled={busy} onClick={()=>void save()}>保存</button><button className="btn sm" disabled={busy} onClick={()=>setEdit(false)}>取消</button>{error&&<p role="alert">{error}</p>}</div>}</div>;
}

function OutcomeEditor({project,rows,tasks,initial,api,onSaved,onCancel}:{project:string;rows:Activity[];tasks:Issue[];initial?:Issue;api:Api;onSaved:()=>void;onCancel:()=>void}){
  const [title,setTitle]=useState(initial?.title||''),[body,setBody]=useState(initial?.description||''),[taskIds,setTaskIds]=useState<string[]>(initial?sourceTasks(initial):[]),[sessionIds,setSessionIds]=useState<string[]>(initial?linkedSessions(initial):[]),[busy,setBusy]=useState(false),[error,setError]=useState(''),[created,setCreated]=useState(initial?.id||'');
  const save=async()=>{setBusy(true);setError('');try{const linked=[...new Set([...sessionIds,...tasks.filter(i=>taskIds.includes(i.id)).flatMap(linkedSessions)])];const labels=['dispatch:outcome',...(project===UNGROUPED_PROJECT?[]:['project:'+project]),...taskIds.map(id=>'outcome-task:'+id),...linked.map(id=>'session:'+id)];let id=created;if(!id){const result=await api.create({title:title.trim(),description:body.trim(),issue_type:'task',priority:2,labels});id=result.id;setCreated(id);}else{await api.update(id,{title:title.trim(),description:body.trim()});await api.labels(id,labels,(initial?.labels||[]).filter(l=>(l.startsWith('outcome-task:')||l.startsWith('session:'))&&!labels.includes(l)));}await api.close(id,'已登记项目成果');onSaved();}catch(e){setError(String(e));}finally{setBusy(false);}};
  return <form className="outcome-editor" onSubmit={e=>{e.preventDefault();void save();}}><h3>{initial?'编辑成果':'登记成果'}</h3><label>成果名称<input aria-label="成果名称" required maxLength={200} value={title} onChange={e=>setTitle(e.target.value)} placeholder="例如：Dispatch 新版 · 项目工作台"/></label><label>交付内容与查看入口<textarea aria-label="交付内容与查看入口" required rows={5} value={body} onChange={e=>setBody(e.target.value)} placeholder="写明交付了什么，附上文档、截图、版本或代码链接（支持 Markdown）"/></label><div className="outcome-sources"><details open><summary>来源任务 · 可选多个</summary><div className="relation-options">{tasks.map(i=><label key={i.id}><input type="checkbox" checked={taskIds.includes(i.id)} onChange={e=>setTaskIds(old=>e.target.checked?[...old,i.id]:old.filter(x=>x!==i.id))}/>{i.title}</label>)}</div></details><details><summary>补充来源会话 · 已选任务的会话会一并关联</summary><div className="relation-options">{rows.map(a=><label key={a.key}><input type="checkbox" checked={sessionIds.includes(a.session_id)} onChange={e=>setSessionIds(old=>e.target.checked?[...old,a.session_id]:old.filter(x=>x!==a.session_id))}/>{a.title}</label>)}</div></details></div>{error&&<p role="alert">保存失败：{error}</p>}<button className="btn primary" disabled={busy||!title.trim()||!body.trim()}>保存成果</button><button className="btn" type="button" disabled={busy} onClick={onCancel}>取消</button></form>;
}

type Props={onDiscuss?:(name:string)=>void;focusSection?:{section:"review"|"sessions";token:number}|null;onSectionDone?:()=>void;archiveDays:number;flags:ProjectFlags;onFlag:(name:string,change:{starred?:boolean;archived?:boolean;alias?:string})=>void;connectionError:boolean;unavailable:string[];rows:Activity[];tasks:Issue[];outcomes:Issue[];api:Api;me:string;selected:string|null;onProject:(name:string|null)=>void;onOpen:(id:string)=>void;onTask:(id:string)=>void;onRead:(a:Activity)=>Promise<void>;onSummarize?:(a:Activity)=>Promise<void>;onReload:()=>void;onNew:(a?:Activity)=>void;loaded:boolean;hosts?:Host[];owners?:Record<string,ProjectOwner>;moveJobs?:MoveJob[];onMoveProject?:(project:string,cwd:string,fromHost:string,to:Host)=>Promise<void>};
type WikiEntry={key:string;kind:'pit'|'win'|'retro'|'howto'|string;text:string;fields?:Record<string,string>;project?:string;task?:string;raw?:string};
const WIKI_KIND:Record<string,string>={pit:'坑',win:'做对',retro:'复盘',howto:'做法'};
// The knowledge base filtered to one project: what went wrong here, what worked, the retros —
// the same entries `dispatch wiki` shows, without the other projects' noise.
function ProjectWiki({entries,project,onTask}:{entries:WikiEntry[]|null;project:string;onTask:(id:string)=>void}){
  const [kind,setKind]=useState('all');const [q,setQ]=useState('');
  if(entries===null)return <p className="empty">正在读这个项目的知识库…</p>;
  const counts:Record<string,number>={};for(const e of entries)counts[e.kind]=(counts[e.kind]||0)+1;
  const shown=entries.filter(e=>(kind==='all'||e.kind===kind)&&(!q.trim()||`${e.text} ${Object.values(e.fields||{}).join(' ')}`.toLowerCase().includes(q.toLowerCase())));
  return <div className="project-wiki">
    <div className="hub-tools"><div className="views">{[['all','全部',entries.length],...Object.entries(WIKI_KIND).filter(([k])=>counts[k]).map(([k,l])=>[k,l,counts[k]])].map(([k,l,n])=><button key={String(k)} className={kind===k?'on':''} onClick={()=>setKind(String(k))}>{l} {n}</button>)}</div><label className="search"><input placeholder="搜这个项目的知识库…" value={q} onChange={e=>setQ(e.target.value)}/></label></div>
    {!entries.length&&<p className="empty">这个项目还没有知识库条目。Agent 踩坑或做对后用 <code>dispatch wiki add --kind pit/win -P {project}</code> 记下来，就会出现在这里。</p>}
    {!!entries.length&&!shown.length&&<p className="empty">没有匹配的条目。</p>}
    <div className="wiki-list">{shown.map(e=><div key={e.key} className={`wiki-item k-${e.kind}`}><div className="wiki-head"><span className={`review-kind k-${e.kind==='pit'?'task':e.kind==='win'?'done':'session'}`}>{WIKI_KIND[e.kind]||e.kind}</span>{e.task&&<button className="link mono" onClick={()=>onTask(e.task!)}>{e.task}</button>}<span className="muted small mono">{e.key}</span></div><p className="wiki-text">{e.text}</p>{Object.entries(e.fields||{}).filter(([,v])=>v).map(([k,v])=><p key={k} className="wiki-field"><b>{k}</b>{v}</p>)}</div>)}</div>
  </div>;
}

export function ProjectHub({moveJobs=[],onDiscuss,focusSection,onSectionDone,archiveDays,flags,onFlag,connectionError,unavailable,rows,tasks,outcomes,api,me,selected,onProject,onOpen,onTask,onRead,onSummarize,onReload,onNew,loaded,hosts=[],owners={},onMoveProject}:Props){
  const [moving,setMoving]=useState<string|null>(null);
  // 双击标题改显示名: labels and directories keep the raw name; empty restores it.
  const [renaming,setRenaming]=useState<string|null>(null);
  const commitRename=(name:string)=>{if(renaming===null)return;const v=renaming.trim();setRenaming(null);if(v===projectLabel(flags,name))return;onFlag(name,{alias:v===name?'':v});};
  const [sortBy,setSortBy]=useState<'recent'|'name'|'sessions'|'tasks'|'owner'>(()=>{try{return (localStorage.getItem('dispatch-projects-sort') as 'recent')||'recent';}catch{return 'recent';}});
  useEffect(()=>{try{localStorage.setItem('dispatch-projects-sort',sortBy);}catch{/* private mode */}},[sortBy]);
  const [tab,setTab]=useState(()=>{const s=focusSection?.section;const t=s||new URLSearchParams(location.search).get('section')||'review';return ['review','sessions','tasks','outcomes','unassigned','folders','docs','wiki'].includes(t)?t:'review';}),[query,setQuery]=useState(''),[scheduled,setScheduled]=useState(false),[archived,setArchived]=useState(false),[editor,setEditor]=useState<Issue|null|false>(false),[showOther,setShowOther]=useState(false),[showArchived,setShowArchived]=useState(false),[docs,setDocs]=useState<Doc[]|null>(null);
  // 知识库 scoped to this project: the pits, wins, retros and how-tos filed with its name.
  const [wiki,setWiki]=useState<WikiEntry[]|null>(null);
  useEffect(()=>{setWiki(null);if(!selected)return;let alive=true;void api.on('local',['wiki','list','-P',selected,'--json']).then(t=>{const d=JSON.parse(t.slice(Math.max(0,t.indexOf('['))));if(alive)setWiki(Array.isArray(d)?d as WikiEntry[]:[]);}).catch(()=>{if(alive)setWiki([]);});return()=>{alive=false;};},[api,selected]);
  const loadDocs=useCallback(()=>{setDocs(null);if(!selected)return;void api.on('local',['docs',selected,'--json']).then(t=>{const d=JSON.parse(t.slice(Math.max(0,t.indexOf('{'))));setDocs(Array.isArray(d.docs)?d.docs as Doc[]:[]);}).catch(()=>setDocs([]));},[api,selected]);
  useEffect(()=>{loadDocs();},[loadDocs]);
  useEffect(()=>{if(!focusSection)return;if(['review','sessions','tasks','outcomes','unassigned','folders','docs'].includes(focusSection.section)){setTab(focusSection.section);setEditor(false);}onSectionDone?.();},[focusSection]);
  const [review,setReview]=useState<ReviewData|null>(null),[reviewBusy,setReviewBusy]=useState(false),[reviewErr,setReviewErr]=useState(''),[termBusy,setTermBusy]=useState(false),[terminalNotice,setTerminalNotice]=useState<{project:string;text:string;error?:boolean}|null>(null),[err,setErr]=useState(''),[doneView,setDoneView]=useState(false),[doneQuery,setDoneQuery]=useState('');
  const [terminalMenu,setTerminalMenu]=useState<{x:number;y:number;from:HTMLButtonElement}|null>(null);
  useEffect(()=>{setTerminalMenu(null);},[selected]);
  // Two calls: the timeline / tasks / sessions come back in a second, the 现状 paragraph may take
  // the model half a minute the first time — the page must not stay blank for it.
  const loadReview=useCallback(()=>{
    setReview(null);setReviewErr('');setReviewBusy(true);
    if(!selected)return;
    const name=selected;
    // `here` merges other Macs' cached answers without waiting for them (the page must paint
    // now); a cache that had gone stale kicks off a background refresh over there that lands a
    // few seconds later. `stale_hosts` says that happened — ask again once, shortly after, so a
    // Mac with no local session/commit material for this project (no checkout here) still ends
    // up showing the other Mac's rows instead of freezing on the first, incomplete answer.
    const fetchHere=()=>api.on('local',['here',name,'--no-summary','--json']);
    void fetchHere().then(t=>{
      const d=JSON.parse(t.slice(Math.max(0,t.indexOf('{')))) as ReviewData&{error?:string};
      if(d.error){setReviewErr(d.error);return;}
      setReview({...d,summary:{text:'',pending:true}});
      if(d.stale_hosts&&d.stale_hosts.length){
        setTimeout(()=>{void fetchHere().then(t2=>{
          const d2=JSON.parse(t2.slice(Math.max(0,t2.indexOf('{')))) as ReviewData&{error?:string};
          if(d2.error)return;
          setReview(prev=>prev&&prev.project===d2.project?{...prev,timeline:d2.timeline,sessions:d2.sessions,open_tasks:d2.open_tasks,cwd:d2.cwd,stale_hosts:d2.stale_hosts}:prev);
        }).catch(()=>{});},6000);
      }
      return api.on('local',['project-summary',name,'--if-stale','--json']).then(u=>{const r=JSON.parse(u.slice(Math.max(0,u.indexOf('{')))) as {summary?:string;at?:number;by?:string;cached?:boolean;error?:string;skipped?:boolean;reason?:string};setReview(prev=>prev&&prev.project===d.project?{...prev,summary:r.error?{text:'',error:r.error}:r.skipped?{text:'',error:r.reason}:{text:r.summary||'',at:r.at,by:r.by,cached:r.cached}}:prev);}).catch(e=>setReview(prev=>prev&&prev.project===d.project?{...prev,summary:{text:'',error:String(e)}}:prev));
    }).catch((e)=>setReviewErr(String(e))).finally(()=>setReviewBusy(false));
  },[api,selected]);
  useEffect(()=>{loadReview();},[loadReview]);
  const verdicts=useMemo(()=>new Map((review?.sessions||[]).map(s=>[s.session_id,s])),[review]);
  const groups=useMemo(()=>projectGroups(rows,tasks,outcomes),[rows,tasks,outcomes]);
  const primary=(p:typeof groups[number])=>p.items.length>0||p.results.length>0||p.sessions.some(a=>!!a.project_override);
  const ranked=useMemo(()=>rankProjects(groups,flags),[groups,flags]);
  const project=groups.find(p=>p.name===selected);
  const starBtn=(name:string)=><button className={`star${isStarred(flags,name)?' on':''}`} onClick={e=>{e.stopPropagation();onFlag(name,{starred:!isStarred(flags,name)});}} title={isStarred(flags,name)?'取消收藏':'收藏：置顶，近期重点关注'} aria-label={isStarred(flags,name)?`取消收藏 ${name}`:`收藏 ${name}`}>{isStarred(flags,name)?'★':'☆'}</button>;
  // Which Mac a project is on: its hand-set owner, else where its conversations run, else the
  // `host:` labels on its tasks (a project that is only tasks on the board still ran somewhere).
  const ownerOf=(p:typeof groups[number]):{name:string;why:string}=>{
    const ctx=projectHome(p.sessions);
    const id=ownerHostId(owners[p.name],hosts)||(ctx?(ctx.host||'local'):undefined);
    const h=hosts.find(x=>(x.local?'local':x.id)===id);
    const name=h?.name||owners[p.name]?.host;
    if(name)return {name,why:owners[p.name]?'项目已交接给这台：新建会话默认开在这里':'项目目录目前在这台电脑上'};
    const tally=new Map<string,number>();
    for(const i of p.items){const l=(i.labels||[]).find(x=>x.startsWith('host:'))?.slice(5);if(l)tally.set(l,(tally.get(l)||0)+1);}
    const fromTasks=[...tally.entries()].sort((a,b)=>b[1]-a[1])[0]?.[0]||'';
    return fromTasks?{name:fromTasks,why:'按这个项目的任务在哪台电脑上做过推断'}:{name:'',why:'还没有归属、目录或任务记录'};
  };
  const ownerBadge=(p:typeof groups[number])=>{
    const {name,why}=ownerOf(p);
    return <span className={`project-owner${name?'':' unknown'}`} title={why}>{name||'未指定'}</span>;
  };
  const open=(name:string)=>{setTab('review');setQuery('');setScheduled(false);onProject(name);};
  // The move running on this project, if any: a bar with the current stage, top-left of the page and on its card.
  const moveOf=(name:string)=>moveJobs.find(j=>j.project===name&&j.state==='running');
  const moveBar=(name:string,compact=false)=>{const j=moveOf(name);if(!j)return null;return <div className={`move-progress${compact?' compact':''}`} role="progressbar" aria-valuenow={j.percent} aria-valuemin={0} aria-valuemax={100} title={`正在迁移到 ${j.to}：${j.label}`}><div className="move-bar"><i style={{width:`${Math.max(2,j.percent)}%`}}/></div><span className="move-text">迁移到 {j.to} · {j.label} · {j.percent}%</span></div>;};
  const taskRow=(i:Issue)=><div className="hub-task" key={i.id}><button className="link task-title" onClick={()=>onTask(i.id)}>{i.title}</button><span className="st sm">{statusLabel(i).text}</span><TaskRelations issue={i} rows={rows} api={api} onSaved={onReload} onOpen={onOpen}/></div>;
  if(!project)return <div className="project-hub"><header className="hub-heading"><div><h2>从项目继续工作</h2><p>项目 → 会话 → 任务 → 成果</p><span className="muted small">{connectionError?"更新中断，正在重新连接":loaded?"每 3 秒同步会话活动":"正在连接…"}</span></div><div className="hub-header-actions"><button className="btn primary" onClick={()=>onNew()}>新建会话</button></div></header>{unavailable.length>0&&<p className="connection-note">{unavailable.join("、")} 暂时无法连接，保留已读取记录。</p>}<div className="hub-list-tools"><label className="search"><input placeholder="搜索项目…" value={query} onChange={e=>setQuery(e.target.value)}/></label><label className="hub-sort">排序<select aria-label="项目排序" value={sortBy} onChange={e=>setSortBy(e.target.value as typeof sortBy)}><option value="recent">最近活动</option><option value="name">名称</option><option value="sessions">会话数</option><option value="tasks">待完成任务</option><option value="owner">所属电脑</option></select></label></div>{!loaded&&<p className="empty">正在读取项目与会话…</p>}{(()=>{const openTasks=(p:typeof groups[number])=>p.items.filter(i=>i.status!=='closed').length;const sorters:Record<typeof sortBy,(a:typeof groups[number],b:typeof groups[number])=>number>={recent:()=>0,name:(a,b)=>a.name.localeCompare(b.name,'zh-Hans-CN'),sessions:(a,b)=>b.sessions.length-a.sessions.length||b.last-a.last,tasks:(a,b)=>openTasks(b)-openTasks(a)||b.last-a.last,owner:(a,b)=>(ownerOf(a).name||'～').localeCompare(ownerOf(b).name||'～','zh-Hans-CN')||b.last-a.last};const list=(showArchived?ranked.archived:ranked.active).filter(p=>(showArchived||showOther||query.trim()||primary(p))&&p.name.toLowerCase().includes(query.toLowerCase())).sort(sorters[sortBy]);const WEEK=7*86400,now=Date.now()/1000;const info=(p:typeof list[number])=>{const active=p.sessions.filter(a=>!a.scheduled&&sessionLifecycle(a,archiveDays)!=='archived');const unread=active.filter(a=>a.unread).length;const doing=p.items.find(i=>i.status==='in_progress');const openCount=p.items.filter(i=>i.status!=='closed').length;const live=unread>0||!!doing||active.some(a=>a.state==='working'&&!a.stale)||(p.last>0&&now-p.last<WEEK);
    // One line that says what the project is up to, never a raw chat reply.
    const blurb=doing?`进行中 · ${doing.title}`:p.results[0]?`最新成果 · ${p.results[0].title}`:active[0]?`最近会话 · ${active[0].title}`:p.items.length?`${p.items.length} 个任务，还没有会话`:'还没有会话或任务';return{active,unread,openCount,live,blurb};};const cards=list.filter(p=>info(p).live),quiet=list.filter(p=>!info(p).live);return <><div className="project-cards">{cards.map(p=>{const x=info(p);return <div className="project-card" data-project={p.name} role="button" tabIndex={0} key={p.name} onClick={()=>open(p.name)} onKeyDown={e=>{if(e.target===e.currentTarget&&e.key==='Enter')open(p.name);}} title="右键：收藏、归档、新建会话"><div><h3>{projectLabel(flags,p.name)}</h3>{starBtn(p.name)}{ownerBadge(p)}{x.unread>0&&<span className="activity-badge new">{x.unread} 个会话未读</span>}</div>{moveBar(p.name,true)}<p>{x.blurb}</p><div className="muted small">{x.active.length} 个会话 · {x.openCount} 个待完成任务 · {p.results.length} 项成果</div><div className="project-card-foot"><span className="link">{primary(p)?"进入项目 →":"查看目录会话 →"}</span><span className="muted small">{p.last?`${ago(p.last)}`:''}</span></div></div>;})}</div>{quiet.length>0&&<div className="project-quiet"><h4 className="muted small">最近没有动静 · {quiet.length}</h4>{quiet.map(p=>{const x=info(p);return <div className="home-rest-item opens" data-project={p.name} role="button" tabIndex={0} key={p.name} onClick={()=>open(p.name)} onKeyDown={e=>{if(e.key==='Enter')open(p.name);}} title="右键：收藏、归档、新建会话"><span className="proj" style={{background:projectColor(p.name)}}/><b>{projectLabel(flags,p.name)}</b>{starBtn(p.name)}{ownerBadge(p)}<span className="muted small">{x.active.length} 个会话 · {x.openCount} 项未完成{p.results.length?` · ${p.results.length} 项成果`:''}</span><span className="muted small right">{p.last?`${ago(p.last)}`:''}</span></div>;})}</div>}</>;})()}{showArchived&&ranked.archived.length===0&&<p className="empty">没有归档的项目。</p>}<div className="hub-list-foot"><button className="btn" onClick={()=>{setShowOther(!showOther);setShowArchived(false);}}>{showOther&&!showArchived?"收起其他目录":`其他目录与未归类 · ${ranked.active.filter(p=>!primary(p)).length}`}</button><button className={`btn${showArchived?' on':''}`} onClick={()=>setShowArchived(!showArchived)}>{showArchived?"返回项目列表":`已归档 · ${ranked.archived.length}`}</button></div></div>;
  const life=(a:Activity)=>sessionLifecycle(a,archiveDays);
  const archivedCount=project.sessions.filter(a=>!a.scheduled&&life(a)==='archived').length;
  const visible=project.sessions.filter(a=>scheduled?!!a.scheduled:!a.scheduled&&(archived?life(a)==='archived':life(a)!=='archived')).sort((x,y)=>Number(!!y.starred)-Number(!!x.starred)||y.last_at-x.last_at).filter(a=>`${a.title} ${a.cwd} ${a.overview||''}`.toLowerCase().includes(query.toLowerCase()));
  const unassigned=project.items.filter(i=>!linkedSessions(i).length);
  const short=shortPath;
  // Shell and Agent entries share the project's owner and home directory.
  const homeAct=projectHome(project.sessions);
  const terminalTarget=newSessionTarget(ownerHostId(owners[project.name],hosts),homeAct,'local');
  const terminalHost=terminalTarget.initialHost;
  const terminalMachine=hosts.find(h=>(h.local?'local':h.id)===terminalHost)?.name||terminalHost;
  const terminalCwd=terminalTarget.initialCwd;
  const openTerminal=async(kind?:string)=>{
    if(!terminalCwd||termBusy)return;
    terminalMenu?.from.focus();setTerminalMenu(null);setTermBusy(true);setTerminalNotice(null);
    try{
      const args=kind?['agent','start',kind,'--focus','--no-wait']:['terminal'];
      const t=await api.on(terminalHost,[...args,'--cwd',terminalCwd,'--label',project.name,'--json']);
      const d=JSON.parse(t.slice(Math.max(0,t.indexOf('{'))));
      if(d.error)throw new Error(String(d.error));
      const agentName=KINDS.find(([k])=>k===kind)?.[1]||kind;
      setTerminalNotice({project:project.name,text:d.app?`已在 ${d.host||terminalMachine} 的 ${d.app} 打开${kind?` ${agentName} 会话`:'终端'}：${d.cwd}`:`已在 ${d.host||terminalMachine} 创建${kind?` ${agentName} 会话`:'终端标签'}，但未能显示窗口。${d.hint||'请检查那台电脑的终端窗口。'}`,error:!d.app});
    }catch(e){setTerminalNotice({project:project.name,text:String(e),error:true});}
    finally{setTermBusy(false);}
  };
  const dirs=[...project.sessions.reduce((m,a)=>{const d=(a.cwd||'').replace(/\/+$/,'');if(!d)return m;const cur=m.get(d)||{count:0,last:0,latest:a};cur.count++;if(a.last_at>cur.last){cur.last=a.last_at;cur.latest=a;}return m.set(d,cur);},new Map<string,{count:number;last:number;latest:Activity}>())].sort((x,y)=>y[1].last-x[1].last);
  return <div className="project-hub"><button className="link" onClick={()=>{setQuery('');onProject(null);}}>‹ 全部项目</button><header className="hub-heading"><div><h2 onDoubleClick={()=>setRenaming(projectLabel(flags,project.name))} title="双击改显示名（标签和目录不变）">{renaming!==null?<input className="project-rename" autoFocus value={renaming} maxLength={80} aria-label="项目显示名" onChange={e=>setRenaming(e.target.value)} onBlur={()=>commitRename(project.name)} onKeyDown={e=>{if(e.key==='Enter'){e.preventDefault();commitRename(project.name);}if(e.key==='Escape'){e.preventDefault();setRenaming(null);}}}/>:projectLabel(flags,project.name)}{flags[project.name]?.alias&&renaming===null&&<span className="muted small project-raw" title="原名：标签和目录用的">{project.name}</span>}{starBtn(project.name)}{ownerBadge(project)}{isArchived(flags,project.name)&&<span className="st sm open">已归档</span>}</h2>{terminalCwd&&<p className="mono muted small project-dir" title={terminalCwd}>{terminalCwd}</p>}{moveBar(project.name)}<p>{project.sessions.filter(a=>!a.scheduled).length} 个会话 · {project.items.length} 个任务 · {project.results.length} 项成果</p></div><div className="hub-header-actions"><button className="btn" disabled={termBusy||!terminalCwd} aria-haspopup="menu" aria-expanded={!!terminalMenu} onClick={e=>{const r=e.currentTarget.getBoundingClientRect();setTerminalMenu({x:r.left,y:r.bottom+6,from:e.currentTarget});}} title={terminalCwd?`选择 Agent，在 ${terminalMachine} 的 ${shortPath(terminalCwd)} 打开终端会话`:'这个项目还没有记录到目录'}>{termBusy?'正在打开…':`终端 · ${terminalMachine} ▾`}</button>{terminalMenu&&<MenuPanel x={terminalMenu.x} y={terminalMenu.y} returnTo={terminalMenu.from} label="选择终端 Agent" title={`在 ${terminalMachine} 打开`} onClose={()=>setTerminalMenu(null)}>{KINDS.map(([kind,label])=><MenuItem key={kind} onClick={()=>void openTerminal(kind)}>{label}</MenuItem>)}<hr/><MenuItem onClick={()=>void openTerminal()}>普通终端</MenuItem></MenuPanel>}{onDiscuss&&<button className="btn" onClick={()=>onDiscuss(project.name)} title="就这个项目的一个想法，让几个 Agent 各说一次并出结论">讨论…</button>}{(()=>{
    // One tap hands the whole project (folder, Git, running conversations) to another Mac:
    // it runs on the Mac the project's folder is on now, and is refused there when Git would lose work.
    const from=terminalTarget.initialHost;const cwd=terminalTarget.initialCwd;
    const targets=cwd&&onMoveProject?hosts.filter(h=>(h.local?'local':h.id)!==from&&(h.local||h.online)):[];
    return <>
      {targets.map(h=>{const j=moveOf(project.name);return <button key={h.id} className="btn" disabled={!!moving||!!j} onClick={async()=>{setMoving(h.id);try{await onMoveProject!(project.name,cwd!,from,h);}finally{setMoving(null);}}} title={j?`正在迁移到 ${j.to}：${j.label}`:`把项目目录、Git 和这边在跑的会话交给 ${h.name}：先预检，确认后才动手`}>{j&&j.to===h.name?`迁移中 ${j.percent}%`:moving===h.id?'预检中…':`迁移到 ${h.name}`}</button>;})}</>;
  })()}<button className="btn primary" onClick={()=>onNew(projectHome(project.sessions))}>在此项目新建会话</button><button className="btn" onClick={()=>onFlag(project.name,{archived:!isArchived(flags,project.name)})} title={isArchived(flags,project.name)?'恢复到工作台和项目列表':'做完了、暂时不用：从工作台和项目列表隐藏，随时可找回'}>{isArchived(flags,project.name)?'取消归档':'归档'}</button></div></header><div className="hub-tabs views">{[['review','项目回顾'],['sessions','会话',project.sessions.filter(a=>!a.scheduled).length],['tasks','任务',project.items.length],['outcomes','成果',project.results.length],['unassigned','待归属任务',unassigned.length],['folders','目录',dirs.length],['docs','文档',docs?docs.length:'…'],['wiki','知识库',wiki?wiki.length:'…']].map(([id,label,n])=><button className={tab===id?'on':''} key={id} onClick={()=>{setTab(String(id));setEditor(false);}}>{label}{n!=null?` ${n}`:''}</button>)}</div>
  {terminalNotice?.project===project.name&&<p role={terminalNotice.error?'alert':'status'} className={terminalNotice.error?'danger':'connection-note'}>{terminalNotice.text}</p>}
  {tab==='review'&&<ProjectReview api={api} data={review} busy={reviewBusy} err={reviewErr} me={me} onOpen={onOpen} onTask={onTask} onReload={loadReview}/>}
  {tab==='sessions'&&<><div className="hub-tools"><input aria-label="搜索项目会话" placeholder="搜索这个项目的会话…" value={query} onChange={e=>setQuery(e.target.value)}/><button className={`btn sm${archived?' on':''}`} onClick={()=>{setArchived(!archived);setScheduled(false);}} title={`手动归档，或超过 ${archiveDays} 天没有活动`}>{archived?'返回最近会话':`已归档 ${archivedCount}`}</button><button className="btn sm" onClick={()=>{setScheduled(!scheduled);setArchived(false);}}>{scheduled?'返回普通会话':`定时会话 ${project.sessions.filter(a=>a.scheduled).length}`}</button></div><ConversationRows rows={visible} me={me} onOpen={onOpen} onRead={onRead} onSummarize={onSummarize} taskContent={a=>{const linked=project.items.filter(i=>linkedSessions(i).includes(a.session_id));const rev=verdicts.get(a.session_id);return <div className="conversation-tasks-line">{rev?<><span className={`review-verdict${rev.verdict==='别关'?' hold':''}`}>{rev.verdict}</span>{rev.reason&&<span className="muted small">{rev.reason}</span>}</>:null}{linked.length?linked.map(i=><button key={i.id} className="chip" onClick={()=>onTask(i.id)}>{i.title}<span className="muted small"> · {i.status==='closed'?'已完成':i.status==='in_progress'?'进行中':'待办'}</span></button>):<span className="muted small">没有明确关联的任务</span>}</div>;}}/>{visible.length===0&&<p className="empty">{archived?'没有归档的会话。':'这个分类没有会话。'}</p>}</>}
  {tab==='tasks'&&(()=>{const needs=project.items.filter(i=>isNeedsYou(i)&&i.status!=='closed');const rest=project.items.filter(i=>!(isNeedsYou(i)&&i.status!=='closed'));const closedAt=(i:Issue)=>Date.parse(i.closed_at||i.updated_at||'')/1000||0;const week=Date.now()/1000-7*86400;const doneAll=rest.filter(i=>columnOf(i)==='done').sort((a,b)=>closedAt(b)-closedAt(a));const doneRecent=doneAll.filter(i=>closedAt(i)>=week);
    const cols:[string,Issue[]][]=[['只能你做',needs],['待办',rest.filter(i=>columnOf(i)==='todo')],['进行中',rest.filter(i=>columnOf(i)==='prog')],['已完成',doneRecent]];
    const tick=async(i:Issue)=>{try{await api.close(i.id,'你做完了');onReload();}catch(e){setErr(String(e));}};
    if(doneView){const q=doneQuery.trim().toLowerCase();const hits=doneAll.filter(i=>!q||i.title.toLowerCase().includes(q)||(i.description||'').toLowerCase().includes(q)||(i.close_reason||'').toLowerCase().includes(q));
      // 7-day buckets counted back from today, newest first.
      const groups=new Map<number,Issue[]>();for(const i of hits){const k=Math.floor((Date.now()/1000-closedAt(i))/(7*86400));groups.set(k,[...(groups.get(k)||[]),i]);}
      const label=(k:number)=>{const end=new Date(Date.now()-k*7*86400*1000),start=new Date(end.getTime()-6*86400*1000);const f=(d:Date)=>`${d.getMonth()+1}月${d.getDate()}日`;return k===0?`最近 7 天（${f(start)}–${f(end)}）`:`${f(start)}–${f(end)}`;};
      return <div className="done-archive"><div className="hub-tools"><button className="link" onClick={()=>setDoneView(false)}>‹ 返回任务板</button><input aria-label="搜索已完成任务" placeholder="搜标题、描述、完成说明…" value={doneQuery} onChange={e=>setDoneQuery(e.target.value)}/><span className="muted small">{hits.length} / {doneAll.length} 项已完成</span></div>{[...groups.keys()].sort((a,b)=>a-b).map(k=><section key={k} className="done-week"><h4>{label(k)}<span className="n">{groups.get(k)!.length}</span></h4>{groups.get(k)!.map(taskRow)}</section>)}{!hits.length&&<p className="empty">没有匹配的已完成任务。</p>}</div>;}
    return <><p className="muted">任务显示发起和参与会话；历史任务没有明确关系时保留待归属，不根据提及次数猜测。</p>{err&&<p className="danger">{err}</p>}<div className="hub-board">{cols.map(([label,list])=><section className={`hub-col${label==='只能你做'?' needs-you':''}`} key={label}><h4>{label}<span className="n">{list.length}</span>{label==='已完成'&&doneAll.length>doneRecent.length&&<button className="link small" onClick={()=>setDoneView(true)}>全部 {doneAll.length} ›</button>}</h4>{label==='只能你做'&&!list.length&&<p className="muted small">Agent 遇到只有你能做的事（发邮件、付款、登录、演示）会记在这里，做完打勾。</p>}{label==='已完成'&&!list.length&&doneAll.length>0&&<p className="muted small">最近 7 天没有完成的任务；更早的在「全部」里。</p>}{list.map(i=>label==='只能你做'?<div className="hub-task needs-you-task" key={i.id}><label className="tick" title="做完了，打勾关掉"><input type="checkbox" onChange={()=>void tick(i)} aria-label={`做完了：${i.title}`}/></label><div className="needs-you-body"><button className="link task-title" onClick={()=>onTask(i.id)}>{i.title}</button>{i.description&&<p className="muted small clamp-2">{i.description}</p>}</div></div>:taskRow(i))}</section>)}</div></>;})()}
  {tab==='unassigned'&&<><p className="muted">任务显示发起和参与会话；历史任务没有明确关系时保留待归属，不根据提及次数猜测。</p>{unassigned.map(taskRow)}{!unassigned.length&&<p className="empty">任务都已有明确关联。</p>}</>}
  {tab==='folders'&&<><p className="muted">这个项目的会话在哪些文件夹里发生过。</p>{dirs.map(([d,info])=><div className="hub-task hub-dir" key={d}><div className="hub-dir-head"><code title={d}>{short(d)}</code><span className="muted small">{info.count} 个会话 · 最近 {ago(info.last)}</span></div><div className="task-links"><button className="btn sm" onClick={()=>onNew(info.latest)}>在此目录新建会话</button><button className="btn sm" onClick={()=>api.openPath(d).catch(()=>{})}>在 Finder 打开</button><button className="btn sm" onClick={()=>api.copy(`cd '${d}'`).catch(()=>{})}>复制 cd</button></div></div>)}{!dirs.length&&<p className="empty">没有记录到工作目录。</p>}</>}
  {tab==='docs'&&<><ProjectFacts api={api} name={project.name}/><ProjectDocs api={api} name={project.name} docs={docs} onReload={loadDocs}/></>}
  {tab==='wiki'&&<ProjectWiki entries={wiki} project={project.name} onTask={onTask}/>}
  {tab==='outcomes'&&<>{editor!==false?<OutcomeEditor key={editor?.id||"new"} project={project.name} rows={project.sessions} tasks={project.items} initial={editor||undefined} api={api} onCancel={()=>setEditor(false)} onSaved={()=>{setEditor(false);onReload();}}/>:<button className="btn primary" onClick={()=>setEditor(null)}>登记成果</button>}{project.results.map(r=><article className="outcome-card" key={r.id}><div className="hub-heading"><h3>{r.title}</h3><button className="btn sm" onClick={()=>setEditor(r)}>编辑</button></div><MediaProvider api={api} session={rows.find(a=>linkedSessions(r).includes(a.session_id))}><Markdown src={r.description||''}/></MediaProvider><div className="task-links">{sourceTasks(r).map(id=><button key={id} className="chip" onClick={()=>onTask(id)}>任务 · {tasks.find(i=>i.id===id)?.title||id}</button>)}{linkedSessions(r).map(id=><button key={id} className="chip" onClick={()=>onOpen(id)}>会话 · {rows.find(a=>a.session_id===id)?.title||id.slice(0,8)} ↗</button>)}</div></article>)}{!project.results.length&&editor===false&&<p className="empty">还没有登记成果。可以把多个任务、多个会话的交付汇总在这里。</p>}<details className="hub-history"><summary>历史完成记录 · {project.items.filter(i=>i.status==='closed').length} 项</summary><p className="muted small">这些是任务完成说明，尚未整理为独立成果。</p>{project.items.filter(i=>i.status==='closed').map(i=><div className="hub-task" key={i.id}><button className="link" onClick={()=>onTask(i.id)}>{i.title}</button><p>{i.close_reason||'打开任务查看完成说明'}</p></div>)}</details></>}
  </div>;
}
