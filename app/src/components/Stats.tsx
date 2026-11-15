import { Fragment, useEffect, useMemo, useState, type ReactNode } from "react";
import type { Api, AgentStartInput } from "../api";
import { actorOf } from "../derive";
import type { Stats, StatsDay, StatsRank } from "../types";
import { InsightsCard } from "./Insights";
import { t as tr, useLocale, useT } from "../i18n";
import { Dropdown, Section } from "./primitives";
import { About } from "./PageParts";
import { useShellHeader } from "./Shell";

interface Props { api: Api; me: string; host?: string; hostName?: string; onDone?: (m: string) => void; onError: (m: string) => void; onStart?: (input: AgentStartInput) => Promise<unknown>; onDelegate?: (prompt: string, label: string) => void; onOpenSession?: (id: string) => void; filters?: StatsFilterState; tabs?: ReactNode }
const parseJson = <T,>(s: string, fallback: T): T => { try { const i = Math.min(...[s.indexOf("{"), s.indexOf("[")].filter((x) => x >= 0)); return JSON.parse(s.slice(i)); } catch { return fallback; } };

const AGENTS = ["claude-code", "codex", "pi", "zcode", "opencode", "hermes", "gemini"];
const COLOR: Record<string, string> = { "claude-code": "var(--claude)", codex: "var(--codex)", pi: "var(--pi)", zcode: "var(--cursor)", opencode: "var(--opencode)", hermes: "var(--hermes)", gemini: "var(--gemini)" };
const RANGES: [number, string][] = [[7, "7 天"], [30, "30 天"], [90, "90 天"], [365, "一年"], [0, "全部"]];
// Weekday keys are the full names; the compact grids drop the 周 prefix (en/de translations have none).
const WD = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"];
const wdShort = (i: number) => tr(WD[i]).replace(/^周/, "");

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

function RankList({ title, items, unit, empty }: { title: string; items: StatsRank[]; unit?: string; empty: string }) {
  const t = useT();
  const u = unit ?? t("次");
  const max = items[0]?.count ?? 0;
  return (
    <Section title={title} count={items.length}>
      <div className="ak-rank">
        {items.length === 0 && <p className="akd-note">{empty}</p>}
        {items.slice(0, 12).map((it) => (
          <div key={it.name} className="rk" title={`${it.name} · ${it.count.toLocaleString()} ${u}` + (Object.keys(it.by).length ? "\n" + AGENTS.filter((a) => it.by[a]).map((a) => `${a} ${it.by[a].toLocaleString()}`).join(" · ") : "")}>
            <span className="nm mono">{it.name}</span>
            <span className="bar"><span className="stk" style={{ width: `${(it.count / max) * 100}%` }}>{AGENTS.filter((a) => it.by[a]).map((a) => <i key={a} style={{ width: `${(it.by[a] / it.count) * 100}%`, background: COLOR[a] }} title={`${a} ${it.by[a]}`} />)}</span></span>
            <span className="n num">{it.count.toLocaleString()} {u}</span>
          </div>
        ))}
      </div>
    </Section>
  );
}

// GitHub-style calendar: one column per week, Monday at the top. Ends at today.
function Calendar({ days, metric, weeks }: { days: StatsDay[]; metric: "tokens" | "msgs"; weeks: number }) {
  const t = useT();
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
  const months = cols.map((c, i) => { const m = c[0].date.getMonth(); const prev = i > 0 ? cols[i - 1][0].date.getMonth() : -1; return m !== prev ? t("{m}月", { m: m + 1 }) : ""; });
  return (
    <div className="cal-wrap">
      <div className="cal-months" style={{ gridTemplateColumns: `repeat(${weeks}, 11px)` }}>{months.map((m, i) => <span key={i}>{m}</span>)}</div>
      <div className="cal-body">
        <div className="cal-wd">{WD.map((w, i) => <span key={w}>{i % 2 === 0 ? wdShort(i) : ""}</span>)}</div>
        <div className="cal" style={{ gridTemplateColumns: `repeat(${weeks}, 11px)` }}>
          {cols.map((col, w) => col.map((c, i) => (
            <i key={`${w}-${i}`} className={`c l${c.date > end ? -1 : level(c.v, max)}`} title={c.date > end ? "" : `${c.key} · ${c.d ? `${t("{n} 条消息", { n: c.d.msgs })} · ${fmtTok(c.d.tokens)} token` : t("没有活动")}`} />
          )))}
        </div>
      </div>
      <div className="cal-legend muted small">{t("少")} {[0, 1, 2, 3, 4].map((l) => <i key={l} className={`c l${l}`} />)} {t("多")}</div>
    </div>
  );
}

function HourGrid({ hours }: { hours: number[][] }) {
  const t = useT();
  const max = Math.max(1, ...hours.flat());
  const busiest = hours.flatMap((r, w) => r.map((n, h) => ({ w, h, n }))).sort((a, b) => b.n - a.n)[0];
  return (
    <div className="hg-wrap">
      <div className="hg">
        <span />{Array.from({ length: 24 }, (_, h) => <span key={h} className="hh muted">{h % 3 === 0 ? h : ""}</span>)}
        {hours.map((row, w) => (
          <Fragment key={`row${w}`}>
            <span className="hw muted">{wdShort(w)}</span>
            {row.map((n, h) => <i key={`${w}-${h}`} className={`c l${level(n, max)}`} title={`${t(WD[w])} ${h}:00 · ${t("{n} 条消息", { n })}`} />)}
          </Fragment>
        ))}
      </div>
      {busiest && busiest.n > 0 && <div className="muted small" style={{ marginTop: 6 }}>{t("最忙：{wd} {from}:00 到 {to}:00", { wd: t(WD[busiest.w]), from: busiest.h, to: busiest.h + 1 })}</div>}
    </div>
  );
}

function Trend({ days, metric, n }: { days: StatsDay[]; metric: "tokens" | "msgs"; n: number }) {
  const t = useT();
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
        <div key={x.key} className={`tb${x.v ? "" : " zero"}`} title={`${x.key} · ${x.v ? (metric === "tokens" ? fmtTok(x.v) + " token" : t("{n} 条消息", { n: x.v })) : t("没有活动")}` + (metric === "tokens" && x.v ? "\n" + AGENTS.filter((a) => x.by[a]).map((a) => `${a} ${fmtTok(x.by[a])}`).join(" · ") : "")}>
          <div className="col">
            {metric === "tokens"
              ? AGENTS.filter((a) => x.by[a]).map((a) => <i key={a} style={{ height: `${(x.by[a] / max) * 100}%`, background: COLOR[a] }} title={`${x.key} · ${a} ${fmtTok(x.by[a])} token`} />)
              : x.v > 0 && <i style={{ height: `${(x.v / max) * 100}%`, background: "var(--blue)" }} />}
            {!x.v && <i className="none" title={`${x.key} · ${t("没有活动")}`} />}
          </div>
          <span className="lb muted">{n <= 14 || x.key.endsWith("01") || list.indexOf(x) % 5 === 0 || list.indexOf(x) === list.length - 1 ? x.label : ""}</span>
        </div>
      ))}
    </div>
  );
}

export type StatsFilterState = { agent: string; setAgent: (a: string) => void; days: number; setDays: (d: number) => void; metric: "tokens" | "msgs"; setMetric: (m: "tokens" | "msgs") => void };
/** Which Agent, how far back and by what: remembered per viewer, shared by the tabs row and the page. */
export function useStatsFilters(): StatsFilterState {
  const [agent, setAgent] = useState<string>(() => { try { const saved = localStorage.getItem("dispatch-stats-agent") ?? ""; return AGENTS.includes(saved) ? saved : ""; } catch { return ""; } });
  const [days, setDays] = useState<number>(() => { try { return Number(localStorage.getItem("dispatch-stats-days") ?? 90); } catch { return 90; } });
  const [metric, setMetric] = useState<"tokens" | "msgs">("tokens");
  useEffect(() => { try { localStorage.setItem("dispatch-stats-agent", agent); localStorage.setItem("dispatch-stats-days", String(days)); } catch { /* ignore */ } }, [agent, days]);
  return { agent, setAgent, days, setDays, metric, setMetric };
}

/** The three pickers on the right of the 统计与额度 tabs row. */
export function StatsFilters({ agent, setAgent, days, setDays, metric, setMetric, me }: StatsFilterState & { me: string }) {
  const t = useT();
  return (
    <span className="ak-tools">
      <Dropdown label={t("Agent")} value={agent} onChange={setAgent} options={[{ value: "", label: t("全部 Agent") }, ...AGENTS.map((a) => ({ value: a, label: actorOf(a, me)?.name ?? a }))]} />
      <Dropdown label={t("时间范围")} value={String(days)} onChange={(v) => setDays(Number(v))} options={RANGES.map(([d, l]) => ({ value: String(d), label: t(l) }))} />
      <Dropdown label={t("按什么算")} value={metric} onChange={setMetric} options={[{ value: "tokens", label: t("按 token") }, { value: "msgs", label: t("按消息") }]} />
    </span>
  );
}

export function StatsView({ api, me, host, hostName, onDone, onError, onStart, onDelegate, onOpenSession, filters, tabs }: Props) {
  const tx = useT();
  const locale = useLocale();
  const own = useStatsFilters();
  const { agent, days, metric } = filters ?? own;
  const [s, setS] = useState<Stats | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let alive = true; setBusy(true);
    // A specific machine (this one or another): only its numbers, hence --local. "全部" merges every Mac.
    const req = host ? api.on(host, ["stats", ...(agent ? ["--agent", agent] : []), "--days", String(days), "--cached", "--local", "--json"]).then((t) => parseJson<Stats | null>(t, null)) : api.stats(agent, days);
    req.then((r) => { if (alive) setS(r); }).catch((e) => onError(String(e))).finally(() => alive && setBusy(false));
    return () => { alive = false; };
  }, [api, agent, days, host]);
  // Header summary: which machines the numbers are from, and whether they are still being counted.
  const scope = hostName ? tx("只看 {name}", { name: hostName }) : s?.hosts && s.hosts.length > 1 ? s.hosts.join(" + ") : "";
  useShellHeader({ subtitle: [scope, busy ? tx("统计中…") : ""].filter(Boolean).join(" · ") }, [scope, busy, locale]);

  const t = s?.total;
  const weeks = days === 0 ? 52 : Math.min(52, Math.max(4, Math.ceil(days / 7) + 1));
  const models = useMemo(() => (s?.models ?? []).map((m) => ({ name: m.model, count: m.msgs, by: { [m.agent]: m.msgs } })), [s]);
  const projects = useMemo(() => (s?.projects ?? []).map((p) => ({ name: p.name, count: p.tokens, by: p.by })), [s]);

  return (
    <div className="ld ak-page ak-stats">
      <div className="ld-col">
        {tabs}
        <div className="ld-list stview">
          {!s && <InsightsCard api={api} host={host} onStart={onStart} onDelegate={onDelegate} onOpenSession={onOpenSession} onDone={onDone ?? (() => {})} onError={onError} />}
          {!s && !busy && <p className="akd-note ak-pad">{tx("还没有统计数据。索引第一次要把全部聊天记录读一遍，稍等一分钟再来。")}</p>}
          {s && t && (
            <>
              <div className="ak-tiles">
                <div className="tile">
                  <b className="num">{fmtTok(t.total)}</b><span>token</span>
                  <small className="num">{tx("输入 {v}", { v: fmtTok(t.tokens.in) })} · {tx("输出 {v}", { v: fmtTok(t.tokens.out) })} · {tx("缓存读 {v}", { v: fmtTok(t.tokens.cr) })} · {tx("缓存写 {v}", { v: fmtTok(t.tokens.cw) })}{t.tokens.think ? ` · ${tx("思考 {v}", { v: fmtTok(t.tokens.think) })}` : ""}</small>
                </div>
                <div className="tile">
                  <b className="num">{t.msgs.toLocaleString()}</b><span>{tx("条消息")}</span>
                  <small className="num">{tx("{n} 个会话", { n: t.sessions })}{t.sub_tokens ? ` · ${tx("子 Agent 烧了 {pct}", { pct: pct(t.sub_tokens, t.total) })}` : ""}</small>
                </div>
                <div className="tile">
                  <b className="num">{t.active_days}</b><span>{tx("活跃天")}</span>
                  <small className="num">{tx("当前连续 {n} 天", { n: t.streak_cur })} · {tx("最长 {n} 天", { n: t.streak_max })}</small>
                </div>
                <div className="tile">
                  <b className="num">{t.tools_distinct}</b><span>{tx("种工具")}</span>
                  <small className="num">{t.active_hours !== null ? tx("{n} 个活跃时段", { n: t.active_hours }) : t.first_day ? tx("{date} 起", { date: t.first_day }) : ""}</small>
                </div>
              </div>

              <InsightsCard api={api} host={host} onStart={onStart} onDelegate={onDelegate} onOpenSession={onOpenSession} onDone={onDone ?? (() => {})} onError={onError} />
              <Section title={tx("谁烧的")} right={tx("按 token")}>
                <div className="ak-block">
                  <Stacked by={Object.fromEntries(s.agents.map((a) => [a.agent, a.total]))} total={Math.max(1, t.total)} height={6} />
                  <div className="ak-burn">
                    {s.agents.map((a) => (
                      <div key={a.agent} className="ak-burn-r">
                        <span className="dot" style={{ background: COLOR[a.agent] }} /><b>{actorOf(a.agent, me)?.name ?? a.agent}</b>
                        <span className="num">{fmtTok(a.total)} · {pct(a.total, t.total)}</span>
                        <span className="s num">{tx("{n} 条消息", { n: a.msgs.toLocaleString() })} · {tx("{n} 会话", { n: a.sessions })} · {tx("{n} 活跃天", { n: a.days })}</span>
                      </div>
                    ))}
                  </div>
                </div>
              </Section>

              <Section title={tx("活动热力图")} right={metric === "tokens" ? tx("颜色深浅 = 当天 token") : tx("颜色深浅 = 当天消息数")}>
                <div className="ak-block"><Calendar days={s.days} metric={metric} weeks={weeks} /></div>
              </Section>

              <div className="ak-2col">
                <Section title={tx("什么时候在干活")} right={tx("周 × 小时，按消息数")}>
                  <div className="ak-block"><HourGrid hours={s.hours} /></div>
                </Section>
                <Section title={tx("最近 {n} 天", { n: days === 0 || days > 30 ? 30 : days })} right={metric === "tokens" ? tx("每天 token，按 Agent 叠放") : tx("每天消息数")}>
                  <div className="ak-block"><Trend days={s.days} metric={metric} n={days === 0 || days > 30 ? 30 : days} /></div>
                </Section>
              </div>

              <div className="ak-2col">
                <RankList title={tx("最常用工具")} items={s.tools} empty={tx("没有工具调用")} />
                <RankList title={tx("模型")} items={models} unit={tx("次回复")} empty={tx("没有模型信息")} />
                <RankList title={tx("最常用技能")} items={s.skills} empty={tx("没调用过技能（Skill 工具或 / 命令）")} />
                <RankList title={tx("派过的子 Agent")} items={s.subagents} empty={tx("没派过子 Agent")} />
              </div>
              <RankList title={tx("项目：谁最烧 token")} items={projects} unit="token" empty={tx("没有项目数据")} />
              <About summary={tx("数据来源")}><p>{tx("token 数来自各 Agent 自己的记录：Claude Code 每次 API 回复的 usage（按 requestId 去重），Codex 每轮的累计 token_count，ZCode 每条消息的 tokens。")}{days ? tx("范围内：按天的数字按活动日期筛，工具/模型/项目按会话最近活动时间筛。") : ""}{tx("不算钱：你用的是订阅，看额度页就够了。")}</p></About>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
