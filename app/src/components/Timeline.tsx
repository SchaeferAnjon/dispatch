/*
 * 项目页 v3 (design/raycast-redesign README「项目页 v3」): one page for a project, used by the project
 * page's 脉络 tab and by the 脉络 page. Left, 现状 (the project paragraph from `dispatch here`) and one
 * timeline of what was done, newest first, day by day, with 更早 at the bottom. Right, what is not done
 * yet: 等你 / 在做 / 没人认领 and the live sessions in the project's folder. Every kind, fold and group
 * comes from `dispatch thread <project> --timeline` (cli/thread.py timeline_report); this file draws.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { loadProjectTimeline, type Api, type HereSession, type OpenAsk, type OpenTask, type OpenWork, type ProjectTimelineData, type TimelineDay, type TimelineEvent } from "../api";
import { actorOf, ago } from "../derive";
import { t as tt, useT } from "../i18n";
import { shortPath } from "../platform";
import { Icon } from "./icons";
import { EmptyView, Meter, Tag } from "./primitives";
import { useActionTarget } from "./Shell";

// ---- 现状: `dispatch here <project> --no-summary` right away, then the model's paragraph.
export type HereSummary = { text: string; at?: number; by?: string; cached?: boolean; error?: string; pending?: boolean };
export type ReviewData = { project: string; detected: boolean; cwd: string; timeline_days: number; summary: HereSummary; open_tasks: { id: string; title: string; status: string; assignee: string; acceptance_done: number; acceptance_total: number; last_at: number; last_note: string }[]; sessions: HereSession[]; stale_hosts?: { name: string; age: number }[] };
const parse = <T,>(text: string): T => JSON.parse(text.slice(Math.max(0, text.indexOf("{")))) as T;

/** 现状 and the live sessions for one project. Two calls: the sessions come back in a second, the
 *  paragraph may take the model half a minute the first time, and the page must not wait for it. */
export function useHere(api: Api, project: string | null) {
  const [data, setData] = useState<ReviewData | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const alive = useRef(0);
  const summary = useCallback((name: string, force: boolean, gen: number) => {
    const args = ["project-summary", name, force ? "--force" : "--if-stale", "--json"];
    return api.on("local", args).then((u) => {
      const r = parse<{ summary?: string; at?: number; by?: string; cached?: boolean; error?: string; skipped?: boolean; reason?: string }>(u);
      if (alive.current !== gen) return;
      setData((prev) => prev && prev.project === name ? { ...prev, summary: r.error ? { text: "", error: r.error } : r.skipped ? { text: "", error: r.reason } : { text: r.summary || "", at: r.at, by: r.by, cached: r.cached } } : prev);
    }).catch((e) => { if (alive.current === gen) setData((prev) => prev && prev.project === name ? { ...prev, summary: { text: "", error: String(e) } } : prev); });
  }, [api]);
  const load = useCallback(() => {
    const gen = ++alive.current;
    setData(null); setErr("");
    if (!project) { setBusy(false); return; }
    setBusy(true);
    const name = project;
    // `here` merges other Macs' cached answers without waiting for them; a stale cache over there
    // kicks off a refresh that lands a few seconds later, so ask once more when it says so.
    const fetchHere = () => api.on("local", ["here", name, "--no-summary", "--json"]);
    void fetchHere().then((text) => {
      if (alive.current !== gen) return;
      const d = parse<ReviewData & { error?: string }>(text);
      if (d.error) { setErr(d.error); return; }
      setData({ ...d, summary: { text: "", pending: true } });
      if (d.stale_hosts && d.stale_hosts.length) {
        setTimeout(() => {
          void fetchHere().then((t2) => {
            const d2 = parse<ReviewData & { error?: string }>(t2);
            if (d2.error || alive.current !== gen) return;
            setData((prev) => prev && prev.project === d2.project ? { ...prev, sessions: d2.sessions, open_tasks: d2.open_tasks, cwd: d2.cwd, stale_hosts: d2.stale_hosts } : prev);
          }).catch(() => {});
        }, 6000);
      }
      return summary(name, false, gen);
    }).catch((e) => { if (alive.current === gen) setErr(String(e)); }).finally(() => { if (alive.current === gen) setBusy(false); });
  }, [api, project, summary]);
  useEffect(() => { load(); return () => { alive.current++; }; }, [load]);
  const rewrite = useCallback(() => {
    if (!project) return;
    setData((prev) => prev ? { ...prev, summary: { ...prev.summary, pending: true } } : prev);
    void summary(project, true, alive.current);
  }, [project, summary]);
  return { data, busy, err, reload: load, rewrite };
}
export type HereState = ReturnType<typeof useHere>;

// ---- small helpers
const pad = (n: number) => String(n).padStart(2, "0");
const hm = (ts: number) => { const d = new Date(ts * 1000); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
const md = (ts: number) => { const d = new Date(ts * 1000); return `${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const dayMd = (date: string) => `${date.slice(5, 7)}-${date.slice(8, 10)}`;
const WEEKDAYS = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"];
const shortId = (id?: string) => (id ?? "").replace(/^task-/, "");
const Mono = ({ children }: { children: ReactNode }) => <span className="mono">{children}</span>;
const RANGES = [3, 7, 14, 0] as const;
type Range = (typeof RANGES)[number];
const STORE = "dispatch-timeline-days";
const readRange = (): Range => { try { const raw = localStorage.getItem(STORE); const v = raw === null || raw === "" ? 7 : Number(raw); return (RANGES as readonly number[]).includes(v) ? v as Range : 7; } catch { return 7; } };
const writeRange = (v: Range) => { try { localStorage.setItem(STORE, String(v)); } catch { /* private window */ } };

/** Up to three hashes; more read 「a … b」. */
function hashes(c?: string[]): ReactNode {
  if (!c?.length) return null;
  if (c.length <= 3) return <Mono>{c.join(" · ")}</Mono>;
  return <Mono>{c[0]} … {c[c.length - 1]}</Mono>;
}
function joinSub(parts: ReactNode[]): ReactNode {
  const xs = parts.filter((p) => p !== null && p !== undefined && p !== "" && p !== false);
  return xs.length ? xs.map((p, i) => <span key={i} className="sp">{i > 0 && <span className="dotsep"> · </span>}{p}</span>) : null;
}

export function kindWord(e: Pick<TimelineEvent, "kind">): string {
  switch (e.kind) {
    case "done": return tt("种类·收尾");
    case "void": return tt("种类·作废");
    case "decide": return tt("种类·结论");
    case "verify": return tt("种类·验收");
    case "commit": return tt("种类·提交");
    case "reply": return tt("种类·回复");
    case "did": return tt("种类·做了");
    default: return "";
  }
}

function verifyParts(v: { ok: number; ask: number; fail: number }): string {
  return [v.ok ? tt("{a} 项通过", { a: v.ok }) : "", v.ask ? tt("{b} 项要你确认", { b: v.ask }) : "", v.fail ? tt("{n} 项未通过", { n: v.fail }) : ""].filter(Boolean).join(tt("，"));
}

/** The row's sentence, built here so it translates. */
export function sentence(e: TimelineEvent): string {
  const f = e.fold;
  switch (e.kind) {
    case "done": case "void":
      if (e.group && e.closes?.length) return tt("{n} 项一起收尾：", { n: e.closes.length }) + e.closes.map((x) => x.title).join(tt("、"));
      return e.text;
    case "verify": {
      const v = e.verify ?? { ok: 0, ask: 0, fail: 0 };
      const parts = v.error && !v.ok && !v.ask && !v.fail ? tt("验收没跑成：{e}", { e: v.error }) : verifyParts(v) || tt("没有验收项");
      return f ? `${tt("{n} 个任务一次验收，{from} 到 {to}：", { n: e.tasks ?? f.count, from: hm(f.from_ts), to: hm(f.to_ts) })}${parts}` : parts;
    }
    case "commit": return f ? `${tt("{n} 个提交", { n: f.count })} · ${e.text}` : e.text;
    case "did": return f ? tt("{n} 步，{from} 到 {to}", { n: f.count, from: hm(f.from_ts), to: hm(f.to_ts) }) : e.text;
    default: return e.text;
  }
}

function verifyTone(v?: { ok: number; ask: number; fail: number; error?: string }): string {
  if (!v) return "";
  if (v.fail || (v.error && !v.ok && !v.ask)) return "bad";
  if (v.ask) return "need";
  return "ok";
}

function Who({ e, me }: { e: TimelineEvent; me: string }) {
  if (e.kind === "verify") return <span className="av sm check" title="Historical review">✓</span>;
  const a = actorOf(e.who, me);
  if (!a) return null;
  return <span className={`av sm ${a.kind}`} title={a.name}>{a.glyph}</span>;
}

type RowCtx = { me: string; sel: string | null; open: Set<string>; pick: (e: TimelineEvent) => void; toggle: (id: string) => void; onTask: (id: string) => void; onSession: (id: string) => void };

function TaskTag({ id, title, onTask }: { id: string; title?: string; onTask: (id: string) => void }) {
  return <button type="button" className="tg" title={title ? `${id} · ${title}` : id} onClick={(ev) => { ev.stopPropagation(); onTask(id); }}><span className="mono">{shortId(id)}</span>{title ? <span className="tgt">{title}</span> : null}</button>;
}

/** One row: time, dot, kind word, who, one sentence, the task / session tags; a grey second line. */
function EventRow({ e, ctx, nested = false }: { e: TimelineEvent; ctx: RowCtx; nested?: boolean }) {
  const t = useT();
  const isOpen = ctx.open.has(e.id);
  const f = e.fold;
  const tone = e.kind === "verify" ? verifyTone(e.verify) : "";
  const cls = ["beat", "tlv", e.kind === "void" ? "done void" : e.kind, tone, isOpen ? "open-fold" : "", ctx.sel === e.id ? "sel" : ""].filter(Boolean).join(" ");
  let sub: ReactNode = null;
  const beforeBtn = e.before && (e.before.steps || e.before.commits)
    ? <button type="button" className="stp" onClick={(ev) => { ev.stopPropagation(); ctx.toggle(e.id); }}>{e.before.steps ? [t("之前 {n} 步", { n: e.before.steps }), e.before.commits ? t("{commits} 个提交", { commits: e.before.commits }) : ""].filter(Boolean).join(t("、")) : t("之前 {commits} 个提交", { commits: e.before.commits })} <span className="chev">▶</span></button> : null;
  switch (e.kind) {
    case "done": case "void":
      sub = joinSub([hashes(e.commits), e.verified === true ? <Tag color="green">{t("已验证")}</Tag> : e.verified === false && !e.unchecked ? <Tag color="orange">{t("未验证")}</Tag> : null,
        e.unchecked ? <Tag color="orange">{t("要真机核验")}</Tag> : null, e.tests, beforeBtn]);
      break;
    case "decide":
      sub = joinSub([e.tag && e.tag !== "结论" ? `【${t(e.tag)}】` : null, e.closes?.length ? t("顺手关掉 {n} 项", { n: e.closes.length }) : null]);
      break;
    case "verify": {
      const v = e.verify;
      sub = joinSub([v?.model, v?.secs ? t("耗时 {n}s", { n: v.secs }) : null, f && !isOpen ? <button type="button" className="stp" onClick={(ev) => { ev.stopPropagation(); ctx.toggle(e.id); }}>{t("每项 ▶")}</button> : null]);
      break;
    }
    case "commit":
      sub = joinSub([hashes(e.commits), e.merges ? t("含 {n} 个 merge", { n: e.merges }) : null]);
      break;
    case "reply":
      sub = e.needs_you ? joinSub([<span key="n">{t("要你做的：")}{e.needs_you}</span>, <Tag key="w" color="orange">{t("等你")}</Tag>]) : null;
      break;
    case "did":
      sub = f ? (f.summary ?? []).join(" · ") : joinSub([hashes(e.commits)]);
      break;
  }
  const hasMore = !!(f?.events?.length || e.verify?.items?.length || e.closes?.length || e.before?.events?.length || (e.full && e.full !== e.text));
  return (
    <div className={cls} data-ev={e.id} onClick={(ev) => { ev.stopPropagation(); ctx.pick(e); if (hasMore) ctx.toggle(e.id); }} onDoubleClick={(ev) => { ev.stopPropagation(); if (e.task) ctx.onTask(e.task); else if (e.session_id) ctx.onSession(e.session_id); }}>
      <span className="ts">{nested ? hm(e.ts) : hm(e.ts)}</span>
      <span className="dot"><i /></span>
      <div className="bbody">
        <div className="ln">
          <span className="kd">{kindWord(e)}</span>
          <Who e={e} me={ctx.me} />
          <span className="tx" title={e.full && e.full !== e.text ? undefined : sentence(e)}>{sentence(e)}</span>
          {hasMore && <span className="chev" aria-hidden>▶</span>}
          {!nested && e.task && <TaskTag id={e.task} title={e.task_title} onTask={ctx.onTask} />}
          {!nested && e.group && e.closes && e.closes.length > 1 && <span className="tg more">{t("+{n} 个任务", { n: e.closes.length - 1 })}</span>}
          {!nested && e.kind === "verify" && (e.tasks ?? 0) > 1 && <span className="tg more">{t("+{n} 个任务", { n: (e.tasks ?? 1) - 1 })}</span>}
          {!nested && e.session_id && <button type="button" className="tg ss" title={e.session_title} onClick={(ev) => { ev.stopPropagation(); ctx.onSession(e.session_id!); }}><Icon name="chat" size={11} /><span className="tgt">{e.session_title || e.session_id.slice(0, 8)}</span></button>}
        </div>
        {sub !== null && sub !== "" && <div className="sub">{sub}</div>}
        {isOpen && <Expanded e={e} ctx={ctx} />}
      </div>
    </div>
  );
}

/** What opening a row shows: its whole text, the rows folded into it, the checker's items, the tasks closed with it. */
function Expanded({ e, ctx }: { e: TimelineEvent; ctx: RowCtx }) {
  const t = useT();
  const items = e.verify?.items ?? [];
  return (
    <div className="xp" onClick={(ev) => ev.stopPropagation()}>
      {e.full && e.full !== e.text && <p className="xp-full">{e.full}</p>}
      {items.length > 0 && <ul className="xp-items">{items.map((it, i) => (
        <li key={i} className={`vi ${it.state}`}>
          <span className="vk">{it.state === "ok" ? t("通过") : it.state === "ask" ? t("要你") : t("未通过")}</span>
          <span className="vt">{it.text}</span>
          {it.task && <TaskTag id={it.task} title={it.title} onTask={ctx.onTask} />}
        </li>))}</ul>}
      {e.closes && e.closes.length > 0 && <ul className="xp-items">{e.closes.map((x) => (
        <li key={x.task} className="vi ok">
          <span className="vk">{e.kind === "decide" ? t("关掉") : kindWord({ kind: (x.kind as TimelineEvent["kind"]) || "done" })}</span>
          <span className="vt"><b>{x.title}</b>{x.text ? `${t("：")}${x.text}` : ""}</span>
          <TaskTag id={x.task} onTask={ctx.onTask} />
        </li>))}</ul>}
      {!items.length && e.fold?.events?.length ? <div className="fold-body">{e.fold.events.map((x) => <EventRow key={x.id} e={x} ctx={ctx} nested />)}</div> : null}
      {e.before?.events?.length ? <div className="fold-body">{e.before.events.map((x) => <EventRow key={x.id} e={x} ctx={ctx} nested />)}</div> : null}
    </div>
  );
}

function dayHead(d: TimelineDay): ReactNode {
  const wd = tt(WEEKDAYS[d.weekday] ?? "");
  return <>{d.today ? <b>{tt("今天")}</b> : d.yesterday ? <b>{tt("昨天")}</b> : null}{d.today || d.yesterday ? <span className="n"> · {dayMd(d.date)} {wd}</span> : <b>{dayMd(d.date)} {wd}</b>}<span className="n"> · {tt("时间线·{n} 条", { n: d.count })}</span></>;
}

/** Days of every page loaded so far, merged, newest first. The CLI folds the whole history before
 *  cutting pages, so a row is on one page only; a row seen twice anyway (a refresh racing 更早) is
 *  dropped here. */
function mergeDays(pages: ProjectTimelineData[]): TimelineDay[] {
  const out: TimelineDay[] = [];
  const seen = new Set<string>();
  for (const p of pages) for (const d of p.days) {
    const events = d.events.filter((e) => !seen.has(e.id));
    for (const e of events) seen.add(e.id);
    if (!events.length) continue;
    const last = out[out.length - 1];
    if (last && last.date === d.date) { last.events = [...last.events, ...events]; last.count += events.length; }
    else out.push({ ...d, events, count: events.length });
  }
  return out;
}

type Props = {
  api: Api; me: string; project: string; version?: number;
  here: HereState;
  onTask: (id: string) => void;
  onSession: (id: string) => void;
  /** 「在此项目新建会话」 on an empty project. */
  onNew?: () => void;
  /** 「还有 N 项 · 去任务页」: the project's tasks, unassigned first. */
  onUnassigned?: () => void;
  /** The checker's test-command suggestion (ProjectHub's card): first in 等你. */
  testCard?: ReactNode;
  /** Show only this task's rows (a task opened elsewhere). */
  focusTask?: string | null;
  /** The project name as a heading (the 脉络 page; the project page has it in the window header). */
  heading?: ReactNode;
};

/** The whole v3 page body: 现状 + what was done on the left, what is not done on the right. */
export function ProjectTimeline({ api, me, project, version = 0, here, onTask, onSession, onNew, onUnassigned, testCard, focusTask, heading }: Props) {
  const t = useT();
  const [range, setRange] = useState<Range>(readRange);
  const [only, setOnly] = useState(false);
  const [pages, setPages] = useState<ProjectTimelineData[]>([]);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [more, setMore] = useState(false);
  const [sel, setSel] = useState<string | null>(null);
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [only1, setOnly1] = useState<string | null>(focusTask ?? null);
  const [drop, setDrop] = useState(false);
  useEffect(() => { setOnly1(focusTask ?? null); }, [focusTask]);
  const key = `${project}\u0000${range}\u0000${only}\u0000${only1 ?? ""}`;
  const shownKey = useRef("");
  useEffect(() => {
    let alive = true;
    const fresh = shownKey.current !== key;
    if (fresh) { setPages([]); setSel(null); setOpen(new Set()); }
    setBusy(true); setErr("");
    // 全部 is `--days 0`: the whole history. A focused task asks the CLI for its rows, so its
    // older history counts in 更早 instead of being cut to the loaded days.
    loadProjectTimeline(api, project, { days: range, only, task: only1 }).then((d) => {
      if (!alive) return;
      shownKey.current = key;
      // A refresh keeps the older pages already read below the first one.
      setPages((prev) => fresh || !prev.length ? [d] : [d, ...prev.slice(1)]);
    }).catch((e) => { if (alive) setErr(String(e)); }).finally(() => { if (alive) setBusy(false); });
    return () => { alive = false; };
  }, [api, project, range, only, only1, version, key]);
  const first = pages[0];
  const last = pages[pages.length - 1];
  const loadMore = () => {
    if (!last?.next_before || more) return;
    setMore(true);
    loadProjectTimeline(api, project, { days: 14, before: last.next_before, only, task: only1, open: false })
      .then((d) => setPages((prev) => [...prev, d])).catch((e) => setErr(String(e))).finally(() => setMore(false));
  };
  const days = useMemo(() => mergeDays(pages), [pages]);
  const selected = useMemo(() => days.flatMap((d) => d.events).find((e) => e.id === sel) ?? null, [days, sel]);
  useActionTarget(selected?.task ? { kind: "task", id: selected.task, primary: { label: t("打开任务"), run: () => onTask(selected.task!) } }
    : selected?.session_id ? { kind: "project", name: project, primary: { label: t("打开会话"), run: () => onSession(selected.session_id!) } }
    : { kind: "project", name: project }, [selected?.id, project]);
  const ctx: RowCtx = { me, sel, open, onTask, onSession, pick: (e) => setSel(e.id), toggle: (id) => setOpen((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; }) };
  // A focused task's page still carries the whole project's open work.
  const openWork = first?.open;
  const counts = openWork?.counts;
  const total = days.reduce((n, d) => n + d.count, 0);
  const folded = pages.reduce((a, p) => ({ steps: a.steps + p.folded.steps, commits: a.commits + p.folded.commits }), { steps: 0, commits: 0 });
  const pickRange = (r: Range) => { setRange(r); writeRange(r); };
  const openColumn = <OpenColumn api={api} me={me} open={openWork} here={here} onTask={onTask} onSession={onSession} onUnassigned={onUnassigned} testCard={testCard} />;
  return (
    <div className="pv3-wrap"><div className="pv3">
      <div className="pv3-main" onClick={() => setSel(null)}>
        <div className="d tl-doc pv3-doc">
          {heading}
          {counts && <button type="button" className={`pv3-bar${drop ? " on" : ""}`} aria-expanded={drop} onClick={(ev) => { ev.stopPropagation(); setDrop(!drop); }}>
            <span className="k">{t("还没做")}</span>{t("等你")} <b>{counts.wait}</b> · {t("在做")} <b>{counts.doing}</b> · {t("没人认领")} <b>{counts.unassigned}</b><span className="chev">▾</span>
          </button>}
          {drop && <div className="pv3-drop" onClick={(ev) => ev.stopPropagation()}>{openColumn}</div>}
          <NowBlock here={here} data={first} />
          <div className="pv3-filter" onClick={(ev) => ev.stopPropagation()}>
            <div className="chips" role="group" aria-label={t("时间范围")}>
              {RANGES.map((r) => <button key={r} type="button" className={range === r ? "on" : ""} aria-pressed={range === r} onClick={() => pickRange(r)}>{r ? t("{n} 天", { n: r }) : t("全部")}</button>)}
            </div>
            <div className="chips" role="group" aria-label={t("显示哪些")}>
              <button type="button" className={!only ? "on" : ""} aria-pressed={!only} onClick={() => setOnly(false)}>{t("做了什么")}</button>
              <button type="button" className={only ? "on" : ""} aria-pressed={only} onClick={() => setOnly(true)}>{t("只看收尾和结论")}</button>
            </div>
            {only1 && <button type="button" className="chip on" onClick={() => setOnly1(null)} title={t("看整个项目")}>{t("只看 {id}", { id: shortId(only1) })} ×</button>}
            <span className="sp" />
            {first && <span className="n">{t("时间线·{n} 条", { n: total })}{folded.steps || folded.commits ? ` · ${t("折起 {steps} 步", { steps: folded.steps })}${t("、")}${t("{commits} 个提交", { commits: folded.commits })}` : ""}</span>}
          </div>
          {err && <p className="err" role="alert">{err}</p>}
          {!first && busy && <p className="muted small">{t("正在读这个项目…")}</p>}
          {first && total === 0 && (first.stats.tasks === 0 && !first.next_before
            ? <EmptyView icon="graph" title={t("这个项目还没有记录")} actions={onNew ? <button className="btn" onClick={onNew}>{t("在此项目新建会话")}</button> : undefined} />
            : <div className="pv3-empty">{range ? t("这 {n} 天没做过什么。", { n: range }) : t("还没有做过什么。")}{range && range < 14 && !first.next_before ? <button type="button" className="lk" onClick={() => pickRange(14)}>{t("看 14 天")}</button> : null}</div>)}
          {days.map((d, i) => {
            const next = days[i + 1];
            const gap = next ? Math.min(...d.events.map((e) => e.ts)) - Math.max(...next.events.map((e) => e.ts)) : 0;
            return (
              <div key={d.date} className="pv3-day">
                <div className="day">{dayHead(d)}</div>
                {d.events.map((e, j) => <EventRow key={`${e.id}:${j}`} e={e} ctx={ctx} />)}
                {gap > 3 * 86400 && <div className="beat gap"><span className="ts" /><span className="dot"><i /></span><div className="bbody">{t("{a} 到 {b} 没动", { a: dayMd(next!.date), b: dayMd(d.date) })}</div></div>}
              </div>
            );
          })}
          {last?.next_before ? <button type="button" className="pv3-earlier" disabled={more} onClick={(ev) => { ev.stopPropagation(); loadMore(); }}>
            {more ? t("正在读…") : <>{t("更早")} · {t("{d} 之前还有 {n} 条", { d: md(last.since), n: last.older })} · {t("再看 {n} 天", { n: 14 })}</>}
          </button> : null}
        </div>
      </div>
      <aside className="pv3-side" aria-label={t("还没做")}>{openColumn}</aside>
    </div></div>
  );
}

function NowBlock({ here, data }: { here: HereState; data?: ProjectTimelineData }) {
  const t = useT();
  const h = here.data;
  const s = h?.summary;
  const st = data?.stats;
  const agents = (st?.agents ?? []).map((a) => actorOf(a, "")?.name ?? a).filter((a, i, xs) => xs.indexOf(a) === i);
  return (
    <section className="pv3-now" aria-label={t("现状")} onClick={(ev) => ev.stopPropagation()}>
      <div className="k">{t("现状")}{s?.by && s.at ? <span className="n"> · {t("{by} {when} 写的", { by: s.by.split(":").pop() ?? s.by, when: hm(s.at) })}</span> : null}<span className="sp" />
        {h && <button type="button" className="lk" disabled={!!s?.pending} onClick={here.rewrite} title={t("让模型重写这段现状")}>{t("重写")}</button>}</div>
      {here.err && !h ? <p className="err" role="alert">{here.err}</p>
        : !h || s?.pending ? <p className="muted">{t("正在读这个项目的会话和任务，写现状…")}</p>
        : s?.error ? <p className="muted">{t("还没有项目总结：{error}", { error: s.error })}</p>
        : s?.text ? <p>{s.text}</p> : <p className="muted">{t("还没有项目总结。")}</p>}
      {h && !h.detected && <p className="muted small">{t("任务板上没认出")} <span className="mono">{h.project}</span>{t("，按目录 {dir} 看。", { dir: shortPath(h.cwd) })}</p>}
      {st && <div className="pv3-stats">
        <span><b>{st.lines}</b> {t("统计·条线")}</span><span><b>{st.moving}</b> {t("统计·还在动")}</span><span><b>{st.tasks}</b> {t("统计·任务")}</span><span><b>{st.closed}</b> {t("统计·收尾")}</span>
        <span><b>{st.commits}</b> {t("统计·提交")}</span><span><b>{st.decisions}</b> {t("统计·结论")}</span>
        {agents.length > 0 && <span>{agents.join(t("、"))}</span>}
        {data!.last_at > 0 && <span>{t("最后一动 {when}", { when: ago(data!.last_at) })}</span>}
      </div>}
    </section>
  );
}

// ---- 还没做: the right column.
function OpenRow({ icon, title, sub, onClick, id }: { icon: ReactNode; title: ReactNode; sub?: ReactNode; onClick?: () => void; id?: string }) {
  return (
    <div className="pv3-row" role={onClick ? "button" : undefined} tabIndex={onClick ? 0 : undefined} data-open={id} onClick={onClick}
      onKeyDown={onClick ? (ev) => { if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); onClick(); } } : undefined}>
      <span className="ic">{icon}</span>
      <div className="mainc"><div className="t">{title}</div>{sub && <div className="s">{sub}</div>}</div>
    </div>
  );
}

function Group({ title, count, children }: { title: string; count: number; children: ReactNode }) {
  return <div className="pv3-grp"><div className="pv3-sec">{title}<span className="n">{count}</span></div>{children}</div>;
}

const WAIT_ROWS = 4;

function More({ n, shown, onToggle, extra }: { n: number; shown: boolean; onToggle: () => void; extra?: ReactNode }) {
  const t = useT();
  if (n <= 0) return null;
  return <div className="pv3-more"><button type="button" className="lk" onClick={onToggle}>{shown ? t("收起") : t("还有 {n} 项", { n })}</button>{extra}</div>;
}

export function OpenColumn({ api, me, open, here, onTask, onSession, onUnassigned, testCard }: { api: Api; me: string; open?: OpenWork; here: HereState; onTask: (id: string) => void; onSession: (id: string) => void; onUnassigned?: () => void; testCard?: ReactNode }) {
  const t = useT();
  const [all, setAll] = useState<Record<string, boolean>>({});
  const [closed, setClosed] = useState<Record<string, boolean>>({});
  const [confirming, setConfirming] = useState("");
  const [closing, setClosing] = useState("");
  const [actionErr, setActionErr] = useState<Record<string, string>>({});
  if (!open) return <div className="pv3-open">{testCard}<p className="muted small pv3-note">{t("正在读还没做的事…")}</p></div>;
  const sessions: HereSession[] = here.data?.sessions ?? open.sessions ?? [];
  const cap = (k: string, xs: unknown[], n: number) => (all[k] ? xs.length : Math.min(n, xs.length));
  const toggle = (k: string) => setAll((p) => ({ ...p, [k]: !p[k] }));
  const acc = (x: OpenTask) => x.acceptance_total > 0 ? <Meter value={x.acceptance_done} max={x.acceptance_total} /> : null;
  const who = (name?: string) => { const a = actorOf(name, me); return a ? <span className={`av sm ${a.kind}`} title={a.name}>{a.glyph}</span> : <Icon name="tasks" size={14} />; };
  const closeSession = async (s: HereSession) => {
    if (!s.pane_id) { onSession(s.session_id); return; }
    setConfirming(""); setClosing(s.session_id); setActionErr((p) => ({ ...p, [s.session_id]: "" }));
    try { await api.on("local", ["agent", "close", s.pane_id, "--json"]); setClosed((p) => ({ ...p, [s.session_id]: true })); }
    catch (e) { setActionErr((p) => ({ ...p, [s.session_id]: String(e) })); }
    finally { setClosing(""); }
  };
  const restore = async (s: HereSession) => {
    setActionErr((p) => ({ ...p, [s.session_id]: "" }));
    onSession(s.session_id);
    setClosed((p) => { const n = { ...p }; delete n[s.session_id]; return n; });
    here.reload();
  };
  // The checker's 要你确认 items, one row per task: the checklist line is the title, the checker's
  // long why stays behind the click (it opens the task).
  const askGroups: { task: string; title: string; items: OpenAsk[]; ts: number }[] = [];
  for (const a of open.asks) {
    const g = askGroups.find((x) => x.task === a.task);
    if (g) { g.items.push(a); g.ts = Math.max(g.ts, a.ts); } else askGroups.push({ task: a.task, title: a.title, items: [a], ts: a.ts });
  }
  const waitN = (testCard ? 1 : 0) + open.asks.length + open.waiting_sessions.length + open.wait.length;
  const empty = waitN === 0 && open.doing.length === 0 && open.unassigned.length === 0 && sessions.length === 0;
  // 等你 shows its first few rows (checker items per task, sessions waiting, tasks marked needs-you)
  // and 在做 / 没人认领 a few each, so all three groups fit one screen; 还有 N 项 opens the rest.
  const waitRows: ReactNode[] = [
    ...askGroups.map((g) => {
      const a = g.items[0];
      const more = g.items.length > 1;
      return <OpenRow key={`ask:${g.task}`} id={g.task} icon={<span className="av sm check">✓</span>} onClick={() => onTask(g.task)}
        title={more ? t("{n} 项验收要你确认", { n: g.items.length }) : a.item || a.text}
        sub={<>{more ? <span className="clip" title={g.items.map((x) => `${x.n}. ${x.item || x.text}`).join("\n")}>{g.items.map((x) => x.item || t("验收第 {n} 项", { n: x.n })).join(t("、"))}</span>
          : <span>{t("验收第 {n} 项", { n: a.n })}</span>}<span className="clip">{g.title}</span><Mono>{shortId(g.task)}</Mono><span className="ago">{ago(g.ts)}</span></>} />;
    }),
    ...open.waiting_sessions.map((s) => <OpenRow key={`s:${s.session_id}`} id={s.session_id} icon={who(s.agent)} title={s.title || s.session_id.slice(0, 8)} onClick={() => onSession(s.session_id)}
      sub={<><span className="clip">{t("会话等你：")}{s.text}</span>{s.ts ? <span className="ago">{ago(s.ts)}</span> : null}</>} />),
    ...open.wait.map((x) => <OpenRow key={`w:${x.id}`} id={x.id} icon={<Icon name="tasks" size={14} />} title={x.title} onClick={() => onTask(x.id)}
      sub={<><Tag color="orange">{t("等你")}</Tag><Mono>{shortId(x.id)}</Mono><span className="ago">{ago(x.last_at)}</span></>} />),
  ];
  const doing = open.doing.slice(0, cap("doing", open.doing, 3));
  const unassigned = open.unassigned.slice(0, cap("un", open.unassigned, 3));
  return (
    <div className="pv3-open">
      {empty && <p className="muted small pv3-note">{t("没有等你的事，也没人在做")}</p>}
      {waitN > 0 && <Group title={t("等你")} count={waitN - (testCard ? 1 : 0)}>
        {testCard}
        {waitRows.slice(0, all.wait ? waitRows.length : WAIT_ROWS)}
        <More n={waitRows.length - WAIT_ROWS} shown={!!all.wait} onToggle={() => toggle("wait")} />
      </Group>}
      {open.doing.length > 0 && <Group title={t("在做")} count={open.doing.length}>
        {doing.map((x) => <OpenRow key={x.id} id={x.id} icon={who(x.assignee)} title={x.title} onClick={() => onTask(x.id)}
          sub={<>{acc(x)}{x.session_state === "working" ? <Tag color="green" dot>{t("在跑")}</Tag> : x.session_state ? <span>{t("空闲")}</span> : x.status !== "in_progress" ? <span>{t(x.status === "blocked" ? "阻塞" : "待办")}</span> : null}<Mono>{shortId(x.id)}</Mono><span className="ago">{ago(x.last_at)}</span></>} />)}
        <More n={open.doing.length - 3} shown={!!all.doing} onToggle={() => toggle("doing")} />
      </Group>}
      {open.unassigned.length > 0 && <Group title={t("没人认领")} count={open.unassigned.length}>
        {unassigned.map((x) => <OpenRow key={x.id} id={x.id} icon={<Icon name="tasks" size={14} />} title={x.title} onClick={() => onTask(x.id)}
          sub={<>{x.priority <= 1 ? <Tag color="orange">P{x.priority}</Tag> : null}{acc(x)}{x.from_title ? <span className="clip">{t("从「{title}」分出", { title: x.from_title })}</span> : null}<Mono>{shortId(x.id)}</Mono><span className="ago">{ago(x.created_at)}</span></>} />)}
        <More n={open.unassigned.length - 3} shown={!!all.un} onToggle={() => toggle("un")} extra={onUnassigned ? <button type="button" className="lk" onClick={onUnassigned}>{t("去任务页")}</button> : null} />
      </Group>}
      {sessions.length > 0 && <Group title={t("本目录活会话")} count={sessions.length}>
        {sessions.map((s) => (
          <div key={`${s.agent}:${s.session_id}`}>
            <OpenRow id={s.session_id} icon={who(s.agent)} title={s.title || s.session_id.slice(0, 8)} onClick={() => onSession(s.session_id)}
              sub={<>
                <span>{s.state === "working" ? t("在跑") : s.state === "idle" ? t("空闲") : t("未登记")}{s.pane_id ? ` · ${t("在 Dispatch 里")}` : ""}{s.host ? ` · ${s.host}` : ""}</span>
                {closed[s.session_id] ? <span className="vd">{t("已关闭")}</span>
                  : <button type="button" className={`vd${s.verdict === "别关" ? " hold" : ""}`} disabled={closing === s.session_id} title={s.verdict === "可关" ? t("关闭这个会话：停掉它在 Dispatch 里的进程，之后可点「恢复」续上") : s.reason || t("不安全的关闭，点开这段会话看看")}
                    onClick={(ev) => { ev.stopPropagation(); if (s.verdict === "可关") { if (confirming === s.session_id) void closeSession(s); else setConfirming(s.session_id); } else onSession(s.session_id); }}>
                    {closing === s.session_id ? t("关闭中…") : s.verdict === "可关" && confirming === s.session_id ? t("确认关闭？") : t(s.verdict)}</button>}
                <button type="button" className="vd ghost" title={t("在 Dispatch 里接着这段会话")} onClick={(ev) => { ev.stopPropagation(); void restore(s); }}>{t("恢复")}</button>
              </>} />
            {actionErr[s.session_id] && <p className="err small pv3-note">{actionErr[s.session_id]}</p>}
          </div>
        ))}
      </Group>}
    </div>
  );
}

export const TIMELINE_INTERNALS = { mergeDays, verifyParts };
