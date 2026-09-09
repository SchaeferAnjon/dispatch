import { useEffect, useMemo, useState } from "react";
import type { Api, AgentStartInput, AgentStartResult } from "../api";
import { control } from "./SessionActions";
import { actorOf, projectOf } from "../derive";
import type { Host, Issue } from "../types";

// 派活: start an agent on a machine through Herdr, optionally handing it a task it
// claims as its own, and send it the first prompt.
export const KINDS: [string, string][] = [["claude", "Claude Code"], ["codex", "Codex"], ["pi", "pi"], ["gemini", "Gemini CLI"], ["opencode", "OpenCode"]];
export const KIND_ACTOR: Record<string, string> = { claude: "claude-code", codex: "codex", pi: "pi", opencode: "zcode", gemini: "gemini" };

interface Props {
  api?: Api;
  hosts: Host[];
  initialHost?: string;
  initialTask?: string;
  initialPrompt?: string;
  initialLabel?: string;
  initialKind?: string;
  initialModel?: string;
  issues: Issue[];
  me: string;
  dirOfProject: (name: string) => string;
  onClose: () => void;
  onStart: (input: AgentStartInput) => Promise<AgentStartResult | null>;
}

export function Delegate({ api, hosts, initialHost, initialTask, initialPrompt, initialLabel, initialKind, initialModel, issues, me, dirOfProject, onClose, onStart }: Props) {
  const online = hosts.filter((h) => h.online || h.local);
  const [hostId, setHostId] = useState(initialHost ?? (online.find((h) => h.local)?.id ?? online[0]?.id ?? ""));
  const host = hosts.find((h) => h.id === hostId);
  const [kind, setKind] = useState(initialKind || "claude");
  const [model, setModel] = useState(initialModel || "");
  const MODELS: Record<string, [string, string][]> = { claude: [["", "默认"], ["claude-fable-5-1", "Fable 5.1（最强）"], ["opus", "Opus"], ["sonnet", "Sonnet"], ["haiku", "Haiku（快、省）"]], codex: [["", "默认"], ["gpt-5.5", "gpt-5.5"], ["gpt-5.6-terra", "gpt-5.6-terra"], ["gpt-6-astra", "gpt-6-astra"]] };
  const [taskId, setTaskId] = useState(initialTask ?? "");
  const task = issues.find((i) => i.id === taskId);
  const suggestedCwd = task ? dirOfProject(projectOf(task)) : "";
  const [cwd, setCwd] = useState("");
  // Folder picker: the same browse the new-session dialog uses, on the chosen machine.
  type Folders = { path: string; parent: string; children: { name: string; path: string }[]; recent: string[]; truncated: boolean };
  const [picking, setPicking] = useState(false);
  const [folders, setFolders] = useState<Folders | null>(null);
  const [browseBusy, setBrowseBusy] = useState(false);
  const browse = async (next: string) => {
    if (!api || !host) return;
    setBrowseBusy(true);
    try { const r = await control<Folders>(api, host.local ? "local" : host.id, "browse", { path: next }); setFolders(r); setCwd(r.path); }
    catch (e) { setErr(String(e)); }
    finally { setBrowseBusy(false); }
  };
  const openPicker = () => { setPicking(true); void browse(cwd.trim() || suggestedCwd || ""); };
  const [prompt, setPrompt] = useState(initialPrompt ?? "");
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState<AgentStartResult | null>(null);
  const [err, setErr] = useState("");
  const candidates = useMemo(() => issues.filter((i) => i.status !== "closed").sort((a, b) => Number(b.id === initialTask) - Number(a.id === initialTask) || a.priority - b.priority || b.updated_at.localeCompare(a.updated_at)), [issues, initialTask]);
  const defaultPrompt = task ? `你接手任务 ${task.id}「${task.title}」。先 \`bd show ${task.id}\` 读背景和验收项，按验收项做完，进展用 dispatch log，收尾 dispatch done --reason。` : "";
  const go = async () => {
    const text = (prompt.trim() || defaultPrompt).trim();
    if (!text || !host) return;
    setBusy(true); setErr("");
    try { setRes(await onStart({ kind, model: model || undefined, host: host.local ? "" : host.id, cwd: (cwd.trim() || suggestedCwd) || undefined, task: taskId || undefined, prompt: text, label: initialLabel || (task ? task.title.slice(0, 24) : text.slice(0, 24)) })); }
    catch (e) { setErr(String(e)); }
    finally { setBusy(false); }
  };
  const actorName = actorOf(KIND_ACTOR[kind] ?? kind, me)?.name ?? kind;
  useEffect(() => { const k = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); }; window.addEventListener("keydown", k); return () => window.removeEventListener("keydown", k); }, [onClose]);
  // Grouped so the eye lands on the tasks that are actually free: this project's, then others', then ones someone already holds.
  const proj = initialTask ? projectOf(issues.find((i) => i.id === initialTask) ?? ({} as Issue)) : "";
  const groups: [string, typeof candidates][] = [
    [proj ? `${proj} · 待接手` : "待接手", candidates.filter((i) => !i.assignee && (!proj || projectOf(i) === proj))],
    ["其他项目 · 待接手", candidates.filter((i) => !i.assignee && proj && projectOf(i) !== proj)],
    ["已有人在做", candidates.filter((i) => !!i.assignee)],
  ];
  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dialog delegate" role="dialog" aria-label="派活">
        <h3>派活{task ? ` · ${task.title}` : initialLabel ? ` · ${initialLabel}` : ""}</h3>
        <p className="muted small">在所选电脑的 Herdr 里起一个 Agent，把任务记到它名下，并发第一句话。它会以自己的身份认领任务，完成后 dispatch done。</p>
        <div className="new-session-selects">
          <label>电脑<select value={hostId} onChange={(e) => setHostId(e.target.value)}>{hosts.map((h) => <option key={h.id} value={h.id} disabled={!h.online && !h.local}>{h.name}{!h.online && !h.local ? " · 离线" : ""}</option>)}</select></label>
          <label>Agent<select value={kind} onChange={(e) => { setKind(e.target.value); setModel(""); }} title="Herdr 能起的 Agent。Gemini CLI / OpenCode 能派活，但它们的对话 Dispatch 还读不到">{KINDS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></label>
          <label>模型<select value={model} onChange={(e) => setModel(e.target.value)}>{(MODELS[kind] ?? [["", "默认"]]).map(([m, l]) => <option key={m} value={m}>{l}</option>)}</select></label>
        </div>
        <label>任务<select value={taskId} onChange={(e) => setTaskId(e.target.value)}><option value="">不挂任务，只发一句话</option>{groups.filter(([, xs]) => xs.length).map(([label, xs]) => <optgroup key={label} label={label}>{xs.map((i) => <option key={i.id} value={i.id}>{i.id} · {i.title}{i.assignee ? ` · 现在 ${actorOf(i.assignee, me)?.name ?? i.assignee}` : ""}</option>)}</optgroup>)}</select></label>
        <label>目录<div className="folder-path"><input placeholder={suggestedCwd ? `默认：${suggestedCwd}` : host?.local ? "默认：~（家目录）；点「选择…」挑一个" : "默认：那台机器的家目录"} value={cwd} onChange={(e) => setCwd(e.target.value)} />{api && <button className="btn sm" type="button" disabled={busy || browseBusy} onClick={picking ? () => setPicking(false) : openPicker}>{picking ? "收起" : "选择…"}</button>}</div></label>
        {picking && <div className="folder-picker" aria-busy={browseBusy}>
          <div className="folder-picker-heading"><b>浏览文件夹</b><span className="muted small">{folders?.path}</span><button className="link" disabled={!folders || browseBusy || folders.path === folders.parent} onClick={() => browse(folders!.parent)}>↑ 上一级</button></div>
          {browseBusy ? <p className="muted">读取文件夹…</p> : <div className="folder-children">{folders?.children.map((f) => <button key={f.path} type="button" onClick={() => browse(f.path)}>▱ {f.name}<span>›</span></button>)}{folders?.children.length === 0 && <p className="muted">没有子文件夹，就用当前目录。</p>}</div>}
          {!!folders?.recent.length && <select aria-label="最近使用的文件夹" value="" disabled={browseBusy} onChange={(e) => browse(e.target.value)}><option value="">最近使用的文件夹…</option>{folders.recent.map((p) => <option key={p} value={p}>{p}</option>)}</select>}
        </div>}
        <label>第一句话<textarea rows={4} placeholder={defaultPrompt || "要它做什么"} value={prompt} onChange={(e) => setPrompt(e.target.value)} /></label>
        {err && <div className="err">{err}</div>}
        {res && (
          <div className="sel-text small">
            <div><b>{res.status}</b> · Herdr {res.pane_id} · {res.actor}{res.warning ? ` · ${res.warning}` : ""}</div>
            {res.output && <pre className="diff" style={{ maxHeight: 220, overflow: "auto" }}>{res.output.split("\n").filter((l) => l.trim()).slice(-25).join("\n")}</pre>}
          </div>
        )}
        <div className="foot">
          <button className="btn ghost" onClick={onClose}>{res ? "关闭" : "取消"}</button>
          <button className="btn primary" disabled={busy || !host || (!prompt.trim() && !defaultPrompt)} onClick={go}>{busy ? "起中，等它回话…" : res ? "再派一个" : `派给 ${actorName}`}</button>
        </div>
      </div>
    </div>
  );
}
