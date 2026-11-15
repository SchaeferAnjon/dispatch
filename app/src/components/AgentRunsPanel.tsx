// The Agent window's 命令 tab: a read-only 「Agent · <cmd>」 tab for every
// shell command the agent runs (from the chat's tool chips), and 输出, the chat's event log. Dispatch
// opens no terminal of its own: a person who wants a shell opens their terminal app.
import { useEffect, useMemo, useRef, useState } from "react";
import { Terminal, type ITheme } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import "@xterm/xterm/css/xterm.css";
import "./agent-runs.css";
import type { ChatApi } from "../chatProtocol";
import { chatViewOf, useChatSession } from "../chatStore";
import { splitKey } from "../chatProtocol";
import { useT } from "../i18n";
import { Icon } from "./icons";
import { AGENT_SCROLLBACK, AGENT_TAB_LINGER_MS, agentLogOf, agentRunsOf, type AgentRun } from "./agentRuns";

export interface AgentRunsPanelProps {
  /** The in-app chat session whose shell commands are shown; null for projects opened without one. */
  session: string | null;
  chat: ChatApi | null;
  /** Collapsed to the 30 px tab strip. */
  collapsed: boolean;
  onToggle: () => void;
}

// ---------------------------------------------------------------- xterm look
const cssVar = (name: string, fallback: string) => {
  if (typeof document === "undefined") return fallback;
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
};
export function termTheme(): ITheme {
  const text = cssVar("--text", "#0d0d0d");
  return {
    background: "rgba(0,0,0,0)", foreground: text, cursor: text, cursorAccent: cssVar("--bg", "#eae9e9"),
    selectionBackground: cssVar("--sel", "#d3d2d2"),
    black: cssVar("--text-2", "#6e6e6e"), brightBlack: cssVar("--text-2", "#6e6e6e"),
    red: cssVar("--red", "#D64545"), brightRed: cssVar("--red", "#D64545"),
    green: cssVar("--green", "#2F9E5F"), brightGreen: cssVar("--green", "#2F9E5F"),
    yellow: cssVar("--orange", "#D9822B"), brightYellow: cssVar("--orange", "#D9822B"),
    blue: cssVar("--blue", "#2A6FDB"), brightBlue: cssVar("--blue", "#2A6FDB"),
    magenta: cssVar("--purple", "#7A5AF5"), brightMagenta: cssVar("--purple", "#7A5AF5"),
    cyan: cssVar("--blue", "#2A6FDB"), brightCyan: cssVar("--blue", "#2A6FDB"),
    white: text, brightWhite: text,
  };
}
/** The theme, re-read when the app switches light / dark (data-theme or the system setting). */
function useTermTheme(): ITheme {
  const [theme, setTheme] = useState<ITheme>(() => termTheme());
  useEffect(() => {
    const again = () => requestAnimationFrame(() => setTheme(termTheme()));
    const mo = new MutationObserver(again);
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "class"] });
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    mq.addEventListener("change", again);
    return () => { mo.disconnect(); mq.removeEventListener("change", again); };
  }, []);
  return theme;
}
const FONT = () => cssVar("--mono", 'ui-monospace,"SF Mono",Menlo,monospace');

// ---------------------------------------------------------------- one command, read-only
function RunView({ run, active, shown, theme }: { run: AgentRun; active: boolean; shown: boolean; theme: ITheme }) {
  const host = useRef<HTMLDivElement>(null);
  const ref = useRef<{ term: Terminal; fit: FitAddon; written: string } | null>(null);
  const text = `\x1b[90m$ ${run.command}\x1b[0m\n${run.output}`;
  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const term = new Terminal({ scrollback: AGENT_SCROLLBACK, disableStdin: true, convertEol: true, fontFamily: FONT(), fontSize: 12, lineHeight: 1.25, theme, cursorBlink: false, allowTransparency: true, cursorInactiveStyle: "none" });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.loadAddon(new SearchAddon());
    term.open(el);
    try { if (el.offsetWidth > 0) fit.fit(); } catch { /* hidden */ }
    ref.current = { term, fit, written: "" };
    const ro = new ResizeObserver(() => { if (el.offsetWidth > 0) { try { fit.fit(); } catch { /* not laid out */ } } });
    ro.observe(el);
    return () => { ro.disconnect(); term.dispose(); ref.current = null; };
  }, []);  // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (ref.current) ref.current.term.options.theme = theme; }, [theme]);
  // Output only grows while a command runs; anything else (a replay) redraws the tab.
  useEffect(() => {
    const r = ref.current;
    if (!r || text === r.written) return;
    if (text.startsWith(r.written)) r.term.write(text.slice(r.written.length));
    else { r.term.reset(); r.term.write(text); }
    r.written = text;
  }, [text]);
  useEffect(() => { const r = ref.current; if (r && active && shown) requestAnimationFrame(() => { try { r.fit.fit(); } catch { /* hidden */ } }); }, [active, shown]);
  return <div ref={host} className="xt ro" hidden={!active} />;
}

// ---------------------------------------------------------------- the panel
const secs = (ms: number) => Math.max(0, Math.round(ms / 1000));
const clock = (sec: number) => new Date(sec * 1000).toLocaleTimeString([], { hour12: false });

export function AgentRunsPanel({ session, chat, collapsed, onToggle }: AgentRunsPanelProps) {
  const t = useT();
  const theme = useTermTheme();
  const [tab, setTab] = useState<"runs" | "out">("runs");
  const [active, setActive] = useState<string | null>(null);
  // The agent's commands, from the chat view; a clock ticks while one runs or lingers.
  const handle = useChatSession(chat, session);
  const view = session ? handle.view ?? chatViewOf(session) ?? null : null;
  const seenDone = useRef(new Map<string, number>());
  const [now, setNow] = useState(() => Date.now());
  const runs = useMemo(() => agentRunsOf(view, now, seenDone.current), [view, now]);
  const ticking = runs.length > 0;
  useEffect(() => { if (!ticking) return; const tm = window.setInterval(() => setNow(Date.now()), 1000); return () => window.clearInterval(tm); }, [ticking]);
  const running = runs.filter((r) => !r.done);
  const agent = session ? splitKey(session)?.agent : undefined;
  // A new command takes the stage.
  const newest = running[running.length - 1]?.tool_id;
  useEffect(() => { if (newest) setActive(newest); }, [newest]);
  const current = active && runs.some((r) => r.tool_id === active) ? active : runs[runs.length - 1]?.tool_id ?? null;
  const curRun = runs.find((r) => r.tool_id === current);
  const log = useMemo(() => agentLogOf(view, clock), [view]);
  const shown = !collapsed && tab === "runs";
  const open = (k: "runs" | "out") => { setTab(k); if (collapsed) onToggle(); };

  return (
    <div className={`panel tpanel${collapsed ? " min" : ""}`}>
      <div className="ptabs">
        <button type="button" className={tab === "runs" && !collapsed ? "on" : ""} onClick={() => open("runs")}><Icon name="term" size={13} />{t("命令")} <span className="n">{runs.length || ""}</span></button>
        <button type="button" className={tab === "out" && !collapsed ? "on" : ""} onClick={() => open("out")}>{t("输出")}</button>
        {collapsed && running.length > 0 && <span className="prun" title={running[running.length - 1].command}><span className="dotc" />{t("Agent · {cmd} 在跑", { cmd: running[running.length - 1].summary })}</span>}
        <span className="sp" />
        <div className="tools">
          <button type="button" onClick={onToggle} title={collapsed ? t("展开") : t("收起")} aria-label={collapsed ? t("展开") : t("收起")}><Icon name={collapsed ? "up" : "down"} /></button>
        </div>
      </div>
      <div className="pbody" hidden={tab !== "runs"}>
        <div className="tstack">
          {!runs.length && <div className="tnote muted">{session ? t("Agent 跑的命令会列在这里，只读。") : t("这里显示应用内对话里 Agent 跑的命令；这段会话现在不在 Dispatch 里跑。")}</div>}
          {runs.map((r) => <RunView key={r.tool_id} run={r} active={current === r.tool_id} shown={shown} theme={theme} />)}
          {curRun && <div className="trun" role="status">{curRun.done
            ? (curRun.ok ? t("Agent 跑完了 · {d}，只读", { d: `${secs(curRun.duration_ms ?? 0)}s` }) : t("Agent 的命令失败了（{code}），只读", { code: curRun.exit_code ?? "?" }))
            : <><span className="pulse" />{agent === "claude-code" ? t("Agent 在跑 · {s}s，只读；Claude 跑完才给输出", { s: secs(now - curRun.started * 1000) }) : t("Agent 在跑 · {s}s，只读", { s: secs(now - curRun.started * 1000) })}</>}</div>}
        </div>
        {runs.length > 0 && <div className="tlist" role="listbox" aria-label={t("Agent 跑的命令")}>
          {runs.map((r) => <div key={r.tool_id} role="option" aria-selected={current === r.tool_id} className={`agent${current === r.tool_id ? " on" : ""}`} onClick={() => setActive(r.tool_id)} title={r.command}>
            <span className={`av sm ${agent === "codex" ? "codex" : "claude"}`}>{agent === "codex" ? "X" : "C"}</span><span className="nm">{t("Agent · {cmd}", { cmd: r.summary })}</span>
            <span className={`dotc${r.done ? " gray" : ""}${r.done && r.ok === false ? " bad" : ""}`} title={r.done ? t("跑完了，{m} 分钟后收起", { m: Math.max(1, Math.ceil((AGENT_TAB_LINGER_MS - (now - (r.started * 1000 + (r.duration_ms ?? 0)))) / 60000)) }) : t("在跑")} />
          </div>)}
        </div>}
      </div>
      <div className="pbody one" hidden={tab !== "out"}><div className="tout mono">{log.length ? log.map((l, i) => <div key={i}>{l}</div>) : <span className="muted">{session ? t("这段会话还没有 Agent 事件。") : t("这里只显示应用内对话的 Agent 事件；这段会话现在不在 Dispatch 里跑。")}</span>}</div></div>
    </div>
  );
}
