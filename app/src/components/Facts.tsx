import { useCallback, useEffect, useState } from "react";
import type { Api } from "../api";
import { isTauri } from "../api";
import type { Host } from "../types";
import { HostPicker, hostReason } from "./HostPicker";
import { Markdown } from "./Markdown";
import { EnvKeys } from "./Env";

interface Props { api: Api; hosts: Host[]; hostId?: string; onDone: (m: string) => void; onError: (m: string) => void }
interface FactsDocMeta { key: string; name: string; path: string; dir: string; exists: boolean; hint: string }
interface FactsDoc { path: string; content: string; exists: boolean }
interface Vault { id: string; name: string; path: string; exists: boolean; open: boolean }

const short = (p: string) => p.replace(/^\/(Users|home)\/[^/]+/, "~");
const parseJson = <T,>(s: string, fallback: T): T => { try { const i = Math.min(...[s.indexOf("{"), s.indexOf("[")].filter((x) => x >= 0)); return JSON.parse(s.slice(i)); } catch { return fallback; } };

const GENERAL_TEMPLATE = `# 服务器与数据库

> 记录机器、云服务、数据库和账号用途。密码、Token 和 API Key 在「密钥与 API」中管理。
> Agent 的行为规则和项目指令在「Agent 规则」中管理。

## 通用

### 服务器

- 名称与用途：
- 地址：
- 关联密钥名称：

### 数据库

- 名称与用途：
- 连接地址：
- 关联密钥名称：

### 常用资料

- 资料位置：
`;

// Resources use the existing facts document; project instructions live in Agent rules.
export function FactsView({ api, hosts, onDone, onError, hostId = "" }: Props) {
  const [host, setHost] = useState("local");
  useEffect(() => { setHost(hostId || "local"); }, [hostId]);
  const [docs, setDocs] = useState<FactsDocMeta[]>([]);
  const [selected, setSelected] = useState("通用");
  const [doc, setDoc] = useState<FactsDoc | null>(null);
  const [draft, setDraft] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [panel, setPanel] = useState<"docs" | "keys" | "vaults">("keys");
  const [vaults, setVaults] = useState<Vault[]>([]);
  const [keysRevision, setKeysRevision] = useState(0);
  const blocked = hostReason(hosts, host);

  const meta = docs.find((d) => d.key === selected);
  const loadDocs = useCallback(async () => {
    if (blocked) return;
    setBusy(true); setError("");
    try { const [d,v]=await Promise.all([api.on(host, ["facts", "docs", "--json"]),api.on(host,['facts','vaults','--json'])]);setDocs(parseJson<FactsDocMeta[]>(d, []).filter(x=>x.key==='通用'));setVaults(parseJson<Vault[]>(v,[])); }
    catch (e) { setError(String(e)); } finally { setBusy(false); }
  }, [api, host, blocked]);
  useEffect(() => { setDocs([]); setDoc(null); setDraft(null); setSelected("通用"); void loadDocs(); }, [loadDocs]);
  const load = useCallback(async () => {
    if (blocked || !meta) return;
    setBusy(true); setError("");
    try { setDoc(parseJson<FactsDoc>(await api.on(host, ["facts", "show", "--path", meta.path, "--json"]), { path: meta.path, content: "", exists: false })); }
    catch (e) { setError(String(e)); } finally { setBusy(false); }
  }, [api, host, blocked, meta]);
  useEffect(() => { setDoc(null); setDraft(null); void load(); }, [load]);

  const save = async () => {
    if (draft === null) return;
    setBusy(true);
    if (!meta) return;
    try { await api.on(host, ["facts", "write", "--path", meta.path], draft); setDraft(null); onDone(meta.key === "通用" ? "已保存；新开的会话会带上" : `已保存到 ${short(meta.path)}（记得 commit）`); await loadDocs(); await load(); }
    catch (e) { onError(String(e)); } finally { setBusy(false); }
  };

  return <div className="instruction-center">
    <div className="instruction-top"><HostPicker locked fromSidebar={!!hostId} hosts={hosts} value={host} onChange={(h) => { if (!busy && draft === null) setHost(h); }} /><span className="spacer" /><button className="btn sm" disabled={busy || draft !== null} onClick={() => { if (panel === "keys") setKeysRevision(n => n + 1); else { void loadDocs(); void load(); } }}>重新读取</button></div>
    {blocked || error ? <div className="err">{blocked || error}</div> : null}
    <div className="facts-mobile-tabs views" role="tablist" aria-label="常用资料分类"><button role="tab" disabled={draft!==null} aria-selected={panel === "keys"} onClick={() => setPanel("keys")}>密钥/API</button><button role="tab" disabled={draft!==null} aria-selected={panel === "docs"} onClick={() => setPanel("docs")}>服务器/数据库</button><button role="tab" disabled={draft!==null} aria-selected={panel === "vaults"} onClick={() => setPanel("vaults")}>Obsidian</button></div>
    <div className={`instruction-grid facts-grid mobile-${panel}`}>
      <aside className="instruction-docs facts-sidebar">
        <button className={`facts-keys-link${panel === "keys" ? " on" : ""}`} disabled={draft!==null} onClick={() => setPanel("keys")}><b>密钥与 API</b><span>Token、密码、API Key 与用途</span></button>
        <button className={panel === 'docs' ? 'on' : ''} disabled={draft!==null} onClick={() => {setSelected('通用');setPanel('docs');}}><b>服务器与数据库</b><span>机器、云服务、连接信息与个人资料</span></button>
        <button className={panel === 'vaults' ? 'on' : ''} disabled={draft!==null} onClick={() => setPanel('vaults')}><b>Obsidian 资料库</b><span>你的笔记和个人知识库</span></button>
      </aside>
      <div className="instruction-detail">
        {panel === "keys" ? <section className="facts-key-content" aria-label="密钥管理">
          <header><h3>密钥与 API</h3><p className="small muted">{hosts.find(h => h.id === host)?.name || "当前机器"} · 按名称或用途搜索，查看和修改都在这里。</p></header>
          <EnvKeys key={keysRevision} api={api} host={host} blocked={blocked} onDone={onDone} onError={onError} compact />
        </section> : panel === 'vaults' ? <section className="vaults-content"><h3>Obsidian 资料库</h3><p className="small muted">笔记在 Obsidian 中编辑。这里列出所选电脑的资料库；打开时使用当前设备的 Obsidian。</p>{vaults.length ? vaults.map(v=><article className="vault-card" key={v.id}><h4>{v.name}</h4><p className="mono small muted">{short(v.path)}</p><div><a className="btn sm" href={`obsidian://open?vault=${encodeURIComponent(v.name)}`} onClick={e=>{if(isTauri){e.preventDefault();void api.openPath(`obsidian://open?vault=${encodeURIComponent(v.name)}`).catch(err=>onError(String(err)));}}}>在 Obsidian 打开</a><button className="btn sm" onClick={()=>api.copy(v.path).then(()=>onDone('资料库路径已复制')).catch(e=>onError(String(e)))}>复制路径</button></div>{!v.exists&&<p className="small muted">当前机器暂时无法访问这个目录</p>}</article>):<p className="empty">尚未检测到资料库。先在这台电脑的 Obsidian 中打开你的资料库，再点“重新读取”。</p>}</section> : <>
        <header><div><h3>服务器与数据库</h3><div className="muted mono small">{doc ? short(doc.path) : "…"}{doc && !doc.exists ? " · 尚未创建" : ""}</div></div><span className="spacer" />
          {draft === null
            ? <button className="btn primary sm" disabled={busy || !doc || !meta} onClick={() => setDraft(doc?.content || GENERAL_TEMPLATE)}>编辑</button>
            : <><button className="btn sm" disabled={busy} onClick={() => setDraft(null)}>取消</button><button className="btn primary sm" disabled={busy} onClick={() => void save()}>保存</button></>}
        </header>
        <p className="small muted">记录服务器、数据库、账号用途和常用资料；密码与 Token 在左侧“密钥与 API”管理。Agent 的行为要求和项目文档在“Agent 规则”。</p>
        {draft === null
          ? <div className="instruction-content facts-content">{doc?.content ? <Markdown src={doc.content} /> : <span className="muted">尚未创建，点「编辑」用模板开始。</span>}</div>
          : <textarea aria-label="常用信息草稿" className="instruction-editor" spellCheck={false} value={draft} onChange={(e) => setDraft(e.target.value)} />}
        </>}
      </div>
    </div>
  </div>;
}
