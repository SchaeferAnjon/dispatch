import { useEffect, useRef, useState, type ClipboardEvent as ReactClipboardEvent } from 'react';
import type { Api } from '../api';
import type { SessionRef, TimelineMsg } from '../types';

interface Receipt { id: string; text: string; state: 'sending' | 'accepted' | 'failed' | 'unknown'; note: string; created: number }
interface Connection { available: boolean; label: string; working?: boolean; receipts: Receipt[] }
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
    const timer = window.setInterval(() => { if (document.visibilityState === 'visible' && !locked.current) void load(); }, 15000);
    return () => { alive.current = false; window.clearInterval(timer); };
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
  const send = async (mode: 'queue' | 'interrupt' = 'queue') => {
    const text = withImages(draft, images.map(x => x.path));
    if (locked.current || !text || saving || !connection?.available) return;
    locked.current = true; setBusy(true); setError('');
    const request = attempt.current?.text === text ? attempt.current : { id: messageId(), text };
    attempt.current = request;
    try { sessionStorage.setItem(storageKey+':attempt',JSON.stringify(request)); } catch { /* private browser */ }
    try {
      const r = readJson<Receipt>(await api.on(host, ['reply', 'send', session.session_id, '--agent', session.agent, '--request', request.id, '--mode', mode, '--json'], text));
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
  const inTranscript = last && messages.some(m => m.role === 'user' && m.text.trim() === last.text.trim() && Date.parse(m.ts) >= (last.created - 10) * 1000);
  const unknown = last && (last.state === 'unknown' || last.state === 'sending');
  return <section className="session-reply" aria-label="回复当前会话">
    {last?.state === 'accepted' && !inTranscript && <div className="reply-receipt" role="status"><span>你 · {last.note}</span><p>{last.text}</p></div>}
    <div className="reply-connection"><span>{connection?.label || (error ? '连接暂时不可用' : '正在连接原会话…')}</span>{!connection?.available && <button className="link" onClick={() => void load()}>重新连接</button>}</div>
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
      <textarea ref={textarea} onPaste={onPaste} aria-label="回复内容" placeholder={connection?.working ? "它在跑，也可以说话：排队等本轮结束，或打断让它马上看" : images.length ? "说说这张图要干什么（可不填）" : "在这里回复，继续这个会话…"} value={draft} maxLength={16000} rows={2} disabled={busy || !!unknown}
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
      {connection?.working && <button className="btn" type="button" disabled={busy || !!saving || (!draft.trim() && !images.length) || !connection?.available || !!unknown} onClick={() => void send('interrupt')} title="先按 Esc 打断当前这轮，再把这条发给它——像 Codex 的引导">打断并发送</button>}
      <button className="btn primary" type="submit" disabled={busy || !!saving || (!draft.trim() && !images.length) || !connection?.available || !!unknown} title={connection?.working ? '排进队列，本轮结束 Agent 就会看到' : undefined}>{busy ? '发送中…' : attempt.current ? '确认发送结果' : connection?.working ? '排队发送' : '发送'}</button>
    </form>
    {(error || unknown || last?.state==='failed') && <div className="reply-error" role="alert">{error || last?.note}{unknown && <><button className="link" onClick={() => { setReceipt(null); void load(); }}>检查送达状态</button><button className="link" onClick={()=>{setDismissed(last.id);forgetAttempt();setError('');}}>已核对，继续编辑</button></>}</div>}
  </section>;
}
