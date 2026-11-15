import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { Activity, Host, Issue, MoveJob } from '../types';
import type { Api } from '../api';
import { ProjectTimeline, useHere, type HereState, type ReviewData } from './Timeline';
import { UNGROUPED_PROJECT, activityKey, conversationProject, sessionLifecycle, workspaceProjectOf } from '../activity';
import { isNeedsYou, linkedSessions, originSession, projectGroups, projectHome, sourceTasks } from '../projectModel';
import { isArchived, isStarred, ownerHostId, newSessionTarget, rankProjects, type ProjectFlagChange, type ProjectFlags, type ProjectOwner, projectLabel } from '../projectFlags';
import { acceptanceProgress, actorOf, ago, columnOf, issueAcceptance, projectOf, relTime } from '../derive';
import { ProjectGlyph, SessionDetail, sessionGroup, sessionTag } from './Workspace';
import { Dropdown, EmptyView, ListDetail, Meta, Meter, Row, Section, Sep, Tabs, Tag, useListKeyboard } from './primitives';
import { useActionTarget, useShellHeader } from './Shell';
import { Avatar, Pri, StatusPill } from './ui';
import { Icon } from './icons';
import { Markdown } from './Markdown';
import { MediaContext, MediaProvider, type AttachmentData } from './Media';
import { NewProject } from './NewProject';
import { hostOfProject } from '../projectHosts';
import { MenuItem, MenuPanel } from './ContextMenu';
import { intlLocale, t as tr, useLocale, useT } from '../i18n';
import { homeOf, isUnder, isWindows, shortPath } from '../platform';

// A research / review / design write-up found in the project's folders or registered by hand.
type Doc = { id: string; title: string; kind: string; path: string; url?: boolean; html?: boolean; size?: number; mtime?: number; ext?: string; dir?: string; source?: string; host?: string; host_name?: string };
const openExternal = (url: string) => { window.open(url, '_blank'); };

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
const FACTS_TEMPLATE = (name: string) => tr("# {name} 常用信息\n\n> 只放这个项目才用的短事实，Agent 需要时 `dispatch facts get -P {name} <主题>` 读。密码和 Key 不写这里，放「规则与资料 → 密钥与 API」并填项目名。\n\n## 服务器\n\n**示例服务**\n- 入口 / 登录方式 / 找谁开账号\n", { name });
export function ProjectFactsView({ name, doc, keys, draft, busy, err, onEdit, onChange, onCancel, onSave, onOpenPath, onCopy }: { name: string; doc: ProjectFactsDoc | null; keys: ProjectKey[] | null; draft: string | null; busy: boolean; err: string; onEdit: () => void; onChange: (t: string) => void; onCancel: () => void; onSave: () => void; onOpenPath: (p: string) => void; onCopy: (t: string) => void }) {
  const t = useT();
  const hasLegacy = !!doc?.legacy?.length;
  return <section className="project-facts" aria-label={t('项目常用信息')}>
    <div className="hub-tools"><b>{t('常用信息')}</b><span className="chip">FACTS.md</span>{doc?.path && <code className="muted small doc-path" title={doc.path}>{shortPath(doc.path)}</code>}<span className="spacer" />
      {draft === null
        ? <>{doc?.exists && <button className="btn sm" onClick={() => onOpenPath(doc.path)}>{isWindows ? t('在资源管理器中显示') : t('在 Finder 打开')}</button>}<button className="btn sm" disabled={busy || !doc} onClick={onEdit}>{doc?.exists ? t('编辑') : t('建一份')}</button></>
        : <><button className="btn sm" disabled={busy} onClick={onCancel}>{t('取消')}</button><button className="btn primary sm" disabled={busy} onClick={onSave}>{busy ? t('保存中…') : t('保存')}</button></>}</div>
    <p className="muted small">{t('只属于这个项目的短事实：服务器入口、登录方式、找谁。Agent 不会每次注入，需要时才')} <span className="mono">dispatch facts get -P {name} {t("主题")}</span> {t('读。')}</p>
    {err && <p className="err small" role="alert">{err}</p>}
    {draft !== null ? <textarea className="project-facts-editor" aria-label={t('编辑项目常用信息')} value={draft} onChange={(e) => onChange(e.target.value)} spellCheck={false} />
      : doc === null ? <p className="empty">{t('正在读…')}</p>
      : doc.content ? <div className="doc-reader"><Markdown src={doc.content} /></div>
      : <p className="empty">{doc.path ? t('还没有 FACTS.md。') : t('还不知道这个项目的目录（先在项目目录里开一次会话）。')}{hasLegacy && ` ${t('全局 FACTS.md 里有这个项目的旧节，见下。')}`}</p>}
    {hasLegacy && draft === null && <details className="project-facts-legacy"><summary className="muted small">{t('全局 FACTS.md 里的旧项目节 · {n}（可搬进项目 FACTS.md）', { n: doc!.legacy!.length })}</summary>{doc!.legacy!.map((l) => <div key={l.heading}><h4>{l.heading}</h4><Markdown src={l.body} /></div>)}</details>}
    <div className="hub-tools project-keys-head"><b>{t('密钥')}</b><span className="muted small">{keys ? t('{n} 个 · 只列名字和用途，值在「规则与资料 → 密钥与 API」', { n: keys.length }) : '…'}</span></div>
    {keys && keys.length > 0 && <div className="project-keys">{keys.map((k) => <div className="hub-task project-key" key={k.name}><code className="mono">{k.name}</code><span className="muted small">{k.note || t('（没写用途）')}</span><span className="spacer" /><button className="btn sm" title={`dispatch env get ${k.name}`} onClick={() => onCopy(`dispatch env get ${k.name}`)}>{t('复制取用命令')}</button></div>)}</div>}
    {keys && keys.length === 0 && <p className="empty small">{t('还没有登记到这个项目的密钥。在「规则与资料 → 密钥与 API」添加时项目填')} <span className="mono">{name}</span>{t('，或用命令')} <span className="mono">dispatch env set {t("名 值")} -P {name}</span></p>}
  </section>;
}

export function ProjectFacts({ api, name, onDone }: { api: Api; name: string; onDone?: (m: string) => void }) {
  const [doc, setDoc] = useState<ProjectFactsDoc | null>(null); const [keys, setKeys] = useState<ProjectKey[] | null>(null);
  const [draft, setDraft] = useState<string | null>(null); const [busy, setBusy] = useState(false); const [err, setErr] = useState('');
  const parse = <T,>(t: string, fallback: T): T => { try { const i = Math.min(...[t.indexOf('{'), t.indexOf('[')].filter((x) => x >= 0)); return JSON.parse(t.slice(i)); } catch { return fallback; } };
  const load = useCallback(async () => {
    setErr('');
    const [d, k] = await Promise.allSettled([api.on(hostOfProject(name), ['facts', 'show', '-P', name, '--json']), api.on('local', ['env', 'list', '-P', name, '--json'])]);
    setDoc(d.status === 'fulfilled' ? parse<ProjectFactsDoc>(d.value, { path: '', content: '', exists: false }) : { path: '', content: '', exists: false });
    setKeys(k.status === 'fulfilled' ? parse<ProjectKey[]>(k.value, []) : []);
    if (d.status === 'rejected') setErr(String(d.reason));
  }, [api, name]);
  useEffect(() => { setDoc(null); setKeys(null); setDraft(null); void load(); }, [load]);
  const save = async () => { if (draft === null) return; setBusy(true); setErr(''); try { await api.on(hostOfProject(name), ['facts', 'write', '-P', name], draft); setDraft(null); onDone?.(tr('已保存 FACTS.md（在项目目录，记得 commit）')); await load(); } catch (e) { setErr(String(e)); } finally { setBusy(false); } };
  return <ProjectFactsView name={name} doc={doc} keys={keys} draft={draft} busy={busy} err={err} onEdit={() => setDraft(doc?.content || FACTS_TEMPLATE(name))} onChange={setDraft} onCancel={() => setDraft(null)} onSave={() => void save()} onOpenPath={(p) => void api.openPath(p).catch(() => {})} onCopy={(text) => void api.copy(text).then(() => onDone?.(tr('已复制'))).catch(() => {})} />;
}

export function ProjectDocs({ api, name, docs, onReload }: { api: Api; name: string; docs: Doc[] | null; onReload: () => void }) {
  const t = useT();
  const [opened, setOpened] = useState<{ doc: Doc; text: string; dir?: string } | null>(null);
  const [err, setErr] = useState(''); const [path, setPath] = useState(''); const [kind, setKind] = useState('调研'); const [busy, setBusy] = useState(false);
  useEffect(() => { setOpened(null); setErr(''); setPath(''); }, [name]);
  const parse = (t: string) => { const d = JSON.parse(t.slice(Math.max(0, t.indexOf('{')))) as { error?: string; [k: string]: unknown }; if (d.error) throw new Error(d.error); return d; };
  const open = async (doc: Doc) => {
    setErr('');
    if (doc.url) { void openExternal(doc.path); return; }
    if (doc.html || doc.ext === 'html' || doc.ext === 'htm') {
      if (doc.host) { setErr(t('这份文档在 {host}，暂时只能在这里读 Markdown 文档', { host: doc.host_name || doc.host })); return; }
      await api.openPath(doc.path).catch((e) => setErr(String(e))); return;
    }
    try { const d = parse(await api.on(doc.host || 'local', ['docs', 'read', name, doc.id, '--json'])); setOpened({ doc, text: String(d.text || ''), dir: d.dir as string | undefined }); } catch (e) { setErr(String(e)); }
  };
  const add = async () => { setBusy(true); setErr(''); try { parse(await api.on('local', ['docs', 'add', name, path.trim(), '--kind', kind, '--json'])); setPath(''); onReload(); } catch (e) { setErr(String(e)); } finally { setBusy(false); } };
  // Registered documents (调研 / 复审 / 设计 written for the person) first, then the scan, newest first;
  // the search box matches title, file name, folder and kind.
  const [docQuery, setDocQuery] = useState('');
  const shownDocs = useMemo(() => {
    const q = docQuery.trim().toLowerCase();
    const list = (docs ?? []).filter((d) => !q || `${d.title} ${d.path} ${d.kind} ${t(d.kind)}`.toLowerCase().includes(q));
    const rank = (d: Doc) => (d.source === 'registered' ? 0 : 1);
    return [...list].sort((a, b) => rank(a) - rank(b) || (b.mtime || 0) - (a.mtime || 0));
  }, [docs, docQuery]);
  const remove = async (doc: Doc) => { setBusy(true); setErr(''); try { parse(await api.on('local', ['docs', 'rm', name, doc.id, '--json'])); onReload(); } catch (e) { setErr(String(e)); } finally { setBusy(false); } };
  const actions = (d: Doc) => <span className="doc-actions" onClick={(e) => e.stopPropagation()}>{d.url ? <button className="btn ghost sm" onClick={() => void openExternal(d.path)}>{t('打开链接')}</button>
    : d.host ? <span className="muted small" title={d.path}>{t('在 {host}', { host: d.host_name || d.host })}</span>
    : <><button className="btn ghost sm" onClick={() => void api.openPath(d.path).catch(() => {})}>{isWindows ? t('在资源管理器中显示') : t('在 Finder 打开')}</button><button className="btn ghost sm" onClick={() => void api.copy(d.path).catch(() => {})}>{t('复制路径')}</button></>}{d.source === 'registered' && <button className="btn ghost sm" disabled={busy} onClick={() => void remove(d)}>{t('移除登记')}</button>}</span>;
  if (opened) {
    const d = opened.doc;
    return <div className="doc-reader"><div className="hub-tools"><button className="btn sm" onClick={() => setOpened(null)}>{t('‹ 文档列表')}</button><Tag>{t(d.kind)}</Tag><b>{d.title}</b><code className="muted small doc-path" title={d.path}>{shortPath(d.path)}</code>{d.host && <Tag>{d.host_name || d.host}</Tag>}<span className="spacer" />{actions(d)}</div><DocMedia api={api} project={name} id={d.id} dir={opened.dir} host={d.host}><Markdown src={opened.text} /></DocMedia></div>;
  }
  const meta = (d: Doc) => `${d.mtime ? new Date(d.mtime * 1000).toLocaleDateString(intlLocale()) : ''}${d.size ? ` · ${d.size >= 1048576 ? `${(d.size / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(d.size / 1024))} KB`}` : ''}`;
  return <div className="docs-tab">
    <div className="pj-toolbar">
      {docs !== null && docs.length > 0 && <input className="tabs-filter" aria-label={t('搜索文档')} placeholder={t('搜索文档：标题、文件名、类型…')} value={docQuery} onChange={(e) => setDocQuery(e.target.value)} />}
      <span className="spacer" />
      <form className="doc-add" onSubmit={(e) => { e.preventDefault(); void add(); }}><input className="ctl" aria-label={t('文档路径或 URL')} placeholder={t('路径或 URL，例如 design/research-2026-09-09.md')} value={path} onChange={(e) => setPath(e.target.value)} /><select className="ctl" aria-label={t('文档类型')} value={kind} onChange={(e) => setKind(e.target.value)}>{['调研', '复审', '设计', '文档', '其他'].map((k) => <option key={k} value={k}>{t(k)}</option>)}</select><button className="btn sm" disabled={busy || !path.trim()}>{t('登记文档…')}</button></form>
    </div>
    {err && <p className="pj-note err">{err}</p>}
    {docs === null ? <p className="pj-hint">{t('正在扫描这个项目的 design/、docs/、研究/…')}</p>
      : docs.length === 0 ? <EmptyView icon="doc" title={t('还没有文档')} description={t('还没有文档。调研、复审产出写到项目的 design/ 目录，或在这里登记一个路径 / URL。')} />
      : shownDocs.length === 0 ? <p className="pj-hint">{t('没有匹配的文档。')}</p>
      : <div className="doc-list">{shownDocs.map((d) => <Row key={d.id} id={`doc:${d.id}`} onClick={() => void open(d)} tooltip={d.url ? d.path : shortPath(d.path)} icon={<Icon name={d.url ? 'external' : 'doc'} />} title={d.title}
        accessories={[<Tag>{t(d.kind)}</Tag>, ...(d.host ? [<Tag>{d.host_name || d.host}</Tag>] : []), ...(meta(d) ? [meta(d)] : []), actions(d)]} />)}</div>}
  </div>;
}

export function TaskRelations({issue,rows,api,onSaved,onOpen}:{issue:Issue;rows:Activity[];api:Api;onSaved:()=>void;onOpen:(id:string)=>void}) {
  const t=useT();
  const [edit,setEdit]=useState(false),[origin,setOrigin]=useState(''),[participants,setParticipants]=useState<string[]>([]),[busy,setBusy]=useState(false),[error,setError]=useState('');
  const ids=linkedSessions(issue);
  // The picker's option list is only needed while editing: computing it for every task on every
  // 3-second sync made long task lists scroll like mud.
  const options=useMemo(()=>edit?rows.filter((a,n,all)=>all.findIndex(x=>x.session_id===a.session_id)===n).sort((a,b)=>Number(conversationProject(b)===projectOf(issue))-Number(conversationProject(a)===projectOf(issue))):[],[edit,rows,issue]);
  const missing=ids.filter(id=>!options.some(a=>a.session_id===id));
  const save=async()=>{setBusy(true);setError('');try{const add=[...new Set([...participants,origin].filter(Boolean))].map(id=>'session:'+id);if(origin)add.push('session-origin:'+origin);await api.labels(issue.id,add,(issue.labels||[]).filter(l=>l.startsWith('session:')||l.startsWith('session-origin:')).filter(l=>!add.includes(l)));setEdit(false);onSaved();}catch(e){setError(String(e));}finally{setBusy(false);}};
  return <div className="task-relations"><div className="task-links">{ids.length?ids.map(id=><button key={id} className="chip" onClick={()=>onOpen(id)}>{originSession(issue)===id?t('发起'):t('参与')} · {rows.find(a=>a.session_id===id)?.title||id.slice(0,8)} ↗</button>):<span className="muted small">{t('没记录（Agent 建任务时通常会自动记）')}</span>}<button className="link" onClick={()=>{setOrigin(originSession(issue));setParticipants(ids);setEdit(!edit);}}>{t('指定是哪次会话')}</button></div>{edit&&<div className="relation-editor"><label>{t('发起会话')}<select aria-label={t('发起会话')} value={origin} onChange={e=>setOrigin(e.target.value)}><option value="">{t('暂不指定')}</option>{options.map(a=><option key={a.session_id} value={a.session_id}>{conversationProject(a)} · {a.title}</option>)}{missing.map(id=><option key={id} value={id}>{t('{id}（历史会话）',{id})}</option>)}</select></label><details><summary>{t('参与会话 · 可选多个')}</summary><div className="relation-options">{options.map(a=><label key={a.session_id}><input type="checkbox" checked={participants.includes(a.session_id)} onChange={e=>setParticipants(old=>e.target.checked?[...old,a.session_id]:old.filter(x=>x!==a.session_id))}/>{a.title}</label>)}</div></details><button className="btn primary sm" disabled={busy} onClick={()=>void save()}>{t('保存')}</button><button className="btn sm" disabled={busy} onClick={()=>setEdit(false)}>{t('取消')}</button>{error&&<p role="alert">{error}</p>}</div>}</div>;
}

function OutcomeEditor({project,rows,tasks,initial,api,onSaved,onCancel}:{project:string;rows:Activity[];tasks:Issue[];initial?:Issue;api:Api;onSaved:()=>void;onCancel:()=>void}){
  const t=useT();
  const [title,setTitle]=useState(initial?.title||''),[body,setBody]=useState(initial?.description||''),[taskIds,setTaskIds]=useState<string[]>(initial?sourceTasks(initial):[]),[sessionIds,setSessionIds]=useState<string[]>(initial?linkedSessions(initial):[]),[busy,setBusy]=useState(false),[error,setError]=useState(''),[created,setCreated]=useState(initial?.id||'');
  const save=async()=>{setBusy(true);setError('');try{const linked=[...new Set([...sessionIds,...tasks.filter(i=>taskIds.includes(i.id)).flatMap(linkedSessions)])];const labels=['dispatch:outcome',...(project===UNGROUPED_PROJECT?[]:['project:'+project]),...taskIds.map(id=>'outcome-task:'+id),...linked.map(id=>'session:'+id)];let id=created;if(!id){const result=await api.create({title:title.trim(),description:body.trim(),issue_type:'task',priority:2,labels});id=result.id;setCreated(id);}else{await api.update(id,{title:title.trim(),description:body.trim()});await api.labels(id,labels,(initial?.labels||[]).filter(l=>(l.startsWith('outcome-task:')||l.startsWith('session:'))&&!labels.includes(l)));}await api.close(id,'已登记项目成果');onSaved();}catch(e){setError(String(e));}finally{setBusy(false);}};
  return <form className="outcome-editor" onSubmit={e=>{e.preventDefault();void save();}}><h3>{initial?t('编辑成果'):t('登记成果')}</h3><label>{t('成果名称')}<input aria-label={t('成果名称')} required maxLength={200} value={title} onChange={e=>setTitle(e.target.value)} placeholder={t('例如：Dispatch 新版 · 项目工作台')}/></label><label>{t('交付内容与查看入口')}<textarea aria-label={t('交付内容与查看入口')} required rows={5} value={body} onChange={e=>setBody(e.target.value)} placeholder={t('写明交付了什么，附上文档、截图、版本或代码链接（支持 Markdown）')}/></label><div className="outcome-sources"><details open><summary>{t('来源任务 · 可选多个')}</summary><div className="relation-options">{tasks.map(i=><label key={i.id}><input type="checkbox" checked={taskIds.includes(i.id)} onChange={e=>setTaskIds(old=>e.target.checked?[...old,i.id]:old.filter(x=>x!==i.id))}/>{i.title}</label>)}</div></details><details><summary>{t('补充来源会话 · 已选任务的会话会一并关联')}</summary><div className="relation-options">{rows.map(a=><label key={a.key}><input type="checkbox" checked={sessionIds.includes(a.session_id)} onChange={e=>setSessionIds(old=>e.target.checked?[...old,a.session_id]:old.filter(x=>x!==a.session_id))}/>{a.title}</label>)}</div></details></div>{error&&<p role="alert">{t('保存失败：{error}',{error})}</p>}<button className="btn primary" disabled={busy||!title.trim()||!body.trim()}>{t('保存成果')}</button><button className="btn" type="button" disabled={busy} onClick={onCancel}>{t('取消')}</button></form>;
}

type Props={onDiscuss?:(name:string)=>void;focusSection?:{section:"review"|"sessions";token:number}|null;onSectionDone?:()=>void;archiveDays:number;flags:ProjectFlags;onFlag:(name:string,change:ProjectFlagChange)=>void;connectionError:boolean;unavailable:string[];rows:Activity[];tasks:Issue[];outcomes:Issue[];api:Api;me:string;selected:string|null;onProject:(name:string|null)=>void;onOpen:(id:string)=>void;onTask:(id:string)=>void;onRead:(a:Activity)=>Promise<void>;onSummarize?:(a:Activity)=>Promise<void>;onReload:()=>void;onNew:(a?:Activity)=>void;onCreated?:(name:string,dir:string,startSession:boolean)=>void;workspaceRoots?:string[];loaded:boolean;hosts?:Host[];owners?:Record<string,ProjectOwner>;moveJobs?:MoveJob[];onMoveProject?:(project:string,cwd:string,fromHost:string,to:Host)=>Promise<void>;/** A short message in the bottom bar (App's say); without it the page shows it inline. */onSay?:(text:string,error?:boolean)=>void};
type WikiEntry={key:string;kind:'pit'|'win'|'retro'|'howto'|string;text:string;fields?:Record<string,string>;project?:string;task?:string;raw?:string};
// Keys are the Chinese source text; every use goes through t().
const WIKI_KIND:Record<string,string>={pit:'坑',win:'做对',retro:'复盘',howto:'做法'};
// The knowledge base filtered to one project: what went wrong here, what worked, the retros —
// the same entries `dispatch wiki` shows, without the other projects' noise.
function ProjectWiki({entries,project,onTask}:{entries:WikiEntry[]|null;project:string;onTask:(id:string)=>void}){
  const t=useT();
  const [kind,setKind]=useState('all');const [q,setQ]=useState('');
  if(entries===null)return <p className="empty">{t('正在读这个项目的知识库…')}</p>;
  const counts:Record<string,number>={};for(const e of entries)counts[e.kind]=(counts[e.kind]||0)+1;
  const shown=entries.filter(e=>(kind==='all'||e.kind===kind)&&(!q.trim()||`${e.text} ${Object.values(e.fields||{}).join(' ')}`.toLowerCase().includes(q.toLowerCase())));
  return <div className="project-wiki">
    <div className="hub-tools"><div className="views">{[['all','全部',entries.length],...Object.entries(WIKI_KIND).filter(([k])=>counts[k]).map(([k,l])=>[k,l,counts[k]])].map(([k,l,n])=><button key={String(k)} className={kind===k?'on':''} onClick={()=>setKind(String(k))}>{t(String(l))} {n}</button>)}</div><label className="search"><input placeholder={t('搜这个项目的知识库…')} value={q} onChange={e=>setQ(e.target.value)}/></label></div>
    {!entries.length&&<p className="empty">{t('这个项目还没有知识库条目。Agent 踩坑或做对后用')} <code>dispatch wiki add --kind pit/win -P {project}</code> {t('记下来，就会出现在这里。')}</p>}
    {!!entries.length&&!shown.length&&<p className="empty">{t('没有匹配的条目。')}</p>}
    <div className="wiki-list">{shown.map(e=><div key={e.key} className={`wiki-item k-${e.kind}`}><div className="wiki-head"><span className={`review-kind k-${e.kind==='pit'?'task':e.kind==='win'?'done':'session'}`}>{WIKI_KIND[e.kind]?t(WIKI_KIND[e.kind]):e.kind}</span>{e.task&&<button className="link mono" onClick={()=>onTask(e.task!)}>{e.task}</button>}<span className="muted small mono">{e.key}</span></div><p className="wiki-text">{e.text}</p>{Object.entries(e.fields||{}).filter(([,v])=>v).map(([k,v])=><p key={k} className="wiki-field"><b>{t(k.replace(/[【】]/g, ""))}</b>{v}</p>)}</div>)}</div>
  </div>;
}

// ---- Projects page (design/raycast-redesign 图 4 and 图 6) ----
// The list is 40px rows grouped 今天有动静 / 更早; a project page is the header, four tabs
// (会话 / 任务 / 成果 / 资料, plus 回顾) and a list with the selected item's Detail on the right.

type Group = ReturnType<typeof projectGroups>[number];
const since = (sec?: number) => (sec ? relTime(new Date(sec * 1000).toISOString()) : '');
const isToday = (sec: number) => !!sec && new Date(sec * 1000).toDateString() === new Date().toDateString();
// Phones hide the Detail pane: a tap opens the row instead of only selecting it.
const narrow = () => typeof window !== 'undefined' && !!window.matchMedia?.('(max-width: 640px)').matches;

/** Where rows stand while a list is on screen. The 3-second sync only refreshes a row's
 *  accessories: a row keeps its place and its group until the list is left and opened again
 *  (or its tab, sort or filter changes, which is `sig`). New rows go to the end of their group. */
export type FrozenOrder = { sig: string; pos: Map<string, number>; group: Map<string, string> };
export const newFrozenOrder = (): FrozenOrder => ({ sig: '', pos: new Map(), group: new Map() });
export function stableOrder<T>(fresh: T[], key: (x: T) => string, groupOf: (x: T) => string, memo: FrozenOrder, sig: string): { item: T; group: string }[] {
  if (memo.sig !== sig) { memo.sig = sig; memo.pos = new Map(); memo.group = new Map(); }
  for (const x of fresh) { const k = key(x); if (!memo.pos.has(k)) { memo.pos.set(k, memo.pos.size); memo.group.set(k, groupOf(x)); } }
  return fresh.map((item) => ({ item, group: memo.group.get(key(item))! })).sort((a, b) => memo.pos.get(key(a.item))! - memo.pos.get(key(b.item))!);
}

/** Where a project lives: which machine and folder its page opens (editor, new conversations), and
 *  which other machines 迁移到 offers (never the one the folder is on). */
export function projectPlace({ project, flags, owners, hosts, home, canMove }: { project: Pick<Group, 'name' | 'sessions'>; flags: ProjectFlags; owners: Record<string, ProjectOwner>; hosts: Host[]; home: string; canMove: boolean }) {
  // No conversation yet: the folder chosen when the project was created.
  const homeAct = projectHome(project.sessions);
  const ownerId = ownerHostId(owners[project.name], hosts);
  const flagDir = flags[project.name]?.dir;
  const flagHere = !!flagDir && (!homeOf(flagDir) || (!!home && isUnder(flagDir, home)));
  const target = newSessionTarget(ownerId, homeAct || (flagDir && (flagHere || (ownerId && ownerId !== 'local')) ? { cwd: flagDir } : undefined), 'local');
  const host = target.initialHost;
  const machine = hosts.find((h) => (h.local ? 'local' : h.id) === host)?.name || host;
  const cwd = target.initialCwd;
  // One tap hands the whole project (folder, Git, running conversations) to another Mac:
  // it runs on the Mac the project's folder is on now, and is refused there when Git would lose work.
  // An offline Mac stays in the list so the menus can show it greyed out with the reason.
  const moveTargets = cwd && canMove ? hosts.filter((h) => (h.local ? 'local' : h.id) !== host) : [];
  return { host, machine, cwd, moveTargets };
}

type Hub = Props & { hosts: Host[]; owners: Record<string, ProjectOwner>; moveJobs: MoveJob[]; groups: Group[]; ranked: { active: Group[]; archived: Group[] }; primary: (p: Group) => boolean; ownerOf: (p: Group) => { name: string; why: string }; moveOf: (name: string) => MoveJob | undefined };

export function ProjectHub(props: Props) {
  const { api, selected, rows, tasks, outcomes, flags, workspaceRoots, hosts = [], owners = {}, moveJobs = [] } = props;
  const t = useT();
  // 知识库 scoped to this project: the pits, wins, retros and how-tos filed with its name.
  const [wiki, setWiki] = useState<WikiEntry[] | null>(null);
  useEffect(() => { setWiki(null); if (!selected) return; let alive = true; void api.on('local', ['wiki', 'list', '-P', selected, '--json']).then((t) => { const d = JSON.parse(t.slice(Math.max(0, t.indexOf('[')))); if (alive) setWiki(Array.isArray(d) ? d as WikiEntry[] : []); }).catch(() => { if (alive) setWiki([]); }); return () => { alive = false; }; }, [api, selected]);
  const [docs, setDocs] = useState<Doc[] | null>(null);
  const loadDocs = useCallback(() => { setDocs(null); if (!selected) return; void api.on('local', ['docs', selected, '--json']).then((t) => { const d = JSON.parse(t.slice(Math.max(0, t.indexOf('{')))); setDocs(Array.isArray(d.docs) ? d.docs as Doc[] : []); }).catch(() => setDocs([])); }, [api, selected]);
  useEffect(() => { loadDocs(); }, [loadDocs]);
  // 现状 and the live sessions (`dispatch here`), shared by the 脉络 tab and the 会话 tab's close-or-not verdicts.
  const here = useHere(api, selected);
  const groups = useMemo(() => projectGroups(rows, tasks, outcomes, flags), [rows, tasks, outcomes, flags]);
  // A real project: it has tasks or outcomes, was linked by hand, was created in the app with a folder, is starred,
  // or its conversations live under a workspace root (~/Projects/<name>: the person put it there on purpose).
  const primary = (p: Group) => p.items.length > 0 || p.results.length > 0 || p.sessions.some((a) => !!a.project_override) || !!flags[p.name]?.dir || isStarred(flags, p.name) || p.sessions.some((a) => !!workspaceProjectOf(a.cwd, workspaceRoots));
  const ranked = useMemo(() => rankProjects(groups, flags), [groups, flags]);
  const project = groups.find((p) => p.name === selected);
  // Which Mac a project is on: its hand-set owner, else where its conversations run, else the
  // `host:` labels on its tasks (a project that is only tasks on the board still ran somewhere).
  const ownerOf = (p: Group): { name: string; why: string } => {
    const ctx = projectHome(p.sessions);
    const id = ownerHostId(owners[p.name], hosts) || (ctx ? (ctx.host || 'local') : undefined);
    const h = hosts.find((x) => (x.local ? 'local' : x.id) === id);
    const name = h?.name || owners[p.name]?.host;
    if (name) return { name, why: owners[p.name] ? t('项目已交接给这台：新建会话默认开在这里') : t('项目目录目前在这台电脑上') };
    const tally = new Map<string, number>();
    for (const i of p.items) { const l = (i.labels || []).find((x) => x.startsWith('host:'))?.slice(5); if (l) tally.set(l, (tally.get(l) || 0) + 1); }
    const fromTasks = [...tally.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || '';
    return fromTasks ? { name: fromTasks, why: t('按这个项目的任务在哪台电脑上做过推断') } : { name: '', why: t('还没有归属、目录或任务记录') };
  };
  // The move running on this project, if any.
  const moveOf = (name: string) => moveJobs.find((j) => j.project === name && j.state === 'running');
  const hub: Hub = { ...props, hosts, owners, moveJobs, groups, ranked, primary, ownerOf, moveOf };
  if (!project) return <ProjectList hub={hub} />;
  return <ProjectPage key={project.name} hub={hub} project={project} here={here} docs={docs} loadDocs={loadDocs} wiki={wiki} />;
}

type ListTab = 'all' | 'starred' | 'other' | 'archived' | `host:${string}`;
type SortKey = 'recent' | 'name' | 'sessions' | 'tasks' | 'owner';
const SORTS: [SortKey, string][] = [['recent', '最近活动'], ['name', '名称'], ['sessions', '会话数'], ['tasks', '待完成任务'], ['owner', '所属电脑']];

function ProjectList({ hub }: { hub: Hub }) {
  const t = useT();
  const locale = useLocale();
  const { flags, ranked, primary, ownerOf, moveOf, archiveDays, api, onNew, onCreated, onProject, loaded, unavailable } = hub;
  const [sortBy, setSortBy] = useState<SortKey>(() => { try { const v = localStorage.getItem('dispatch-projects-sort') as SortKey; return SORTS.some(([k]) => k === v) ? v : 'recent'; } catch { return 'recent'; } });
  useEffect(() => { try { localStorage.setItem('dispatch-projects-sort', sortBy); } catch { /* private mode */ } }, [sortBy]);
  const [tab, setTab] = useState<ListTab>('all');
  const [query, setQuery] = useState('');
  const [creating, setCreating] = useState(false);
  const [sel, setSel] = useState<string | null>(null);
  const frozen = useRef(newFrozenOrder());
  const WEEK = 7 * 86400, now = Date.now() / 1000;
  const info = (p: Group) => {
    const active = p.sessions.filter((a) => !a.scheduled && sessionLifecycle(a, archiveDays) !== 'archived');
    const unread = active.filter((a) => a.unread).length;
    const running = active.filter((a) => a.state === 'working' && !a.stale).length;
    const doing = p.items.find((i) => i.status === 'in_progress');
    const openCount = p.items.filter((i) => i.status !== 'closed').length;
    // One line that says what the project is up to, never a raw chat reply.
    const blurb = doing ? doing.title : p.results[0] ? t('最新成果 · {title}', { title: p.results[0].title }) : active[0]?.title ? t('最近会话 · {title}', { title: active[0].title }) : p.items.length ? t('{n} 个任务，还没有会话', { n: p.items.length }) : t('还没有会话或任务');
    const today = unread > 0 || running > 0 || isToday(p.last);
    return { active, unread, running, openCount, blurb, today, live: today || !!doing || (p.last > 0 && now - p.last < WEEK) };
  };
  const owners = [...new Set(ranked.active.filter(primary).map((p) => ownerOf(p).name).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'));
  const inTab = (p: Group) => tab === 'all' ? primary(p) || !!query.trim() : tab === 'starred' ? isStarred(flags, p.name) : tab === 'other' ? !primary(p) : tab === 'archived' ? true : ownerOf(p).name === tab.slice(5) && primary(p);
  const sorters: Record<SortKey, (a: Group, b: Group) => number> = { recent: () => 0, name: (a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'), sessions: (a, b) => b.sessions.length - a.sessions.length || b.last - a.last, tasks: (a, b) => info(b).openCount - info(a).openCount || b.last - a.last, owner: (a, b) => (ownerOf(a).name || '～').localeCompare(ownerOf(b).name || '～', 'zh-Hans-CN') || b.last - a.last };
  const q = query.trim().toLowerCase();
  const list = (tab === 'archived' ? ranked.archived : ranked.active).filter((p) => inTab(p) && (!q || `${p.name} ${projectLabel(flags, p.name)}`.toLowerCase().includes(q))).sort(sorters[sortBy]);
  const ordered = stableOrder(list, (p) => p.name, (p) => (info(p).today ? 'today' : 'earlier'), frozen.current, `${tab}|${sortBy}|${q}`);
  const today = ordered.filter((x) => x.group === 'today').map((x) => x.item);
  const earlier = ordered.filter((x) => x.group !== 'today').map((x) => x.item);
  const ids = [...today, ...earlier].map((p) => p.name);
  const cur = sel && ids.includes(sel) ? sel : null;
  const open = (name: string) => { setSel(name); onProject(name); };
  useListKeyboard(ids, cur, setSel, { onEnter: open });
  useActionTarget(cur ? { kind: 'project', name: cur } : null, [cur]);
  const sortLabel = t(SORTS.find(([k]) => k === sortBy)![1]);
  useShellHeader({
    subtitle: t('{n} 个 · 按{sort}', { n: list.length, sort: sortLabel }),
    actions: onCreated ? <button className="btn" onClick={() => setCreating(true)} title={t('先建项目再开会话：选文件夹或新建文件夹')}><Icon name="folder" />{t('新建项目')}</button> : undefined,
  }, [list.length, sortLabel, !!onCreated, locale]);
  const row = (p: Group) => {
    const x = info(p);
    const owner = ownerOf(p);
    const j = moveOf(p.name);
    const counts = [x.active.length ? t('{n} 会话', { n: x.active.length }) : '', x.openCount ? t('{n} 未完成', { n: x.openCount }) : ''].filter(Boolean).join(' · ');
    // Three accessories: one state (moving, else running, else unread), the counts, the time. The Mac is in the Detail.
    const acc: ReactNode[] = [
      j ? <Meter value={j.percent} max={100} label={t('迁移到 {host} · {n}%', { host: j.to, n: j.percent })} />
        : x.running ? <Tag color="green" dot>{t('{n} 在跑', { n: x.running })}</Tag>
        : x.unread ? <Tag color="blue">{t('{n} 未读', { n: x.unread })}</Tag> : null,
      counts ? <span title={owner.name ? `${owner.name} · ${owner.why}` : undefined}>{counts}</span> : null,
      <span className="pj-time">{since(p.last)}</span>,
    ].filter((a) => a !== null);
    return <Row key={p.name} id={p.name} data-project={p.name} selected={cur === p.name} onClick={() => open(p.name)} tooltip={t('右键：收藏、归档、新建会话、迁到另一台')}
      icon={<ProjectGlyph name={projectLabel(flags, p.name)} />}
      title={<>{projectLabel(flags, p.name)}{isStarred(flags, p.name) && <span className="pj-star" title={t('已收藏')}> ★</span>}</>} accessories={acc} />;
  };
  const counts = { all: ranked.active.filter(primary).length, starred: ranked.active.filter((p) => isStarred(flags, p.name)).length, other: ranked.active.filter((p) => !primary(p)).length, archived: ranked.archived.length };
  const tabItems: { key: ListTab; label: ReactNode; count?: number; title?: string }[] = [
    { key: 'all', label: t('全部'), count: counts.all },
    ...(counts.starred ? [{ key: 'starred' as ListTab, label: t('收藏'), count: counts.starred }] : []),
    ...(owners.length > 1 ? owners.map((o) => ({ key: `host:${o}` as ListTab, label: o, count: ranked.active.filter((p) => primary(p) && ownerOf(p).name === o).length })) : []),
    { key: 'other', label: t('其他目录'), count: counts.other, title: t('只是在某个文件夹里开过会话，还不算正式项目') },
    { key: 'archived', label: t('已归档'), count: counts.archived },
  ];
  return <>
    <ListDetail className="pj-list" tabs={<Tabs items={tabItems} value={tab} onChange={(k) => { setTab(k); setSel(null); }} right={<>
      <input className="tabs-filter" aria-label={t('搜索项目…')} placeholder={t('搜索项目…')} value={query} onChange={(e) => setQuery(e.target.value)} />
      <Dropdown value={sortBy} onChange={setSortBy} label={t('项目排序')} options={SORTS.map(([k, l]) => ({ value: k, label: t(l) }))} />
    </>} />}>
      {unavailable.length > 0 && <p className="pj-note">{t('{hosts} 暂时无法连接，保留已读取记录。', { hosts: unavailable.join(t('、')) })}</p>}
      {!loaded && <p className="pj-note">{t('正在读取项目与会话…')}</p>}
      {today.length > 0 && <Section title={t('今天有动静')} count={today.length}>{today.map(row)}</Section>}
      {earlier.length > 0 && <Section title={today.length ? t('更早') : t('项目')} count={earlier.length}>{earlier.map(row)}</Section>}
      {loaded && !ids.length && <EmptyView icon={tab === 'archived' ? 'archive' : 'folder'} title={tab === 'archived' ? t('没有归档的项目。') : q ? t('没有匹配的项目') : t('还没有项目')} description={tab === 'archived' || q ? undefined : t('项目 → 会话 → 任务 → 成果')} actions={!q && tab !== 'archived' ? <><button className="btn primary" onClick={() => onNew()}>{t('新建会话')}</button>{onCreated && <button className="btn" onClick={() => setCreating(true)}>{t('新建项目')}</button>}</> : undefined} />}
    </ListDetail>
    {creating && onCreated && <NewProject api={api} onClose={() => setCreating(false)} onCreated={(n, d, start) => { setCreating(false); onCreated(n, d, start); }} />}
  </>;
}

type PageTab = 'overview' | 'sessions' | 'tasks' | 'outcomes' | 'materials';
type Material = 'docs' | 'facts' | 'wiki' | 'folders';
// Old section names (links from the workbench, ?section=, focusSection) → the tab and its sub-view.
// A project opens on 脉络 · 回顾 (overview); only an explicit section picks another tab.
const SECTION_TAB: Record<string, [PageTab, string?]> = { overview: ['overview'], thread: ['overview'], review: ['overview'], sessions: ['sessions'], tasks: ['tasks'], unassigned: ['tasks', 'unassigned'], outcomes: ['outcomes'], docs: ['materials', 'docs'], folders: ['materials', 'folders'], wiki: ['materials', 'wiki'], facts: ['materials', 'facts'] };

function ProjectPage({ hub, project, here, docs, loadDocs, wiki }: { hub: Hub; project: Group; here: HereState; docs: Doc[] | null; loadDocs: () => void; wiki: WikiEntry[] | null }) {
  const t = useT();
  const locale = useLocale();
  const { api, flags, hosts, owners, onFlag, onNew, onDiscuss, onMoveProject, focusSection, onSectionDone, ownerOf, moveOf } = hub;
  const initial = SECTION_TAB[focusSection?.section || new URLSearchParams(location.search).get('section') || ''] ?? ['overview'];
  const [tab, setTab] = useState<PageTab>(initial[0]);
  const [sub, setSub] = useState<string | undefined>(initial[1]);
  useEffect(() => { if (!focusSection) return; const m = SECTION_TAB[focusSection.section]; if (m) { setTab(m[0]); setSub(m[1]); } onSectionDone?.(); }, [focusSection]);
  const [moving, setMoving] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const commitRename = () => { if (renaming === null) return; const v = renaming.trim(); setRenaming(null); if (v === projectLabel(flags, project.name)) return; onFlag(project.name, { alias: v === project.name ? '' : v }); };
  // This Mac's home is not known to a web page: projectPlace treats every recorded folder as it is.
  const home = '';
  const [menu, setMenu] = useState<{ kind: 'more'; x: number; y: number; from: HTMLButtonElement } | null>(null);
  const term = projectPlace({ project, flags, owners, hosts, home, canMove: !!onMoveProject });
  const menuAt = (kind: 'more', from: HTMLButtonElement) => { const r = from.getBoundingClientRect(); setMenu({ kind, x: r.right - 220, y: r.bottom + 6, from }); };
  // The header buttons live in App's header: they call through a ref so they always see this render.
  const act = useRef({ more: (_: HTMLButtonElement) => {} });
  act.current.more = (from) => menuAt('more', from);
  const starred = isStarred(flags, project.name), archived = isArchived(flags, project.name);
  const owner = ownerOf(project);
  const openCount = project.items.filter((i) => i.status !== 'closed').length;
  const sessionsN = project.sessions.filter((a) => !a.scheduled).length;
  const job = moveOf(project.name);
  useShellHeader({
    subtitle: [flags[project.name]?.alias ? project.name : '', owner.name, t('{n} 个会话', { n: sessionsN }), t('{n} 项未完成', { n: openCount }), archived ? t('已归档') : ''].filter(Boolean).join(' · '),
    actions: <>
      <button className="hd-icon" aria-haspopup="menu" title={t('项目操作')} aria-label={t('项目操作')} onClick={(e) => act.current.more(e.currentTarget)}><Icon name="more" /></button>
    </>,
  }, [project.name, flags[project.name]?.alias, owner.name, sessionsN, openCount, archived, locale]);
  const tabsFor = (right?: ReactNode) => <Tabs<PageTab> value={tab} onChange={(k) => { setTab(k); setSub(undefined); }} right={right} items={[
    { key: 'overview', label: t('脉络'), title: t('这个项目的现状、做了什么（新的在上）和还没做的') },
    { key: 'sessions', label: t('会话'), count: sessionsN },
    { key: 'tasks', label: t('项目页·任务'), count: project.items.length },
    { key: 'outcomes', label: t('项目页·成果'), count: project.results.length },
    { key: 'materials', label: t('资料') },
  ]} />;
  const notes = <>
    {renaming !== null && <div className="pj-rename"><span>{t('项目显示名')}</span><input autoFocus value={renaming} maxLength={80} aria-label={t('项目显示名')} onChange={(e) => setRenaming(e.target.value)} onBlur={commitRename} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); commitRename(); } if (e.key === 'Escape') { e.preventDefault(); setRenaming(null); } }} /><span className="muted">{t('标签和目录不变，清空恢复原名')}</span></div>}
    {job && <p className="pj-note" role="progressbar" aria-valuenow={job.percent} aria-valuemin={0} aria-valuemax={100}><Meter value={job.percent} max={100} label={`${t('迁移到 {host}', { host: job.to })} · ${job.label} · ${job.percent}%`} /></p>}
  </>;
  const moreItems: { label: string; onClick: () => void; disabled?: boolean; title?: string; sub?: string }[] = [
    { label: t('在此项目新建会话'), onClick: () => onNew(projectHome(project.sessions)) },
    ...(onDiscuss ? [{ label: t('讨论…'), title: t('就这个项目的一个想法，让几个 Agent 各说一次并出结论'), onClick: () => onDiscuss(project.name) }] : []),
    { label: t('改显示名…'), onClick: () => setRenaming(projectLabel(flags, project.name)) },
    { label: starred ? t('取消收藏') : t('收藏：置顶'), onClick: () => onFlag(project.name, { starred: !starred }) },
    { label: archived ? t('取消归档') : t('归档'), title: archived ? t('恢复到工作台和项目列表') : t('做完了、暂时不用：从工作台和项目列表隐藏，随时可找回'), onClick: () => onFlag(project.name, { archived: !archived }) },
    ...term.moveTargets.map((h) => ({ label: job && job.to === h.name ? t('迁移中 {n}%', { n: job.percent }) : moving === h.id ? t('预检中…') : t('迁移到 {host}', { host: h.name }), disabled: !!moving || !!job || !(h.local || h.online), sub: h.local || h.online ? undefined : t('{name} 离线', { name: h.name }), title: t('把项目目录、Git 和这边在跑的会话交给 {host}：先预检，确认后才动手', { host: h.name }), onClick: () => { void (async () => { setMoving(h.id); try { await onMoveProject!(project.name, term.cwd!, term.host, h); } finally { setMoving(null); } })(); } })),
  ];
  const page = tab === 'sessions' ? <ProjectSessions hub={hub} project={project} tabs={tabsFor} notes={notes} verdicts={here.data} />
    : tab === 'tasks' ? <ProjectTasks hub={hub} project={project} tabs={tabsFor} notes={notes} initial={sub} />
    : tab === 'outcomes' ? <ProjectOutcomes hub={hub} project={project} tabs={tabsFor} notes={notes} />
    : tab === 'materials' ? <ProjectMaterials hub={hub} project={project} tabs={tabsFor} notes={notes} initial={sub as Material | undefined} docs={docs} loadDocs={loadDocs} wiki={wiki} />
    : <div className="ld pj-page"><div className="ld-col">{tabsFor()}<div className="pj-pane pj-v3">{notes}
      <ProjectTimeline api={api} me={hub.me} project={project.name} here={here} onTask={hub.onTask} onSession={hub.onOpen}
        onNew={() => onNew(projectHome(project.sessions))} onUnassigned={() => { setTab('tasks'); setSub('unassigned'); }} />
    </div></div></div>;
  return <>
    {page}
    {menu?.kind === 'more' && <MenuPanel x={menu.x} y={menu.y} returnTo={menu.from} label={t('项目操作')} title={projectLabel(flags, project.name)} onClose={() => setMenu(null)}>{moreItems.map((i) => <MenuItem key={i.label} disabled={i.disabled} hint={i.sub} onClick={() => { setMenu(null); i.onClick(); }}>{i.label}</MenuItem>)}</MenuPanel>}
  </>;
}

type TabsFor = (right?: ReactNode) => ReactNode;
const filterBox = (value: string, set: (v: string) => void, label: string) => <input className="tabs-filter" aria-label={label} placeholder={label} value={value} onChange={(e) => set(e.target.value)} />;

function ProjectSessions({ hub, project, tabs, notes, verdicts }: { hub: Hub; project: Group; tabs: TabsFor; notes: ReactNode; verdicts: ReviewData | null }) {
  const t = useT();
  const { archiveDays, me, onOpen, onRead, onSummarize, onTask } = hub;
  const [filter, setFilter] = useState<'recent' | 'archived' | 'scheduled'>('recent');
  const [query, setQuery] = useState('');
  const [sel, setSel] = useState<string | null>(null);
  const life = (a: Activity) => sessionLifecycle(a, archiveDays);
  const archivedCount = project.sessions.filter((a) => !a.scheduled && life(a) === 'archived').length;
  const scheduledCount = project.sessions.filter((a) => a.scheduled).length;
  const q = query.trim().toLowerCase();
  const visible = project.sessions.filter((a) => filter === 'scheduled' ? !!a.scheduled : !a.scheduled && (filter === 'archived' ? life(a) === 'archived' : life(a) !== 'archived')).sort((x, y) => Number(!!y.starred) - Number(!!x.starred) || y.last_at - x.last_at).filter((a) => !q || `${a.title} ${a.cwd} ${a.overview || ''}`.toLowerCase().includes(q));
  const sections: [string, string, Activity[]][] = [['you', t('等你'), visible.filter((a) => sessionGroup(a) === 'you')], ['running', t('在跑'), visible.filter((a) => sessionGroup(a) === 'running')], ['idle', t('空闲'), visible.filter((a) => sessionGroup(a) === 'idle')]];
  const ids = sections.flatMap(([, , l]) => l.map(activityKey));
  const cur = sel && ids.includes(sel) ? sel : ids[0] ?? null;
  const a = cur ? visible.find((x) => activityKey(x) === cur) : undefined;
  useListKeyboard(ids, cur, setSel, { onEnter: (k) => { const x = visible.find((v) => activityKey(v) === k); if (x) onOpen(x.session_id); } });
  useActionTarget(a ? { kind: 'session', key: activityKey(a) } : null, [a ? activityKey(a) : '']);
  const linkedOf = (s: Activity) => project.items.filter((i) => linkedSessions(i).includes(s.session_id));
  const verdict = a ? verdicts?.sessions.find((s) => s.session_id === a.session_id) : undefined;
  const row = (s: Activity) => {
    const tag = sessionTag(s);
    const linked = linkedOf(s)[0];
    return <Row key={activityKey(s)} id={activityKey(s)} data-session={activityKey(s)} selected={cur === activityKey(s)} onClick={() => (narrow() ? onOpen(s.session_id) : setSel(activityKey(s)))} onOpen={() => onOpen(s.session_id)}
      icon={<Avatar actor={actorOf(s.agent, me)} />} title={<>{s.starred && <span className="pj-star">★ </span>}{s.title}</>}
      accessories={[...(tag ? [<Tag color={tag.color}>{tag.text}</Tag>] : []), ...(linked ? [<span className="mono" title={linked.title}>{linked.id.replace(/^task-/, '')}</span>] : []), <span className="pj-time">{since(s.last_at)}</span>]} />;
  };
  const opts = [{ value: 'recent' as const, label: t('全部') }, { value: 'archived' as const, label: t('已归档 {n}', { n: archivedCount }) }, { value: 'scheduled' as const, label: t('定时会话 {n}', { n: scheduledCount }) }];
  return <ListDetail className="pj-page" tabs={tabs(<>{filterBox(query, setQuery, t('搜索这个项目的会话…'))}<Dropdown value={filter} onChange={(v) => { setFilter(v); setSel(null); }} label={t('会话范围')} options={opts} /></>)}
    detail={a ? <SessionDetail a={a} me={me} linked={linkedOf(a)} verdict={verdict ? { verdict: verdict.verdict, reason: verdict.reason } : undefined} onOpen={onOpen} onRead={onRead} onSummarize={onSummarize} onTask={onTask} /> : undefined}>
    {notes}
    {sections.map(([k, label, list]) => list.length > 0 && <Section key={k} title={label} count={list.length}>{list.map(row)}</Section>)}
    {!ids.length && <EmptyView icon="chat" title={filter === 'archived' ? t('没有归档的会话。') : q ? t('没有匹配的会话') : t('这个分类没有会话。')} actions={filter === 'recent' && !q ? <button className="btn" onClick={() => hub.onNew(projectHome(project.sessions))}>{t('在此项目新建会话')}</button> : undefined} />}
  </ListDetail>;
}

function TaskDetail({ hub, project, issue, onTick }: { hub: Hub; project: Group; issue: Issue; onTick?: () => void }) {
  const t = useT();
  const { rows, api, onReload, onOpen, onTask, me } = hub;
  const actor = actorOf(issue.assignee, me);
  const accept = issueAcceptance(issue);
  const acceptProg = acceptanceProgress(accept);
  const acceptDone = acceptProg.done;
  return <div className="pd">
    <div className="pd-crumb"><ProjectGlyph name={project.name} small />{project.name}<span aria-hidden>›</span>{t('任务')}</div>
    <h2>{issue.title}</h2>
    <div className="pd-actions">
      <button className="btn primary sm" onClick={() => onTask(issue.id)}>{t('打开任务')}</button>
      {onTick && <button className="btn sm" onClick={onTick}>{t('做完了，打勾关掉')}</button>}
    </div>
    <div className="pd-md">
      {issue.close_reason && <><h4>{t('完成说明')}</h4><p>{issue.close_reason}</p></>}
      {issue.description && <><h4>{t('描述')}</h4><div className="pd-desc"><Markdown src={issue.description} /></div></>}
      <h4>{t('关联会话')}</h4>
      <TaskRelations issue={issue} rows={rows} api={api} onSaved={onReload} onOpen={onOpen} />
    </div>
    <Sep />
    <Meta rows={[
      [t('状态'), <StatusPill issue={issue} sm />],
      [t('优先级'), <Pri p={issue.priority} />],
      [t('负责人'), actor ? <>{<Avatar actor={actor} size={16} />}{actor.name}</> : <span className="muted">{t('未认领')}</span>],
      ...(accept.length ? [[t('验收'), <Meter value={acceptDone} max={accept.length} />] as [ReactNode, ReactNode]] : []),
      [t('ID'), <span className="mono">{issue.id}</span>],
      [t('更新'), ago(Date.parse(issue.updated_at) / 1000 || 0)],
    ]} />
  </div>;
}

function ProjectTasks({ hub, project, tabs, notes, initial }: { hub: Hub; project: Group; tabs: TabsFor; notes: ReactNode; initial?: string }) {
  const t = useT();
  const { api, onReload, onTask, me } = hub;
  const [view, setView] = useState<'current' | 'unassigned' | 'done'>(initial === 'unassigned' ? 'unassigned' : 'current');
  const [query, setQuery] = useState('');
  const [sel, setSel] = useState<string | null>(null);
  const [err, setErr] = useState('');
  const q = query.trim().toLowerCase();
  const match = (i: Issue) => !q || i.title.toLowerCase().includes(q) || (i.description || '').toLowerCase().includes(q) || (i.close_reason || '').toLowerCase().includes(q) || i.id.includes(q);
  const closedAt = (i: Issue) => Date.parse(i.closed_at || i.updated_at || '') / 1000 || 0;
  const week = Date.now() / 1000 - 7 * 86400;
  const needs = project.items.filter((i) => isNeedsYou(i) && i.status !== 'closed');
  const rest = project.items.filter((i) => !(isNeedsYou(i) && i.status !== 'closed'));
  const doneAll = rest.filter((i) => columnOf(i) === 'done').sort((a, b) => closedAt(b) - closedAt(a));
  const unassigned = project.items.filter((i) => !linkedSessions(i).length);
  // The label doubles as the section key; t() only at display.
  let sections: [string, ReactNode, Issue[], ReactNode?][];
  if (view === 'done') {
    // 7-day buckets counted back from today, newest first.
    const buckets = new Map<number, Issue[]>();
    for (const i of doneAll.filter(match)) { const k = Math.floor((Date.now() / 1000 - closedAt(i)) / (7 * 86400)); buckets.set(k, [...(buckets.get(k) || []), i]); }
    const f = (d: Date) => t('{m}月{d}日', { m: d.getMonth() + 1, d: d.getDate() });
    const label = (k: number) => { const end = new Date(Date.now() - k * 7 * 86400 * 1000), start = new Date(end.getTime() - 6 * 86400 * 1000); return k === 0 ? t('最近 7 天（{from} 到 {to}）', { from: f(start), to: f(end) }) : t('{from} 到 {to}', { from: f(start), to: f(end) }); };
    sections = [...buckets.keys()].sort((a, b) => a - b).map((k) => [`w${k}`, label(k), buckets.get(k)!]);
  } else if (view === 'unassigned') {
    sections = [['unassigned', t('待归属任务'), unassigned.filter(match)]];
  } else {
    const doneRecent = doneAll.filter((i) => closedAt(i) >= week);
    sections = [
      ['只能你做', t('只能你做'), needs.filter(match)],
      ['进行中', t('进行中'), rest.filter((i) => columnOf(i) === 'prog').filter(match)],
      ['待办', t('待办'), rest.filter((i) => columnOf(i) === 'todo').filter(match)],
      ['已完成', t('已完成'), doneRecent.filter(match), doneAll.length > doneRecent.length ? <button className="link" onClick={() => { setView('done'); setSel(null); }}>{t('全部 {n} ›', { n: doneAll.length })}</button> : undefined],
    ];
  }
  const ids = sections.flatMap(([, , l]) => l.map((i) => i.id));
  const cur = sel && ids.includes(sel) ? sel : ids[0] ?? null;
  const issue = cur ? project.items.find((i) => i.id === cur) : undefined;
  useListKeyboard(ids, cur, setSel, { onEnter: onTask });
  useActionTarget(issue ? { kind: 'task', id: issue.id } : null, [issue?.id]);
  const tick = async (i: Issue) => { try { await api.close(i.id, '你做完了'); onReload(); } catch (e) { setErr(String(e)); } };
  const row = (i: Issue) => {
    const actor = actorOf(i.assignee, me);
    const needsYou = isNeedsYou(i) && i.status !== 'closed';
    const n = linkedSessions(i).length;
    return <Row key={i.id} id={i.id} data-task={i.id} selected={cur === i.id} onClick={() => (narrow() ? onTask(i.id) : setSel(i.id))} onOpen={() => onTask(i.id)}
      icon={needsYou ? <label className="pj-tick" title={t('做完了，打勾关掉')} onClick={(e) => e.stopPropagation()}><input type="checkbox" onChange={() => void tick(i)} aria-label={t('做完了：{title}', { title: i.title })} /></label> : actor ? <Avatar actor={actor} /> : <Icon name={i.status === 'closed' ? 'check' : 'tasks'} />}
      title={i.title}
      accessories={[...(i.priority <= 1 ? [<Pri p={i.priority} />] : []), ...(n ? [<span title={t('关联会话')}>{t('{n} 会话', { n })}</span>] : []), <span className="mono">{i.id.replace(/^task-/, '')}</span>, <span className="pj-time">{since(i.status === 'closed' ? closedAt(i) : Date.parse(i.updated_at) / 1000)}</span>]} />;
  };
  const opts = [{ value: 'current' as const, label: t('当前') }, { value: 'unassigned' as const, label: t('待归属任务 {n}', { n: unassigned.length }) }, { value: 'done' as const, label: t('全部已完成 {n}', { n: doneAll.length }) }];
  const empty = view === 'done' ? t('没有匹配的已完成任务。') : view === 'unassigned' ? t('任务都已有明确关联。') : q ? t('没有匹配的任务') : t('这个项目还没有任务');
  return <ListDetail className="pj-page" tabs={tabs(<>{filterBox(query, setQuery, t('搜标题、描述、完成说明…'))}<Dropdown value={view} onChange={(v) => { setView(v); setSel(null); }} label={t('任务范围')} options={opts} /></>)}
    detail={issue ? <TaskDetail hub={hub} project={project} issue={issue} onTick={isNeedsYou(issue) && issue.status !== 'closed' ? () => void tick(issue) : undefined} /> : undefined}>
    {notes}
    {err && <p className="pj-note err" role="alert">{err}</p>}
    {view === 'unassigned' && <p className="pj-note">{t('任务显示发起和参与会话；历史任务没有明确关系时保留待归属，不根据提及次数猜测。')}</p>}
    {sections.map(([k, label, list, right]) => (list.length > 0 || k === '只能你做' && view === 'current' && !q) && <Section key={k} title={label} count={list.length} right={right}>
      {k === '只能你做' && !list.length ? <p className="pj-hint">{t('Agent 遇到只有你能做的事（发邮件、付款、登录、演示）会记在这里，做完打勾。')}</p> : list.map(row)}
    </Section>)}
    {!ids.length && view !== 'current' && <EmptyView icon="tasks" title={empty} />}
    {!ids.length && view === 'current' && (q || !project.items.length) && <EmptyView icon="tasks" title={empty} />}
  </ListDetail>;
}

function ProjectOutcomes({ hub, project, tabs, notes }: { hub: Hub; project: Group; tabs: TabsFor; notes: ReactNode }) {
  const t = useT();
  const { api, rows, tasks, onReload, onOpen, onTask } = hub;
  const [editor, setEditor] = useState<Issue | null | false>(false);
  const [sel, setSel] = useState<string | null>(null);
  const history = project.items.filter((i) => i.status === 'closed');
  const ids = [...project.results.map((r) => r.id), ...history.map((i) => i.id)];
  const cur = sel && ids.includes(sel) ? sel : ids[0] ?? null;
  const outcome = project.results.find((r) => r.id === cur);
  const task = outcome ? undefined : history.find((i) => i.id === cur);
  useListKeyboard(ids, cur, setSel, { onEnter: (id) => { const r = project.results.find((x) => x.id === id); if (r) setEditor(r); else onTask(id); }, enabled: editor === false });
  useActionTarget(task ? { kind: 'task', id: task.id } : null, [task?.id]);
  const detail = editor !== false ? undefined : outcome ? <div className="pd">
    <div className="pd-crumb"><ProjectGlyph name={project.name} small />{project.name}<span aria-hidden>›</span>{t('成果')}</div>
    <h2>{outcome.title}</h2>
    <div className="pd-actions"><button className="btn sm" onClick={() => setEditor(outcome)}>{t('编辑')}</button></div>
    <div className="pd-md pd-desc"><MediaProvider api={api} session={rows.find((a) => linkedSessions(outcome).includes(a.session_id))}><Markdown src={outcome.description || ''} /></MediaProvider></div>
    {(sourceTasks(outcome).length > 0 || linkedSessions(outcome).length > 0) && <><Sep /><div className="pd-md"><h4>{t('来源')}</h4><ul className="pd-links">
      {sourceTasks(outcome).map((id) => <li key={id}><button className="link" onClick={() => onTask(id)}>{t('任务')} · {tasks.find((i) => i.id === id)?.title || id}</button></li>)}
      {linkedSessions(outcome).map((id) => <li key={id}><button className="link" onClick={() => onOpen(id)}>{t('会话')} · {rows.find((a) => a.session_id === id)?.title || id.slice(0, 8)}</button></li>)}
    </ul></div></>}
  </div> : task ? <TaskDetail hub={hub} project={project} issue={task} /> : undefined;
  return <ListDetail className="pj-page" detail={detail} tabs={tabs(editor === false ? <button className="btn sm" onClick={() => setEditor(null)}>{t('登记成果')}</button> : undefined)}>
    {notes}
    {editor !== false ? <OutcomeEditor key={editor?.id || 'new'} project={project.name} rows={project.sessions} tasks={project.items} initial={editor || undefined} api={api} onCancel={() => setEditor(false)} onSaved={() => { setEditor(false); onReload(); }} />
      : <>
        {project.results.length > 0 ? <Section title={t('成果')} count={project.results.length}>{project.results.map((r) => <Row key={r.id} id={r.id} data-task={r.id} selected={cur === r.id} onClick={() => setSel(r.id)} onOpen={() => setEditor(r)} icon={<Icon name="star" />} title={r.title} accessories={[...(sourceTasks(r).length ? [t('{n} 任务', { n: sourceTasks(r).length })] : []), <span className="pj-time">{since(Date.parse(r.closed_at || r.updated_at) / 1000)}</span>]} />)}</Section>
          : <EmptyView icon="star" title={t('还没有登记成果')} description={t('还没有登记成果。可以把多个任务、多个会话的交付汇总在这里。')} actions={<button className="btn primary" onClick={() => setEditor(null)}>{t('登记成果')}</button>} />}
        {history.length > 0 && <Section title={t('历史完成记录')} count={history.length} right={t('任务完成说明，尚未整理为成果')}>{history.map((i) => <Row key={i.id} id={i.id} data-task={i.id} selected={cur === i.id} onClick={() => setSel(i.id)} onOpen={() => onTask(i.id)} icon={<Icon name="check" />} title={i.title} accessories={[<span className="pj-time">{since(Date.parse(i.closed_at || i.updated_at) / 1000)}</span>]} />)}</Section>}
      </>}
  </ListDetail>;
}

function ProjectMaterials({ hub, project, tabs, notes, initial, docs, loadDocs, wiki }: { hub: Hub; project: Group; tabs: TabsFor; notes: ReactNode; initial?: Material; docs: Doc[] | null; loadDocs: () => void; wiki: WikiEntry[] | null }) {
  const t = useT();
  const { api, onNew, onTask, onSay } = hub;
  const [part, setPart] = useState<Material>(initial || 'docs');
  const dirs = [...project.sessions.reduce((m, a) => { const d = (a.cwd || '').replace(/\/+$/, ''); if (!d) return m; const cur = m.get(d) || { count: 0, last: 0, latest: a }; cur.count++; if (a.last_at > cur.last) { cur.last = a.last_at; cur.latest = a; } return m.set(d, cur); }, new Map<string, { count: number; last: number; latest: Activity }>())].sort((x, y) => y[1].last - x[1].last);
  const parts: [Material, string, number | string | undefined][] = [['docs', t('文档'), docs ? docs.length : '…'], ['facts', t('常用信息'), undefined], ['wiki', t('知识库'), wiki ? wiki.length : '…'], ['folders', t('目录'), dirs.length]];
  return <div className="ld pj-page"><div className="ld-col">{tabs(<div className="seg" role="group" aria-label={t('资料')}>{parts.map(([k, label, n]) => <button key={k} className={part === k ? 'on' : ''} aria-pressed={part === k} onClick={() => setPart(k)}>{label}{n !== undefined && <span className="n">{n}</span>}</button>)}</div>)}
    <div className="pj-pane">
      {notes}
      {part === 'docs' && <ProjectDocs api={api} name={project.name} docs={docs} onReload={loadDocs} />}
      {part === 'facts' && <ProjectFacts api={api} name={project.name} onDone={onSay ? (m) => onSay(m) : undefined} />}
      {part === 'wiki' && <ProjectWiki entries={wiki} project={project.name} onTask={onTask} />}
      {part === 'folders' && <>
        <p className="pj-hint">{t('这个项目的会话在哪些文件夹里发生过。')}</p>
        {dirs.map(([d, info]) => <Row key={d} id={d} icon={<Icon name="folder" />} title={<span title={d}>{shortPath(d)}</span>}
          accessories={[<button className="btn ghost sm" onClick={() => onNew(info.latest)}>{t('在此目录新建会话')}</button>, <button className="btn ghost sm" onClick={() => void api.openPath(d).catch(() => {})}>{isWindows ? t('在资源管理器中显示') : t('在 Finder 打开')}</button>, <button className="btn ghost sm" onClick={() => void api.copy(`cd '${d}'`).catch(() => {})}>{t('复制 cd')}</button>]} />)}
        {!dirs.length && <EmptyView icon="folder" title={t('没有记录到工作目录。')} />}
      </>}
    </div>
  </div></div>;
}
