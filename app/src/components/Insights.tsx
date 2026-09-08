import { useCallback, useEffect, useState } from "react";
import { isTauri, type Api, type AgentStartInput } from "../api";
import type { InsightReport, InsightReportList, Insights } from "../types";

interface Props {
  api: Api; host?: string;
  onStart?: (input: AgentStartInput) => Promise<unknown>;
  // Preferred over onStart: opens the 派活 dialog prefilled, so the click always shows something.
  onDelegate?: (prompt: string, label: string) => void;
  onOpenSession?: (id: string) => void;
  onDone: (m: string) => void; onError: (m: string) => void;
}

// Last answers, kept for the life of the page so reopening 统计 paints at once and refreshes behind.
const memo: { signals: Map<number, Insights>; list: InsightReportList | null; reports: Map<string, InsightReport> } = { signals: new Map(), list: null, reports: new Map() };

const KIND_LABEL: Record<string, string> = { correction: "纠错多", overflow: "上下文溢出", tool_errors: "工具报错", no_board: "没上板", long: "超长" };
const CADENCE: [number, string][] = [[0, "不自动"], [7, "每 7 天"], [14, "每 14 天"], [30, "每 30 天"]];

// The cross-agent /insights. Top: the model-written report — like Claude Code's own
// /insights page, but over every agent's sessions — dated, generated on a cadence or by
// hand, each section a one-paragraph overview that expands to its items, and the full page
// one click away. Below: the raw signal counts it was fed, the per-session alerts, and the
// button that hands an agent the job of turning the findings into rule/skill changes.
export function InsightsCard({ api, host, onStart, onDelegate, onOpenSession, onDone, onError }: Props) {
  const [days, setDays] = useState(14);
  const [r, setR] = useState<Insights | null>(() => memo.signals.get(14) ?? null);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState<"asktail" | "correction" | "rules" | null>(null);
  const [tick, setTick] = useState(0);
  const [seenOpen, setSeenOpen] = useState(false);

  useEffect(() => {
    let alive = true;
    const cached = memo.signals.get(days);
    if (cached) setR(cached); else setBusy(true);
    api.insights(days).then((x) => { if (x) memo.signals.set(days, x); if (alive) setR(x); }).catch((e) => onError(String(e))).finally(() => alive && setBusy(false));
    return () => { alive = false; };
  }, [api, days, tick]);

  // ---- the report
  const [list, setList] = useState<InsightReportList | null>(memo.list);
  const [rep, setRep] = useState<InsightReport | null>(() => { const mine = memo.list?.reports.find((x) => x.source === "dispatch" && !x.error); return mine ? memo.reports.get(mine.id) ?? null : null; });
  const [repId, setRepId] = useState<string>("latest");
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [history, setHistory] = useState(false);
  const refresh = useCallback(async () => {
    try {
      const l = await api.insightReports(); memo.list = l; setList(l);
      const mine = l.reports.filter((x) => x.source === "dispatch" && !x.error);
      const want = repId === "latest" ? mine[0]?.id : repId;
      if (!want) { setRep(null); return; }
      if (memo.reports.has(want)) setRep(memo.reports.get(want)!);
      else { const x = await api.insightReport(want); if (x) memo.reports.set(want, x); setRep(x); }
    } catch (e) { onError(String(e)); }
  }, [api, repId, onError]);
  useEffect(() => { void refresh(); }, [refresh]);
  // While a run is in flight, poll until it lands.
  useEffect(() => {
    if (!list?.running) return;
    const t = window.setInterval(() => void refresh(), 8_000);
    return () => window.clearInterval(t);
  }, [list?.running, refresh]);
  const generate = async () => { try { await api.insightGenerate(days); onDone(`开始生成最近 ${days} 天的报告，一般 1–3 分钟`); await refresh(); } catch (e) { onError(String(e)); } };
  const schedule = async (every: number) => { try { await api.insightSchedule(every); onDone(every ? `每 ${every} 天自动生成一份` : "已关闭自动生成"); await refresh(); } catch (e) { onError(String(e)); } };
  // The desktop opens the file; the phone/browser gets the same page from the serve route.
  const openHtml = (row: { id: string; html: string }) => {
    if (isTauri) { api.openPath(row.html).catch((e) => onError(String(e))); return; }
    window.open(`/insights/${encodeURIComponent(row.id)}.html`, "_blank", "noopener");
  };
  const toggle = (k: string) => setExpanded((s) => { const n = new Set(s); if (n.has(k)) n.delete(k); else n.add(k); return n; });
  const allOpen = rep?.report ? rep.report.sections.every((s) => expanded.has(s.key)) : false;

  // ---- hand-off to an agent
  const [starting, setStarting] = useState(false);
  const improve = async () => {
    if (!r) return;
    const label = "跨 Agent 复盘改进";
    const prompt = rep?.report ? `${r.prompt}\n\n已有一份模型写好的洞察报告（${rep.created_at}，最近 ${rep.days} 天）：\`dispatch insights show ${rep.id} --json\`，先读它的 friction 和 suggestions 两节，按建议落地，不要重复分析。` : r.prompt;
    if (onDelegate) { onDelegate(prompt, label); return; }
    if (onStart) {
      setStarting(true);
      try { await onStart({ kind: "claude", host: host && host !== "local" ? host : "", prompt, label }); }
      catch (e) { onError(String(e)); }
      finally { setStarting(false); }
      return;
    }
    try { await navigator.clipboard.writeText(r.command); onDone("改进任务的启动命令已复制：在终端粘贴运行"); }
    catch { onDone("剪贴板不可用；命令：" + r.command.slice(0, 120) + "…"); }
  };
  const ack = async () => { try { await api.insightsAck(days); setTick((t) => t + 1); onDone("这批洞察已标记为看过；新出现的会再提醒"); } catch (e) { onError(String(e)); } };
  const tot = (k: keyof NonNullable<Insights["per_agent"][string]>) => Object.values(r?.per_agent ?? {}).reduce((a, b) => a + ((b[k] as number) || 0), 0);
  const fresh = (r?.alerts ?? []).filter((a) => !a.seen);
  const seen = (r?.alerts ?? []).filter((a) => a.seen);
  const canStart = !!(onDelegate || onStart);
  const running = list?.running;
  const rows = list?.reports ?? [];
  const latestNative = rows.find((x) => x.source === "claude-code");

  return (
    <section className="st-card ins">
      <h4>洞察<span className="muted">{rep ? `报告生成于 ${rep.created_at} · 最近 ${rep.days} 天 · ${rep.session_count} 个会话` : "还没有报告"}</span>
        <span className="spacer" />
        <label className="ins-cadence muted small">自动<select value={list?.schedule.every_days ?? 0} onChange={(e) => void schedule(Number(e.target.value))}>{CADENCE.map(([d, l]) => <option key={d} value={d}>{l}</option>)}</select></label>
        <span className="views">{[7, 14, 30].map((d) => <button key={d} className={days === d ? "on" : ""} onClick={() => setDays(d)}>{d} 天</button>)}</span>
        <button className="btn sm" disabled={!!running} onClick={generate} title="让模型读最近这段时间所有 Agent 的会话摘要，写一份报告（后台，1–3 分钟）">{running ? `生成中 ${Math.max(0, Math.round((Date.now() / 1000 - running.started) / 60))} 分…` : rep ? "重新生成" : "生成报告"}</button>
        {rep && <button className="btn sm" onClick={() => openHtml({ id: rep.id, html: rows.find((x) => x.id === rep.id)?.html ?? "" })} title="整页打开这份报告（手机上在新标签打开）">整页打开 ↗</button>}
        <button className="btn primary sm" disabled={!r || starting} onClick={improve} title={canStart ? "打开派活窗口：在选定的机器起一个 Claude Code，按报告的建议改规则/技能、把结论写进知识库" : "复制启动命令"}>{starting ? "正在派活…" : canStart ? "✦ 派 Agent 做改进" : "✦ 复制改进命令"}</button>
      </h4>

      {!rep && !running && <div className="ins-empty">
        <p>这里放的是跨 Agent 的复盘报告：模型读最近所有 Agent（Claude Code / Codex / pi / ZCode）的会话摘要，写出「在做什么、怎么用、哪里出问题、建议改什么」，结构和 Claude Code 自带的 /insights 一样，但覆盖全部 Agent。</p>
        <p className="muted small">点「生成报告」手动跑一次；「自动」选一个周期后，Dispatch 开着时到期会自己跑。{latestNative ? <>Claude Code 自己的 /insights 报告（{latestNative.created_at}）也在下面的历史里，可以直接打开。</> : null}</p>
      </div>}
      {running && !rep && <div className="empty small">正在生成第一份报告……读会话、写报告一般 1–3 分钟，页面会自己刷新。</div>}

      {rep?.report && (
        <div className="ins-report">
          <div className="ins-headline">{rep.report.headline}<span className="spacer" /><button className="link sm" onClick={() => setExpanded(allOpen ? new Set() : new Set(rep.report!.sections.map((s) => s.key)))}>{allOpen ? "全部收起" : "全部展开"}</button></div>
          <div className="ins-sections">
            {rep.report.sections.map((s) => {
              const on = expanded.has(s.key);
              return (
                <div key={s.key} className={`ins-sec${on ? " on" : ""}`}>
                  <button className="ins-sec-h" onClick={() => toggle(s.key)} aria-expanded={on}><span className="chev">›</span><b>{s.title}</b><span className="muted small">{s.items.length} 条</span></button>
                  <p className="ins-sec-sum">{s.summary}</p>
                  {on && <div className="ins-items">
                    {s.items.map((it, i) => (
                      <div key={i} className="ins-item">
                        <div className="l1"><b>{it.title}</b>{it.priority && <span className={`st sm ${it.priority === "高" ? "rev" : "open"}`}>{it.priority}</span>}{it.metric && <span className="mono muted small">{it.metric}</span>}</div>
                        {it.detail && <div className="d">{it.detail}</div>}
                        {it.action && <div className="act">改法：{it.action}</div>}
                        {it.evidence && it.evidence.length > 0 && <div className="ev mono small">会话：{it.evidence.map((id, k) => onOpenSession ? <button key={k} className="link" onClick={() => onOpenSession(id)}>{id}</button> : <span key={k}>{id}</span>)}</div>}
                      </div>
                    ))}
                  </div>}
                </div>
              );
            })}
          </div>
        </div>
      )}
      {rep && !rep.report && <div className="err small">上次生成失败：{rep.error}</div>}

      {rows.length > 0 && (
        <details className="ins-history" open={history} onToggle={(e) => setHistory((e.target as HTMLDetailsElement).open)}>
          <summary>历史报告 <span className="muted small">{rows.length} 份 · 含 Claude Code 自带 /insights 的</span></summary>
          <div className="ins-hist-rows">
            {rows.map((x) => (
              <div key={x.id} className={`ins-hist${rep && x.id === rep.id ? " cur" : ""}`}>
                <span className="mono small">{x.created_at}</span>
                <span className={`st sm ${x.source === "claude-code" ? "open" : "prog"}`}>{x.source === "claude-code" ? "Claude Code" : `全部 Agent · ${x.days} 天`}</span>
                <span className="t">{x.error ? `失败：${x.error.slice(0, 80)}` : x.headline}</span>
                {x.source === "dispatch" && !x.error && <button className="link sm" onClick={() => setRepId(x.id)}>在这里看</button>}
                {!x.error && <button className="link sm" onClick={() => openHtml(x)}>整页打开 ↗</button>}
              </div>
            ))}
          </div>
        </details>
      )}

      <details className="ins-signals" open={!rep}>
        <summary>信号统计 <span className="muted small">正则从会话记录里数出来的线索，是报告的输入 · {r?.total_sessions ?? 0} 个会话{busy && r ? " · 更新中…" : ""}</span><span className="spacer" /><button className={`link sm${open === "rules" ? " on" : ""}`} onClick={(e) => { e.preventDefault(); setOpen(open === "rules" ? null : "rules"); }}>{open === "rules" ? "收起规则" : "怎么算的？"}</button></summary>
        {busy && !r && <div className="empty small">读会话中…</div>}
        {open === "rules" && r && (
          <div className="ins-rules">
            <p className="muted small">这些数字不用模型，只按下面的规则从本机的会话记录（Claude Code / Codex / pi / ZCode 的转录）里数出来；每个都是线索不是结论，点数字看样本再判断。</p>
            <dl>{r.rules.map((x) => <div key={x.key}><dt>{x.name}</dt><dd>{x.how}</dd></div>)}</dl>
          </div>
        )}
        {r && (
          <>
            <div className="ins-tiles">
              <button className={`tile${open === "asktail" ? " on" : ""}`} onClick={() => setOpen(open === "asktail" ? null : "asktail")}><b>{tot("asktail")}</b><span>问句/选项收尾</span><small>{r.samples.asktail.length}+ 次没被回答</small></button>
              <button className={`tile${open === "correction" ? " on" : ""}`} onClick={() => setOpen(open === "correction" ? null : "correction")}><b>{tot("correction")}</b><span>用户纠错/催促</span><small>点开看样本</small></button>
              <div className="tile"><b>{tot("overflow")}</b><span>上下文溢出</span><small>{tot("long")} 个会话超 60 轮</small></div>
              <div className="tile"><b>{tot("ends_on_question")}</b><span>停在问句上</span><small>{tot("continue")} 次「继续」</small></div>
              <div className="tile"><b>{tot("tool_errors")}</b><span>工具报错</span><small>命令失败 / 编辑没匹配到</small></div>
              <div className="tile"><b>{tot("no_board")}</b><span>长会话没上板</span><small>≥15 轮却没 dispatch begin</small></div>
            </div>
            <ul className="ins-findings">{r.findings.map((f, i) => <li key={i}>{f}</li>)}</ul>
            {(open === "asktail" || open === "correction") && (
              <div className="ins-samples">
                {r.samples[open].length === 0 && <div className="empty small">没有样本</div>}
                {r.samples[open].slice().reverse().map((s, i) => (
                  <div key={i} className="smp">
                    <div className="who mono muted">{s.agent} · {onOpenSession ? <button className="link" onClick={() => onOpenSession(s.session_id)}>{s.session_id.slice(0, 8)}</button> : s.session_id.slice(0, 8)} · {s.ts}</div>
                    <div className="a">助手…{s.assistant.slice(-160)}</div>
                    <div className="u">用户：{s.user.slice(0, 140)}</div>
                  </div>
                ))}
              </div>
            )}
            <div className="muted small">按 Agent：{Object.entries(r.per_agent).map(([a, c]) => `${a} ${c.sessions} 会话 · 纠错 ${c.correction} · 问句 ${c.asktail} · 报错 ${c.tool_errors}`).join("　")}</div>
          </>
        )}
      </details>

      {r && (
        <div className="ins-alerts">
          <div className="ins-alerts-head"><b>主动洞察</b><span className="muted small">按会话盯着的信号；新的会在工作台和系统通知里提醒。</span><span className="spacer" />{fresh.length > 0 && <button className="btn sm" onClick={ack}>都看过了（{fresh.length}）</button>}</div>
          {fresh.length === 0 && <div className="muted small">没有新的告警{seen.length ? "；已看过的在下面" : ""}。</div>}
          {fresh.slice(0, 8).map((a) => (
            <div key={a.id} className="ins-alert">
              <span className={`st sm ${a.kind === "correction" || a.kind === "tool_errors" ? "rev" : "prog"}`}>{KIND_LABEL[a.kind] ?? a.kind}</span>
              <span className="t">{a.text}</span>
              {onOpenSession && <button className="link sm" onClick={() => onOpenSession(a.session_id)}>看会话</button>}
            </div>
          ))}
          {seen.length > 0 && <details className="ins-seen" open={seenOpen} onToggle={(e) => setSeenOpen((e.target as HTMLDetailsElement).open)}>
            <summary className="muted small">已看过的 {seen.length} 条</summary>
            {seen.slice(0, 30).map((a) => (
              <div key={a.id} className="ins-alert seen">
                <span className={`st sm open`}>{KIND_LABEL[a.kind] ?? a.kind}</span>
                <span className="t">{a.text}</span>
                {onOpenSession && <button className="link sm" onClick={() => onOpenSession(a.session_id)}>看会话</button>}
              </div>
            ))}
          </details>}
        </div>
      )}
    </section>
  );
}
