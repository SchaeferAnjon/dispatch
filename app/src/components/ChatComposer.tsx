import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type ClipboardEvent as ReactClipboardEvent, type DragEvent as ReactDragEvent } from "react";
import type { Api } from "../api";
import { isBusy, type Capability, type ChatAgent, type ChatImage, type ChatView, type PermissionMode, type QueueItem, type SendMode, type SlashCommand } from "../chatProtocol";
import type { Issue } from "../types";
import { t, useT } from "../i18n";
import { modelKind, useModels } from "../models";
import { ModelSelect } from "./ModelSelect";
import { matchCommands, shrinkImage, slashQuery } from "./SessionReply";
import { MentionPopover, useMentions, type MentionSession } from "./MentionPopover";
import { Icon } from "./icons";
import { ConvStatus, control } from "./SessionActions";
import { tildePath } from "../activity";

// The input box of a live chat (DESIGN.md 输入框): the text, one row of pills under it (图片 +, 权限模式, Agent · 模型)
// and one round key at the bottom right that sends, queues while a turn runs, or stops the turn when the box
// is empty. Above it the messages chatd holds in its queue. `/` opens the command menu, `@` the task /
// conversation / folder list.

/** The four permission modes and their labels. */
export const MODES: [PermissionMode, string][] = [["default", "手动确认"], ["acceptEdits", "自动接受编辑"], ["plan", "计划模式"], ["bypassPermissions", "跳过权限"]];
/** Codex's own three levels (chat_codex.MODE_MAP): read-only, --full-auto (workspace write, asks before the rest), full access. */
export const CODEX_MODES: [PermissionMode, string][] = [["plan", "只读"], ["default", "自动"], ["bypassPermissions", "完全访问"]];
export const modesFor = (agent: string): [PermissionMode, string][] => (agent === "codex" ? CODEX_MODES : MODES);
export const AGENT_NAMES: Record<ChatAgent, string> = { "claude-code": "Claude Code", codex: "Codex", opencode: "OpenCode" };
/** Commands the page runs itself instead of sending them to the agent. */
export const LOCAL_COMMANDS: SlashCommand[] = [
  { name: "model", description: "换模型，例如 /model haiku", kind: "builtin" },
  { name: "plan", description: "切到计划模式", kind: "builtin" },
];
export const MAX_QUEUE_SHOWN = 3;

export type ComposerKey = "send" | "interrupt" | "allow" | "allow_session" | "deny" | null;
/** What a key means. ↵ and ⌘↵ send (queue while busy), ⇧↵ is a new line; with a permission card
 *  waiting and the box empty ↵ allows once and esc denies, otherwise esc stops a running turn.
 *  ⇧↵ (本会话都允许) only counts outside the text box (`inBox` false): typed in the box it stays a new
 *  line, since a card can arrive between two keystrokes. A question card never takes ↵: it needs
 *  its answers picked on the card. */
export function composerKey(e: { key: string; metaKey?: boolean; ctrlKey?: boolean; shiftKey?: boolean; altKey?: boolean; isComposing?: boolean }, s: { busy: boolean; hasText: boolean; pending: boolean; question?: boolean; inBox?: boolean }): ComposerKey {
  if (e.isComposing) return null;
  const mod = !!(e.metaKey || e.ctrlKey);
  if (e.key === "Enter") {
    if (s.pending && !s.hasText && !mod && !e.altKey) {
      if (s.question) return null;
      if (e.shiftKey) return s.inBox ? null : "allow_session";
      return "allow";
    }
    if (e.shiftKey || e.altKey) return null;
    return s.hasText ? "send" : null;
  }
  if (e.key === "Escape") return s.pending ? "deny" : s.busy ? "interrupt" : null;
  return null;
}

export type SendPlan =
  | { kind: "none" }
  | { kind: "model"; model: string }
  | { kind: "mode"; mode: PermissionMode }
  | { kind: "send"; text: string; mode?: SendMode };
/** The draft as an action: a local /command, or a message (queued while the agent is busy). */
export function planSend(draft: string, view: Pick<ChatView, "lifecycle"> | null, images = 0): SendPlan {
  const text = draft.trim();
  if (!text && !images) return { kind: "none" };
  if (/^\/plan\s*$/.test(text)) return { kind: "mode", mode: "plan" };
  const m = /^\/model\s+(\S+)\s*$/.exec(text);
  if (m) return { kind: "model", model: m[1] };
  return { kind: "send", text: text || t("看一下这几张图"), mode: view && isBusy(view) ? "queue" : undefined };
}

/** A pasted or dropped picture, in the form this agent takes: inline base64 (Claude) or a saved path (Codex). */
export async function toChatImage(api: Api, host: string, caps: Capability[], f: File): Promise<{ image: ChatImage; preview: string }> {
  const data = await shrinkImage(f);
  if (caps.includes("images_base64")) {
    const m = /^data:([^;]+);base64,(.*)$/.exec(data);
    if (!m) throw new Error(t("无法读取这张图片"));
    return { image: { media_type: m[1], data: m[2] }, preview: data };
  }
  if (caps.includes("images_path")) {
    const raw = await api.on(host, ["save-image", "--json"], JSON.stringify({ name: f.name || "photo", data }));
    const saved = JSON.parse(raw.slice(raw.indexOf("{"))) as { path: string };
    return { image: { path: saved.path }, preview: data };
  }
  throw new Error(t("这个 Agent 在 Dispatch 里还收不了图片"));
}

/** A pill as wide as the chosen option: the text shows in the pill, the real select lies over it (so the
 *  system menu, or VS Code's quick pick in the IDE, still opens on a click). A caret says it opens. */
export function Fit({ children, className = "", title }: { children: ReactNode; className?: string; title?: string }) {
  const ref = useRef<HTMLLabelElement>(null);
  const [text, setText] = useState("");
  useLayoutEffect(() => { const sel = ref.current?.querySelector("select"); const v = sel?.options[sel.selectedIndex]?.text ?? ""; if (v !== text) setText(v); });
  return <label ref={ref} className={`dd fit${className ? ` ${className}` : ""}`} title={title}>{children}<span className="v">{text}</span><Icon name="down" size={12} className="caret" /></label>;
}

/** The git branch of a folder on a Mac (`session-control branch`), for the right end of the line under the box; "" when none. */
export function useBranch(api: Api | null, host: string, cwd: string | undefined): string {
  const [branch, setBranch] = useState("");
  useEffect(() => {
    let alive = true;
    setBranch("");
    if (!api || !cwd) return;
    control<{ branch?: string }>(api, host, "branch", { path: cwd }).then((r) => { if (alive) setBranch(r.branch ?? ""); }).catch(() => {});
    return () => { alive = false; };
  }, [api, host, cwd]);
  return branch;
}

/** The Agent's colour as a dot before its name (DESIGN.md: brand marks come later, the identity colour stands in). */
export const AgentDot = ({ agent }: { agent: string }) => <i className={`agent-dot ${agent}`} aria-hidden="true" />;

/** The one round key at the box's bottom right: an arrow that sends (or queues while a turn runs), a square
 *  that stops the running turn. The two icons cross-fade in 150ms; what it does is in the tooltip. */
export function SendButton({ stop = false, disabled, onClick, label, title }: { stop?: boolean; disabled?: boolean; onClick: () => void; label: string; title: string }) {
  return <button type="button" className={`send${stop ? " stop" : ""}`} disabled={disabled} onClick={onClick} aria-label={label} title={title}>
    <Icon name="up" size={16} className="go" />
    <svg className="ic sq" width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><rect x="4" y="4" width="8" height="8" rx="1.5" fill="currentColor" /></svg>
  </button>;
}

/** The live chat's key: the one place to stop a turn besides esc. While a turn runs and the box is empty it is
 *  a square that interrupts; with text it queues the message (排队发送, in the tooltip); otherwise it sends. */
export function ComposerSend({ running, hasText, canSend, canStop, onSend, onStop }: { running: boolean; hasText: boolean; canSend: boolean; canStop: boolean; onSend: () => void; onStop: () => void }) {
  if (running && !hasText) return <SendButton stop disabled={!canStop} onClick={onStop} label={t("停止")} title={t("停止这一轮，排队的消息留着（esc）")} />;
  return <SendButton disabled={!canSend || !hasText} onClick={onSend} label={running ? t("排队发送") : t("发送")} title={running ? t("排队发送：这一轮结束就发（↵）") : t("发送（↵）")} />;
}

export interface ComposerActions {
  /** `display`: what the bubble shows when the agent gets more (`@codebase` results). */
  send: (text: string, images: ChatImage[], mode?: SendMode, display?: string, previews?: string[]) => Promise<unknown>;
  interrupt: () => Promise<unknown>;
  withdraw: (message_id: string) => Promise<unknown>;
  setModel: (model: string) => Promise<unknown>;
  setPermissionMode: (mode: PermissionMode) => Promise<unknown>;
  commands: () => Promise<unknown>;
  decide: (decision: "allow" | "allow_session" | "deny") => void;
}

interface Props {
  api: Api; session: string; view: ChatView | null; agent: ChatAgent; host: string; hostName: string; cwd?: string;
  issues: Issue[]; sessions: MentionSession[]; project?: string;
  actions: ComposerActions | null;
  /** Can take a message now (open, or stopped for idleness: chatd resumes it on the next send). */
  enabled: boolean;
  /** Errors go to the page's toast (DESIGN.md: no red boxes in the page); without it they show under the box. */
  onError?: (m: string) => void;
}

export function ChatComposer({ api, session, view, agent, host, hostName, cwd, issues, sessions, project, actions, enabled, onError }: Props) {
  const t = useT();
  const storageKey = `dispatch-chat-draft:${session}`;
  const [draft, setDraft] = useState(() => { try { return sessionStorage.getItem(storageKey) || ""; } catch { return ""; } });
  useEffect(() => { try { if (draft) sessionStorage.setItem(storageKey, draft); else sessionStorage.removeItem(storageKey); } catch { /* private mode */ } }, [draft, storageKey]);
  const [images, setImages] = useState<{ image: ChatImage; preview: string; name: string }[]>([]);
  const [saving, setSaving] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setErrorHere] = useState("");
  const setError = (m: string) => { if (m && onError) onError(m); else setErrorHere(m); };
  const textarea = useRef<HTMLTextAreaElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const caps = view?.capabilities ?? [];
  const running = !!view && isBusy(view);
  const pending = view?.pending[0] ?? null;
  const catalog = useModels(api, host);
  const mention = useMentions({ api, host, cwd, draft, setDraft, textarea, tasks: issues, sessions, codebase: true });
  // `/`: the agent's own commands (chatd `commands`, asked once) plus the three this page runs.
  const query = slashQuery(draft);
  const [slashClosed, setSlashClosed] = useState("");
  const [slashCursor, setSlashCursor] = useState(0);
  const asked = useRef(false);
  useEffect(() => { if (query !== null && !view?.commands && !asked.current && actions && caps.includes("commands")) { asked.current = true; void actions.commands().catch(() => {}); } }, [query !== null, view?.commands, actions]);  // eslint-disable-line react-hooks/exhaustive-deps
  const slash = query !== null && slashClosed !== draft ? matchCommands([...LOCAL_COMMANDS.map((c) => ({ ...c, description: t(c.description) })), ...(view?.commands ?? []).filter((c) => !LOCAL_COMMANDS.some((l) => l.name === c.name))], query, 12) : [];
  useEffect(() => { setSlashCursor(0); }, [query]);

  const addFiles = async (files: File[]) => {
    for (const f of files.filter((x) => x.type.startsWith("image/"))) {
      setSaving((n) => n + 1);
      try { const r = await toChatImage(api, host, caps, f); setImages((xs) => [...xs, { ...r, name: f.name || t("图片") }]); }
      catch (e) { setError(t("图片没加上：{err}", { err: e instanceof Error ? e.message : String(e) })); }
      finally { setSaving((n) => n - 1); }
    }
  };
  const onPaste = (e: ReactClipboardEvent) => { const files = Array.from(e.clipboardData.files); if (files.length) { e.preventDefault(); void addFiles(files); } };
  const onDrop = (e: ReactDragEvent) => { const files = Array.from(e.dataTransfer.files); if (files.length) { e.preventDefault(); void addFiles(files); } };

  const submit = async () => {
    if (!actions || busy || saving) return;
    const plan = planSend(draft, view, images.length);
    if (plan.kind === "none") return;
    setError("");
    if (plan.kind === "send") {
      // sent the moment you press it: the box empties now and the message shows in the conversation;
      // a failure puts the text back with the error instead of leaving it waiting behind 「发送中…」
      if (!enabled) return;
      const was = draft, pics = images;
      setDraft(""); setImages([]);
      try {
        const cb = await mention.codebase(await mention.expand(plan.text), plan.text);
        await actions.send(cb.text, pics.map((x) => x.image), plan.mode, cb.display, pics.map((x) => x.preview));
        mention.reset();
      } catch (e) { setDraft((d) => d || was); setImages((xs) => xs.length ? xs : pics); setError(String(e)); }
      finally { textarea.current?.focus(); }
      return;
    }
    setBusy(true);
    try {
      if (plan.kind === "model") await actions.setModel(plan.model);
      else await actions.setPermissionMode(plan.mode);
      setDraft("");
    } catch (e) { setError(String(e)); }
    finally { setBusy(false); textarea.current?.focus(); }
  };
  const takeBack = async (q: QueueItem, now: boolean) => {
    if (!actions) return;
    setError("");
    try {
      await actions.withdraw(q.message_id);
      if (now) await actions.send(q.text, [], "interrupt");
      else if (!draft.trim()) setDraft(q.text);
    } catch (e) { setError(String(e)); }
  };
  const queue = view?.queue ?? [];
  const lifeLabel = !view ? t("连接中") : view.lifecycle === "running" ? t("在跑") : view.lifecycle === "waiting_permission" ? t("等你确认") : view.lifecycle === "waiting_input" ? t("等你回答") : view.lifecycle === "starting" ? t("启动中") : view.lifecycle === "stopped" ? t("已停") : view.lifecycle === "error" ? t("出错了") : t("空闲");
  const modelOptions = catalog[modelKind(agent)];
  const hasText = !!draft.trim() || images.length > 0;
  const branch = useBranch(api, host, cwd);
  return (
    <div className="composer chat-composer">
      {queue.length > 0 && <div className="queued-list">{queue.slice(0, MAX_QUEUE_SHOWN).map((q, i) => <div key={q.message_id} className="queued" role="status">
        <span className="kbd">{t("排队 {n}", { n: i + 1 })}</span><span className="tx" title={q.text}>{q.text}</span>
        <button type="button" className="lk" onClick={() => void takeBack(q, false)}>{t("撤回")}</button>
        <button type="button" className="lk" onClick={() => void takeBack(q, true)} title={t("打断这一轮，马上把这句发过去")}>{t("改成现在插话")}</button>
      </div>)}{queue.length > MAX_QUEUE_SHOWN && <div className="queued"><span>{t("还有 {n} 条在排队", { n: queue.length - MAX_QUEUE_SHOWN })}</span></div>}</div>}
      <div className="cbox" onDragOver={(e) => e.preventDefault()} onDrop={onDrop}>
        {mention.open && <MentionPopover items={mention.items} cursor={mention.cursor} onPick={mention.pick} onHover={mention.setCursor} project={project} dir={cwd} />}
        {slash.length > 0 && !mention.open && <ul className="reply-slash chat-slash" role="listbox" aria-label={t("可用的 / 命令")}>
          {slash.map((c, i) => <li key={c.name} role="option" aria-selected={i === slashCursor} className={i === slashCursor ? "on" : ""} onMouseDown={(e) => { e.preventDefault(); setDraft(`/${c.name} `); textarea.current?.focus(); }} onMouseEnter={() => setSlashCursor(i)}><b>/{c.name}</b><span>{c.description}</span></li>)}
        </ul>}
        {(images.length > 0 || saving > 0) && <div className="reply-images">
          {images.map((im, i) => <div key={i} className="disc-img"><img src={im.preview} alt={im.name} /><button type="button" className="x" onClick={() => setImages((xs) => xs.filter((_, j) => j !== i))} aria-label={t("移除图片")}>✕</button></div>)}
          {saving > 0 && <span className="muted small">{t("传图中…")}</span>}
        </div>}
        <textarea ref={textarea} className="ta" aria-label={t("回复内容")} rows={2} value={draft} maxLength={16000} disabled={!actions}
          placeholder={enabled ? t("回复，@ 提任务或文件夹，/ 命令，直接粘贴图片") : t("这段会话现在收不了消息")}
          onChange={(e) => { setDraft(e.target.value); mention.track(); if (error) setError(""); }} onKeyUp={mention.track} onClick={mention.track} onPaste={onPaste}
          onKeyDown={(e) => {
            if (mention.onKeyDown(e)) return;
            if (slash.length) {
              if (e.key === "ArrowDown") { e.preventDefault(); setSlashCursor((i) => (i + 1) % slash.length); return; }
              if (e.key === "ArrowUp") { e.preventDefault(); setSlashCursor((i) => (i - 1 + slash.length) % slash.length); return; }
              if (e.key === "Tab" || (e.key === "Enter" && !e.metaKey && !e.ctrlKey && !e.shiftKey && slashQuery(draft) !== null && !/^\/plan$/.test(draft.trim()))) { e.preventDefault(); setDraft(`/${slash[Math.min(slashCursor, slash.length - 1)].name} `); return; }
              if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); setSlashClosed(draft); return; }
            }
            const k = composerKey({ key: e.key, metaKey: e.metaKey, ctrlKey: e.ctrlKey, shiftKey: e.shiftKey, altKey: e.altKey, isComposing: e.nativeEvent.isComposing }, { busy: running, hasText: !!draft.trim() || images.length > 0, pending: !!pending, question: pending?.kind === "question", inBox: true });
            if (!k) return;
            e.preventDefault(); e.stopPropagation();
            if (k === "send") void submit();
            else if (k === "interrupt") void actions?.interrupt().catch((x) => setError(String(x)));
            else actions?.decide(k);
          }} />
        <div className="tools">
          <input ref={fileInput} type="file" accept="image/*" multiple hidden onChange={(e) => { void addFiles(Array.from(e.target.files || [])); e.target.value = ""; }} />
          <button type="button" className="btn ghost icon" onClick={() => fileInput.current?.click()} disabled={!caps.some((c) => c === "images_base64" || c === "images_path")} title={t("发图片：也可以直接粘贴或拖进来")} aria-label={t("添加图片")}><Icon name="plus" size={14} /></button>
          {/* the Agent is fixed once the conversation is open: its name is plain text; only the model changes */}
          <span className="dd txt fixed" title={t("这段对话的 Agent，开了之后不能换")}><AgentDot agent={agent} />{AGENT_NAMES[agent]}</span>
          <Fit className="txt" title={caps.includes("set_model") ? t("模型") : t("这个 Agent 在 Dispatch 里不能中途换模型")}>
            <ModelSelect options={modelOptions} value={view?.model ?? ""} disabled={!actions || !caps.includes("set_model")} onChange={(m) => void actions?.setModel(m).catch((x) => setError(String(x)))} />
          </Fit>
          <ComposerSend running={running} hasText={hasText} canStop={!!actions} canSend={!!actions && !busy && saving === 0 && enabled}
            onSend={() => void submit()} onStop={() => void actions?.interrupt().catch((x) => setError(String(x)))} />
        </div>
      </div>
      {/* one 12px line under the box (DESIGN.md 输入框): the permission mode and the state on the left, the branch on the right */}
      <div className="cstat-row">
        <span className="cs-l">
          <Fit className="txt" title={caps.includes("set_permission_mode") ? t("权限模式") : t("这个 Agent 在 Dispatch 里不能切换权限模式")}>
            <Icon name="shield" size={14} />
            <select aria-label={t("权限模式")} value={view?.permission_mode || "default"} disabled={!actions || !caps.includes("set_permission_mode")} onChange={(e) => void actions?.setPermissionMode(e.target.value as PermissionMode).catch((x) => setError(String(x)))}>
              {modesFor(agent).map(([v, l]) => <option key={v} value={v}>{t(l)}</option>)}
              {view?.permission_mode && !modesFor(agent).some(([v]) => v === view.permission_mode) && <option value={view.permission_mode}>{view.permission_mode}</option>}
            </select>
          </Fit>
          <ConvStatus agent={agent} model={view?.model || undefined} host={hostName} cwd={cwd ? tildePath(cwd) : undefined} state={lifeLabel} tone={view?.pending.length ? "wait" : running ? "run" : "idle"} note={t("在 Dispatch 里跑")} />
        </span>
        <span className="cs-r">{branch && <span className="cs-branch" title={t("当前分支")}><Icon name="branch" size={14} />{branch}</span>}</span>
      </div>
      {error && <div className="chat-error" role="alert">{error}</div>}
    </div>
  );
}
