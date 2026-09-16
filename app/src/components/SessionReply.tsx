import { useEffect, useRef, useState, type ClipboardEvent as ReactClipboardEvent } from 'react';
import type { Api } from '../api';
import type { SessionRef, TimelineMsg } from '../types';
import { control as sessionControl } from './SessionActions';

interface Receipt { id: string; text: string; state: 'sending' | 'accepted' | 'failed' | 'unknown'; note: string; created: number; delivered?: boolean }
interface DesktopRequest { id: string; kind: 'command' | 'file' | 'permission' | 'question' | 'option' | 'elicitation' | 'other'; summary: string; reason?: string; cwd?: string; files?: string[]; questions?: { id: string; text: string; options: string[] }[] }
interface Desktop { running: boolean; status: string; requests: DesktopRequest[]; model?: string; approval_policy?: string }
interface Connection { available: boolean; label: string; working?: boolean; receipts: Receipt[]; model?: string; mode?: string; desktop?: Desktop; adoptable?: boolean; adopt_state?: 'idle' | 'working'; source_app?: string }
const REQUEST_LABEL: Record<DesktopRequest['kind'], string> = { command: '要跑命令', file: '要改文件', permission: '申请权限', question: '在提问', option: '要你选', elicitation: 'MCP 请求', other: '等确认' };
const MODES: [string, string][] = [['default', '手动确认'], ['acceptEdits', '自动接受编辑'], ['plan', '计划模式'], ['bypassPermissions', '跳过权限']];
const MODELS: [string, string][] = [['fable', 'Fable 5.1'], ['opus', 'Opus 5'], ['sonnet', 'Sonnet 5'], ['haiku', 'Haiku 4.5']];
/** "Sonnet 5" → "sonnet": the alias /model takes. */
export const modelAlias = (label: string): string => (label.trim().split(/\s+/)[0] || '').toLowerCase();
export interface SlashCommand { name: string; description: string; kind: 'builtin' | 'skill' | 'command' }
const KIND_LABEL: Record<SlashCommand['kind'], string> = { builtin: '命令', skill: '技能', command: '自定义' };
/** The draft is a lone `/word` (no argument yet): that word is the menu query. */
export const slashQuery = (draft: string): string | null => { const m = /^\/(\S*)$/.exec(draft); return m ? m[1] : null; };
/** Prefix matches first, then substring matches on name or description; at most `limit`. */
export function matchCommands(all: SlashCommand[], query: string, limit = 40): SlashCommand[] {
  const q = query.toLowerCase();
  const starts = all.filter(c => c.name.toLowerCase().startsWith(q));
  const rest = q ? all.filter(c => !starts.includes(c) && (c.name.toLowerCase().includes(q) || (q.length > 1 && c.description.toLowerCase().includes(q)))) : [];
  return [...starts, ...rest].slice(0, limit);
}
const readJson = <T,>(raw: string): T => JSON.parse(raw.slice(raw.indexOf('{')));
interface Attached { path: string; preview: string; name: string }
/** Phone photos are 3–8 MB; the agent only needs to see them. Fit inside 2000px as JPEG (screenshots stay PNG when small). */
export async function shrinkImage(file: File, maxSide = 2000): Promise<string> {
  const dataUrl = await new Promise<string>((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result)); r.onerror = () => rej(r.error); r.readAsDataURL(file); });
  if (file.size < 600_000 && file.type !== 'image/heic' && file.type !== 'image/heif') return dataUrl;
  const img = await new Promise<HTMLImageElement>((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error('无法读取这张图片')); i.src = dataUrl; });
  const k = Math.min(1, maxSide / Math.max(img.width, img.height));
  const c = document.createElement('canvas'); c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
  c.getContext('2d')?.drawImage(img, 0, 0, c.width, c.height);
  return c.toDataURL('image/jpeg', 0.85);
}
/** The message the agent reads: the text plus, when there are pictures, where to find them. */
export const withImages = (text: string, paths: string[]): string => paths.length ? `${text.trim() || '看一下这几张图'} 附图（用 Read 看）：${paths.join(' ')}` : text.trim();
const messageId = () => {
  // randomUUID is unavailable on HTTP phone connections; getRandomValues is not.
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 15) | 64; bytes[8] = (bytes[8] & 63) | 128;
  const h = Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20)}`;
};

export function SessionReply({ api, session, messages, onSent }: { api: Api; session: SessionRef; messages: TimelineMsg[]; onSent: () => void }) {
  const host = session.host || 'local';
  const storageKey = `dispatch-reply:${host}:${session.agent}:${session.session_id}`;
  const [draft, setDraft] = useState(() => { try { return sessionStorage.getItem(storageKey) || ''; } catch { return ''; } });
  const [connection, setConnection] = useState<Connection | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [receipt, setReceipt] = useState<Receipt | null>(null);
  const attempt = useRef<{ id: string; text: string } | null>((() => { try { return JSON.parse(sessionStorage.getItem(storageKey+':attempt') || 'null'); } catch { return null; } })());
  const [dismissed, setDismissed] = useState('');
  const forgetAttempt = () => { attempt.current = null; try { sessionStorage.removeItem(storageKey+':attempt'); } catch { /* private browser */ } };
  const locked = useRef(false);
  const alive = useRef(true);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const [images, setImages] = useState<Attached[]>([]);
  const [saving, setSaving] = useState(0);
  const fileInput = useRef<HTMLInputElement>(null);
  // Pictures land on the machine the session runs on, so its Read tool can open the path.
  const addFiles = async (files: File[]) => {
    for (const f of files.filter(x => x.type.startsWith('image/'))) {
      setSaving(n => n + 1);
      try {
        const data = await shrinkImage(f);
        const t = await api.on(host, ['save-image', '--json'], JSON.stringify({ name: f.name || 'photo', data }));
        const saved = readJson<{ path: string }>(t);
        if (alive.current) setImages(xs => [...xs, { path: saved.path, preview: data, name: f.name || '图片' }]);
      } catch (e) { if (alive.current) setError(/usage:|invalid choice/.test(String(e)) ? '会话所在机器的 dispatch 太旧，还不会存图片；更新那台机器后再试。' : `图片没传上去：${String(e)}`); }
      finally { if (alive.current) setSaving(n => n - 1); }
    }
  };
  const onPaste = (e: ReactClipboardEvent) => { const files = Array.from(e.clipboardData.files); if (files.length) { e.preventDefault(); void addFiles(files); } };
  const [commands, setCommands] = useState<SlashCommand[] | null>(null);
  const [cursor, setCursor] = useState(0);
  const [menuClosed, setMenuClosed] = useState('');
  const query = slashQuery(draft);
  const menu = query !== null && menuClosed !== draft && commands ? matchCommands(commands, query) : [];
  useEffect(() => {
    if (query === null || commands) return;
    let live = true;
    api.on(host, ['reply', 'commands', session.session_id, '--agent', session.agent, '--json'])
      .then(raw => { if (live) setCommands(JSON.parse(raw.slice(raw.indexOf('[')))); })
      .catch(() => { if (live) setCommands([]); });
    return () => { live = false; };
  }, [query === null, commands, api, host, session.session_id, session.agent]);
  useEffect(() => { setCursor(0); }, [query]);
  useEffect(() => { document.querySelector('.reply-slash li.on')?.scrollIntoView({ block: 'nearest' }); }, [cursor, menu.length]);
  const pick = (c: SlashCommand) => { setDraft(`/${c.name} `); setMenuClosed(''); textarea.current?.focus(); };
  const args = ['reply', 'status', session.session_id, '--agent', session.agent, '--json'];
  const load = async () => {
    try {
      const c = readJson<Connection>(await api.on(host, args));
      if (alive.current) {
        setConnection(c); setError('');
        setReceipt(old => old ? c.receipts.find(r=>r.id===old.id) || old : old);
        const sent = c.receipts.find(r=>r.id===attempt.current?.id);
        if (sent?.state==='accepted') { setDraft(old=>old.trim()===sent.text.trim()?'':old);forgetAttempt(); }
        if (sent?.state==='failed') forgetAttempt();
      }
      return c;
    } catch (e) {
      if (alive.current) { setConnection(null); setError(`暂时无法连接：${String(e)}`); }
      return null;
    }
  };
  useEffect(() => {
    alive.current = true; void load();
    const reconnect = () => { if (document.visibilityState === 'visible' && !locked.current) void load(); };
    const timer = window.setInterval(reconnect, 15000);
    window.addEventListener('online', reconnect);
    document.addEventListener('visibilitychange', reconnect);
    return () => { alive.current = false; window.clearInterval(timer); window.removeEventListener('online', reconnect); document.removeEventListener('visibilitychange', reconnect); };
  }, [api, storageKey]);
  useEffect(() => { try { draft ? sessionStorage.setItem(storageKey, draft) : sessionStorage.removeItem(storageKey); } catch { /* private browser */ } }, [draft, storageKey]);
  // iOS's visual viewport shrinks for the keyboard before the layout viewport does.
  useEffect(() => {
    const viewport = window.visualViewport;
    const resize = () => {
      const active = document.activeElement === textarea.current;
      document.documentElement.style.setProperty('--reply-viewport', active && viewport ? `${viewport.height + viewport.offsetTop}px` : '100dvh');
      document.body.classList.toggle('reply-keyboard', active && !!viewport && window.innerHeight - viewport.height > 120);
    };
    viewport?.addEventListener('resize', resize); viewport?.addEventListener('scroll', resize);
    document.addEventListener('focusin', resize); document.addEventListener('focusout', resize);
    return () => { viewport?.removeEventListener('resize', resize); viewport?.removeEventListener('scroll', resize); document.removeEventListener('focusin', resize); document.removeEventListener('focusout', resize); document.body.classList.remove('reply-keyboard'); document.documentElement.style.removeProperty('--reply-viewport'); };
  }, []);
  const [switching, setSwitching] = useState(false);
  // Phone: the one-line box is fine for a sentence; a long message wants the big editor.
  const [big, setBig] = useState(false);
  // The original session runs on this host but outside Herdr (a plain terminal, VS Code…):
  // take it into Herdr first, then re-check the connection. Runs on the session's own host,
  // not necessarily this device's.
  const [adopting, setAdopting] = useState(false);
  const adoptRequest = useRef<string | null>(null);
  const adopt = async () => {
    if (adopting) return;
    setAdopting(true); setError('');
    adoptRequest.current ??= messageId();
    try {
      const r = await sessionControl<{ request_id?: string; state: string; message: string }>(api, host, 'adopt', { session_id: session.session_id, request_id: adoptRequest.current });
      if (r.request_id) {
        for (let n = 0; n < 45; n++) {
          await new Promise(res => window.setTimeout(res, 1000));
          const s = await sessionControl<{ state: string; message: string }>(api, host, 'status', { request_id: r.request_id });
          if (!['starting', 'running'].includes(s.state)) { if (s.state !== 'ready') setError(s.message); break; }
        }
      }
      adoptRequest.current = null;
      await load();
    } catch (e) { setError(String(e)); }
    finally { setAdopting(false); }
  };
  const control = async (payload: { mode?: string; model?: string; interrupt?: boolean; request_id?: string; decision?: string; answers?: Record<string, unknown> }) => {
    if (switching) return;
    setSwitching(true); setError('');
    try {
      const r = readJson<{ state: string; note: string; model?: string; mode?: string; desktop?: Desktop }>(await api.on(host, ['reply', 'control', session.session_id, '--agent', session.agent, '--json'], JSON.stringify(payload)));
      if (r.state !== 'accepted') setError(r.note); else if (payload.interrupt || payload.request_id) setNotice(r.note);
      setConnection(c => c ? { ...c, model: r.model ?? c.model, mode: r.mode ?? c.mode, ...(r.desktop ? { desktop: r.desktop, working: r.desktop.running } : {}) } : c);
      if (payload.interrupt || payload.request_id) onSent();
    } catch (e) { setError(String(e)); }
    finally { setSwitching(false); }
  };
  const [notice, setNotice] = useState('');
  const [answerDraft, setAnswerDraft] = useState<Record<string, string>>({});
  // Codex desktop: what it waits for right now (approvals, questions), answered over the desktop's own IPC.
  const desktop = connection?.desktop;
  const desktopBlock = desktop && (desktop.requests.length > 0 || desktop.running) ? <div className="reply-desktop" role="status">
    {desktop.requests.map(r => <div key={r.id} className={`reply-request k-${r.kind}`}>
      <div className="reply-request-head"><b>{REQUEST_LABEL[r.kind] ?? '等确认'}</b><span className="reply-request-text">{r.summary}</span></div>
      {r.reason && <p className="muted small">{r.reason}</p>}
      {r.cwd && <p className="muted small mono">{r.cwd}</p>}
      {(r.kind === 'command' || r.kind === 'file') && <div className="reply-request-actions">
        <button className="btn sm primary" type="button" disabled={switching} onClick={() => void control({ request_id: r.id, decision: 'accept' })}>批准</button>
        <button className="btn sm" type="button" disabled={switching} onClick={() => void control({ request_id: r.id, decision: 'acceptForSession' })} title="这个会话里同类的都批准">本会话都批准</button>
        <button className="btn sm" type="button" disabled={switching} onClick={() => void control({ request_id: r.id, decision: 'decline' })}>拒绝</button>
      </div>}
      {r.kind === 'permission' && <div className="reply-request-actions">
        <button className="btn sm primary" type="button" disabled={switching} onClick={() => void control({ request_id: r.id, decision: 'accept' })}>批准（本轮）</button>
        <button className="btn sm" type="button" disabled={switching} onClick={() => void control({ request_id: r.id, decision: 'decline' })}>拒绝</button>
      </div>}
      {r.kind === 'question' && <div className="reply-request-answers">
        {(r.questions ?? []).map(q => <label key={q.id}><span>{q.text}</span>
          {q.options.length > 0 && <div className="reply-request-options">{q.options.map(o => <button key={o} type="button" className={`btn sm${answerDraft[q.id] === o ? ' on' : ''}`} onClick={() => setAnswerDraft(d => ({ ...d, [q.id]: o }))}>{o}</button>)}</div>}
          <input value={answerDraft[q.id] ?? ''} onChange={e => setAnswerDraft(d => ({ ...d, [q.id]: e.target.value }))} placeholder={q.options.length ? '或自己写' : '你的回答'} />
        </label>)}
        <button className="btn sm primary" type="button" disabled={switching || !(r.questions ?? []).every(q => (answerDraft[q.id] ?? '').trim())} onClick={() => void control({ request_id: r.id, answers: Object.fromEntries((r.questions ?? []).map(q => [q.id, { answers: [answerDraft[q.id]] }])) })}>回答</button>
      </div>}
      {(r.kind === 'option' || r.kind === 'elicitation' || r.kind === 'other') && <p className="muted small">这种请求得在 Codex 桌面端里处理。</p>}
    </div>)}
    {desktop.running && <div className="reply-request-actions"><span className="muted small">它正在跑</span><button className="btn sm" type="button" disabled={switching} onClick={() => void control({ interrupt: true })} title="停下当前这轮（桌面端的 Stop）">打断</button></div>}
  </div> : null;
  const send = async (mode: 'queue' | 'interrupt' = 'queue') => {
    // Pictures travel as separate --image arguments: the CLI attaches them the way each agent
    // takes them (Claude Code: one paste per picture, then the words; others: paths in the text).
    const paths = images.map(x => x.path);
    const text = draft.trim() || (paths.length ? '看一下这几张图' : '');
    if (locked.current || !text || saving || !connection?.available) return;
    locked.current = true; setBusy(true); setError('');
    const request = attempt.current?.text === text ? attempt.current : { id: messageId(), text };
    attempt.current = request;
    try { sessionStorage.setItem(storageKey+':attempt',JSON.stringify(request)); } catch { /* private browser */ }
    try {
      const r = readJson<Receipt>(await api.on(host, ['reply', 'send', session.session_id, '--agent', session.agent, '--request', request.id, '--mode', mode, ...paths.flatMap(p => ['--image', p]), '--json'], text));
      if (r.state === 'accepted') { try { if ((sessionStorage.getItem(storageKey)||'').trim()===text) sessionStorage.removeItem(storageKey); } catch { /* private browser */ } forgetAttempt(); }
      if (!alive.current) return;
      setReceipt(r);
      if (r.state === 'accepted') { setDraft(''); setImages([]); onSent(); }
      else if (r.state === 'failed') { forgetAttempt(); setError(r.note); }
      else setError(r.note);
      await load();
    } catch {
      // Reconcile the same receipt on a network retry; never generate a fresh ID.
      if (alive.current) setError('连接中断，草稿已保留。点“确认发送结果”查询或重试同一条消息。');
    } finally {
      locked.current = false;
      if (alive.current) setBusy(false);
    }
  };
  const last = (receipt || connection?.receipts[0])?.id===dismissed ? null : receipt || connection?.receipts[0];
  const plain = (t: string) => t.replace(/\[Image: source: [^\]]*\]|(?:^|\s)\/\S+\.(?:png|jpe?g|gif|webp|heic|heif)\b/gi, ' ').split('附图（用 Read 看）：')[0].replace(/\s+/g, ' ').trim();
  const shownInTranscript = (r: Receipt) => messages.some(m => m.role === 'user' && plain(m.text) === plain(r.text) && Date.parse(m.ts) >= (r.created - 10) * 1000);
  // Everything accepted but not yet in the conversation, oldest first: while the agent works, Claude Code
  // holds several queued messages, and each one stays visible here until its turn comes.
  const pending = (connection?.receipts ?? []).filter(r => r.state === 'accepted' && r.id !== dismissed && !r.delivered && !shownInTranscript(r) && Date.now() / 1000 - r.created < 6 * 3600).sort((a, b) => a.created - b.created);
  const unknown = last && (last.state === 'unknown' || last.state === 'sending');
  return <section className={`session-reply${big ? " big" : ""}`} aria-label="回复当前会话">
    {pending.length > 0 && <div className="reply-receipt" role="status">{pending.length > 1 && <span>已排队 {pending.length} 条，本轮结束后按顺序处理</span>}{pending.map(r => <div key={r.id} className="reply-queued"><span>你 · {r.note}</span><p>{r.text}</p></div>)}</div>}
    {desktopBlock}
    {notice && <div className="reply-receipt" role="status"><span>{notice}</span><button className="link" type="button" onClick={() => setNotice('')}>好</button></div>}
    <div className="reply-connection"><span>{connection?.label || (error ? '连接暂时不可用' : '正在连接原会话…')}</span>
      {connection?.available && (connection.mode || connection.model) && <span className="reply-switches">
        {connection.mode && <select aria-label="权限模式" title="权限模式：终端里的 Shift+Tab" value={connection.mode} disabled={switching} onChange={e => void control({ mode: e.target.value })}>{MODES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}{!MODES.some(([v]) => v === connection.mode) && <option value={connection.mode}>{connection.mode}</option>}</select>}
        {connection.model && <select aria-label="模型" title="模型：终端里的 /model" value={modelAlias(connection.model)} disabled={switching || !!connection.working} onChange={e => void control({ model: e.target.value })}>{MODELS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}{!MODELS.some(([v]) => v === modelAlias(connection.model!)) && <option value={modelAlias(connection.model)}>{connection.model}</option>}</select>}
      </span>}
      {!connection?.available && connection?.adoptable && <button className="btn sm" type="button" disabled={adopting || connection.adopt_state === 'working'}
        title={connection.adopt_state === 'working' ? `它正在 ${connection.source_app || '原终端'} 里跑，等它停下来再接` : `把它从 ${connection.source_app || '原终端'} 接进那台电脑的 Herdr，再发这条`}
        onClick={() => void adopt()}>{adopting ? '正在接…' : '接进 Herdr 再发'}</button>}
      {!connection?.available && <button className="link" onClick={() => void load()}>重新连接</button>}</div>
    <form onSubmit={e => { e.preventDefault(); void send(); }}>
      {menu.length > 0 && <ul className="reply-slash" role="listbox" aria-label="可用的 / 命令">
        {menu.map((c, i) => <li key={c.name} role="option" aria-selected={i === cursor} className={i === cursor ? 'on' : ''}
          onMouseDown={e => { e.preventDefault(); pick(c); }} onMouseEnter={() => setCursor(i)}>
          <b>/{c.name}</b><span>{c.description}</span><i>{KIND_LABEL[c.kind]}</i>
        </li>)}
      </ul>}
      {query !== null && commands === null && <div className="reply-slash reply-slash-loading">正在读取可用命令…</div>}
      {(images.length > 0 || saving > 0) && <div className="reply-images">
        {images.map((im, i) => <div key={im.path} className="disc-img"><img src={im.preview} alt={im.name} title={im.path} /><button type="button" className="x" onClick={() => setImages(images.filter((_, j) => j !== i))} aria-label="移除图片">✕</button></div>)}
        {saving > 0 && <span className="muted small">传图中…</span>}
      </div>}
      <input ref={fileInput} type="file" accept="image/*" multiple hidden onChange={e => { void addFiles(Array.from(e.target.files || [])); e.target.value = ''; }} />
      <button className="btn reply-attach" type="button" disabled={busy || !!unknown} onClick={() => fileInput.current?.click()} title="发图片：手机可拍照或选相册，电脑也可以直接粘贴" aria-label="添加图片">📷</button>
      <div className="reply-box"><textarea ref={textarea} onPaste={onPaste} aria-label="回复内容" placeholder={connection?.working ? "" : images.length ? "说说这张图要干什么（可不填）" : "在这里回复…"} value={draft} maxLength={16000} rows={1} disabled={busy || !!unknown}
        onChange={e => { setDraft(e.target.value); if (receipt?.state === 'failed') setReceipt(null); }}
        onKeyDown={e => {
          if (e.nativeEvent.isComposing) return;
          if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); void send(); return; }
          if (!menu.length) return;
          if (e.key === 'ArrowDown') { e.preventDefault(); setCursor(i => (i + 1) % menu.length); }
          else if (e.key === 'ArrowUp') { e.preventDefault(); setCursor(i => (i - 1 + menu.length) % menu.length); }
          else if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); pick(menu[Math.min(cursor, menu.length - 1)]); }
          else if (e.key === 'Escape') { e.preventDefault(); setMenuClosed(draft); }
        }} />
      <button className="btn reply-expand" type="button" onMouseDown={e => e.preventDefault()} onClick={() => { setBig(b => !b); textarea.current?.focus(); }} title={big ? '收起输入框' : '放大输入框'} aria-label={big ? '收起输入框' : '放大输入框'}>{big ? '⤡' : '⤢'}</button></div>
      {connection?.working && <button className="btn" type="button" onMouseDown={e => e.preventDefault()} disabled={busy || !!saving || (!draft.trim() && !images.length) || !connection?.available || !!unknown} onClick={() => void send('interrupt')} title="先按 Esc 打断当前这轮，再把这条发给它——像 Codex 的引导">打断并发送</button>}
      <button className="btn primary" type="submit" onMouseDown={e => e.preventDefault()} disabled={busy || !!saving || (!draft.trim() && !images.length) || !connection?.available || !!unknown} title={connection?.working ? '排进队列，本轮结束 Agent 就会看到' : undefined}>{busy ? '发送中…' : attempt.current ? '确认发送结果' : connection?.working ? '排队发送' : '发送'}</button>
    </form>
    {(error || unknown || last?.state==='failed') && <div className="reply-error" role="alert">{error || last?.note}{unknown && <><button className="link" onClick={() => { setReceipt(null); void load(); }}>检查送达状态</button><button className="link" onClick={()=>{setDismissed(last.id);forgetAttempt();setError('');}}>已核对，继续编辑</button></>}</div>}
  </section>;
}
