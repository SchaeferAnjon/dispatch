import { useEffect, useMemo, useState } from "react";
import type { Api } from "../api";
import { actorOf } from "../derive";
import type { Stats, StatsDay, StatsRank } from "../types";
import { InsightsCard } from "./Insights";

interface Props { api: Api; me: string; onDone?: (m: string) => void; onError: (m: string) => void }

const AGENTS = ["claude-code", "codex", "pi", "zcode", "qoder", "qoder-ide"];
const COLOR: Record<string, string> = { "claude-code": "var(--claude)", codex: "var(--codex)", pi: "var(--pi)", zcode: "var(--cursor)", qoder: "var(--qoder)", "qoder-ide": "var(--qoder-2)" };
const RANGES: [number, string][] = [[7, "7 天"], [30, "30 天"], [90, "90 天"], [365, "一年"], [0, "全部"]];
const WD = ["一", "二", "三", "四", "五", "六", "日"];

export const fmtTok = (n: number) => n >= 1e9 ? `${(n / 1e9).toFixed(2)}B` : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}K` : String(n);
const pct = (a: number, b: number) => (b ? `${Math.round((a / b) * 100)}%` : "0%");

// Colour intensity: a fixed set of five steps reads better than a continuous ramp on a small cell.
const level = (v: number, max: number) => (v <= 0 || max <= 0 ? 0 : v >= max * 0.75 ? 4 : v >= max * 0.45 ? 3 : v >= max * 0.2 ? 2 : 1);

function Stacked({ by, total, height = 6 }: { by: Record<string, number>; total: number; height?: number }) {
  return (
    <div className="stk" style={{ height }}>
      {AGENTS.filter((a) => by[a]).map((a) => <i key={a} style={{ width: `${(by[a] / total) * 100}%`, background: COLOR[a] }} title={`${a} ${fmtTok(by[a])}`} />)}
    </div>
  );
}

function RankList({ title, items, unit = "次", empty }: { title: string; items: StatsRank[]; unit?: string; empty: string }) {
  const max = items[0]?.count ?? 0;
  return (
    <section className="st-card">
      <h4>{title}<span className="muted">{items.length}</span></h4>
      {items.length === 0 && <div className="empty small">{empty}</div>}
      {items.slice(0, 12).map((it) => (
        <div key={it.name} className="rk">
          <span className="nm mono" title={it.name}>{it.name}</span>
          <span className="bar"><span className="stk" style={{ width: `${(it.count / max) * 100}%` }}>{AGENTS.filter((a) => it.by[a]).map((a) => <i key={a} style={{ width: `${(it.by[a] / it.count) * 100}%`, background: COLOR[a] }} title={`${a} ${it.by[a]}`} />)}</span></span>
          <span className="n mono">{it.count.toLocaleString()} {unit}</span>
        </div>
      ))}
    </section>
  );
}

// GitHub-style calendar: one column per week, Monday at the top. Ends at today.
function Calendar({ days, metric, weeks }: { days: StatsDay[]; metric: "tokens" | "msgs"; weeks: number }) {
  const map = useMemo(() => new Map(days.map((d) => [d.date, d])), [days]);
  const today = new Date();
  const end = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const dow = (end.getDay() + 6) % 7; // Monday = 0
  const start = new Date(end); start.setDate(end.getDate() - dow - (weeks - 1) * 7);
  const cols: { date: Date; key: string; v: number; d?: StatsDay }[][] = [];
  let max = 0;
  for (let w = 0; w < weeks; w++) {
    const col = [];
    for (let i = 0; i < 7; i++) {
      const dt = new Date(start); dt.setDate(start.getDate() + w * 7 + i);
      const key = `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, "0")}-${String(dt.getDate()).padStart(2, "0")}`;
      const d = map.get(key); const v = d ? d[metric] : 0;
      if (dt <= end) max = Math.max(max, v);
      col.push({ date: dt, key, v, d });
    }
    cols.push(col);
  }
  const months = cols.map((c, i) => { const m = c[0].date.getMonth(); const prev = i > 0 ? cols[i - 1][0].date.getMonth() : -1; return m !== prev ? `${m + 1}月` : ""; });
  return (
    <div className="cal-wrap">
      <div className="cal-months" style={{ gridTemplateColumns: `repeat(${weeks}, 11px)` }}>{months.map((m, i) => <span key={i}>{m}</span>)}</div>
      <div className="cal-body">
        <div className="cal-wd">{WD.map((w, i) => <span key={w}>{i % 2 === 0 ? w : ""}</span>)}</div>
        <div className="cal" style={{ gridTemplateColumns: `repeat(${weeks}, 11px)` }}>
          {cols.map((col, w) => col.map((c, i) => (
            <i key={`${w}-${i}`} className={`c l${c.date > end ? -1 : level(c.v, max)}`} title={c.date > end ? "" : `${c.key} · ${c.d ? `${c.d.msgs} 条消息 · ${fmtTok(c.d.tokens)} token` : "没有活动"}`} />
          )))}
        </div>
      </div>
      <div className="cal-legend muted small">少 {[0, 1, 2, 3, 4].map((l) => <i key={l} className={`c l${l}`} />)} 多</div>
    </div>
  );
}

function HourGrid({ hours }: { hours: number[][] }) {
  const max = Math.max(1, ...hours.flat());
  const busiest = hours.flatMap((r, w) => r.map((n, h) => ({ w, h, n }))).sort((a, b) => b.n - a.n)[0];
  return (
    <div className="hg-wrap">
      <div className="hg">
        <span />{Array.from({ length: 24 }, (_, h) => <span key={h} className="hh muted">{h % 3 === 0 ? h : ""}</span>)}
        {hours.map((row, w) => (
          <>
            <span key={`w${w}`} className="hw muted">{WD[w]}</span>
            {row.map((n, h) => <i key={`${w}-${h}`} className={`c l${level(n, max)}`} title={`周${WD[w]} ${h}:00 · ${n} 条消息`} />)}
          </>
        ))}
      </div>
      {busiest && busiest.n > 0 && <div className="muted small" style={{ marginTop: 6 }}>最忙：周{WD[busiest.w]} {busiest.h}:00 – {busiest.h + 1}:00</div>}
    </div>
  );
}

function Trend({ days, metric, n }: { days: StatsDay[]; metric: "tokens" | "msgs"; n: number }) {
  const map = new Map(days.map((d) => [d.date, d]));
  const today = new Date();
  const list = Array.from({ length: n }, (_, i) => {
    const dt = new Date(today.getFullYear(), today.getMonth(), today.getDate() - (n - 1 - i));
    const key = `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, "0")}-${String(dt.getDate()).padStart(2, "0")}`;
    const d = map.get(key);
    const by: Record<string, number> = {};
    if (d) { if (metric === "tokens") Object.assign(by, d.by); else by.all = d.msgs; }
    return { key, label: `${dt.getMonth() + 1}/${dt.getDate()}`, v: d ? d[metric] : 0, by };
  });
  const max = Math.max(1, ...list.map((x) => x.v));
  return (
    <div className="trend">
      {list.map((x) => (
        <div key={x.key} className="tb" title={`${x.key} · ${metric === "tokens" ? fmtTok(x.v) + " token" : x.v + " 条消息"}`}>
          <div className="col">
            {metric === "tokens"
              ? AGENTS.filter((a) => x.by[a]).map((a) => <i key={a} style={{ height: `${(x.by[a] / max) * 100}%`, background: COLOR[a] }} />)
              : x.v > 0 && <i style={{ height: `${(x.v / max) * 100}%`, background: "var(--accent)" }} />}
          </div>
          <span className="lb muted">{n <= 14 || x.key.endsWith("01") ? x.label : ""}</span>
        </div>
      ))}
    </div>
  );
}

export function StatsView({ api, me, onDone, onError }: Props) {
  const [agent, setAgent] = useState<string>(() => { try { return localStorage.getItem("dispatch-stats-agent") ?? ""; } catch { return ""; } });
  const [days, setDays] = useState<number>(() => { try { return Number(localStorage.getItem("dispatch-stats-days") ?? 90); } catch { return 90; } });
  const [metric, setMetric] = useState<"tokens" | "msgs">("tokens");
  const [s, setS] = useState<Stats | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let alive = true; setBusy(true);
    try { localStorage.setItem("dispatch-stats-agent", agent); localStorage.setItem("dispatch-stats-days", String(days)); } catch { /* ignore */ }
    api.stats(agent, days).then((r) => { if (alive) setS(r); }).catch((e) => onError(String(e))).finally(() => alive && setBusy(false));
    return () => { alive = false; };
  }, [api, agent, days]);

  const t = s?.total;
  const weeks = days === 0 ? 52 : Math.min(52, Math.max(4, Math.ceil(days / 7) + 1));
  const models = useMemo(() => (s?.models ?? []).map((m) => ({ name: m.model, count: m.msgs, by: { [m.agent]: m.msgs } })), [s]);
  const projects = useMemo(() => (s?.projects ?? []).map((p) => ({ name: p.name, count: p.tokens, by: p.by })), [s]);

  return (
    <div className="stview">
      <div className="st-tools">
        <div className="views">
          <button className={agent === "" ? "on" : ""} onClick={() => setAgent("")}>全部 Agent</button>
          {AGENTS.map((a) => <button key={a} className={agent === a ? "on" : ""} onClick={() => setAgent(a)}><span className="dot" style={{ background: COLOR[a] }} />{actorOf(a, me)?.name ?? a}</button>)}
        </div>
        <div className="views">{RANGES.map(([d, l]) => <button key={d} className={days === d ? "on" : ""} onClick={() => setDays(d)}>{l}</button>)}</div>
        <div className="views">
          <button className={metric === "tokens" ? "on" : ""} onClick={() => setMetric("tokens")}>按 token</button>
          <button className={metric === "msgs" ? "on" : ""} onClick={() => setMetric("msgs")}>按消息</button>
        </div>
        <span className="spacer" />
        {busy && <span className="muted small">统计中…</span>}
      </div>

      <InsightsCard api={api} onDone={onDone ?? (() => {})} onError={onError} />
      {!s && !busy && <div className="empty">还没有统计数据。索引第一次要把全部聊天记录读一遍，稍等一分钟再来。</div>}
      {s && t && (
        <>
          <div className="st-tiles">
            <div className="tile">
              <b>{fmtTok(t.total)}</b><span>token</span>
              <small className="mono">输入 {fmtTok(t.tokens.in)} · 输出 {fmtTok(t.tokens.out)} · 缓存读 {fmtTok(t.tokens.cr)} · 缓存写 {fmtTok(t.tokens.cw)}{t.tokens.think ? ` · 思考 ${fmtTok(t.tokens.think)}` : ""}</small>
            </div>
            <div className="tile">
              <b>{t.msgs.toLocaleString()}</b><span>条消息</span>
              <small className="mono">{t.sessions} 个会话{t.sub_tokens ? ` · 子 Agent 烧了 ${pct(t.sub_tokens, t.total)}` : ""}</small>
            </div>
            <div className="tile">
              <b>{t.active_days}</b><span>活跃天</span>
              <small className="mono">当前连续 {t.streak_cur} 天 · 最长 {t.streak_max} 天</small>
            </div>
            <div className="tile">
              <b>{t.tools_distinct}</b><span>种工具</span>
              <small className="mono">{t.active_hours !== null ? `${t.active_hours} 个活跃时段` : t.first_day ? `${t.first_day} 起` : ""}</small>
            </div>
          </div>

          <section className="st-card">
            <h4>谁烧的<span className="muted">按 token</span></h4>
            <Stacked by={Object.fromEntries(s.agents.map((a) => [a.agent, a.total]))} total={Math.max(1, t.total)} height={10} />
            <div className="ag-row">
              {s.agents.map((a) => (
                <div key={a.agent} className="ag">
                  <span className="dot" style={{ background: COLOR[a.agent] }} /><b>{actorOf(a.agent, me)?.name ?? a.agent}</b>
                  <span className="mono muted">{fmtTok(a.total)} · {pct(a.total, t.total)} · {a.msgs.toLocaleString()} 条 · {a.sessions} 会话 · {a.days} 活跃天</span>
                </div>
              ))}
            </div>
          </section>

          <section className="st-card">
            <h4>活动热力图<span className="muted">{metric === "tokens" ? "颜色深浅 = 当天 token" : "颜色深浅 = 当天消息数"}</span></h4>
            <Calendar days={s.days} metric={metric} weeks={weeks} />
          </section>

          <div className="st-2col">
            <section className="st-card">
              <h4>什么时候在干活<span className="muted">周 × 小时，按消息数</span></h4>
              <HourGrid hours={s.hours} />
            </section>
            <section className="st-card">
              <h4>最近 {days === 0 || days > 30 ? 30 : days} 天<span className="muted">{metric === "tokens" ? "每天 token，按 Agent 叠放" : "每天消息数"}</span></h4>
              <Trend days={s.days} metric={metric} n={days === 0 || days > 30 ? 30 : days} />
            </section>
          </div>

          <div className="st-2col">
            <RankList title="最常用工具" items={s.tools} empty="没有工具调用" />
            <RankList title="模型" items={models} unit="次回复" empty="没有模型信息" />
            <RankList title="最常用技能" items={s.skills} empty="没调用过技能（Skill 工具或 / 命令）" />
            <RankList title="派过的子 Agent" items={s.subagents} empty="没派过子 Agent" />
          </div>
          <RankList title="项目：谁最烧 token" items={projects} unit="token" empty="没有项目数据" />
          <div className="muted small st-foot">token 数来自各 Agent 自己的记录：Claude Code 每次 API 回复的 usage（按 requestId 去重），Codex 每轮的累计 token_count，ZCode 每条消息的 tokens。{days ? "范围内：按天的数字按活动日期筛，工具/模型/项目按会话最近活动时间筛。" : ""}不算钱——你用的是订阅，看额度页就够了。</div>
        </>
      )}
    </div>
  );
}
