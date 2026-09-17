import { useEffect, useState } from "react";
import type { Api } from "../api";
import type { EnvVar, Host } from "../types";
import { HostPicker, hostReason } from "./HostPicker";
import { useT } from "../i18n";

interface Props { api: Api; hosts: Host[]; hostId?: string; onDone: (m: string) => void; onError: (m: string) => void }
const parseJson = <T,>(s: string, fallback: T): T => { try { const i = Math.min(...[s.indexOf("{"), s.indexOf("[")].filter((x) => x >= 0)); return JSON.parse(s.slice(i)); } catch { return fallback; } };

// API keys and other secrets live in one 0600 file (~/.config/dispatch/env), never in
// the board or the wiki. Agents learn the *names* from `dispatch prime` and fetch a
// value with `dispatch env get NAME` only when they need it.
export function EnvView({ api, hosts, onDone, onError, hostId = "" }: Props) {
  const [host, setHost] = useState("local");
  useEffect(() => { setHost(hostId || "local"); }, [hostId]);
  const blocked = hostReason(hosts, host);
  return (
    <div className="pit-wrap">
      <HostPicker locked fromSidebar={!!hostId} hosts={hosts} value={host} onChange={setHost} />
      <EnvKeys api={api} host={host} blocked={blocked} onDone={onDone} onError={onError} />
    </div>
  );
}

type KeysProps = { api: Api; host: string; blocked: string; onDone: (m: string) => void; onError: (m: string) => void; compact?: boolean };
export function EnvKeys(props: KeysProps) {
  // A machine change must also discard revealed values, open editors and searches.
  return <EnvKeyList key={props.host} {...props} />;
}

function EnvKeyList({ api, host, blocked, onDone, onError, compact }: KeysProps) {
  const t = useT();
  const [items, setItems] = useState<EnvVar[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [shown, setShown] = useState<Record<string, string>>({});
  const [editing, setEditing] = useState<{ name: string; note: string; project: string; isNew: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const [query, setQuery] = useState("");
  const [error, setError] = useState("");

  const load = async () => { if (blocked) { setItems([]); setLoaded(true); return; } setError(""); try { setItems(parseJson<EnvVar[]>(await api.on(host, ["env", "list", "--json"]), [])); } catch (e) { setError(String(e)); } finally { setLoaded(true); } };
  useEffect(() => { setShown({}); void load(); }, [api, host, blocked]);

  const reveal = async (name: string) => {
    if (shown[name] !== undefined) { const c = { ...shown }; delete c[name]; setShown(c); return; }
    try { const value = (await api.on(host, ["env", "get", name])).trimEnd(); setShown(old => ({ ...old, [name]: value })); } catch (e) { onError(String(e)); }
  };
  const copy = async (name: string) => {
    try { await api.copy((await api.on(host, ["env", "get", name])).trimEnd()); onDone(t("{name} 已复制", { name })); } catch (e) { onError(String(e)); }
  };
  // Deleting a key is not undoable (the value is gone): ask for a second click.
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);
  const remove = async (name: string) => {
    if (busy) return;
    if (pendingDelete !== name) { setPendingDelete(name); window.setTimeout(() => setPendingDelete((k) => (k === name ? null : k)), 4000); return; }
    setPendingDelete(null);
    setBusy(true);
    try { await api.on(host, ["env", "unset", name]); setShown({}); onDone(t("{name} 已删除", { name })); await load(); } catch (e) { onError(String(e)); } finally { setBusy(false); }
  };
  // A key with a project is listed to agents only inside that project and shown on its project page.
  const save = async (name: string, value: string, note: string, project: string) => {
    setBusy(true);
    try { await api.on(host, ["env", "set", name, "--stdin", "--note", note, "--project", project], value); setShown({}); setQuery(name); onDone(t("{name} 已保存", { name })); setEditing(null); await load(); } catch (e) { onError(String(e)); } finally { setBusy(false); }
  };
  const needle = query.trim().toLowerCase();
  const filtered = items.filter(v => `${v.name} ${v.note} ${v.project || ""}`.toLowerCase().includes(needle));

  return (
    <div className={compact ? "env-keys compact" : "env-keys"}>
      <div className="env-toolbar">
        <span className="muted small">{t("{n} 个", { n: needle ? `${filtered.length} / ${items.length}` : items.length })}</span>
        <span className="spacer" />
        <button className="btn sm" disabled={!!blocked || busy} onClick={() => setEditing({ name: "", note: "", project: "", isNew: true })}>{t("＋ 添加")}</button>
      </div>
      <label className="search env-search"><input aria-label={t("搜索密钥名称或用途")} placeholder={t("搜索名称、用途或项目…")} value={query} onChange={e => setQuery(e.target.value)} />{query && <button className="env-clear" aria-label={t("清空密钥搜索")} onClick={() => setQuery("")}>×</button>}</label>
      {!compact && <p className="pit-hint">{t("存在 ~/.config/dispatch/env（仅本人可读）。fish 新终端自动加载；Agent 在会话开始只看到变量名和用途，需要时 dispatch env get 名字 取值——不用你每次会话重贴 Key。不进任务板、不进知识库。")}</p>}
      {!loaded && <div className="empty">{t("载入中…")}</div>}
      {error && <div className="err">{error}<button className="btn sm" onClick={() => void load()}>{t("重新读取")}</button></div>}
      {blocked && <div className="empty">{blocked}</div>}
      {!blocked && !error && loaded && items.length === 0 && <div className="empty">{t("还没有密钥，点击「添加」保存。")}</div>}
      {!blocked && loaded && items.length > 0 && filtered.length === 0 && <div className="empty">{t("没有匹配的密钥")}<button className="btn sm" onClick={() => setQuery("")}>{t("清空搜索")}</button></div>}
      <div className="env-list">
        {filtered.map((v) => (
          <article key={v.name} className="env-item" aria-label={v.name}>
            <h4 className="mono">{v.name}{v.project && <span className="chip env-project" title={t("只属于这个项目：Agent 只在该项目的会话里看到它，项目页也会列出")}>{v.project}</span>}</h4>
            {v.note && <p className="env-note">{v.note}</p>}
            <div className="env-value mono">{shown[v.name] !== undefined ? shown[v.name] : v.masked}<span className="muted"> · {t("{n} 位", { n: v.length })}</span></div>
            <div className="env-actions">
              <button className="btn ghost sm" disabled={busy} aria-label={shown[v.name] !== undefined ? t("隐藏 {name}", { name: v.name }) : t("显示 {name}", { name: v.name })} onClick={() => reveal(v.name)}>{shown[v.name] !== undefined ? t("隐藏") : t("显示")}</button>
              <button className="btn ghost sm" disabled={busy} aria-label={t("复制 {name}", { name: v.name })} onClick={() => copy(v.name)}>{t("复制")}</button>
              <button className="btn ghost sm" disabled={busy} aria-label={t("编辑 {name}", { name: v.name })} onClick={() => setEditing({ name: v.name, note: v.note, project: v.project || "", isNew: false })}>{t("编辑")}</button>
              <details className="env-more"><summary aria-label={t("更多操作 {name}", { name: v.name })}>{t("更多")}</summary><div>
                <button className="btn ghost sm" disabled={busy} onClick={() => void api.copy(`dispatch env get ${v.name}`).then(() => onDone(t("取用命令已复制"))).catch(e => onError(String(e)))}>{t("复制取用命令")}</button>
                <button className="btn ghost sm danger" disabled={busy} onClick={() => remove(v.name)}>{pendingDelete === v.name ? t("再点一次确认删除（值找不回来）") : t("删除密钥")}</button>
              </div></details>
            </div>
          </article>
        ))}
      </div>
      {editing && <EnvDialog initial={editing} busy={busy} onCancel={() => setEditing(null)} onSave={save} />}
    </div>
  );
}

function EnvDialog({ initial, busy, onCancel, onSave }: { initial: { name: string; note: string; project: string; isNew: boolean }; busy: boolean; onCancel: () => void; onSave: (n: string, v: string, note: string, project: string) => Promise<void> }) {
  const t = useT();
  const [name, setName] = useState(initial.name);
  const [value, setValue] = useState("");
  const [note, setNote] = useState(initial.note);
  const [project, setProject] = useState(initial.project);
  const ok = !busy && /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) && value.trim().length > 0;
  return (
    <div className="overlay" onMouseDown={(e) => !busy && e.target === e.currentTarget && onCancel()}>
      <div className="dialog env-dialog" role="dialog" aria-modal="true" aria-label={t("环境变量")} onKeyDown={(e) => { if (e.key === "Escape" && !busy) onCancel(); if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && ok) onSave(name.trim(), value.trim(), note.trim(), project.trim()); }}>
        <h3>{initial.isNew ? t("添加变量") : t("改 {name} 的值", { name: initial.name })}</h3>
        <div className="row">
          <label>{t("变量名")}<input autoFocus={initial.isNew} value={name} disabled={!initial.isNew} onChange={(e) => setName(e.target.value.toUpperCase())} placeholder="ZHIPU_API_KEY" /></label>
          <label>{t("用途")}<input value={note} onChange={(e) => setNote(e.target.value)} placeholder={t("智谱 GLM（GetNewWord / bookmark 用）")} /></label>
        </div>
        <label>{t("项目（可空）")}<input value={project} onChange={(e) => setProject(e.target.value)} placeholder={t("留空＝所有项目都能用；填项目名＝只在该项目里出现")} /></label>
        <label>{t("值")}<textarea autoFocus={!initial.isNew} value={value} onChange={(e) => setValue(e.target.value)} placeholder={t("粘贴 Key")} spellCheck={false} /></label>
        <div className="foot">
          <button className="btn ghost" disabled={busy} onClick={onCancel}>{t("取消")}</button>
          <button className="btn primary" disabled={!ok} onClick={() => onSave(name.trim(), value.trim(), note.trim(), project.trim())}>{busy ? t("保存中…") : t("保存 ⌘⏎")}</button>
        </div>
      </div>
    </div>
  );
}
