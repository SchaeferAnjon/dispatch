import { useCallback, useEffect, useState } from "react";
import type { Api } from "../api";
import type { Host } from "../types";
import { HostPicker, hostReason } from "./HostPicker";
import { Markdown } from "./Markdown";
import { EnvKeys } from "./Env";

interface Props { api: Api; hosts: Host[]; onDone: (m: string) => void; onError: (m: string) => void }
interface Section { heading: string; key: string; lines: number }
interface FactsDoc { path: string; content: string; exists: boolean }

const short = (p: string) => p.replace(/^\/(Users|home)\/[^/]+/, "~");
const parseJson = <T,>(s: string, fallback: T): T => { try { const i = Math.min(...[s.indexOf("{"), s.indexOf("[")].filter((x) => x >= 0)); return JSON.parse(s.slice(i)); } catch { return fallback; } };

const TEMPLATE = `# 常用信息（FACTS.md）

> 服务器、域名、数据库、各家 API 的名字和用途、我在多个会话里反复说的话。
> **密钥值不写这里**——写 \`dispatch env set 名 值\`，这里只写名字和用途。
> \`## 通用\` 每个会话都注入；\`## <项目名>\` 只在该项目目录里的会话注入（项目名＝板上 project 标签，不分大小写）。

## 通用

- （所有项目都用得上的：机器、账号约定、常说的话）

## <项目名>

- 服务器：
- 域名：
- 数据库：
- API：
- 常用命令：
`;

// The third tab of the instruction page: one markdown file (~/.agents/rules/FACTS.md) per Mac
// holding the facts the user keeps repeating — servers, domains, databases, which API key is
// for what. `dispatch prime` injects the general section plus the current project's section.
export function FactsView({ api, hosts, onDone, onError }: Props) {
  const [host, setHost] = useState("local");
  const [doc, setDoc] = useState<FactsDoc | null>(null);
  const [sections, setSections] = useState<Section[]>([]);
  const [draft, setDraft] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const blocked = hostReason(hosts, host);

  const load = useCallback(async () => {
    if (blocked) return;
    setBusy(true); setError("");
    try {
      const d = parseJson<FactsDoc>(await api.on(host, ["facts", "show", "--json"]), { path: "", content: "", exists: false });
      setDoc(d);
      setSections(parseJson<Section[]>(await api.on(host, ["facts", "sections", "--json"]), []));
    } catch (e) { setError(String(e)); } finally { setBusy(false); }
  }, [api, host, blocked]);
  useEffect(() => { setDoc(null); setDraft(null); void load(); }, [load]);

  const save = async () => {
    if (draft === null) return;
    setBusy(true);
    try { await api.on(host, ["facts", "write"], draft); setDraft(null); onDone("常用信息已保存；新开的会话会带上"); await load(); }
    catch (e) { onError(String(e)); } finally { setBusy(false); }
  };
  const jump = (heading: string) => { const el = document.getElementById(`facts-${heading}`); el?.scrollIntoView({ behavior: "smooth", block: "start" }); };

  return <div className="instruction-center">
    <div className="instruction-top"><HostPicker hosts={hosts} value={host} onChange={(h) => { if (!busy) setHost(h); }} /><span className="spacer" /><button className="btn sm" disabled={busy} onClick={() => void load()}>重新读取</button></div>
    {blocked || error ? <div className="err">{blocked || error}</div> : null}
    <div className="instruction-grid facts-grid">
      <aside className="instruction-docs"><h3>节 <span className="muted">{sections.length}</span></h3>
        {sections.map((s) => <button key={s.heading} disabled={busy || draft !== null} onClick={() => jump(s.heading)}><b>{s.heading}</b><span>{s.key === "通用" || s.key === "general" ? "每个会话都注入" : `只注入 ${s.key} 项目的会话`} · {s.lines} 行</span></button>)}
        {sections.length === 0 && <p className="small muted">还没有任何节。点「编辑」，用 <code>## 通用</code> 和 <code>## 项目名</code> 分节。</p>}
      </aside>
      <div className="instruction-detail">
        <header><div><h3>常用信息</h3><div className="muted mono small">{doc ? short(doc.path) : "…"}{doc && !doc.exists ? " · 尚未创建" : ""}</div></div><span className="spacer" />
          {draft === null
            ? <button className="btn primary sm" disabled={busy || !doc} onClick={() => setDraft(doc?.content || TEMPLATE)}>编辑</button>
            : <><button className="btn sm" disabled={busy} onClick={() => setDraft(null)}>取消</button><button className="btn primary sm" disabled={busy} onClick={() => void save()}>保存</button></>}
        </header>
        <p className="small muted">服务器、域名、数据库、各家 API 的名字和用途、你常在会话里重复的话。密钥值不放这里（用「环境」页 / <code>dispatch env</code>），这里只写名字。<code>## 通用</code> 每个会话都带上；<code>## 项目名</code> 只在该项目的会话里带上（<code>dispatch prime</code> 注入）。</p>
        {draft === null
          ? <div className="instruction-content facts-content">{doc?.content ? <Markdown src={withAnchors(doc.content)} /> : <span className="muted">尚未创建，点「编辑」用模板开始。</span>}</div>
          : <textarea aria-label="常用信息草稿" className="instruction-editor" spellCheck={false} value={draft} onChange={(e) => setDraft(e.target.value)} />}
      </div>
      <aside className="facts-keys">
        <h3>密钥 <span className="muted">dispatch env</span></h3>
        <p className="small muted">这台机器的 Key（<code>~/.config/dispatch/env</code>）。左边文档只写名字和用途，值在这里改；Agent 用 <code>dispatch env get 名</code> 取。</p>
        <EnvKeys api={api} host={host} blocked={blocked} onDone={onDone} onError={onError} compact />
      </aside>
    </div>
  </div>;
}

// Give each `## heading` an id so the side list can scroll to it. Markdown renderers keep raw
// HTML anchors, and an empty <a id> costs nothing when they don't.
function withAnchors(md: string): string {
  return md.replace(/^## (.+)$/gm, (_m, h: string) => `<a id="facts-${h.trim()}"></a>\n## ${h}`);
}
