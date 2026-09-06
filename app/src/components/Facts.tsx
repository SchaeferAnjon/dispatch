import { useCallback, useEffect, useState } from "react";
import type { Api } from "../api";
import type { Host } from "../types";
import { HostPicker, hostReason } from "./HostPicker";
import { Markdown } from "./Markdown";
import { EnvKeys } from "./Env";

interface Props { api: Api; hosts: Host[]; onDone: (m: string) => void; onError: (m: string) => void }
interface FactsDocMeta { key: string; name: string; path: string; dir: string; exists: boolean; hint: string }
interface FactsDoc { path: string; content: string; exists: boolean }

const short = (p: string) => p.replace(/^\/(Users|home)\/[^/]+/, "~");
const parseJson = <T,>(s: string, fallback: T): T => { try { const i = Math.min(...[s.indexOf("{"), s.indexOf("[")].filter((x) => x >= 0)); return JSON.parse(s.slice(i)); } catch { return fallback; } };

const GENERAL_TEMPLATE = `# 常用信息（跨项目通用）

> 只放多个项目都用得上的：机器、共用的云服务账号、各家 AI API 的用途、产品线、常说的话。
> 项目自己的服务器 / 发版 / 数据库细节写在那个项目目录的 AGENTS.md。
> **密钥值不写这里**——写 \`dispatch env set 名 值\`，这里只写名字和用途。

## 通用

- 机器：
- 共用云服务：
- AI 供应商与用途：
- 常说的话：
`;
const PROJECT_TEMPLATE = (name: string) => `# ${name} · 项目常用信息（Agent 在本目录都读这份）

> 只写本项目的事实；跨项目通用的在 \`dispatch facts show\`。密钥值在 \`dispatch env\` / 本机 .env 文件。

## 线上

- 域名：
- 服务器：
- 发版：

## 数据

- 数据库：
- 文件存储：

## 本地开发

- 启动：
- 验证：
`;

// The third tab of the instruction page. Two layers of facts: ~/.agents/rules/FACTS.md for
// what every project shares (machines, cloud accounts, which API key is for what — injected by
// `dispatch prime`), and each project's own AGENTS.md for its servers/deploy/database (read
// natively by every agent in that directory). Both are edited here; secrets stay in dispatch env.
export function FactsView({ api, hosts, onDone, onError }: Props) {
  const [host, setHost] = useState("local");
  const [docs, setDocs] = useState<FactsDocMeta[]>([]);
  const [selected, setSelected] = useState("通用");
  const [doc, setDoc] = useState<FactsDoc | null>(null);
  const [draft, setDraft] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [mobilePanel, setMobilePanel] = useState<"docs" | "keys">("docs");
  const blocked = hostReason(hosts, host);

  const meta = docs.find((d) => d.key === selected);
  const loadDocs = useCallback(async () => {
    if (blocked) return;
    setBusy(true); setError("");
    try { setDocs(parseJson<FactsDocMeta[]>(await api.on(host, ["facts", "docs", "--json"]), [])); }
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
    <div className="instruction-top"><HostPicker hosts={hosts} value={host} onChange={(h) => { if (!busy) setHost(h); }} /><span className="spacer" /><button className="btn sm" disabled={busy} onClick={() => { void loadDocs(); void load(); }}>重新读取</button></div>
    {blocked || error ? <div className="err">{blocked || error}</div> : null}
    <div className="facts-mobile-tabs views" role="tablist" aria-label="常用信息内容"><button role="tab" aria-selected={mobilePanel === "docs"} onClick={() => setMobilePanel("docs")}>文档</button><button role="tab" aria-selected={mobilePanel === "keys"} onClick={() => setMobilePanel("keys")}>密钥</button></div>
    <div className={`instruction-grid facts-grid mobile-${mobilePanel}`}>
      <aside className="instruction-docs facts-sidebar"><h3 className="facts-doc-label">文档 <span className="muted">{docs.length}</span></h3>
        {docs.map((d) => <button key={d.key} className={`facts-doc-link${selected === d.key ? " on" : ""}`} disabled={busy || draft !== null} onClick={() => setSelected(d.key)}><b>{d.name}</b><span>{d.exists ? d.hint : "尚未创建"}</span></button>)}
        <p className="small muted facts-doc-hint">选择项目，查看它的 <code>AGENTS.md</code>。</p>
        <div className="facts-keys">
          <h3>密钥</h3>
          <p className="small muted">保存在当前机器。可按名称或用途查找。</p>
          <EnvKeys api={api} host={host} blocked={blocked} onDone={onDone} onError={onError} compact />
        </div>
      </aside>
      <div className="instruction-detail">
        <header><div><h3>{meta?.name || "常用信息"}</h3><div className="muted mono small">{doc ? short(doc.path) : "…"}{doc && !doc.exists ? " · 尚未创建" : ""}</div></div><span className="spacer" />
          {draft === null
            ? <button className="btn primary sm" disabled={busy || !doc || !meta} onClick={() => setDraft(doc?.content || (meta?.key === "通用" ? GENERAL_TEMPLATE : PROJECT_TEMPLATE(meta?.name || "")))}>编辑</button>
            : <><button className="btn sm" disabled={busy} onClick={() => setDraft(null)}>取消</button><button className="btn primary sm" disabled={busy} onClick={() => void save()}>保存</button></>}
        </header>
        <p className="small muted">{meta?.key === "通用"
          ? <>跨项目通用的：机器、共用的云服务账号、各家 API 的用途、常说的话。每个会话开始由 <code>dispatch prime</code> 注入。</>
          : <>只写这个项目的事实：服务器、发版、数据库、本地开发。Agent 在该目录工作时自己会读 <code>AGENTS.md</code>，不占其他项目的上下文。文件在 git 里，改完记得 commit。</>}
          密钥值不放文档里，用左栏的密钥列。</p>
        {draft === null
          ? <div className="instruction-content facts-content">{doc?.content ? <Markdown src={doc.content} /> : <span className="muted">尚未创建，点「编辑」用模板开始。</span>}</div>
          : <textarea aria-label="常用信息草稿" className="instruction-editor" spellCheck={false} value={draft} onChange={(e) => setDraft(e.target.value)} />}
      </div>
    </div>
  </div>;
}
