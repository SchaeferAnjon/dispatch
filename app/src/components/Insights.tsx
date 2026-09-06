import { useEffect, useState } from "react";
import type { Api } from "../api";
import type { Insights } from "../types";

interface Props { api: Api; onDone: (m: string) => void; onError: (m: string) => void }

// The cross-agent "/insights": how the agents behaved lately — unanswered confirmation
// questions, user corrections, context overflows, over-long sessions — with samples,
// and one button that hands an agent the job of turning that into rule/skill changes.
export function InsightsCard({ api, onDone, onError }: Props) {
  const [days, setDays] = useState(14);
  const [r, setR] = useState<Insights | null>(null);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState<"asktail" | "correction" | null>(null);

  useEffect(() => {
    let alive = true; setBusy(true);
    api.insights(days).then((x) => { if (alive) setR(x); }).catch((e) => onError(String(e))).finally(() => alive && setBusy(false));
    return () => { alive = false; };
  }, [api, days]);

  const improve = async () => {
    if (!r) return;
    try { await navigator.clipboard.writeText(r.command); onDone("改进任务的启动命令已复制：在终端粘贴运行，Agent 会读样本、改规则/技能并把结论写进知识库"); }
    catch { onDone("剪贴板不可用；命令：" + r.command.slice(0, 120) + "…"); }
  };
  const tot = (k: keyof NonNullable<Insights["per_agent"][string]>) => Object.values(r?.per_agent ?? {}).reduce((a, b) => a + (b[k] as number), 0);

  return (
    <section className="st-card ins">
      <h4>洞察<span className="muted">最近 {days} 天 · {r?.total_sessions ?? 0} 个会话</span>
        <span className="spacer" />
        <span className="views">{[7, 14, 30].map((d) => <button key={d} className={days === d ? "on" : ""} onClick={() => setDays(d)}>{d} 天</button>)}</span>
        <button className="btn primary sm" disabled={!r || busy} onClick={improve}>✦ 生成改进任务</button>
      </h4>
      {busy && !r && <div className="empty small">读会话中…</div>}
      {r && (
        <>
          <div className="ins-tiles">
            <button className={`tile${open === "asktail" ? " on" : ""}`} onClick={() => setOpen(open === "asktail" ? null : "asktail")}><b>{tot("asktail")}</b><span>问句/选项收尾</span><small>{r.samples.asktail.length}+ 次没被回答</small></button>
            <button className={`tile${open === "correction" ? " on" : ""}`} onClick={() => setOpen(open === "correction" ? null : "correction")}><b>{tot("correction")}</b><span>用户纠错/催促</span><small>点开看样本</small></button>
            <div className="tile"><b>{tot("overflow")}</b><span>上下文溢出</span><small>{tot("long")} 个会话超 60 轮</small></div>
            <div className="tile"><b>{tot("ends_on_question")}</b><span>停在问句上</span><small>{tot("continue")} 次「继续」</small></div>
          </div>
          <ul className="ins-findings">{r.findings.map((f, i) => <li key={i}>{f}</li>)}</ul>
          {open && (
            <div className="ins-samples">
              {r.samples[open].length === 0 && <div className="empty small">没有样本</div>}
              {r.samples[open].slice().reverse().map((s, i) => (
                <div key={i} className="smp">
                  <div className="who mono muted">{s.agent} · {s.session_id.slice(0, 8)} · {s.ts}</div>
                  <div className="a">助手…{s.assistant.slice(-160)}</div>
                  <div className="u">用户：{s.user.slice(0, 140)}</div>
                </div>
              ))}
            </div>
          )}
          <div className="muted small">按 Agent：{Object.entries(r.per_agent).map(([a, c]) => `${a} ${c.sessions} 会话 · 纠错 ${c.correction} · 问句 ${c.asktail}`).join("　")}</div>
        </>
      )}
    </section>
  );
}
