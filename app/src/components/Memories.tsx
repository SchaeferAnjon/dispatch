import { confirmAction } from '../confirm';
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import type { Api } from "../api";
import type { Host } from "../types";
import { hostReason } from "./HostPicker";
import { Markdown } from "./Markdown";
import { useLocale, useT, intlLocale } from "../i18n";
import { EmptyView, ListDetail, Meta, Row, Section, Sep, Tabs, Tag, useListKeyboard } from "./primitives";
import { About, DetailHead, DetailSection, SearchField, hostName, revealDetail } from "./PageParts";
import { useShellHeader } from "./Shell";
import { Icon } from "./icons";
import { tildePath } from "../activity";

interface Props { api: Api; hosts: Host[]; hostId?: string; onDone: (m: string) => void; onError: (m: string) => void }
interface MemoryEntry {
  id: string; agent: string; project: string; project_dir: string; expired: boolean;
  path: string; name: string; description: string; type: string; index: boolean;
  size: number; mtime: number; body: string;
}
interface MemorySummary {
  at: number; model: string; cached: boolean; fingerprint: string;
  overall: string; projects: Record<string, string>;
}
type Sel = { kind: "entry"; path: string } | { kind: "project"; agent: string; project: string } | null;

const AGENT_LABEL: Record<string, string> = { "claude-code": "Claude Code", codex: "Codex", zcode: "ZCode", hermes: "Hermes" };
const short = tildePath;
const parseJson = <T,>(s: string, fallback: T): T => { try { const i = Math.min(...[s.indexOf("{"), s.indexOf("[")].filter((x) => x >= 0)); return JSON.parse(s.slice(i)); } catch { return fallback; } };
const fmtSize = (n: number) => n < 1024 ? `${n} B` : `${(n / 1024).toFixed(1)} KB`;
const fmtTime = (t: number) => { const d = new Date(t * 1000); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`; };
const cleanName = (n: string) => n.replace(/\.md$/, "");
const isGeneral = (p: string) => p === "通用" || p === "全局";
const projectKey = (agent: string, project: string) => `${agent}|${project}`;
const agentRank = (a: string) => { const i = Object.keys(AGENT_LABEL).indexOf(a); return i < 0 ? 99 : i; };
const norm = (r: Partial<MemoryEntry>): MemoryEntry => ({
  id: r.id ?? r.path ?? "", agent: r.agent ?? "", project: r.project ?? "通用", project_dir: r.project_dir ?? "",
  expired: Boolean(r.expired), path: r.path ?? "", name: r.name ?? "", description: r.description ?? "",
  type: r.type ?? "", index: Boolean(r.index), size: r.size ?? 0, mtime: r.mtime ?? 0, body: r.body ?? "",
});

// Each agent keeps its own long-term memory on disk; this page only reads them.
export function MemoriesView({ api, hosts, onDone, onError, hostId = "" }: Props) {
  const t = useT();
  const [host, setHost] = useState("local");
  useEffect(() => { setHost(hostId || "local"); }, [hostId]);
  const [files, setFiles] = useState<MemoryEntry[]>([]);
  const [summary, setSummary] = useState<MemorySummary | null>(null);
  const [sel, setSel] = useState<Sel>(null);
  const [busy, setBusy] = useState(false);
  const [summaryBusy, setSummaryBusy] = useState(false);
  const [summaryFailed, setSummaryFailed] = useState(false);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [openProjects, setOpenProjects] = useState<Record<string, boolean>>({});
  const blocked = hostReason(hosts, host);

  const loadList = useCallback(async () => {
    if (blocked) return;
    setBusy(true); setError("");
    try { setFiles(parseJson<Partial<MemoryEntry>[]>(await api.on(host, ["memories", "list", "--json"]), []).map(norm)); }
    catch (e) { setError(String(e)); } finally { setBusy(false); }
  }, [api, host, blocked]);

  const loadSummary = useCallback(async (force = false) => {
    if (blocked) return;
    setSummaryBusy(true); setSummaryFailed(false);
    try {
      const args = force ? ["memories", "summary", "--force", "--json"] : ["memories", "summary", "--json"];
      const raw = parseJson<MemorySummary | null>(await api.on(host, args), null);
      const s = raw && !Array.isArray(raw) && typeof raw.overall === "string" ? raw : null;
      setSummary(s);
      if (!s) setSummaryFailed(true);
    } catch { setSummaryFailed(true); }
    finally { setSummaryBusy(false); }
  }, [api, host, blocked]);

  useEffect(() => { setFiles([]); setSummary(null); setSel(null); setSummaryFailed(false); void loadList(); void loadSummary(false); }, [loadList, loadSummary]);

  const q = query.trim().toLowerCase();
  const groups = useMemo(() => {
    const byAgent = new Map<string, Map<string, MemoryEntry[]>>();
    for (const f of files) {
      if (q && !`${f.project} ${f.description} ${f.name}`.toLowerCase().includes(q)) continue;
      const projects = byAgent.get(f.agent) ?? new Map<string, MemoryEntry[]>();
      projects.set(f.project, [...(projects.get(f.project) ?? []), f]);
      byAgent.set(f.agent, projects);
    }
    return [...byAgent.entries()]
      .sort((a, b) => agentRank(a[0]) - agentRank(b[0]))
      .map(([agent, projects]) => [agent, [...projects.entries()].sort((a, b) => {
        const ga = isGeneral(a[0]) ? 1 : 0, gb = isGeneral(b[0]) ? 1 : 0;
        return ga !== gb ? ga - gb : a[0].localeCompare(b[0], intlLocale());
      })] as [string, [string, MemoryEntry[]][]]);
  }, [files, q]);

  const selectedPath = sel?.kind === "entry" ? sel.path : "";
  const selectedEntry = useMemo(() => (sel?.kind === "entry" ? files.find((f) => f.path === sel.path) ?? null : null), [files, sel]);
  const isOpen = (agent: string, project: string, list: MemoryEntry[]) => {
    if (q) return true;
    const k = projectKey(agent, project);
    if (openProjects[k] === true) return true;
    if (openProjects[k] === false) return false;
    if (sel?.kind === "project" && sel.agent === agent && sel.project === project) return true;
    return list.length <= 3 || list.some((f) => f.path === selectedPath);
  };

  const selectEntry = (e: MemoryEntry) => {
    setSel({ kind: "entry", path: e.path });
    const k = projectKey(e.agent, e.project);
    setOpenProjects((o) => (o[k] === undefined ? o : { ...o, [k]: true }));
  };
  const archive = async (e: MemoryEntry) => {
    const label = e.description || cleanName(e.name);
    setBusy(true);
    try {
      if (!await confirmAction(t("归档「{label}」？文件会移到同目录的 archived/ 文件夹，不再出现在这里。", { label }))) return;
      await api.on(host, ["memories", "archive", "--path", e.path, "--json"]); onDone(t("已归档")); await loadList();
    }
    catch (err) { onError(String(err)); } finally { setBusy(false); }
  };
  const promote = async (e: MemoryEntry) => {
    const text = (e.description || cleanName(e.name)).trim();
    if (!text) return;
    setBusy(true);
    try { await api.on(host, ["profile", "add", text]); onDone(t("已归入「关于我」")); }
    catch (err) { onError(String(err)); } finally { setBusy(false); }
  };

  const entryDetail = (e: MemoryEntry) => {
    const text = (e.description || cleanName(e.name)).trim();
    return <>
      <DetailHead crumb={[AGENT_LABEL[e.agent] ?? e.agent, e.project]} title={e.description || cleanName(e.name)}
        tag={e.expired ? <Tag color="orange">{t("过期")}</Tag> : e.index ? <Tag>{t("索引")}</Tag> : undefined}
        actions={<>
          {text ? <button className="btn sm" disabled={busy} onClick={() => void promote(e)} title={t("把这句话追加到「关于我」，之后所有 Agent 都会看到")}>{t("归入关于我")}</button> : null}
          <button className="btn sm ghost" disabled={busy} onClick={() => api.openPath(e.path).catch((err) => onError(String(err)))}>{t("用默认应用打开")}</button>
          <button className="btn sm ghost" disabled={busy} onClick={() => api.copy(e.path).then(() => onDone(t("路径已复制"))).catch((err) => onError(String(err)))}>{t("复制路径")}</button>
          {e.expired ? <button className="btn sm ghost" disabled={busy} onClick={() => void archive(e)} title={t("移到 archived/ 文件夹")}>{t("归档")}</button> : null}
        </>} />
      <Meta rows={[
        [t("文件"), <span className="mono">{e.name}</span>],
        ...(e.type ? [[t("类型"), e.type] as [ReactNode, ReactNode]] : []),
        [t("大小"), <span className="num">{fmtSize(e.size)} · {fmtTime(e.mtime)}</span>],
        [t("位置"), <span className="mono sel-text">{short(e.path)}</span>],
      ]} />
      {e.expired ? <p className="akd-note">{t("项目目录已不存在")}</p> : null}
      {e.index ? <p className="akd-note">{t("这是本项目的索引文件，列出的条目就是下面这些记忆。")}</p> : null}
      <Sep />
      <div className="akd-md">{e.body ? <Markdown src={e.body} /> : <p className="akd-note">{t("这个文件是空的。")}</p>}</div>
    </>;
  };

  const overview = () => {
    const entries = Object.entries(summary?.projects ?? {});
    return <>
      <DetailHead crumb={[t("Agent 记忆")]} title={t("Agent 记忆总览")}
        actions={<button className="btn sm" disabled={summaryBusy || busy || !!blocked} onClick={() => void loadSummary(true)}>{summaryBusy ? t("正在总结…") : t("重新总结")}</button>} />
      <p className="akd-note">{summary ? t("{model} 总结于 {at}", { model: summary.model || t("模型"), at: summary.at ? fmtTime(summary.at) : "?" }) + (summary.cached ? t("（缓存）") : "") : t("各 Agent 跨会话自己积累的记忆，按项目分组，只读。")}</p>
      {summaryBusy && !summary ? <p className="akd-note">{t("正在总结各项目的记忆，第一次可能要等半分钟…")}</p> : null}
      {summary ? <>
        <Sep />
        <div className="akd-md"><Markdown src={summary.overall || t("暂无总览。")} /></div>
        {entries.length > 0 ? <><Sep /><DetailSection title={t("各项目一句话")} count={entries.length}>
          {entries.map(([key, sentence]) => { const i = key.indexOf("|"); const a = i < 0 ? "" : key.slice(0, i); const p = i < 0 ? key : key.slice(i + 1); return <div key={key} className="ak-line"><b>{p}{a && a !== "codex" ? <span className="s"> · {AGENT_LABEL[a] ?? a}</span> : null}</b><p>{sentence}</p></div>; })}
        </DetailSection></> : null}
      </> : !summaryBusy ? <p className="akd-note">{summaryFailed ? t("暂时取不到总览，点「重新总结」再试；左侧的记忆仍然可以直接查看。") : t("还没有总览。")}</p> : null}
    </>;
  };

  const projectDetail = (agent: string, project: string) => {
    const list = files.filter((f) => f.agent === agent && f.project === project);
    const sentence = summary?.projects?.[projectKey(agent, project)] ?? "";
    return <>
      <DetailHead crumb={[AGENT_LABEL[agent] ?? agent]} title={project} tag={<Tag>{t("{n} 条记忆", { n: list.length })}</Tag>} />
      {sentence ? <div className="akd-md"><p>{sentence}</p></div> : <p className="akd-note">{t("这个项目还没有一句话总结，点「重新总结」可以生成。")}</p>}
      <Sep />
      <DetailSection title={t("记忆")} count={list.length}>
        {list.length > 0 ? list.map((e) => <button key={e.path} className="ak-task" onClick={() => selectEntry(e)}><span className="t">{e.description || cleanName(e.name)}</span><span className="s num">{fmtSize(e.size)} · {fmtTime(e.mtime)}</span></button>) : <p className="akd-note">{t("这个项目下没有记忆文件。")}</p>}
      </DetailSection>
    </>;
  };

  const locale = useLocale();
  useShellHeader({
    subtitle: [hostName(hosts, host), files.length ? t("{n} 条记忆", { n: files.length }) : ""].filter(Boolean).join(" · "),
    actions: <button className="btn sm ghost" disabled={busy} onClick={() => { void loadList(); void loadSummary(false); }} title={t("重新读取")} aria-label={t("重新读取")}><Icon name="refresh" size={14} /></button>,
  }, [host, hosts, files.length, busy, locale]);

  const [agentTab, setAgentTab] = useState("all");
  const shownGroups = agentTab === "all" ? groups : groups.filter(([a]) => a === agentTab);
  // Rows in display order, for ↑↓: 总览, then per agent each project and (when open) its entries.
  const ids: string[] = ["overview"];
  for (const [agent, projects] of shownGroups) for (const [project, list] of projects) { ids.push(`p:${projectKey(agent, project)}`); if (isOpen(agent, project, list)) for (const f of list) ids.push(`e:${f.path}`); }
  const selId = sel?.kind === "entry" ? `e:${sel.path}` : sel?.kind === "project" ? `p:${projectKey(sel.agent, sel.project)}` : "overview";
  const selectId = (id: string) => {
    if (id === "overview") setSel(null);
    else if (id.startsWith("e:")) { const f = files.find((x) => x.path === id.slice(2)); if (f) selectEntry(f); }
    else { const k = id.slice(2); const i = k.indexOf("|"); setSel({ kind: "project", agent: k.slice(0, i), project: k.slice(i + 1) }); }
  };
  useListKeyboard(ids, selId, selectId);

  const tabs = <Tabs items={[{ key: "all", label: t("全部"), count: files.length }, ...[...new Set(files.map((f) => f.agent))].sort((a, b) => agentRank(a) - agentRank(b)).map((a) => ({ key: a, label: AGENT_LABEL[a] ?? a, count: files.filter((f) => f.agent === a).length }))]} value={agentTab} onChange={setAgentTab} right={<span className="ak-tools"><SearchField value={query} onChange={setQuery} placeholder={t("按项目、描述或文件名筛选")} label={t("筛选记忆文件")} /></span>} />;
  return <ListDetail className="ak-page ak-doc ak-memories" tabs={tabs} detail={<div className="ak-detail">{(blocked || error) && <p className="akd-note err">{blocked || error}</p>}{selectedEntry ? entryDetail(selectedEntry) : sel?.kind === "project" ? projectDetail(sel.agent, sel.project) : overview()}</div>}>
    <Row id="overview" selected={!sel} onClick={() => { setSel(null); revealDetail(); }} icon={<Icon name="grid" filled={!sel} />} title={t("Agent 记忆总览")} />
    {shownGroups.map(([agent, projects]) => <Section key={agent} title={AGENT_LABEL[agent] ?? agent} count={projects.reduce((n, [, l]) => n + l.length, 0)}>
      {projects.map(([project, list]) => {
        const open = isOpen(agent, project, list);
        const dirs = [...new Set(list.map((f) => f.project_dir).filter(Boolean))];
        const active = sel?.kind === "project" && sel.agent === agent && sel.project === project;
        return <div key={project} className="ak-tree">
          <Row id={`p:${projectKey(agent, project)}`} selected={active} aria-expanded={open} tooltip={dirs.length > 1 ? dirs.map(short).join("\n") : project}
            onClick={() => { setOpenProjects((o) => ({ ...o, [projectKey(agent, project)]: !open })); setSel({ kind: "project", agent, project }); }}
            icon={<Icon name={open ? "down" : "right"} size={12} />} title={project} accessories={[<span className="num">{list.length}</span>]} />
          {open ? list.map((e) => <Row key={e.path} id={`e:${e.path}`} className={`ak-leaf${e.expired ? " ak-off" : ""}`} selected={selectedPath === e.path} onClick={() => { selectEntry(e); revealDetail(); }} tooltip={e.name}
            icon={<Icon name="doc" size={14} />} title={e.description || cleanName(e.name)}
            accessories={[...(e.index ? [<Tag>{t("索引")}</Tag>] : []), ...(e.expired ? [<Tag color="orange">{t("过期")}</Tag>] : [])]} />) : null}
        </div>;
      })}
    </Section>)}
    {!busy && files.length === 0 && !error && !blocked && <EmptyView icon="book" title={t("没有记忆文件")} description={t("这台机器上没找到任何 Agent 的记忆文件。")} />}
    {files.length > 0 && groups.length === 0 && <p className="akd-note ak-pad">{t("没有匹配「{query}」的记忆。", { query })}</p>}
    <About summary={t("关于 Agent 记忆")}><p>{t("每个 Agent 在这里保存自己跨会话积累的长期记忆，按项目分组，页面只读不会改动它们。想让它变成所有 Agent 都知道的事实，打开一条记忆点「归入关于我」。")}</p></About>
  </ListDetail>;
}
