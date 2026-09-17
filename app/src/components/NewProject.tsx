import { useEffect, useRef, useState } from 'react';
import { isTauri, type Api } from '../api';
import { open as pickFolder } from '@tauri-apps/plugin-dialog';
import { useT } from '../i18n';
import { control } from './SessionActions';

interface Folders { path: string; parent: string; children: { name: string; path: string }[]; recent: string[]; truncated: boolean }

/** Create a project before its first session: pick (or make) its folder on this Mac, optionally
 *  `git init`, and the project appears on the projects page with that folder as its home. */
export function NewProject({ api, onClose, onCreated }: { api: Api; onClose: () => void; onCreated: (name: string, dir: string, startSession: boolean) => void }) {
  const t = useT();
  const [name, setName] = useState('');
  const [nameTouched, setNameTouched] = useState(false);
  const [path, setPath] = useState('');
  const [folders, setFolders] = useState<Folders | null>(null);
  const [browseBusy, setBrowseBusy] = useState(false);
  const [subfolder, setSubfolder] = useState('');
  const [git, setGit] = useState(true);
  const [startSession, setStartSession] = useState(true);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const generation = useRef(0);
  const dialog = useRef<HTMLDivElement>(null);
  useEffect(() => { dialog.current?.focus(); }, []);

  const browse = async (next: string) => {
    const seq = ++generation.current;
    setBrowseBusy(true); setError('');
    try { const r = await control<Folders>(api, 'local', 'browse', { path: next }); if (seq === generation.current) { setFolders(r); setPath(r.path); } }
    catch (e) { if (seq === generation.current) setError(String(e)); }
    finally { if (seq === generation.current) setBrowseBusy(false); }
  };
  useEffect(() => { void browse(''); return () => { generation.current++; }; }, []);
  const pick = async () => {
    setError('');
    try { const p = await pickFolder({ directory: true, multiple: false, title: t('选择项目文件夹'), defaultPath: path || undefined }); if (typeof p === 'string' && p) { setPath(p); void browse(p); } }
    catch (e) { setError(String(e)); }
  };
  // The folder the project will live in: the browsed one, or a new subfolder inside it.
  const target = subfolder.trim() ? `${path.replace(/\/+$/, '')}/${subfolder.trim().replace(/^\/+|\/+$/g, '')}` : path.replace(/\/+$/, '');
  const suggested = target.split('/').filter(Boolean).pop() ?? '';
  const finalName = (nameTouched && name.trim()) ? name.trim() : suggested;
  const create = async () => {
    if (!target || !finalName) { setError(t('先选一个文件夹')); return; }
    setBusy(true); setError('');
    try {
      const raw = await api.on('local', ['project', finalName, '--dir', target, '--create', ...(git ? ['--git'] : []), '--json']);
      const r = JSON.parse(raw.slice(Math.max(0, raw.indexOf('{')))) as { name: string; dir: string };
      onCreated(r.name || finalName, r.dir || target, startSession);
    } catch (e) { setError(String(e).replace(/^Error: /, '')); }
    finally { setBusy(false); }
  };
  return <div className="overlay"><div className="dialog new-session-dialog" role="dialog" ref={dialog} tabIndex={-1} aria-modal="true" aria-label={t('新建项目')} onKeyDown={e => { if (e.key === 'Escape') onClose(); }}>
    <h3>{t('新建项目')}</h3>
    <p className="muted small">{t('先建项目，再开会话：选一个已有文件夹，或在它下面新建一个。这个文件夹里以后的会话都归这个项目。')}</p>
    <label>{t('项目文件夹')}<div className="folder-path"><input aria-label={t('项目文件夹')} value={path} disabled={busy} onChange={e => setPath(e.target.value)} placeholder={t('输入完整路径，或从下方选择')} />{isTauri && <button className="btn sm" type="button" disabled={busy} onClick={() => void pick()} title={t('用 Finder 选一个文件夹')}>{t('从 Finder 选择…')}</button>}<button className="btn sm" type="button" disabled={busy || browseBusy} onClick={() => browse(path)}>{t('前往')}</button></div></label>
    <div className="folder-picker" aria-busy={browseBusy}>
      <div className="folder-picker-heading"><b>{t('浏览文件夹')}</b><button className="link" disabled={!folders || busy || browseBusy || folders.path === folders.parent} onClick={() => browse(folders!.parent)}>{t('↑ 上一级')}</button></div>
      {browseBusy ? <p className="muted">{t('读取文件夹…')}</p> : <div className="folder-children">{folders?.children.map(f => <button key={f.path} type="button" disabled={busy} onClick={() => browse(f.path)}>▱ {f.name}<span>›</span></button>)}{folders?.children.length === 0 && <p className="muted">{t('没有子文件夹，可直接使用当前目录。')}</p>}</div>}
      {folders?.truncated && <small>{t('子文件夹较多，可输入完整路径前往。')}</small>}
    </div>
    <label>{t('在这个文件夹下新建子文件夹（可不填）')}<input aria-label={t('新建子文件夹')} value={subfolder} disabled={busy} onChange={e => setSubfolder(e.target.value)} placeholder={t('例如 my-app：不填就用上面选中的文件夹本身')} /></label>
    <label>{t('项目名')}<input aria-label={t('项目名')} value={nameTouched ? name : suggested} disabled={busy} onChange={e => { setNameTouched(true); setName(e.target.value); }} placeholder={t('默认用文件夹名')} /></label>
    <label className="check"><input type="checkbox" checked={git} disabled={busy} onChange={e => setGit(e.target.checked)} /> {t('还不是 git 仓库就 git init')}</label>
    <label className="check"><input type="checkbox" checked={startSession} disabled={busy} onChange={e => setStartSession(e.target.checked)} /> {t('建好后马上在这里开一个会话')}</label>
    {error && <p className="setup-bad">{error}</p>}
    <div className="dialog-actions"><button className="btn" type="button" disabled={busy} onClick={onClose}>{t('取消')}</button><button className="btn primary" type="button" disabled={busy || !target} onClick={() => void create()}>{busy ? t('创建中…') : t('创建项目')}</button></div>
  </div></div>;
}
