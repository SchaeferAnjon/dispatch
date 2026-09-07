import { createContext, useCallback, useContext, useEffect, useState, useRef, type ReactNode } from 'react';
import type { Api } from '../api';
import type { SessionRef } from '../types';

export interface Attachment { id: string; name: string; path: string; ts: string; mime: string; exists: boolean }
export interface AttachmentData { name: string; path: string; mime: string; size: number; data: string; text?: string }
interface MediaAccess { read: (ref: string) => Promise<AttachmentData>; open: (ref: string) => void }
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
  const open = useCallback((ref: string) => { const id=++requestId.current; setShow(true); setError(''); setValue(null); void read(ref).then(v=>{if(requestId.current===id)setValue(v);}).catch(e=>{if(requestId.current===id)setError(String(e));}); }, [read]);
  useEffect(() => { ++requestId.current; setShow(false); setValue(null); }, [session?.agent,session?.session_id,session?.host]);
  useEffect(() => {
    if (!value) { setUrl(''); return; }
    const bytes = Uint8Array.from(atob(value.data), c => c.charCodeAt(0));
    const u = URL.createObjectURL(new Blob([bytes], { type: value.mime })); setUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [value]);
  useEffect(() => {
    if (!show) return;
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); setShow(false); } };
    window.addEventListener('keydown', key, true); return () => window.removeEventListener('keydown', key, true);
  }, [show]);
  const html = value?.mime === 'text/html' ? `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:; connect-src 'none'; form-action 'none'; base-uri 'none'">${value.text || ''}` : '';
  return <Context.Provider value={{ read, open }}>{children}{show && <div className="overlay media-overlay" onMouseDown={e => e.target === e.currentTarget && setShow(false)}>
    <div className="media-dialog" role="dialog" aria-modal="true" aria-label="附件预览"><header><b>{value?.name || (error ? '无法预览' : '正在读取附件…')}</b><span className="spacer" />{value && <a className="btn sm" href={url} download={value.name}>下载</a>}<button className="btn sm" autoFocus onClick={() => setShow(false)} aria-label="关闭附件预览">✕</button></header>
      {error && <p className="err">{error}</p>}
      {value && <div className="media-content">{value.mime.startsWith('image/') ? <img src={dataUrl(value)} alt={value.name} /> : html ? <iframe title={value.name} sandbox="allow-scripts" srcDoc={html} /> : value.mime === 'application/pdf' ? <iframe title={value.name} src={url} /> : value.mime.startsWith('video/') ? <video controls src={url} /> : value.mime.startsWith('audio/') ? <audio controls src={url} /> : value.text != null ? <pre>{value.text}</pre> : <p>此文件可下载后用对应应用打开。</p>}</div>}
      {value?.mime === 'text/html' && <footer>HTML 在隔离预览中运行；外部网络不会加载；同目录图片可预览。复杂外部依赖请在原项目中查看。</footer>}
    </div></div>}</Context.Provider>;
}

export function AttachmentList({ items }: { items: Attachment[] }) {
  const media = useMedia();
  return <div className="attachment-list">{items.length === 0 ? <p className="muted">没有找到图片或链接的本地文件。</p> : items.map(a => <button className="attachment-card" key={a.id} onClick={() => media?.open(a.id)}><span className="attachment-icon">{a.mime.startsWith('image/') ? '▧' : a.mime === 'text/html' ? '‹/›' : '▤'}</span><span><b>{a.name}</b><small>{a.mime} · {a.exists ? '点击预览' : '原文件已不可用'}</small></span><span>›</span></button>)}</div>;
}
