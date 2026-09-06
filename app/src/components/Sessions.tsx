import { useEffect, useMemo, useState } from "react";
import type { Api } from "../api";
import { actorOf, durSince, fmtTime, NO_RESUME, projectColor, relTime } from "../derive";
import { lineDiff, withContext } from "../diff";
import type { Session, SessionDetail, SessionRef } from "../types";
import { Avatar } from "./ui";
import { Markdown } from "./Markdown";

interface Props { api: Api; me: string; live: Session[]; onSelectTask: (id: string) => void; onDone: (m: string) => void; onError: (m: string) => void; initialId?: string | null; hostId?: string }

const ENTRY: Record<string, string> = { cli: "终端", desktop: "桌面端", sdk: "SDK", "vscode-extension": "VS Code" };

export function SessionsView({ api, me, live, onSelectTask, onDone, onError, initialId, hostId }: Props) {
  const [refs, setRefs] = useState<SessionRef[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [q, setQ] = useState("");
  const [agent, setAgent] = useState<string>("");
  const [host, setHost] = useState<string>("");
  useEffect(() => { setHost(hostId ?? ""); }, [hostId]);
  const [sel, setSel] = useState<string | null>(initialId ?? null);
  const [detail, setDetail] = useState<SessionDetail | null>(null);
  const [tab, setTab] = useState<"timeline" | "files" | "tasks">("timeline");
  const [busy, setBusy] = useState(false);
  // Which kinds of turns to show. Tools off by default: the conversation is the point.
  const [kinds, setKinds] = useState<Record<"user" | "assistant" | "tool", boolean>>(() => { try { return { user: true, assistant: true, tool: false, ...JSON.parse(localStorage.getItem("dispatch-tl-kinds") || "{}") }; } catch { return { user: true, assistant: true, tool: false }; } });
  const flip = (k: "user" | "assistant" | "tool") => { const v = { ...kinds, [k]: !kinds[k] }; setKinds(v); try { localStorage.setItem("dispatch-tl-kinds", JSON.stringify(v)); } catch { /* ignore */ } };

  const load = async () => { try { setRefs(await api.sessionList()); setLoaded(true); } catch (e) { onError(String(e)); } };
  useEffect(() => { load(); const t = window.setInterval(load, 60_000); return () => window.clearInterval(t); }, [api]);
  useEffect(() => {
    if (!sel) { setDetail(null); return; }
    let alive = true;
    setBusy(true);
    api.sessionDetail(sel).then((d) => { if (alive) setDetail(d); }).catch((e) => onError(String(e))).finally(() => alive && setBusy(false));
    return () => { alive = false; };
  }, [sel, api]);

  const items = useMemo(() => {
    const qq = q.trim().toLowerCase();
    return refs.filter((r) => (!agent || r.agent === agent) && (!host || (r.host ?? "local") === host) && (!qq || (r.title || "").toLowerCase().includes(qq) || r.cwd.toLowerCase().includes(qq) || r.session_id.startsWith(qq) || Object.keys(r.tasks).some((t) => t.includes(qq))));
  }, [refs, q, agent, host]);
  const hostList = useMemo(() => { const m = new Map<string, string>(); for (const r of refs) if (r.host) m.set(r.host, r.host_name ?? r.host); return [...m.entries()]; }, [refs]);

  const liveOf = (id: string) => live.find((s) => s.session_id === id);
  const copy = async (cmd: string) => { try { await api.copy(cmd); onDone("恢复命令已复制，去终端粘贴回车"); } catch (e) { onError(String(e)); } };
  const focus = async (id: string) => { try { onDone(await api.focusSession(id)); } catch (e) { onError(String(e)); } };

  return (
    <div className="sess-wrap">
      <div className="sess-side">
        <div className="sess-tools">
          <label className="search" style={{ width: "100%" }}>🔍<input placeholder="标题、目录、任务 ID…" value={q} onChange={(e) => setQ(e.target.value)} /></label>
          <div className="views" style={{ marginTop: 6 }}>
            {[["", "全部"], ["claude-code", "Claude"], ["codex", "Codex"], ["pi", "pi"], ["zcode", "ZCode"], ["qoder", "Qoder"], ["qoder-ide", "Qoder IDE"]].map(([v, l]) => <button key={v} className={agent === v ? "on" : ""} onClick={() => setAgent(v)}>{l}</button>)}
            <span className="spacer" /><span className="muted mono small">{items.length}</span>
          </div>
          {hostList.length > 1 && (
            <div className="views" style={{ marginTop: 4 }} title="哪台机器上的聊天记录">
              <button className={host === "" ? "on" : ""} onClick={() => setHost("")}>两台都看</button>
              {hostList.map(([id, name]) => <button key={id} className={host === id ? "on" : ""} onClick={() => setHost(id)}>{name}</button>)}
            </div>
          )}
        </div>
        <div className="sess-items">
          {!loaded && <div className="empty">索引中…（首次要读完全部历史）</div>}
          {loaded && items.length === 0 && <div className="empty">没有匹配的会话</div>}
          {items.map((r) => {
            const a = actorOf(r.agent, me);
            const l = liveOf(r.session_id);
            return (
              <button key={r.session_id} className={`sess-item${sel === r.session_id ? " sel" : ""}`} onClick={() => { setSel(r.session_id); setTab("timeline"); }}>
                <div className="l1"><Avatar actor={a} /><span className="t">{r.title || "（无标题）"}</span>{l && <span className={`st sm ${l.state === "working" ? "prog" : "done"}`}>{l.state === "working" ? "在跑" : "开着"}</span>}</div>
                <div className="l2"><span className="proj" style={{ background: projectColor(r.project) }} />{r.project || "?"}{r.remote && <span className="host-chip">{r.host_name}</span>}<span className="muted">· {ENTRY[r.entrypoint] ?? r.entrypoint ?? ""} · {r.user_msgs} 轮{r.subagents.length ? ` · ${r.subagents.length} 子` : ""}</span><span className="ago mono">{relTime(new Date(r.last_at * 1000).toISOString())}</span></div>
                {r.current_task && <div className="l3 mono">正在做 {r.current_task}</div>}
              </button>
            );
          })}
        </div>
      </div>

      <div className="sess-main">
        {!sel && <div className="empty">选一个会话。这里能看到它做了什么、改了哪些文件、派了哪些子 Agent，以及怎么恢复它。</div>}
        {sel && !detail && <div className="empty">{busy ? "读取对话记录…" : ""}</div>}
        {detail && (() => {
          const m = detail.meta; const a = actorOf(m.agent, me); const l = liveOf(m.session_id);
          return (
            <>
              <div className="sess-head">
                <Avatar actor={a} size={28} />
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div className="ttl">{m.title || "（无标题）"}</div>
                  <div className="sub mono">{m.cwd}{m.branch ? ` · ${m.branch}` : ""} · {m.session_id}</div>
                </div>
                {(l || NO_RESUME.has(m.agent)) && <button className="btn primary sm" onClick={() => focus(m.session_id)} title={l?.herdr ? `Herdr ${l.herdr.tab_id}` : l?.source_app ?? "ZCode"}>打开会话</button>}
                {!NO_RESUME.has(m.agent) && <button className="btn sm" onClick={() => copy(m.resume_cmd)} title={m.resume_cmd}>复制恢复命令</button>}
              </div>
              <div className="sess-meta kv">
                <b>开始</b><span className="mono">{m.first_ts ? fmtTime(m.first_ts) : "?"}</span>
                <b>最近</b><span className="mono">{m.last_ts ? `${fmtTime(m.last_ts)}（${durSince(m.last_at)}前）` : "?"}</span>
                <b>来源</b><span>{ENTRY[m.entrypoint] ?? m.entrypoint ?? "?"}{l ? ` · ${l.source_app}` : ""}{m.remote && <span className="host-chip">{m.host_name}</span>}</span>
                <b>对话</b><span>{m.user_msgs} 轮 · {m.assistant_msgs} 次回复 · {(m.size / 1e6).toFixed(1)} MB</span>
                <b>工具</b><span className="mono small">{Object.entries(detail.tool_counts).sort((x, y) => y[1] - x[1]).slice(0, 8).map(([k, v]) => `${k} ${v}`).join(" · ") || "—"}</span>
                {m.subagents.length > 0 && (<><b>子 Agent</b><span className="subs">{m.subagents.map((s) => <span key={s.agent_id} className="sub-chip" title={s.path}>↳ <b>{s.type}</b> {s.description}<span className="muted mono"> · {(s.size / 1e3).toFixed(0)} KB</span></span>)}</span></>)}
              </div>
              <div className="views" style={{ padding: "0 16px", borderBottom: "1px solid var(--line)" }}>
                <button className={tab === "timeline" ? "on" : ""} onClick={() => setTab("timeline")}>时间线 {detail.messages.length}</button>
                <button className={tab === "files" ? "on" : ""} onClick={() => setTab("files")}>改动 {detail.files.length}</button>
                <button className={tab === "tasks" ? "on" : ""} onClick={() => setTab("tasks")}>任务 {Object.keys(m.tasks).length}</button>
                {tab === "timeline" && (() => {
                  const nU = detail.messages.filter((x) => x.role === "user").length;
                  const nA = detail.messages.filter((x) => x.role === "assistant" && x.text.trim()).length;
                  const nT = detail.messages.reduce((s, x) => s + x.tools.length + (x.role === "tool" ? 1 : 0), 0);
                  return (
                    <span className="kinds" title="点一下切换显示哪类内容">
                      <button className={`chip${kinds.user ? " on" : ""}`} onClick={() => flip("user")}>你 <span className="mono muted">{nU}</span></button>
                      <button className={`chip${kinds.assistant ? " on" : ""}`} onClick={() => flip("assistant")}>{a?.name ?? "Agent"} <span className="mono muted">{nA}</span></button>
                      <button className={`chip${kinds.tool ? " on" : ""}`} onClick={() => flip("tool")}>工具调用 <span className="mono muted">{nT}</span></button>
                    </span>
                  );
                })()}
              </div>
              <div className="sess-body">
                {tab === "timeline" && (() => {
                  const showTools = kinds.tool;
                  const list = detail.messages.filter((x) => x.role === "gap" || (x.role === "user" && kinds.user) || (x.role === "assistant" && (x.text.trim() ? kinds.assistant : kinds.tool)) || (x.role === "tool" && kinds.tool));
                  return list.map((x, i) => (
                    <div key={i} className={`tl ${x.role}`}>
                      {x.role === "gap" ? <div className="muted">{x.text}</div> : (
                        <>
                          <div className="tl-h"><b>{x.role === "user" ? "你" : x.role === "tool" ? "工具" : a?.name}</b><span className="mono muted small">{x.ts ? fmtTime(x.ts) : ""}</span></div>
                          {x.text && (x.role === "assistant" ? <div className="tl-t"><Markdown src={x.text} className="compact" /></div> : <div className="tl-t sel-text">{x.text}</div>)}
                          {showTools && x.tools.length > 0 && <div className="tl-tools">{x.tools.map((t, j) => <span key={j} className="tool-chip" title={t.summary}><b>{t.name}</b>{t.summary ? ` ${t.summary.slice(0, 80)}` : ""}</span>)}</div>}
                        </>
                      )}
                    </div>
                  ));
                })()}
                {tab === "files" && detail.files.length === 0 && <div className="empty">这个会话没有通过 Edit / Write 改文件</div>}
                {tab === "files" && detail.files.map((f) => (
                  <details key={f.path} className="fdiff" open={detail.files.length <= 3}>
                    <summary><span className="mono">{f.path.replace(/^\/Users\/[^/]+/, "~")}</span><span className="muted"> · {f.changes.length} 处</span></summary>
                    {f.changes.map((c, i) => (
                      <div key={i} className="hunk">
                        <div className="hunk-h muted small">{c.kind === "write" ? "写入整个文件" : c.kind === "patch" ? `${c.op ?? "修改"}${c.add !== undefined ? ` · +${c.add} −${c.del ?? 0}` : ""}` : "编辑"}{c.ts ? ` · ${fmtTime(c.ts)}` : ""}</div>
                        {c.kind === "patch"
                          ? <pre className="diff">{c.new ? c.new.split("\n").map((ln, k) => <div key={k} className={`ln ${ln.startsWith("+") && !ln.startsWith("+++") ? "add" : ln.startsWith("-") && !ln.startsWith("---") ? "del" : "same"}`}>{ln}</div>) : <div className="skip">补丁内容没存下来</div>}</pre>
                          : <pre className="diff">{withContext(lineDiff(c.old, c.new)).map((ln, k) => ln.kind === "skip" ? <div key={k} className="skip">… {ln.count} 行未变 …</div> : <div key={k} className={`ln ${ln.kind}`}>{ln.kind === "add" ? "+" : ln.kind === "del" ? "-" : " "} {ln.text}</div>)}</pre>}
                      </div>
                    ))}
                  </details>
                ))}
                {tab === "tasks" && (Object.keys(m.tasks).length === 0 ? <div className="empty">对话里没提到任务 ID</div> : (
                  <div className="task-links">{Object.entries(m.tasks).sort((x, y) => y[1] - x[1]).map(([id, n]) => <button key={id} className="chip" onClick={() => onSelectTask(id)}><span className="mono">{id}</span><span className="muted">{n} 次</span>{m.current_task === id && <span className="st sm prog">最后认领</span>}</button>)}</div>
                ))}
              </div>
            </>
          );
        })()}
      </div>
    </div>
  );
}
