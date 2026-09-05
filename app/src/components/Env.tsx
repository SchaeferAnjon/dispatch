import { useEffect, useState } from "react";
import type { Api } from "../api";
import type { EnvVar } from "../types";

interface Props { api: Api; onDone: (m: string) => void; onError: (m: string) => void }

// API keys and other secrets live in one 0600 file (~/.config/dispatch/env), never in
// the board or the wiki. Agents learn the *names* from `dispatch prime` and fetch a
// value with `dispatch env get NAME` only when they need it.
export function EnvView({ api, onDone, onError }: Props) {
  const [items, setItems] = useState<EnvVar[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [shown, setShown] = useState<Record<string, string>>({});
  const [editing, setEditing] = useState<{ name: string; note: string; isNew: boolean } | null>(null);
  const [busy, setBusy] = useState(false);

  const load = async () => { try { setItems(await api.envList()); setLoaded(true); } catch (e) { onError(String(e)); } };
  useEffect(() => { load(); }, [api]);

  const reveal = async (name: string) => {
    if (shown[name] !== undefined) { const c = { ...shown }; delete c[name]; setShown(c); return; }
    try { setShown({ ...shown, [name]: await api.envGet(name) }); } catch (e) { onError(String(e)); }
  };
  const copy = async (name: string) => {
    try { await navigator.clipboard.writeText(await api.envGet(name)); onDone(`${name} 已复制`); } catch (e) { onError(String(e)); }
  };
  const remove = async (name: string) => {
    if (busy) return;
    setBusy(true);
    try { await api.envUnset(name); onDone(`${name} 已删除`); await load(); } catch (e) { onError(String(e)); } finally { setBusy(false); }
  };
  const save = async (name: string, value: string, note: string) => {
    setBusy(true);
    try { await api.envSet(name, value, note); onDone(`${name} 已保存；新开的终端自动带上，Agent 用 dispatch env get 取`); setEditing(null); await load(); } catch (e) { onError(String(e)); } finally { setBusy(false); }
  };

  return (
    <div className="pit-wrap">
      <div className="pit-head">
        <span className="muted mono small">{items.length} 个</span>
        <span className="spacer" />
        <button className="btn primary" onClick={() => setEditing({ name: "", note: "", isNew: true })}>＋ 添加</button>
      </div>
      <p className="pit-hint">存在 <span className="mono">~/.config/dispatch/env</span>（仅本人可读）。fish 新终端自动加载；Agent 在会话开始只看到变量名和用途，需要时 <span className="mono">dispatch env get 名字</span> 取值——不用你每次会话重贴 Key。不进任务板、不进知识库。</p>
      {!loaded && <div className="empty">载入中…</div>}
      {loaded && items.length === 0 && <div className="empty">还没有。把智谱、豆包语音等 API Key 加进来，以后任何 Agent 都自己取。</div>}
      <div className="pit-list">
        {items.map((v) => (
          <div key={v.name} className="pit howto">
            <div className="pit-top">
              <span className="mono key" style={{ fontWeight: 600 }}>{v.name}</span>
              {v.note && <span className="muted">{v.note}</span>}
              <span className="spacer" />
              <button className="btn ghost sm" onClick={() => reveal(v.name)}>{shown[v.name] !== undefined ? "隐藏" : "显示"}</button>
              <button className="btn ghost sm" onClick={() => copy(v.name)}>复制</button>
              <button className="btn ghost sm" onClick={() => setEditing({ name: v.name, note: v.note, isNew: false })}>改值</button>
              <button className="btn ghost sm danger" disabled={busy} onClick={() => remove(v.name)}>删除</button>
            </div>
            <div className="pit-row"><span className="lbl plain">值</span><span className="mono" style={{ userSelect: "text", wordBreak: "break-all" }}>{shown[v.name] !== undefined ? shown[v.name] : `${v.masked}  （${v.length} 位）`}</span></div>
            <div className="pit-row"><span className="lbl plain">用法</span><span className="mono muted small">dispatch env get {v.name}</span></div>
          </div>
        ))}
      </div>
      {editing && <EnvDialog initial={editing} onCancel={() => setEditing(null)} onSave={save} />}
    </div>
  );
}

function EnvDialog({ initial, onCancel, onSave }: { initial: { name: string; note: string; isNew: boolean }; onCancel: () => void; onSave: (n: string, v: string, note: string) => Promise<void> }) {
  const [name, setName] = useState(initial.name);
  const [value, setValue] = useState("");
  const [note, setNote] = useState(initial.note);
  const ok = /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) && value.trim().length > 0;
  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onCancel()}>
      <div className="dialog" role="dialog" aria-label="环境变量" onKeyDown={(e) => { if (e.key === "Escape") onCancel(); if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && ok) onSave(name.trim(), value.trim(), note.trim()); }}>
        <h3>{initial.isNew ? "添加变量" : `改 ${initial.name} 的值`}</h3>
        <div className="row">
          <label>变量名<input autoFocus={initial.isNew} value={name} disabled={!initial.isNew} onChange={(e) => setName(e.target.value.toUpperCase())} placeholder="ZHIPU_API_KEY" /></label>
          <label>用途<input value={note} onChange={(e) => setNote(e.target.value)} placeholder="智谱 GLM（GetNewWord / bookmark 用）" /></label>
        </div>
        <label>值<textarea autoFocus={!initial.isNew} value={value} onChange={(e) => setValue(e.target.value)} placeholder="粘贴 Key" spellCheck={false} /></label>
        <div className="foot">
          <button className="btn ghost" onClick={onCancel}>取消</button>
          <button className="btn primary" disabled={!ok} onClick={() => onSave(name.trim(), value.trim(), note.trim())}>保存 ⌘⏎</button>
        </div>
      </div>
    </div>
  );
}
