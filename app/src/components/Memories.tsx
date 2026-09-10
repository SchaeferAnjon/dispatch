import { useCallback, useEffect, useMemo, useState } from "react";
import type { Api } from "../api";
import type { Host } from "../types";
import { HostPicker, hostReason } from "./HostPicker";
import { Markdown } from "./Markdown";

interface Props { api: Api; hosts: Host[]; hostId?: string; onDone: (m: string) => void; onError: (m: string) => void }
interface MemoryFile { agent: string; project: string; path: string; name: string; index: boolean; size: number; mtime: number }
interface MemoryDoc extends MemoryFile { content: string }

const AGENT_LABEL: Record<string, string> = { "claude-code": "Claude Code", codex: "Codex", zcode: "ZCode / OpenCode" };
const AGENT_HINT: Record<string, string> = {
  "claude-code": "~/.claude/projects/<目录>/memory/ · 按工作目录各一份，MEMORY.md 是索引",
  codex: "~/.codex/memories/raw_memories.md · 单文件，不分项目",
  zcode: "~/.zcode/cli/memories/projects/<项目>/memory/ · 按项目分，MEMORY.md 是索引",
};
const short = (p: string) => p.replace(/^\/(Users|home)\/[^/]+/, "~");
const parseJson = <T,>(s: string, fallback: T): T => { try { const i = Math.min(...[s.indexOf("{"), s.indexOf("[")].filter((x) => x >= 0)); return JSON.parse(s.slice(i)); } catch { return fallback; } };
const projectLabel = (p: string) => { const seg = p.split("/").filter((x) => x && x !== "…"); return seg.length > 3 ? "…/" + seg.slice(-2).join("/") : p; };
const splitFront = (src: string) => { const m = /^---\n([\s\S]*?)\n---\n?/.exec(src); if (!m) return { meta: {} as Record<string, string>, body: src }; const meta: Record<string, string> = {}; for (const line of m[1].split("\n")) { const kv = /^\s*([\w-]+):\s*(.+)$/.exec(line); if (kv) meta[kv[1]] = kv[2].trim(); } return { meta, body: src.slice(m[0].length) }; };
const fmtSize = (n: number) => n < 1024 ? `${n} B` : `${(n / 1024).toFixed(1)} KB`;
const fmtTime = (t: number) => { const d = new Date(t * 1000); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`; };

// Each agent keeps its own long-term memory on disk; this page only reads them.
export function MemoriesView({ api, hosts, onDone, onError, hostId = "" }: Props) {
  const [host, setHost] = useState("local");
  useEffect(() => { setHost(hostId || "local"); }, [hostId]);
  const [files, setFiles] = useState<MemoryFile[]>([]);
  const [selected, setSelected] = useState("");
  const [doc, setDoc] = useState<MemoryDoc | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [openProjects, setOpenProjects] = useState<Record<string, boolean>>({});
  const blocked = hostReason(hosts, host);

  const loadList = useCallback(async () => {
    if (blocked) return;
    setBusy(true); setError("");
    try { setFiles(parseJson<MemoryFile[]>(await api.on(host, ["memories", "list", "--json"]), [])); }
    catch (e) { setError(String(e)); } finally { setBusy(false); }
  }, [api, host, blocked]);
  useEffect(() => { setFiles([]); setDoc(null); setSelected(""); void loadList(); }, [loadList]);

  useEffect(() => {
    if (blocked || !selected) { setDoc(null); return; }
    let live = true;
    setBusy(true); setError("");
    api.on(host, ["memories", "show", "--path", selected, "--json"])
      .then((s) => { if (live) setDoc(parseJson<MemoryDoc | null>(s, null)); })
      .catch((e) => { if (live) setError(String(e)); })
      .finally(() => { if (live) setBusy(false); });
    return () => { live = false; };
  }, [api, host, blocked, selected]);

  const q = query.trim().toLowerCase();
  const groups = useMemo(() => {
    const byAgent = new Map<string, Map<string, MemoryFile[]>>();
    for (const f of files) {
      if (q && !`${f.project} ${f.name}`.toLowerCase().includes(q)) continue;
      const projects = byAgent.get(f.agent) ?? new Map<string, MemoryFile[]>();
      projects.set(f.project, [...(projects.get(f.project) ?? []), f]);
      byAgent.set(f.agent, projects);
    }
    return [...byAgent.entries()];
  }, [files, q]);
  const projectKey = (agent: string, project: string) => `${agent}|${project}`;
  const isOpen = (agent: string, project: string, n: number) => !!q || n <= 3 || openProjects[projectKey(agent, project)] === true || (openProjects[projectKey(agent, project)] === undefined && files.some((f) => f.path === selected && f.agent === agent && f.project === project));

  return <div className="instruction-center">
    <div className="instruction-top"><HostPicker locked fromSidebar={!!hostId} hosts={hosts} value={host} onChange={(h) => { if (!busy) setHost(h); }} /><input className="memories-search" type="search" placeholder="按目录或文件名筛选" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="筛选记忆文件" /><span className="spacer" /><button className="btn sm" disabled={busy} onClick={() => void loadList()}>重新读取</button></div>
    {blocked || error ? <div className="err">{blocked || error}</div> : null}
    <div className="instruction-grid memories-grid">
      <aside className="instruction-docs memories-list">
        <h3>Agent 记忆 <span className="muted">{files.length || "…"}</span></h3>
        {groups.map(([agent, projects]) => <section key={agent} className="memories-agent">
          <h4>{AGENT_LABEL[agent] ?? agent} <span className="muted">{[...projects.values()].reduce((n, l) => n + l.length, 0)}</span></h4>
          {[...projects.entries()].map(([project, list]) => {
            const open = isOpen(agent, project, list.length);
            return <div key={project} className="memories-project">
              <button className="memories-project-head" onClick={() => setOpenProjects((o) => ({ ...o, [projectKey(agent, project)]: !open }))} aria-expanded={open}><span className="memories-caret">{open ? "▾" : "▸"}</span><b title={project}>{projectLabel(project)}</b><span className="muted">{list.length}</span></button>
              {open && list.map((f) => <button key={f.path} className={`memories-file${selected === f.path ? " on" : ""}`} onClick={() => setSelected(f.path)} disabled={busy && selected !== f.path}><span>{f.index ? "索引 · " : ""}{f.name.replace(/\.md$/, "")}</span><small>{fmtSize(f.size)} · {fmtTime(f.mtime)}</small></button>)}
            </div>;
          })}
        </section>)}
        {!busy && files.length === 0 && !error && <p className="muted small">这台机器上没找到任何 Agent 的记忆文件。</p>}
        {files.length > 0 && groups.length === 0 && <p className="muted small">没有匹配「{query}」的文件。</p>}
      </aside>
      <div className="instruction-detail">
        {doc ? <>
          <header><div><h3>{doc.name}</h3><div className="muted mono small">{short(doc.path)} · {fmtSize(doc.size)} · {fmtTime(doc.mtime)}</div></div><span className="spacer" />
            <button className="btn sm" onClick={() => api.copy(doc.path).then(() => onDone("路径已复制")).catch((e) => onError(String(e)))}>复制路径</button>
            <button className="btn sm" onClick={() => api.openPath(doc.path).catch((e) => onError(String(e)))}>用默认应用打开</button>
          </header>
          {(() => { const { meta, body } = splitFront(doc.content); return <>
            {meta.description && <p className="memories-desc">{meta.description}{meta.type ? <span className="muted"> · {meta.type}</span> : null}</p>}
            <p className="small muted">{AGENT_LABEL[doc.agent] ?? doc.agent} 在「{doc.project}」目录里自己写的记忆；改它请让那个 Agent 自己改。跨项目、所有 Agent 都该知道的事放「常用资料」。</p>
            <div className="instruction-content facts-content memories-content"><Markdown src={body} /></div>
          </>; })()}
        </> : <>
          <header><div><h3>Agent 记忆</h3><div className="muted small">各 Agent 跨会话自己积累的记忆，只读。</div></div></header>
          <div className="memories-intro">
            {Object.entries(AGENT_LABEL).map(([k, v]) => <p key={k} className="small"><b>{v}</b><span className="muted mono"> {AGENT_HINT[k]}</span></p>)}
            <p className="small muted">pi、Gemini CLI 没有跨会话记忆，只有会话记录和 AGENTS.md / GEMINI.md，所以不在这里。</p>
            <p className="small muted">左侧选一个文件查看。想把某段记忆变成所有 Agent 共享的事实，用 <code>dispatch facts import</code> 抽出来核对后进「常用资料」。</p>
          </div>
        </>}
      </div>
    </div>
  </div>;
}
