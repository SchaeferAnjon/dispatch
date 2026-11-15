// A folder in Dispatch IDE without a conversation: the same composer, with the Agent to start
// (Claude Code or Codex), its models (the catalog Dispatch's new-Agent page reads) and its
// permission levels. The first message opens the chat in chatd, like Dispatch's 新建 Agent.
import { useEffect, useState } from "react";
import type { Host } from "../types";
import type { ChatAgent, PermissionMode } from "../chatProtocol";
import { useT } from "../i18n";
import { initialOf, modelKind, modelName, useModels } from "../models";
import { isInstalled } from "../installedAgents";
import { ModelSelect } from "../components/ModelSelect";
import { AGENT_NAMES, SendButton, modesFor } from "../components/ChatComposer";
import { startInDispatch } from "../components/NewChat";
import { LiveLine } from "../components/ChatPage";
import { ConvStatus } from "../components/SessionActions";
import { api, send } from "./bridge";

const AGENT_KEY = "dispatch-ide-agent";
const CHAT_AGENTS = Object.keys(AGENT_NAMES) as ChatAgent[];

export function NewConversation({ root, hosts }: { root: string; hosts: Host[] }) {
  const t = useT();
  const [agent, setAgent] = useState<ChatAgent>(() => { try { const a = localStorage.getItem(AGENT_KEY); return a === "codex" ? "codex" : "claude-code"; } catch { return "claude-code"; } });
  const [model, setModel] = useState("");
  const [mode, setMode] = useState<PermissionMode>("default");
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  // sent at once: the message shows above the box, which empties, while the Agent starts
  const [pending, setPending] = useState<string | null>(null);
  const [at, setAt] = useState(0);
  const [, tick] = useState(0);
  useEffect(() => { if (pending === null || err) return; const tm = window.setInterval(() => tick((n) => n + 1), 1000); return () => window.clearInterval(tm); }, [pending, err]);
  const catalog = useModels(api, "local");
  const pickAgent = (a: ChatAgent) => {
    setAgent(a); setModel("");
    if (!modesFor(a).some(([v]) => v === mode)) setMode("default");
    try { localStorage.setItem(AGENT_KEY, a); } catch { /* private mode */ }
  };
  const start = async () => {
    const msg = text.trim();
    if (!msg || busy) return;
    setBusy(true); setErr(""); setPending(msg); setText(""); setAt(Date.now() / 1000);
    try {
      const session = await startInDispatch(api, { agent, cwd: root, model, permission_mode: mode }, msg);
      send({ kind: "opened", session });
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); setBusy(false); }
  };
  const retry = () => { if (pending) { setText(pending); setPending(null); setErr(""); } };
  return <div className="ic ic-new">
    {pending === null ? <p className="ic-new-hint">{t("这个文件夹还没有对话，第一句话发出去才启动 Agent。")}</p>
      : <div className="ic-pending">
        <div className="turn you"><div className="bubble-row"><div className="bubble sel-text">{pending}</div></div></div>
        {err ? <div className="ic-failed"><span>{t("没发出去：{error}", { error: err })}</span><button type="button" className="lk" onClick={retry}>{t("重发")}</button></div>
          : <LiveLine label={t("正在启动 Agent")} secs={Math.max(0, Math.round(Date.now() / 1000 - at))} />}
      </div>}
    <div className="composer chat-composer">
      <div className="cbox">
        <textarea className="ta" rows={3} autoFocus value={text} disabled={busy} aria-label={t("回复内容")} placeholder={t("说这次想做什么")}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void start(); } }} />
        <div className="tools">
          <label className="dd dd-agent" data-agent={agent} title={AGENT_NAMES[agent]}>
            <select aria-label={t("Agent")} value={agent} disabled={busy} onChange={(e) => pickAgent(e.target.value as ChatAgent)}>
              {CHAT_AGENTS.map((a) => <option key={a} value={a} disabled={!isInstalled(a)}>{AGENT_NAMES[a]}</option>)}
            </select>
          </label>
          <label className="dd dd-model" data-short={initialOf(modelName(catalog[modelKind(agent)], model), catalog[modelKind(agent)])} title={modelName(catalog[modelKind(agent)], model) || t("默认")}><ModelSelect options={catalog[modelKind(agent)]} value={model} disabled={busy} onChange={setModel} /></label>
          <label className="dd dd-perm" title={t(modesFor(agent).find(([v]) => v === mode)?.[1] ?? "权限模式")}>
            <select aria-label={t("权限模式")} value={mode} disabled={busy} onChange={(e) => setMode(e.target.value as PermissionMode)}>
              {modesFor(agent).map(([v, l]) => <option key={v} value={v}>{t(l)}</option>)}
            </select>
          </label>
          <span className="sp" />
          <SendButton disabled={busy || !text.trim()} onClick={() => void start()} label={t("发送")} title={t("发送并启动 Agent（↵）")} />
        </div>
      </div>
      <div className="cstat-row"><ConvStatus agent={agent} host={hosts.find((h) => h.local)?.name || t("本机")} cwd={root} state={t("还没开始")} tone="idle" /></div>
    </div>
  </div>;
}
