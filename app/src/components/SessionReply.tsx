import { useEffect, useRef, useState } from 'react';
import type { Api } from '../api';
import type { SessionRef, TimelineMsg } from '../types';

interface Receipt { id: string; text: string; state: 'sending' | 'accepted' | 'failed' | 'unknown'; note: string; created: number }
interface Connection { available: boolean; label: string; receipts: Receipt[] }
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
  const send = async () => {
    const text = draft.trim();
    if (locked.current || !text || !connection?.available) return;
    locked.current = true; setBusy(true); setError('');
    const request = attempt.current?.text === text ? attempt.current : { id: messageId(), text };
    attempt.current = request;
    try { sessionStorage.setItem(storageKey+':attempt',JSON.stringify(request)); } catch { /* private browser */ }
    try {
      const r = readJson<Receipt>(await api.on(host, ['reply', 'send', session.session_id, '--agent', session.agent, '--request', request.id, '--json'], text));
      if (r.state === 'accepted') { try { if ((sessionStorage.getItem(storageKey)||'').trim()===text) sessionStorage.removeItem(storageKey); } catch { /* private browser */ } forgetAttempt(); }
      if (!alive.current) return;
      setReceipt(r);
      if (r.state === 'accepted') { setDraft(''); onSent(); }
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
      <textarea ref={textarea} aria-label="回复内容" placeholder="在这里回复，继续这个会话…" value={draft} maxLength={16000} rows={2} disabled={busy || !!unknown}
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
      <button className="btn primary" type="submit" disabled={busy || !draft.trim() || !connection?.available || !!unknown}>{busy ? '发送中…' : attempt.current ? '确认发送结果' : '发送'}</button>
    </form>
    {(error || unknown || last?.state==='failed') && <div className="reply-error" role="alert">{error || last?.note}{unknown && <><button className="link" onClick={() => { setReceipt(null); void load(); }}>检查送达状态</button><button className="link" onClick={()=>{setDismissed(last.id);forgetAttempt();setError('');}}>已核对，继续编辑</button></>}</div>}
  </section>;
}
