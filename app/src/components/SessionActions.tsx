import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { isTauri, type Api } from '../api';
import { open as pickFolder } from '@tauri-apps/plugin-dialog';
import type { Host } from '../types';
import { shrinkImage, withImages } from './SessionReply';
import { t, useT } from '../i18n';

type Target = { session_id: string; agent: string; host?: string; host_name?: string };
interface Launch { request_id: string; state: string; message: string; session_id?: string; agent: string; cwd: string }
interface Folders { path: string; parent: string; children: { name: string; path: string }[]; recent: string[]; truncated: boolean }
const names: Record<string,string> = { codex: 'Codex', 'claude-code': 'Claude Code', pi: 'pi', zcode: 'ZCode', opencode: 'OpenCode', hermes: 'Hermes' };
const id = () => {
  const b = crypto.getRandomValues(new Uint8Array(16)); b[6] = (b[6] & 15) | 64; b[8] = (b[8] & 63) | 128;
  const h = Array.from(b, x => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20)}`;
};
export const control = async <T,>(api: Api, host: string, op: string, input: unknown): Promise<T> => JSON.parse(await api.on(host, ['session-control', op], JSON.stringify(input)));
const Context = createContext<{ api: Api | null; notify: (message: string, error?: boolean) => void } | null>(null);
export function SessionActions({ api, notify, children }: { api: Api | null; notify: (message: string, error?: boolean) => void; children: ReactNode }) {
  return <Context.Provider value={{ api, notify }}>{children}</Context.Provider>;
}

// Open a session in its agent's terminal on the machine it lives on. The same
// call backs the button and the context-menu entry.
export function useOpenSession() {
  const ctx = useContext(Context);
  const requests = useRef(new Map<string, string>());
  return async (session: Target) => {
    if (!ctx?.api) return;
    const key = `${session.host || 'local'}:${session.session_id}`;
    if (!requests.current.has(key)) requests.current.set(key, id());
    try {
      if (session.agent === 'zcode') { ctx.notify(await ctx.api.on(session.host || 'local', ['focus', session.session_id])); return; }
      const r = await control<Launch>(ctx.api, session.host || 'local', 'open', { ...session, request_id: requests.current.get(key) });
      ctx.notify(t('{host}：{message}', { host: session.host_name || t('电脑'), message: r.message }));
      if (r.request_id) {
        for (let n = 0; n < 80; n++) {
          await new Promise(resolve => window.setTimeout(resolve, 2000));
          const s = await control<Launch>(ctx.api, session.host || 'local', 'status', { request_id: r.request_id });
          if (!['starting', 'running'].includes(s.state)) { ctx.notify(s.message, s.state !== 'ready'); break; }
        }
      }
      requests.current.delete(key);
    } catch (e) { ctx.notify(String(e), true); }
  };
}

export function OpenSessionButton({ session, compact = false }: { session: Target; compact?: boolean }) {
  const t = useT();
  const ctx = useContext(Context);
  const [busy, setBusy] = useState(false);
  const request = useRef<string | null>(null);
  const supported = ['codex', 'claude-code', 'pi', 'zcode', 'opencode', 'hermes'].includes(session.agent) && !session.session_id.startsWith('pid-');
  const open = async () => {
    if (!ctx?.api || busy) return;
    setBusy(true);
    request.current ??= id();
    try {
      if (session.agent === 'zcode') { ctx.notify(await ctx.api.on(session.host || 'local', ['focus', session.session_id])); return; }
      const r = await control<Launch>(ctx.api, session.host || 'local', 'open', { ...session, request_id: request.current });
      ctx.notify(t('{host}：{message}', { host: session.host_name || t('电脑'), message: r.message }));
      if (r.request_id) {
        // Keep one request identity until the server confirms the result.
        for (let n=0; n<80; n++) {
          await new Promise(resolve => window.setTimeout(resolve, 2000));
          const s = await control<Launch>(ctx.api, session.host || 'local', 'status', { request_id: r.request_id });
          if (!['starting', 'running'].includes(s.state)) { ctx.notify(s.message, s.state !== 'ready'); break; }
        }
      }
      request.current = null;
    } catch (e) { ctx.notify(String(e), true); }
    finally { setBusy(false); }
  };
  if (!supported) return null;
  return <button type="button" className={`btn sm original-session${compact ? ' compact' : ''}`} disabled={busy || !ctx?.api} onClick={open} title={t('在{host}的 {agent} 中打开此会话', { host: session.host_name || t('电脑'), agent: names[session.agent] })}>
    {busy ? t('正在打开…') : <><span className="open-desktop-label">{t('打开 {agent} 会话 ↗', { agent: names[session.agent] })}</span><span className="open-mobile-label">{t('在电脑上打开 ↗')}</span></>}
  </button>;
}

// A session running in some other terminal (Warp, iTerm, Terminal, VS Code…) can be taken
// into Herdr: the CLI stops it once idle and resumes the same transcript in a new Herdr tab.
// Only Herdr-hosted sessions get the tab title, working/idle judgement and phone replies.
export const canAdopt = (s: { agent: string; host?: string; herdr?: unknown; source_app?: string; session_id: string; probable_session_id?: string; remote?: boolean }) =>
  !s.herdr && ['claude-code', 'codex', 'pi'].includes(s.agent) && s.source_app !== 'Herdr' && (!s.session_id.startsWith('pid-') || !!s.probable_session_id);

export function AdoptButton({ session, compact = false, className = 'btn sm' }: { session: { agent: string; session_id: string; host?: string; herdr?: unknown; source_app?: string; state?: string; probable_session_id?: string; remote?: boolean }; compact?: boolean; className?: string }) {
  const t = useT();
  const ctx = useContext(Context);
  const [busy, setBusy] = useState(false);
  const request = useRef<string | null>(null);
  if (!canAdopt(session)) return null;
  const working = session.state === 'working';
  const host = session.host || 'local';
  const adopt = async () => {
    if (!ctx?.api || busy) return;
    setBusy(true);
    request.current ??= id();
    try {
      const r = await control<Launch & { stopped_pid?: number | null }>(ctx.api, host, 'adopt', { session_id: session.session_id, request_id: request.current });
      ctx.notify(r.message);
      if (r.request_id) {
        for (let n = 0; n < 60; n++) {
          await new Promise(resolve => window.setTimeout(resolve, 2000));
          const s = await control<Launch>(ctx.api, host, 'status', { request_id: r.request_id });
          if (!['starting', 'running'].includes(s.state)) { ctx.notify(s.state === 'ready' ? t('已接到 Herdr：{message}', { message: s.message }) : s.message, s.state !== 'ready'); break; }
        }
      }
      request.current = null;
    } catch (e) { ctx.notify(String(e), true); }
    finally { setBusy(false); }
  };
  const where = session.source_app && session.source_app !== '未登记' ? session.source_app : t('别的终端');
  return <button type="button" className={`${className} adopt-session${compact ? ' compact' : ''}`} disabled={busy || !ctx?.api || working} onClick={adopt}
    title={working ? t('它正在 {where} 里跑，等它停下来再接', { where }) : t('它现在在 {where} 里。停掉那边的进程，在 Herdr 新标签里恢复同一个会话（有标题、能判断在跑/等你、手机端能回复）', { where })}>
    {busy ? t('正在接…') : compact ? t('接到 Herdr') : t('从 {where} 接到 Herdr', { where })}
  </button>;
}

export function NewSession({ api, hosts, initialHost, initialCwd, onClose, onCreated, onComputer }: { api: Api; hosts: Host[]; initialHost: string; initialCwd?: string; onClose: () => void; onCreated: (sid: string, host: string, agent: string) => void; onComputer: (host: string) => void }) {
  const t = useT();
  const [host, setHost] = useState(initialHost || 'local');
  const [agent, setAgent] = useState('claude-code');
  const [path, setPath] = useState('');
  const [folders, setFolders] = useState<Folders | null>(null);
  const [browseBusy, setBrowseBusy] = useState(false);
  const [prompt, setPrompt] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [launch, setLaunch] = useState<Launch | null>(null);
  const request = useRef<string | null>(null);
  const generation = useRef(0);
  // Pictures and files for the first message: stored on the Mac the session will run on, so its
  // Read tool can open them; the message carries the paths (same note the reply box uses).
  type Attached = { path: string; name: string; image: boolean; preview?: string };
  const [files, setFiles] = useState<Attached[]>([]);
  const [saving, setSaving] = useState(0);
  const imageInput = useRef<HTMLInputElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const readAsDataUrl = (f: File) => new Promise<string>((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result)); r.onerror = () => rej(r.error); r.readAsDataURL(f); });
  const addFiles = async (list: File[]) => {
    for (const f of list) {
      setSaving((n) => n + 1);
      try {
        const image = f.type.startsWith('image/');
        const data = image ? await shrinkImage(f) : await readAsDataUrl(f);
        const raw = await api.on(host, [image ? 'save-image' : 'save-file', '--json'], JSON.stringify({ name: f.name || (image ? 'photo' : 'file'), data }));
        const saved = JSON.parse(raw.slice(raw.indexOf('{'))) as { path: string };
        setFiles((xs) => [...xs, { path: saved.path, name: f.name || (image ? t('图片') : t('文件')), image, preview: image ? data : undefined }]);
      } catch (e) { setError(/usage:|invalid choice/.test(String(e)) ? t('那台电脑的 Dispatch 太旧，还不会存附件；更新后再试。') : t('附件没传上去：{err}', { err: String(e) })); }
      finally { setSaving((n) => n - 1); }
    }
  };
  const onPaste = (e: React.ClipboardEvent) => { const list = Array.from(e.clipboardData.files); if (list.length) { e.preventDefault(); void addFiles(list); } };
  const messageWithFiles = (text: string) => {
    const images = files.filter((f) => f.image).map((f) => f.path);
    const others = files.filter((f) => !f.image).map((f) => f.path);
    const base = withImages(text, images) || (others.length ? '看一下这几个文件' : text.trim());
    return others.length ? `${base} 附件（用 Read 看）：${others.join(' ')}` : base;
  };
  const browse = async (next: string) => {
    const seq = ++generation.current;
    setBrowseBusy(true); setError('');
    try { const r = await control<Folders>(api, host, 'browse', { path: next }); if (seq === generation.current) { setFolders(r); setPath(r.path); } }
    catch (e) { if (seq === generation.current) setError(String(e)); }
    finally { if (seq === generation.current) setBrowseBusy(false); }
  };
  useEffect(() => { setFolders(null); setPath(''); void browse(host === (initialHost || 'local') ? initialCwd || '' : ''); return () => { generation.current++; }; }, [host]);
  // On this Mac the desktop app can ask Finder for the folder; other Macs and the phone keep the in-app browser.
  const finder = isTauri && host === 'local';
  const pick = async () => {
    setError('');
    try { const p = await pickFolder({ directory: true, multiple: false, title: t('选择工作文件夹'), defaultPath: path || undefined }); if (typeof p === 'string' && p) { setPath(p); void browse(p); } }
    catch (e) { setError(String(e)); }
  };
  useEffect(() => {
    if (!launch || !['starting','running'].includes(launch.state)) return;
    let active = true; let timer = 0;
    const poll = async () => {
      try { const r = await control<Launch>(api, host, 'status', {request_id: launch.request_id}); if (active) { setLaunch(r); setError(''); if (r.state === 'ready' && r.session_id) { try { sessionStorage.removeItem('dispatch-new-session'); } catch { /* private mode */ } onCreated(r.session_id, host, agent); } } }
      catch (e) { if (active) setError(t('连接中断，正在重新查询创建结果：{err}', { err: String(e) })); }
      if (active) timer = window.setTimeout(poll, 2000);
    };
    timer = window.setTimeout(poll, 1000);
    return () => { active = false; window.clearTimeout(timer); };
  }, [launch?.request_id, launch?.state, host]);
  useEffect(() => {
    try { const saved = JSON.parse(sessionStorage.getItem('dispatch-new-session') || 'null'); if (saved) { setHost(saved.host); request.current = saved.request_id; setLaunch(saved); } } catch { /* storage unavailable */ }
  }, []);
  const submit = async () => {
    if (busy || launch || saving || (!prompt.trim() && !files.length) || !path) return;
    setBusy(true); setError(''); request.current ??= id();
    const pending = { request_id: request.current, state: 'starting', host, agent, cwd: path, message: t('正在连接电脑…') };
    try { sessionStorage.setItem('dispatch-new-session', JSON.stringify(pending)); } catch { /* private mode */ }
    try { const r = await control<Launch>(api, host, 'start', {request_id: request.current, agent, cwd: path, prompt: messageWithFiles(prompt), focus: finder}); setLaunch(r); }
    catch (e) {
      setError(String(e));
      // Distinguish rejected input from an accepted launch with a lost response.
      // A transport failure keeps the same identity and switches to polling.
      try { setLaunch(await control<Launch>(api, host, 'status', { request_id: request.current })); }
      catch (lookup) {
        if (String(lookup).includes('找不到这次创建记录')) {
          request.current = null;
          try { sessionStorage.removeItem('dispatch-new-session'); } catch { /* private mode */ }
        } else { setLaunch(pending); }
      }
    }
    finally { setBusy(false); }
  };
  const locked = busy || !!launch;
  const dialog = useRef<HTMLDivElement>(null);
  useEffect(() => { dialog.current?.focus(); }, []);
  return <div className="overlay"><div className="dialog new-session-dialog" role="dialog" ref={dialog} tabIndex={-1} aria-modal="true" aria-label={t('新建会话')} onKeyDown={e => {
      if (e.key === 'Escape') onClose();
      if (e.key === 'Tab') {
        const nodes = Array.from(dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),textarea:not(:disabled),select:not(:disabled)') || []);
        const first = nodes[0], last = nodes[nodes.length-1];
        if (e.shiftKey && (document.activeElement === first || document.activeElement === dialog.current)) { e.preventDefault(); last?.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus(); }
      }
    }}>
    <header><div><h3>{t('新建会话')}</h3><p>{t('选择工作目录，直接开始一段新对话。')}</p></div><button className="btn ghost" aria-label={t('关闭新建会话')} onClick={onClose}>✕</button></header>
    {!launch && <><div className="new-session-selects">
      <label>{t('运行电脑')}<select aria-label={t('运行电脑')} value={host} disabled={locked} onChange={e => setHost(e.target.value)}>{hosts.length ? hosts.map(h => <option key={h.id} value={h.local ? 'local' : h.id} disabled={!h.online && !h.local}>{h.name}{!h.online && !h.local ? ` · ${t('离线')}` : ''}</option>) : <option value="local">{t('本机')}</option>}</select></label>
      <label>Agent<select aria-label="Agent" title={t('能在 Dispatch 里看到对话并回复的 Agent；派活对话框里的 Gemini CLI 只能派，看不到')} value={agent} disabled={locked} onChange={e => setAgent(e.target.value)}>{Object.entries(names).filter(([k]) => k !== 'zcode').map(([k,n]) => <option key={k} value={k}>{n}</option>)}</select></label>
    </div>
    <label>{t('工作文件夹')}<div className="folder-path"><input aria-label={t('工作文件夹')} value={path} disabled={locked} onChange={e => setPath(e.target.value)} placeholder={t('输入完整路径，或从下方选择')} />{finder && <button className="btn sm" type="button" disabled={locked} onClick={() => void pick()} title={t('用 Finder 选一个文件夹')}>{t('从 Finder 选择…')}</button>}<button className="btn sm" type="button" disabled={locked || browseBusy} onClick={() => browse(path)}>{t('前往')}</button></div></label>
    <div className="folder-picker" aria-busy={browseBusy}>
      <div className="folder-picker-heading"><b>{t('浏览文件夹')}</b><button className="link" disabled={!folders || locked || browseBusy || folders.path === folders.parent} onClick={() => browse(folders!.parent)}>{t('↑ 上一级')}</button></div>
      {browseBusy ? <p className="muted">{t('读取文件夹…')}</p> : <div className="folder-children">{folders?.children.map(f => <button key={f.path} type="button" disabled={locked} onClick={() => browse(f.path)}>▱ {f.name}<span>›</span></button>)}{folders?.children.length === 0 && <p className="muted">{t('没有子文件夹，可直接使用当前目录。')}</p>}</div>}
      {folders?.truncated && <small>{t('子文件夹较多，可输入完整路径前往。')}</small>}
    </div>
    {!!folders?.recent.length && <label>{t('最近使用')}<select aria-label={t('最近使用的文件夹')} value="" disabled={locked || browseBusy} onChange={e => browse(e.target.value)}><option value="">{t('选择最近使用的文件夹…')}</option>{folders.recent.map(p => <option key={p} value={p}>{p}</option>)}</select></label>}
    <label>{t('第一条消息')}<textarea aria-label={t('第一条消息')} value={prompt} disabled={locked} maxLength={16000} onChange={e => setPrompt(e.target.value)} onPaste={onPaste} placeholder={files.length ? t('说说这些图片/文件要干什么（可不填）') : t('告诉 Agent 这次想做什么…（可粘贴图片）')} /></label>
    <div className="new-session-attach">
      <button className="btn sm" type="button" disabled={locked} onClick={() => imageInput.current?.click()} title={t('加图片：手机可拍照或选相册，电脑也可以直接粘贴到上面')}>📷 {t('图片')}</button>
      <button className="btn sm" type="button" disabled={locked} onClick={() => fileInput.current?.click()} title={t('加文件：存到运行那台电脑上，Agent 用 Read 看')}>📎 {t('文件')}</button>
      {saving > 0 && <span className="muted small">{t('正在上传 {n} 个…', { n: saving })}</span>}
      <input ref={imageInput} type="file" accept="image/*" multiple hidden onChange={e => { void addFiles(Array.from(e.target.files ?? [])); e.target.value = ''; }} />
      <input ref={fileInput} type="file" multiple hidden onChange={e => { void addFiles(Array.from(e.target.files ?? [])); e.target.value = ''; }} />
      {files.map((f) => <span key={f.path} className="new-session-file" title={f.path}>{f.preview ? <img src={f.preview} alt="" /> : '📄'}<span className="n">{f.name}</span><button type="button" className="link" aria-label={t('移除 {name}', { name: f.name })} disabled={locked} onClick={() => setFiles((xs) => xs.filter((x) => x.path !== f.path))}>✕</button></span>)}
    </div>
    <p className="new-session-note">{t('Agent 在所选电脑的终端中运行，沿用已有登录和权限设置。')}{finder ? t('创建好后会直接切到 Herdr 所在的终端；也可以回到 Dispatch 查看进展并继续回复。') : t('你可以留在 Dispatch 查看进展并继续回复。')}</p></>}
    {launch && <div className="launch-progress" role="status"><b>{launch.state === 'ready' ? t('会话已就绪') : launch.state === 'attention' || launch.state === 'failed' ? t('需要查看电脑') : t('正在新建会话…')}</b><p>{launch.message}</p><code>{launch.cwd}</code>{['attention','failed'].includes(launch.state) && <button className="btn" onClick={() => onComputer(host)}>{t('查看电脑与连接')}</button>}{launch.session_id && <button className="btn primary" onClick={() => onCreated(launch.session_id!, host, agent)}>{t('进入会话')}</button>}</div>}
    {error && <p className="new-session-error" role="alert">{error}</p>}
    <div className="foot"><button className="btn" onClick={onClose}>{launch ? t('收起') : t('取消')}</button>{!launch && <button className="btn primary" disabled={busy || browseBusy || !path || saving > 0 || (!prompt.trim() && !files.length)} onClick={submit}>{busy ? t('正在创建…') : t('创建并发送')}</button>}{launch && ['attention','failed'].includes(launch.state) && <button className="btn" onClick={() => { try { sessionStorage.removeItem('dispatch-new-session'); } catch { /* private mode */ } onClose(); }}>{t('已了解')}</button>}</div>
  </div></div>;
}
