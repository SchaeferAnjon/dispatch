import { createContext, useCallback, useContext, useEffect, useState, useRef, type ReactNode } from 'react';
import type { Api } from '../api';
import type { SessionRef } from '../types';

export interface Attachment { id: string; name: string; path: string; ts: string; mime: string; exists: boolean }
export interface AttachmentData { name: string; path: string; mime: string; size: number; data: string; text?: string }
interface MediaAccess { read: (ref: string) => Promise<AttachmentData>; open: (ref: string, group?: string[]) => void; thumb: (ref: string) => string | undefined }
type Thumbs = Record<string, { name: string; mime: string; size: number; data: string }>;
const Context = createContext<MediaAccess | null>(null);
export const useMedia = () => useContext(Context);
export const dataUrl = (a: AttachmentData) => `data:${a.mime};base64,${a.data}`;
const cache = new Map<string, Promise<AttachmentData>>();

export function MediaProvider({ api, session, children }: { api: Api; session?: Pick<SessionRef, 'host' | 'agent' | 'session_id'>; children: ReactNode }) {
  const [value, setValue] = useState<AttachmentData | null>(null);
  const [error, setError] = useState('');
  const [show, setShow] = useState(false);
  const [url, setUrl] = useState('');
  const requestId = useRef(0);
  const read = useCallback((ref: string) => {
    if (!session) return Promise.reject(new Error('请先打开会话'));
    const key = `${session.host || 'local'}:${session.agent}:${session.session_id}:${ref}`;
    if (!cache.has(key)) {
      if (cache.size > 30) cache.delete(cache.keys().next().value!);
      const request = api.on(session.host || 'local', ['attachment', `${session.agent}:${session.session_id}`, ref, '--json']).then(s => JSON.parse(s) as AttachmentData).catch(e => { cache.delete(key); throw e; });
      cache.set(key, request);
    }
    return cache.get(key)!;
  }, [api, session?.agent, session?.session_id, session?.host]);
  // Lightbox: one picture at full size, with prev/next over the group it was clicked in.
  const [group, setGroup] = useState<string[]>([]);
  const [at, setAt] = useState(0);
  const load = useCallback((ref: string) => { const id=++requestId.current; setError(''); setValue(null); void read(ref).then(v=>{if(requestId.current===id)setValue(v);}).catch(e=>{if(requestId.current===id)setError(String(e));}); }, [read]);
  const open = useCallback((ref: string, grp?: string[]) => { const g = grp && grp.length ? grp : [ref]; setGroup(g); setAt(Math.max(0, g.indexOf(ref))); setShow(true); load(ref); }, [load]);
  const step = useCallback((d: number) => { if (group.length < 2) return; const n = (at + d + group.length) % group.length; setAt(n); load(group[n]); }, [group, at, load]);
  // Thumbnails for every picture in the session come in one CLI call (the CLI scales them
  // with sips and caches on disk); before that call lands, tiles show a placeholder.
  const [thumbs, setThumbs] = useState<Thumbs | null>(null);
  const thumbsWanted = useRef(false);
  const sessionKey = session ? `${session.host || 'local'}:${session.agent}:${session.session_id}` : '';
  useEffect(() => { thumbsWanted.current = false; setThumbs(null); }, [sessionKey]);
  const thumb = useCallback((ref: string) => {
    if (!session) return undefined;
    if (!thumbsWanted.current) {
      thumbsWanted.current = true;
      const key = sessionKey;
      api.on(session.host || 'local', ['attachment', `${session.agent}:${session.session_id}`, '--thumbs', '--json']).then(t => { if (thumbsWanted.current && key === sessionKey) setThumbs(JSON.parse(t) as Thumbs); }).catch(() => { if (key === sessionKey) setThumbs({}); });
    }
    const t = thumbs?.[ref];
    return t ? `data:${t.mime};base64,${t.data}` : thumbs ? '' : undefined;
  }, [api, session?.agent, session?.session_id, session?.host, sessionKey, thumbs]);
  useEffect(() => { ++requestId.current; setShow(false); setValue(null); }, [session?.agent,session?.session_id,session?.host]);
  useEffect(() => {
    if (!value) { setUrl(''); return; }
    const bytes = Uint8Array.from(atob(value.data), c => c.charCodeAt(0));
    const u = URL.createObjectURL(new Blob([bytes], { type: value.mime })); setUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [value]);
  useEffect(() => {
    if (!show) return;
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); setShow(false); } else if (e.key === 'ArrowRight' || e.key === 'ArrowDown') { e.preventDefault(); step(1); } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') { e.preventDefault(); step(-1); } };
    window.addEventListener('keydown', key, true); return () => window.removeEventListener('keydown', key, true);
  }, [show, step]);
  const html = value?.mime === 'text/html' ? `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:; connect-src 'none'; form-action 'none'; base-uri 'none'">${value.text || ''}` : '';
  return <Context.Provider value={{ read, open, thumb }}>{children}{show && <div className="overlay media-overlay" onMouseDown={e => e.target === e.currentTarget && setShow(false)}>
    <div className="media-dialog" role="dialog" aria-modal="true" aria-label="附件预览"><header><b>{value?.name || (error ? '无法预览' : '正在读取附件…')}</b>{value && <span className="muted small mono">{value.mime.replace('image/', '')} · {value.size >= 1048576 ? `${(value.size / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(value.size / 1024))} KB`}</span>}<span className="spacer" />{group.length > 1 && <span className="media-nav"><button className="btn sm" onClick={() => step(-1)} aria-label="上一张">‹</button><span className="mono small">{at + 1} / {group.length}</span><button className="btn sm" onClick={() => step(1)} aria-label="下一张">›</button></span>}{value && <a className="btn sm" href={url} download={value.name}>下载</a>}<button className="btn sm" autoFocus onClick={() => setShow(false)} aria-label="关闭附件预览">✕</button></header>
      {error && <p className="err">{error}</p>}
      {value && <div className="media-content">{value.mime.startsWith('image/') ? <img src={dataUrl(value)} alt={value.name} /> : html ? <iframe title={value.name} sandbox="allow-scripts" srcDoc={html} /> : value.mime === 'application/pdf' ? <iframe title={value.name} src={url} /> : value.mime.startsWith('video/') ? <video controls src={url} /> : value.mime.startsWith('audio/') ? <audio controls src={url} /> : value.text != null ? <pre>{value.text}</pre> : <p>此文件可下载后用对应应用打开。</p>}</div>}
      {value?.mime === 'text/html' && <footer>HTML 在隔离预览中运行；外部网络不会加载；同目录图片可预览。复杂外部依赖请在原项目中查看。</footer>}
    </div></div>}</Context.Provider>;
}

// A picture inside a conversation turn: thumbnail now, the full viewer on click.
export function InlineImage({ id, group }: { id: string; group?: string[] }) {
  const media = useMedia();
  const t = media?.thumb(id);
  const [src, setSrc] = useState('');
  const [failed, setFailed] = useState(false);
  // Only when the batch has no thumbnail for this id (a very new picture) fall back to one read.
  useEffect(() => { if (t !== '' || !media) return; let alive = true; media.read(id).then(v => { if (alive) setSrc(dataUrl(v)); }).catch(() => { if (alive) setFailed(true); }); return () => { alive = false; }; }, [id, media, t]);
  const shown = t || src;
  if (failed) return <span className="inline-image broken muted small">图片无法读取</span>;
  return <button className={`inline-image${shown ? '' : ' loading'}`} onClick={() => media?.open(id, group)} title="点开看大图（左右键切换）">{shown ? <img src={shown} alt="会话图片" loading="lazy" /> : <span className="ph" aria-label="图片载入中" />}</button>;
}

// Several pictures in one turn: a tidy grid of same-size tiles instead of a pile of
// differently sized images. Past `max` tiles the last one says how many more; the
// lightbox walks through all of them.
export function ImageGrid({ ids, max = 8 }: { ids: string[]; max?: number }) {
  const media = useMedia();
  const [all, setAll] = useState(false);
  const shown = all ? ids : ids.slice(0, max);
  const rest = ids.length - shown.length;
  if (ids.length === 0) return null;
  return <div className={`img-grid n${Math.min(shown.length, 4)}`}>
    {shown.map(id => <InlineImage key={id} id={id} group={ids} />)}
    {rest > 0 && <button className="inline-image more" onClick={() => setAll(true)} title="显示全部"><span>+{rest}</span></button>}
    {ids.length > 1 && <button className="img-grid-open link sm" onClick={() => media?.open(ids[0], ids)}>{ids.length} 张 · 逐张看</button>}
  </div>;
}

export function AttachmentList({ items }: { items: Attachment[] }) {
  const media = useMedia();
  return <div className="attachment-list">{items.length === 0 ? <p className="muted">没有找到图片或链接的本地文件。</p> : items.map(a => a.mime.startsWith('image/') && a.exists ? <Thumb key={a.id} a={a} onOpen={() => media?.open(a.id, items.filter(x => x.mime.startsWith('image/') && x.exists).map(x => x.id))} /> : <button className="attachment-card" key={a.id} onClick={() => media?.open(a.id)}><span className="attachment-icon">{a.mime === 'text/html' ? '‹/›' : '▤'}</span><span><b>{a.name}</b><small>{a.mime} · {a.exists ? '点击预览' : '原文件已不可用'}</small></span><span>›</span></button>)}</div>;
}

function Thumb({ a, onOpen }: { a: Attachment; onOpen: () => void }) {
  const media = useMedia();
  const t = media?.thumb(a.id);
  const [src, setSrc] = useState('');
  useEffect(() => { if (t !== '' || !media) return; let alive = true; media.read(a.id).then(v => { if (alive) setSrc(dataUrl(v)); }).catch(() => {}); return () => { alive = false; }; }, [a.id, media, t]);
  const shown = t || src;
  return <button className="attachment-card thumb" onClick={onOpen} title={a.path || a.name}>{shown ? <img src={shown} alt={a.name} loading="lazy" /> : <span className="attachment-icon">▧</span>}<span><b>{a.name}</b><small>{a.mime.replace('image/', '')}</small></span></button>;
}
