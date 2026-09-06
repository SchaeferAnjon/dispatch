import { useEffect, useState } from "react";
import type { Api } from "../api";
import type { Host, RulesStatus } from "../types";
import { HostPicker, hostReason } from "./HostPicker";
import { Markdown } from "./Markdown";

interface Props { api: Api; hosts: Host[]; onDone: (m: string) => void; onError: (m: string) => void }

const AGENT_LABEL: Record<string, string> = { claude: "Claude Code", codex: "Codex", pi: "pi", zcode: "ZCode", qoder: "Qoder" };
const STATE_LABEL: Record<string, { text: string; cls: string }> = {
  synced: { text: "已同步", cls: "done" }, stale: { text: "过期", cls: "prog" }, absent: { text: "未写入", cls: "block" }, missing: { text: "文件不存在", cls: "block" },
};
const parseJson = <T,>(s: string, fallback: T): T => { try { const i = Math.min(...[s.indexOf("{"), s.indexOf("[")].filter((x) => x >= 0)); return JSON.parse(s.slice(i)); } catch { return fallback; } };

// One markdown file is the rule set for every agent on a machine; each agent's own
// instruction file only carries a managed block that mirrors it. Every call goes through
// `dispatch [--host X] rules …`, so the same editor works for any Mac in hosts.json.
export function RulesView({ api, hosts, onDone, onError }: Props) {
  const [host, setHost] = useState("local");
  const [content, setContent] = useState("");
  const [status, setStatus] = useState<RulesStatus | null>(null);
  const [draft, setDraft] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const blocked = hostReason(hosts, host);

  const load = async () => {
    if (blocked) { setContent(""); setStatus(null); return; }
    try {
      const [c, s] = await Promise.all([api.on(host, ["rules", "show"]), api.on(host, ["rules", "status", "--json"])]);
      setContent(c); setStatus(parseJson<RulesStatus | null>(s, null));
    } catch (e) { onError(String(e)); }
  };
  useEffect(() => { setDraft(null); load(); }, [api, host, blocked]);

  const save = async () => {
    if (draft === null) return;
    setBusy(true);
    try { await api.on(host, ["rules", "write"], draft); setDraft(null); onDone(`规则已保存并同步到${host === "local" ? "本机" : hosts.find((h) => h.id === host)?.name}的所有 Agent（新会话生效）`); await load(); } catch (e) { onError(String(e)); } finally { setBusy(false); }
  };
  const sync = async () => {
    setBusy(true);
    try { await api.on(host, ["rules", "sync", "--force", "--json"]); onDone("已重新写入所有 Agent 的指令文件"); await load(); } catch (e) { onError(String(e)); } finally { setBusy(false); }
  };
  const stale = status?.targets.filter((t) => t.state !== "synced").length ?? 0;

  return (
    <div className="rules-wrap" style={{ flexDirection: "column" }}>
      <HostPicker hosts={hosts} value={host} onChange={setHost} />
      <div style={{ display: "flex", flex: 1, minHeight: 0 }}>
      <div className="rules-side">
        <h4>改一处，同步到</h4>
        {status?.targets.map((t) => {
          const st = STATE_LABEL[t.state] ?? { text: t.state, cls: "open" };
          return (
            <div key={t.agent} className="rule-target">
              <div className="l1"><b>{AGENT_LABEL[t.agent] ?? t.agent}</b><span className={`st sm ${st.cls}`}>{st.text}</span></div>
              <div className="mono small muted">{t.path.replace(/^\/Users\/[^/]+/, "~")}</div>
              <div className="small muted">{t.mode === "import" ? "用 @import 引用（不复制内容）" : "内容内联在托管块里"}</div>
            </div>
          );
        })}
        <div className="rules-actions">
          <button className={`btn sm${stale ? " primary" : ""}`} disabled={busy || !!blocked} onClick={sync}>{stale ? `同步（${stale} 个未更新）` : "重新同步"}</button>
        </div>
        <p className="small muted">Agent 自己也能查：<span className="mono">dispatch [--host mini] rules show|status|sync</span></p>
      </div>
      <div className="sess-main">
        <div className="sess-head">
          <div style={{ minWidth: 0, flex: 1 }}>
            <div className="ttl">{host === "local" ? "这台电脑" : hosts.find((h) => h.id === host)?.name}上所有 Agent 的共同规则</div>
            <div className="sub mono" title={status?.source}>{status?.source?.replace(/^\/Users\/[^/]+/, "~") ?? "…"}{status?.hash ? ` · 版本 ${status.hash}` : ""}</div>
          </div>
          {draft === null ? <button className="btn primary sm" disabled={!!blocked || !content} onClick={() => setDraft(content)}>在这里改</button> : (
            <>
              <button className="btn ghost sm" onClick={() => setDraft(null)}>放弃</button>
              <button className="btn primary sm" disabled={busy || draft === content} onClick={save}>保存并同步 ⌘S</button>
            </>
          )}
        </div>
        <div className="sess-body">
          {blocked ? <div className="empty">{blocked}</div> : draft === null ? (content ? <Markdown src={content} /> : <div className="empty">读取中…</div>) : (
            <textarea className="skill-edit" value={draft} onChange={(e) => setDraft(e.target.value)} spellCheck={false}
              onKeyDown={(e) => { if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") { e.preventDefault(); save(); } if (e.key === "Escape") setDraft(null); }} />
          )}
        </div>
      </div>
      </div>
    </div>
  );
}
