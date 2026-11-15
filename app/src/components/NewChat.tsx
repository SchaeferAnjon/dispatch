import { useEffect, useMemo, useRef, useState } from "react";
import type { Api } from "../api";
import { newId, rememberPictures, request } from "../chatStore";
import type { ChatAgent, ChatApi, ChatEventOf, ChatImage, PermissionMode } from "../chatProtocol";
import type { Host, Issue } from "../types";
import { t, useT } from "../i18n";
import { UNGROUPED_PROJECT } from "../activity";
import { isInstalled, firstInstalled } from "../installedAgents";
import { modelKind, useModels } from "../models";
import { isMac } from "../platform";
import { ModelSelect } from "./ModelSelect";
import { control } from "./SessionActions";
import { shrinkImage, withImages } from "./SessionReply";
import { AgentDot, Fit, SendButton, modesFor, useBranch } from "./ChatComposer";
import { MentionPopover, useMentions, type MentionSession } from "./MentionPopover";
import { Icon } from "./icons";
import { PlacePicker } from "./PlacePicker";

// 新建 Agent (DESIGN.md 新建 Agent 页, after Copilot's new session): no greeting, the box a little above the middle,
// two chips over it (项目或文件夹, Agent), + and the model inside, and one gray line under it (权限、顺手建任务 on the
// left, 新工作树 and the branch on the right). The first message starts the agent on another Mac
// (`dispatch --host <it> agent start`); this page has no in-app chat of its own.

export const NEW_SESSION_KEY = "dispatch-new-session";
const OLD_MODELS_KEY = "dispatch-new-session-models";
export interface NewSessionDefaults { project: string; cwd: string; agent: string; model: string; host: string }
export const AGENTS: [string, string][] = [["claude-code", "Claude Code"], ["codex", "Codex"], ["pi", "pi"]];

export function readDefaults(): Partial<NewSessionDefaults> {
  try {
    const d = JSON.parse(localStorage.getItem(NEW_SESSION_KEY) || "null");
    if (d && typeof d === "object") return d as Partial<NewSessionDefaults>;
    // Before v3 only the model per agent was kept.
    const old = JSON.parse(localStorage.getItem(OLD_MODELS_KEY) || "{}") as Record<string, string>;
    return old && old["claude-code"] ? { model: old["claude-code"] } : {};
  } catch { return {}; }
}
export function saveDefaults(d: NewSessionDefaults) { try { localStorage.setItem(NEW_SESSION_KEY, JSON.stringify(d)); } catch { /* private mode */ } }

/** Start the agent in Dispatch (chatd `open` + `send`) and send the first message; resolves with the session key. */
export async function startInDispatch(chat: ChatApi, input: { agent: ChatAgent; cwd: string; model?: string; permission_mode?: PermissionMode; task?: string; label?: string }, text: string, images: ChatImage[] = [], display?: string, pictures: string[] = []): Promise<string> {
  const opened = await request(chat, { cmd: "open", request_id: newId(), ...input, model: input.model || undefined, task: input.task || undefined }, 60000);
  const key = (opened as ChatEventOf<"opened">).session;
  const message_id = newId();
  rememberPictures(message_id, pictures);  // the conversation page draws them over the first bubble
  await request(chat, { cmd: "send", session: key, message_id, text, images: images.length ? images : undefined, display: display && display !== text ? display : undefined });
  return key;
}

/** Why a session of `project` cannot start on `host`: it belongs to another Mac (dispatch-project-owners)
 *  that this Mac does not know, that is offline, or that is not the one picked. "" when it can. */
export function ownerBlock(project: string, owner: { id?: string; name: string } | undefined, host: string, hosts: Pick<Host, "id" | "local" | "online">[]): string {
  if (!owner) return "";
  const p = { project, host: owner.name };
  if (!owner.id) return t("项目 {project} 归「{host}」，这台不认识那台电脑，先在「电脑」页把它加进来。", p);
  const h = hosts.find((x) => (x.local ? "local" : x.id) === owner.id);
  if (h && !h.local && h.online === false) return t("项目 {project} 归「{host}」，它现在离线。这个项目的会话只在那台上开，等它上线再发。", p);
  return host !== owner.id ? t("项目 {project} 归「{host}」，会话只在那台上开。", p) : "";
}

interface Folders { path: string; recent: string[] }

interface Props {
  api: Api;
  hosts: Host[];
  issues: Issue[];
  /** Projects to pick from, with the Mac and folder a session of theirs starts in when known, and the
   *  Mac it belongs to (dispatch-project-owners; `id` missing when this Mac's hosts do not know it). */
  projects: { name: string; dir?: string; host?: string; owner?: { id?: string; name: string } }[];
  projectOfDir: (cwd: string) => string;
  sessions: MentionSession[];
  initial?: { project?: string | null; cwd?: string; host?: string };
  onBack: () => void;
  /** Started: the transcript id once it exists. */
  onStarted: (sessionId: string, host: string, agent: string, project: string) => void;
  onOtherFolder: (ctx: { host: string; cwd: string; project: string }) => void;
  onComputer: (host: string) => void;
  /** 新工作树 under the box: remembered in the shared settings; it starts nothing yet. */
  worktree?: boolean;
  onWorktree?: (on: boolean) => void;
}

export function NewChat({ api, hosts, issues, projects, projectOfDir, sessions, initial, onBack, onStarted, onOtherFolder, onComputer, worktree = false, onWorktree }: Props) {
  const t = useT();
  const saved = useMemo(readDefaults, []);
  const hostIds = hosts.map((h) => (h.local ? "local" : h.id));
  const savedHost = saved.host && (hostIds.includes(saved.host) || !hosts.length) ? saved.host : "local";
  const firstProject = initial?.project ?? (initial?.cwd ? projectOfDir(initial.cwd) : saved.project ?? "");
  // Opened without a place (the phone's ＋, ⌘N elsewhere): a project that lives on one Mac starts there, in its folder.
  const home = initial?.host || initial?.cwd ? undefined : projects.find((p) => p.name === firstProject && p.host);
  const [host, setHost] = useState(() => initial?.host || home?.host || savedHost);
  const [agent, setAgent] = useState(() => (saved.agent && isInstalled(saved.agent) ? saved.agent : firstInstalled(["claude-code", "codex", "pi"])));
  const [model, setModel] = useState(saved.model ?? "");
  const [cwd, setCwd] = useState(initial?.cwd || (home && home.host !== savedHost ? home.dir : "") || (initial?.project ? projects.find((p) => p.name === initial.project)?.dir : "") || saved.cwd || "");
  const [project, setProject] = useState(firstProject);
  const [mode, setMode] = useState<PermissionMode>("default");
  const [makeTask, setMakeTask] = useState(false);
  const [draft, setDraft] = useState("");
  const [files, setFiles] = useState<{ file: File; preview: string }[]>([]);
  const [recent, setRecent] = useState<string[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const catalog = useModels(api, host);
  // This Mac has no in-app chat on the web page: a session starts on another Mac.
  const localReason = t("应用内聊天只在电脑上的 Dispatch 里可用");
  const projectTasks = useMemo(() => issues.filter((i) => !project || (i.labels ?? []).includes(`project:${project}`)), [issues, project]);
  const mention = useMentions({ api, host, cwd, draft, setDraft, textarea, tasks: projectTasks, sessions, codebase: true });
  useEffect(() => { textarea.current?.focus(); }, []);
  // Recent folders of the chosen computer (session-control browse keeps them); the first fills an empty folder.
  useEffect(() => {
    let alive = true;
    control<Folders>(api, host, "browse", { path: "" }).then((r) => { if (!alive) return; setRecent(r.recent ?? []); setCwd((c) => c || r.recent?.[0] || ""); }).catch(() => { if (alive) setRecent([]); });
    return () => { alive = false; };
  }, [api, host]);
  // A project brings its Mac along with its folder: kanban picked on the phone (served by the mini) runs on its owner.
  const pickProject = (name: string) => { setProject(name); const p = projects.find((x) => x.name === name); if (p?.host && hostIds.includes(p.host)) setHost(p.host); if (p?.dir) setCwd(p.dir); };
  // A folder of a project that lives on another Mac brings the project, and so that Mac and its folder there.
  // A folder outside every project leaves none picked.
  const pickFolder = (dir: string) => { const p = projectOfDir(dir); const o = projects.find((x) => x.name === p)?.owner; if (o?.id && o.id !== host) { pickProject(p); return; } setCwd(dir); setProject(p && p !== UNGROUPED_PROJECT ? p : ""); };
  // A project's sessions start only on the Mac it belongs to: the host picker stays there, and says so when it cannot.
  const owner = projects.find((p) => p.name === project)?.owner;
  useEffect(() => {
    if (!owner?.id || owner.id === host || !hostIds.includes(owner.id)) return;
    setHost(owner.id);
    const dir = projects.find((p) => p.name === project)?.dir;
    if (dir) setCwd(dir);
  }, [owner?.id]);  // eslint-disable-line react-hooks/exhaustive-deps
  const blocked = ownerBlock(project, owner, host, hosts);
  // One chip for the place: the project's name for a folder inside it, the folder's own name otherwise.
  const placeName = project && project !== UNGROUPED_PROJECT ? project : cwd.replace(/\/+$/, "").split("/").pop() || cwd;
  const branch = useBranch(api, host, cwd);
  // ⌘O: the old dialog with the folder browser; esc: back where you came from.
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if ((isMac ? e.metaKey : e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "o") { e.preventDefault(); onOtherFolder({ host, cwd, project }); return; }
      // A dialog on top (⌘O, ⌘K) takes its own esc; it may already be gone when this runs, so ask the target.
      const inDialog = !!(e.target as HTMLElement | null)?.closest?.(".overlay,.ap-shade,.ap,.dialog");
      if (e.key === "Escape" && !e.defaultPrevented && !inDialog && !document.querySelector(".overlay,.ap-shade,.dialog")) { e.preventDefault(); onBack(); }
    };
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [host, cwd, project, onBack, onOtherFolder]);
  const addFiles = async (list: File[]) => {
    const imgs = list.filter((f) => f.type.startsWith("image/"));
    for (const f of imgs) { try { setFiles((xs) => [...xs, { file: f, preview: "" }]); const preview = await shrinkImage(f); setFiles((xs) => xs.map((x) => (x.file === f ? { ...x, preview } : x))); } catch (e) { setError(String(e)); } }
  };
  const makeTaskFor = async (text: string): Promise<string> => {
    const title = text.split("\n")[0].replace(/@\S+/g, "").trim().slice(0, 80) || t("新会话");
    const i = await api.create({ title, description: text, labels: project && project !== UNGROUPED_PROJECT ? [`project:${project}`] : [] });
    return i?.id ?? "";
  };
  // Another Mac: `dispatch --host <it> agent start`, an in-app chat in the Dispatch open there; the
  // conversation shows up in the list once its transcript syncs.
  const start = async () => {
    if (busy) return;
    const typed = draft.trim();
    if (!typed && !files.length) { textarea.current?.focus(); return; }
    if (!cwd) { setError(t("先选一个文件夹")); return; }
    if (blocked) { setError(blocked); return; }
    if (host === "local") { setError(localReason); return; }
    setBusy(true); setError("");
    saveDefaults({ project, cwd, agent, model, host });
    try {
      const expanded = await mention.expand(typed || t("看一下这几张图"));
      const cb = await mention.codebase(expanded, typed);
      const text = cb.text;
      const task = makeTask ? await makeTaskFor(expanded) : "";
      // Pictures travel as paths saved on that Mac, named in the first message.
      const paths: string[] = [];
      for (const f of files) { const data = f.preview || await shrinkImage(f.file); const raw = await api.on(host, ["save-image", "--json"], JSON.stringify({ name: f.file.name || "photo", data })); paths.push((JSON.parse(raw.slice(raw.indexOf("{"))) as { path: string }).path); }
      const r = await api.agentStart({ kind: agent === "claude-code" ? "claude" : "codex", host, cwd, model: model || undefined, task: task || undefined, prompt: withImages(text, paths), label: project || undefined });
      const key = r?.session ?? r?.pane_id ?? "";
      if (!key.includes(":")) throw new Error(r?.warning || t("那台电脑没起来这个 Agent"));
      setDraft(""); setFiles([]);
      onStarted(key.slice(key.indexOf(":") + 1), host, agent, project);
    } catch (e) { setError(String(e)); }
    finally { setBusy(false); }
  };
  // the host picker only matters with more than one Mac
  const hostPick = hosts.length > 1 && <Fit className="txt" title={t("主机")}><span className={`dotc${hosts.find((h) => (h.local ? "local" : h.id) === host)?.online === false ? " off" : ""}`} /><select aria-label={t("主机")} value={host} disabled={busy} title={owner ? t("项目 {project} 归「{host}」，会话只在那台上开", { project, host: owner.name }) : undefined} onChange={(e) => setHost(e.target.value)}>{hosts.map((h) => { const id = h.local ? "local" : h.id; const other = !!owner?.id && id !== owner.id; return <option key={h.id} value={id} disabled={(!h.online && !h.local) || other}>{h.name}{!h.online && !h.local ? ` · ${t("离线")}` : other ? ` · ${t("项目不在这台")}` : ""}</option>; })}</select></Fit>;
  return (
    <div className="ns new-chat">
      <div className="composer">
        {/* above the box (DESIGN.md 参照 Copilot): where it runs and which Agent */}
        <div className="ns-chips">
          <PlacePicker label={placeName} cwd={cwd} project={project} projects={projects} recent={recent} disabled={busy}
            onProject={pickProject} onFolder={pickFolder} onOther={() => onOtherFolder({ host, cwd, project })} />
          <Fit title={t("Agent")}><AgentDot agent={agent} /><select aria-label={t("Agent")} value={agent} disabled={busy} onChange={(e) => { const a = e.target.value; setAgent(a); setModel(""); if (!modesFor(a).some(([v]) => v === mode)) setMode("default"); }}>
            {AGENTS.map(([k, n]) => <option key={k} value={k} disabled={!isInstalled(k)}>{n}{isInstalled(k) ? "" : ` · ${t("未安装")}`}</option>)}
          </select></Fit>
        </div>
        <div className="cbox" onDragOver={(e) => e.preventDefault()} onDrop={(e) => { const l = Array.from(e.dataTransfer.files); if (l.length) { e.preventDefault(); void addFiles(l); } }}>
          {mention.open && <MentionPopover items={mention.items} cursor={mention.cursor} onPick={mention.pick} onHover={mention.setCursor} project={project} dir={cwd} />}
          {files.length > 0 && <div className="reply-images">{files.map((f, i) => <div key={i} className="disc-img">{f.preview && <img src={f.preview} alt={f.file.name} />}<button type="button" className="x" onClick={() => setFiles((xs) => xs.filter((_, j) => j !== i))} aria-label={t("移除图片")}>✕</button></div>)}</div>}
          <textarea ref={textarea} className="ta" rows={2} aria-label={t("第一条消息")} value={draft} maxLength={16000} disabled={busy}
            placeholder={t("说这次想做什么，@ 提任务或文件夹，可以直接粘贴图片")}
            onChange={(e) => { setDraft(e.target.value); mention.track(); }} onKeyUp={mention.track} onClick={mention.track}
            onPaste={(e) => { const l = Array.from(e.clipboardData.files); if (l.length) { e.preventDefault(); void addFiles(l); } }}
            onKeyDown={(e) => {
              if (mention.onKeyDown(e)) return;
              if (e.nativeEvent.isComposing) return;
              if (e.key === "Enter" && !e.shiftKey && !e.altKey) { e.preventDefault(); void start(); }
            }} />
          <div className="tools">
            <input ref={fileInput} type="file" accept="image/*" multiple hidden onChange={(e) => { void addFiles(Array.from(e.target.files || [])); e.target.value = ""; }} />
            <button type="button" className="btn ghost icon" disabled={busy} onClick={() => fileInput.current?.click()} title={t("加图片：也可以直接粘贴")} aria-label={t("添加图片")}><Icon name="plus" size={14} /></button>
            <Fit className="txt" title={t("模型")}><ModelSelect options={catalog[modelKind(agent)]} value={model} disabled={busy} onChange={setModel} /></Fit>
            <SendButton disabled={busy || !!blocked || (!draft.trim() && !files.length)} onClick={() => void start()} label={t("发送并启动")} title={t("发送并启动 Agent（↵）")} />
          </div>
        </div>
        {/* one 12px line under the box: how it runs on the left, 新工作树 and the branch on the right */}
        <div className="cstat-row">
          <span className="cs-l">
            <Fit className="txt" title={t("权限模式")}><Icon name="shield" size={14} /><select aria-label={t("权限模式")} value={mode} disabled={busy || host !== "local"} onChange={(e) => setMode(e.target.value as PermissionMode)}>{modesFor(agent).map(([v, l]) => <option key={v} value={v}>{t(l)}</option>)}</select></Fit>
            <button type="button" className={`dd txt toggle${makeTask ? " on" : ""}`} aria-pressed={makeTask} disabled={busy} onClick={() => setMakeTask((v) => !v)} title={t("第一句话同时建成任务，挂在上面的项目下")}><Icon name={makeTask ? "check" : "tasks"} size={14} /><span className="v">{t("顺手建任务")}</span></button>
            {hostPick}
          </span>
          <span className="cs-r">
            <label className="cs-wt" title={t("先只记住这个开关，还不会真的建工作树")}><input type="checkbox" checked={worktree} disabled={busy} onChange={(e) => onWorktree?.(e.target.checked)} />{t("新工作树")}</label>
            {branch && <><i className="sep" aria-hidden="true">·</i><span className="cs-branch" title={t("当前分支")}><Icon name="branch" size={14} />{branch}</span></>}
          </span>
        </div>
        {blocked && <div className="hint" role="status">{blocked}</div>}
        {host === "local" && <div className="hint">{localReason}</div>}
        {error && <div className="chat-error" role="alert">{error}<button type="button" className="lk" onClick={() => onComputer(host)}>{t("查看电脑与连接")}</button></div>}
      </div>
    </div>
  );
}
