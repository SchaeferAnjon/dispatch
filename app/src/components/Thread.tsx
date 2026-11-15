/*
 * 脉络, one project per page. Left, the projects grouped 还在动 / 最近收尾 / 更早. Right, the selected
 * project as the project page draws it (Timeline.tsx): 现状, what was done newest first day by day with
 * 更早 at the bottom, and what is not done on the right. ThreadPane still draws one line (a task's
 * Detail 「这条线」), oldest first, from `dispatch thread <task>`.
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import { loadThread, loadThreadProjects, type Api, type ThreadBeat, type ThreadData, type ThreadDay, type ThreadProjectRow, type ThreadProjects } from "../api";
import { actorOf, glyphStyle } from "../derive";
import { useT, t as tt } from "../i18n";
import { EmptyView, Section, Tag, Row, useListKeyboard } from "./primitives";
import { useActionTarget, useShellHeader } from "./Shell";
import { ProjectTimeline, useHere } from "./Timeline";

interface Props {
  api: Api;
  me: string;
  version: number;
  /** The open task: the page follows its project and opens its chapter. */
  selected: string | null;
  /** Open a task (its Detail). */
  onSelect: (id: string) => void;
  /** Open a conversation (the sessions page). */
  onOpenSession?: (id: string) => void;
  /** The project the rest of the app is looking at; the page starts there. */
  currentProject?: string | null;
}

const STORE = "dispatch-thread-project";
const WEEKDAYS = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"];
const RECENT = 14 * 86400;

const pad = (n: number) => String(n).padStart(2, "0");
const hm = (ts: number) => { const d = new Date(ts * 1000); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
const md = (ts: number) => { const d = new Date(ts * 1000); return `${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const mdhm = (ts: number) => `${md(ts)} ${hm(ts)}`;
/** Row time: 刚刚 / 5m / 4h / 1d within a week, else the date. */
function when(ts: number): string {
  if (!ts) return "";
  const s = Date.now() / 1000 - ts;
  if (s < 60) return tt("刚刚");
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  if (s < 7 * 86400) return `${Math.floor(s / 86400)}d`;
  return md(ts);
}
const readStore = () => { try { return localStorage.getItem(STORE); } catch { return null; } };
const writeStore = (v: string) => { try { localStorage.setItem(STORE, v); } catch { /* private window */ } };

function Pj({ name }: { name: string }) {
  return <span className="pj sm" style={glyphStyle(name)}>{(name || "?").slice(0, 1)}</span>;
}

function Who({ who, me }: { who?: string; me: string }) {
  const a = actorOf(who, me);
  if (!a || a.kind === "human") return null;
  return <span className="who"><span className={`av sm ${a.kind}`} title={a.name}>{a.glyph}</span></span>;
}

const Mono = ({ children }: { children: ReactNode }) => <span className="mono">{children}</span>;

function commitsText(c: string[] | undefined): ReactNode {
  if (!c?.length) return null;
  if (c.length === 1) return <Mono>{c[0]}</Mono>;
  return <>{tt("{n} 个提交", { n: c.length })} <Mono>{c[0]} … {c[c.length - 1]}</Mono></>;
}

function joinSub(parts: ReactNode[]): ReactNode {
  const xs = parts.filter((p) => p !== null && p !== undefined && p !== "" && p !== false);
  return xs.length ? xs.map((p, i) => <span key={i}>{i > 0 && " · "}{p}</span>) : null;
}

type BeatCtx = { me: string; open: Set<string>; toggle: (k: string) => void; sel: string | null; setSel: (k: string, task?: string) => void; onOpen: (id: string) => void };
const keyOf = (b: ThreadBeat, prefix = "") => `${prefix}${b.kind}:${b.task ?? ""}:${b.ts}`;

function kindLabel(b: ThreadBeat): string {
  switch (b.kind) {
    case "ask": return tt("你说");
    case "discuss": return tt("讨论（这一轮）");
    case "decide": return b.tag === "分工" ? tt("分工") : tt("结论");
    case "claim": return tt("接手");
    case "did": return tt("做了");
    case "done": return tt("收尾");
    case "fork": return tt("分出");
    case "created": return tt("开了");
    case "verify": return tt("验收");
    case "open": return b.state === "run" ? tt("在跑") : b.state === "wait" ? tt("等你") : tt("开着");
    default: return "";
  }
}

function statusText(s?: string): string {
  return s === "in_progress" ? tt("进行中") : s === "blocked" ? tt("阻塞") : s === "deferred" ? tt("搁置") : tt("待办");
}

/** One record on the line: time, dot, kind word, who, text, a grey second line; folds open in place. */
function Beat({ b, ctx, first, last, prefix = "", tail = false }: { b: ThreadBeat; ctx: BeatCtx; first?: boolean; last?: boolean; prefix?: string; tail?: boolean }) {
  const t = useT();
  const k = keyOf(b, prefix);
  const foldable = b.kind === "discuss" || b.kind === "fork" || (b.kind === "did" && !!b.fold);
  const isOpen = foldable && ctx.open.has(k);
  const cls = ["beat",
    b.kind === "ask" ? "ask" : b.kind === "decide" ? "decide" : b.kind === "done" ? "done" : b.kind === "gap" ? "gap" : "",
    b.kind === "verify" ? `verify ${b.verify?.fail ? "bad" : b.verify?.ask ? "need" : "ok"}` : "",
    b.kind === "fork" ? "fork" : "",
    b.kind === "open" ? (b.state === "run" ? "run" : b.state === "wait" ? "wait" : "open") : "",
    foldable ? "fold" : "", isOpen ? "open-fold" : "", first ? "first" : "", last ? "last" : "", ctx.sel === k ? "sel" : ""].filter(Boolean).join(" ");
  if (b.kind === "gap") {
    const days = b.days ?? 0;
    return <div className={cls}><span className="ts" /><span className="dot"><i /></span><div className="bbody">{days >= 14 && days < 21 ? t("两周没动") : t("{n} 天没动", { n: days })}</div></div>;
  }
  let tx: ReactNode = b.text;
  let sub: ReactNode = null;
  let sum: ReactNode = null;
  let inner: ReactNode = null;
  switch (b.kind) {
    case "ask":
      sub = b.opening ? joinSub([<Mono key="id">{b.task}</Mono>, b.discussion ? t("讨论（这一轮）") : "", b.discussion && b.host ? t("主持 {who}", { who: actorOf(b.host, ctx.me)?.name ?? b.host }) : ""]) : null;
      break;
    case "created":
      sub = joinSub([<Mono key="id">{b.task}</Mono>, b.who ? t("{who} 建的", { who: actorOf(b.who, ctx.me)?.name ?? b.who }) : ""]);
      break;
    case "decide":
      sub = `【${t(b.tag || "结论")}】`;
      break;
    case "claim": {
      const to = actorOf(b.who, ctx.me)?.name ?? b.who ?? "";
      const by = b.routed_by ? (b.routed_by === b.who ? t("派给自己") : t("{by} 派给 {to}", { by: actorOf(b.routed_by, ctx.me)?.name ?? b.routed_by, to })) : "";
      if (!b.text) tx = <span className="muted">{by || to}</span>;
      sub = joinSub([b.text ? by : ""]);
      break;
    }
    case "did":
      if (b.fold) {
        tx = t("{n} 步，{from} 到 {to}", { n: b.count ?? 0, from: hm(b.from_ts ?? b.ts), to: hm(b.to_ts ?? b.ts) });
        sum = (b.summary ?? []).join(" · ");
        inner = (b.beats ?? []).map((x, i, xs) => <Beat key={keyOf(x, k)} b={{ ...x, kind: "did" }} ctx={ctx} prefix={k} first={i === 0} last={i === xs.length - 1} />);
      } else sub = commitsText(b.commits);
      break;
    case "done":
      sub = joinSub([commitsText(b.commits), b.verified === true ? t("已验证") : b.verified === false ? t("未验证") : ""]);
      break;
    case "discuss": {
      const ms = b.members ?? [];
      tx = t("{n} 人各说一次", { n: ms.length });
      sum = ms.map((m) => `${actorOf(m.who, ctx.me)?.name ?? m.who}${t("：")}${m.text}`).join(t("；"));
      inner = ms.map((m, i) => (
        <div key={i} className="beat">
          <span className="ts">{hm(m.ts)}</span><span className="dot"><i /></span>
          <div className="bbody"><Who who={m.who} me={ctx.me} /><span className="tx">{m.full || m.text}</span><div className="sub">{joinSub([actorOf(m.who, ctx.me)?.name ?? m.who, m.model])}</div></div>
        </div>
      ));
      break;
    }
    case "fork": {
      tx = <>{b.title} <Mono>{b.task}</Mono></>;
      const end = b.closed_at ? <>{t("收尾 {when}", { when: sameDay(b.closed_at, b.ts) ? hm(b.closed_at) : mdhm(b.closed_at) })}{b.commits?.length ? <> · <Mono>{b.commits[b.commits.length - 1]}</Mono></> : null}</> : kindLabel({ kind: "open", ts: 0, state: b.state });
      sum = <>{end}{b.open_after ? ` · ${t("又分出 {n} 项开着", { n: b.open_after })}` : ""}</>;
      inner = (b.beats ?? []).map((x, i, xs) => <Beat key={keyOf(x, k)} b={x} ctx={ctx} prefix={k} first={i === 0} last={i === xs.length - 1} />);
      break;
    }
    case "open":
      tx = <>{b.title} <Mono>{b.task}</Mono></>;
      sub = joinSub([statusText(b.status), b.assignee ? actorOf(b.assignee, ctx.me)?.name ?? b.assignee : t("没人认领"), b.from_title ? t("从「{title}」分出", { title: b.from_title }) : ""]);
      break;
  }
  if (b.kind === "verify" && b.verify) {
    const v = b.verify;
    tx = v.error && !v.ok && !v.ask && !v.fail ? t("验收没跑成：{e}", { e: v.error }) : [v.ok ? t("{a} 项通过", { a: v.ok }) : "", v.ask ? t("{b} 项要你确认", { b: v.ask }) : "", v.fail ? t("{n} 项未通过", { n: v.fail }) : ""].filter(Boolean).join(t("，"));
    sub = joinSub([v.model ?? "", v.secs ? t("耗时 {n}s", { n: v.secs }) : ""]);
  }
  const showWho = b.kind === "claim" || b.kind === "done" || (b.kind === "did" && !b.fold);
  return (
    <div className={cls} data-beat={k} onClick={(e) => { e.stopPropagation(); ctx.setSel(k, b.task); }} onDoubleClick={(e) => { e.stopPropagation(); if (b.task) ctx.onOpen(b.task); }}>
      <span className="ts">{tail ? "" : hm(b.ts)}</span>
      <span className="dot"><i /></span>
      <div className="bbody">
        <span className="kd">{kindLabel(b)}</span>
        {showWho && <Who who={b.who} me={ctx.me} />}
        {foldable
          ? <button className="fbtn" aria-expanded={isOpen} onClick={(e) => { e.stopPropagation(); ctx.toggle(k); ctx.setSel(k, b.task); }}><span className="tx">{tx}</span><span className="chev">▶</span></button>
          : <span className="tx" title={b.full && b.full !== b.text ? b.full : undefined}>{tx}</span>}
        {foldable ? sum !== null && <span className="sum">{sum}</span> : sub !== null && <div className="sub">{sub}</div>}
        {isOpen && <div className="fold-body">{inner}</div>}
      </div>
    </div>
  );
}

function sameDay(a: number, b: number) { return md(a) === md(b); }

/** Which folds start open: a branch that still has something open, or that holds the open task. */
function openFolds(days: ThreadDay[], selected: string, root: string, prefix = ""): Set<string> {
  const out = new Set<string>();
  const walk = (bs: ThreadBeat[], pre: string): boolean => {
    let any = false;
    for (const b of bs) {
      const k = keyOf(b, pre);
      const inner = b.beats ? walk(b.beats, k) : false;
      const holds = !!selected && b.task === selected && selected !== root;
      if (b.kind === "fork" && (inner || holds || (b.open_after ?? 0) > 0 || b.state !== "done")) { out.add(k); any = true; }
      if (holds) any = true;
    }
    return any;
  };
  for (const day of days) walk(day.beats, prefix);
  return out;
}
const initialOpen = (d: ThreadData) => openFolds(d.days, d.selected, d.root);

export function ThreadPane({ d, me, onOpen, onPick }: { d: ThreadData; me: string; onOpen: (id: string) => void; onPick: (task: string | null) => void }) {
  const t = useT();
  const [open, setOpen] = useState<Set<string>>(() => initialOpen(d));
  const [sel, setSel] = useState<string | null>(null);
  const [askFull, setAskFull] = useState(false);
  useEffect(() => { setOpen(initialOpen(d)); setSel(null); setAskFull(false); }, [d.root]);
  const ctx: BeatCtx = { me, open, sel, onOpen, toggle: (k) => setOpen((s) => { const n = new Set(s); if (n.has(k)) n.delete(k); else n.add(k); return n; }), setSel: (k, task) => { setSel(k); onPick(task ?? null); } };
  const n = d.now;
  const unclaimed = d.left.filter((x) => !x.assignee).length;
  const running = d.left.filter((x) => x.state === "run").length;
  const agents = d.line.agents.map((a) => actorOf(a, me)?.name ?? a);
  const uniqAgents = agents.filter((a, i) => agents.indexOf(a) === i);
  const stale = d.last_at && Date.now() / 1000 - d.last_at > 3600;
  const allDays = d.days;
  return (
    <div className="d tl-doc">
      <div className="crumb"><Pj name={d.project} />{d.project}<span>›</span><Mono>{d.root}</Mono><span>›</span>{t("{n} 个任务", { n: d.task_count })}{d.session_count ? ` · ${t("{n} 条会话", { n: d.session_count })}` : ""}{d.open_count > 0 && <Tag>{t("剩 {n}", { n: d.open_count })}</Tag>}</div>
      <h2>{d.title}</h2>
      {d.ask && (
        <div className="askbox">
          <span className="av human">{t("你")}</span>
          <div>
            <div className="k">{t("你的原话")} · {mdhm(d.ask.at)}{d.ask.source === "session" ? ` · ${t("会话开头")}` : ""}</div>
            <div className={`ask-t${askFull ? " full" : ""}`}>{d.ask.text}</div>
            {d.ask.text.length > 160 && <button className="lk" onClick={() => setAskFull(!askFull)}>{askFull ? t("收起") : t("展开全文")}</button>}
          </div>
        </div>
      )}
      <div className="now">
        <div>
          <div className="k">{t("走到哪")}</div>
          <div className="v">
            {n.main ? <>{t("主线 {when} 收尾：", { when: mdhm(n.main.closed_at) })}<b>{n.main.text}</b></> : n.latest ? <>{t("{when}：", { when: mdhm(n.latest.at) })}{n.latest.text}</> : t("还没有记录。")}
            {n.branches.total > 0 && <>{t("分出 {n} 条支线，{m} 条已收尾。", { n: n.branches.total, m: n.branches.closed })}</>}
            {n.last_at > 0 && <>{t("最后一动 {when}。", { when: mdhm(n.last_at) })}</>}
          </div>
        </div>
        <div>
          <div className="k">{t("剩下")}</div>
          <div className="v">
            {d.left.length === 0 ? t("都收尾了。") : <>
              <b>{running ? t("{n} 在跑", { n: running }) : t("{n} 项开着", { n: d.left.length })}</b>
              {!running && unclaimed === d.left.length ? t("，都没人认领") : ""}{t("：")}
              {d.left.slice(0, 3).map((x, i) => <span key={x.id}>{i > 0 && t("、")}<Mono>{x.id}</Mono> {x.short || x.title}</span>)}
              {d.left.length > 3 && t(" 等 {n} 项", { n: d.left.length })}{t("。")}
            </>}
          </div>
        </div>
        <div>
          <div className="k">{t("这条线")}</div>
          <div className="v">
            {t("{n} 任务 · {m} 收尾", { n: d.line.tasks, m: d.line.closed })}<br />
            {t("{n} 结论 · {m} 提交", { n: d.line.decisions, m: d.line.commits })}<br />
            {uniqAgents.join(t("、")) || t("没有 Agent 记录")}
          </div>
        </div>
      </div>
      {allDays.map((day, di) => (
        <div key={day.date}>
          <div className="day">{md(new Date(day.date + "T12:00:00").getTime() / 1000)} {t(WEEKDAYS[day.weekday] ?? "")}{day.today && <span className="n"> · {t("今天")}</span>}</div>
          {day.beats.map((b, i) => <Beat key={keyOf(b)} b={b} ctx={ctx} first={di === 0 && i === 0} last={!d.tail.length && di === allDays.length - 1 && i === day.beats.length - 1} />)}
        </div>
      ))}
      {d.tail.length > 0 && <>
        <div className="day">{t("现在")}{stale ? <span className="n"> · {t("{when} 起没动", { when: mdhm(d.last_at) })}</span> : null}</div>
        {d.tail.map((b, i) => <Beat key={keyOf(b, "tail:")} b={b} ctx={ctx} prefix="tail:" tail last={i === d.tail.length - 1} />)}
      </>}
    </div>
  );
}


/** A project's state as one tag: 在跑 / 等你 N / 剩 N / 收尾. */
export function ProjectStateTag({ p }: { p: Pick<ThreadProjectRow, "state" | "wait" | "open"> }) {
  const t = useT();
  if (p.state === "run") return <Tag color="green" dot>{t("在跑")}</Tag>;
  if (p.state === "wait") return <Tag color="orange">{t("等你 {n}", { n: p.wait })}</Tag>;
  if (p.state === "done") return <Tag color="green">{t("收尾")}</Tag>;
  return <Tag>{t("剩 {n}", { n: p.open })}</Tag>;
}

/** The board for lines nobody gave a project (cli/thread.py NO_PROJECT); shown in the reader's language. */
export const NO_PROJECT = "未分项目";
const projectName = (name: string) => (name === NO_PROJECT ? tt(NO_PROJECT) : name);
/** Where a task lives on this page: its own project (未分项目 when it has none) and its chapter there. */
export function homeOf(d: ThreadData): { project: string; root: string } {
  return { project: d.home_project === undefined ? d.project : d.home_project || NO_PROJECT, root: d.home_root || d.root };
}

type Group = "moving" | "recent" | "older";
const groupOf = (p: ThreadProjectRow, now: number): Group => p.state !== "done" ? "moving" : now - p.last_at < RECENT ? "recent" : "older";

export function ThreadView({ api, me, version, selected, onSelect, onOpenSession, currentProject }: Props) {
  const t = useT();
  const [list, setList] = useState<ThreadProjects | null>(null);
  const [listErr, setListErr] = useState("");
  const [query, setQuery] = useState("");
  const [project, setProject] = useState<string>(() => currentProject || readStore() || "");
  const [focus, setFocus] = useState<string | null>(null);
  // Phone: one column; the list shows until a project is picked, ‹ 所有项目 goes back to it.
  const [phoneList, setPhoneList] = useState(!currentProject && !selected && !readStore());

  useEffect(() => { if (currentProject) setProject(currentProject); }, [currentProject]);
  useEffect(() => {
    let alive = true;
    setListErr("");
    loadThreadProjects(api).then((l) => { if (alive) setList(l); }).catch((e) => { if (alive) { setListErr(String(e)); setList(null); } });
    return () => { alive = false; };
  }, [api, version]);
  // A task opened elsewhere: follow it to its own project and show only its rows there. One opened
  // from this page (its row is on screen) leaves the page as it is.
  const main = useRef<HTMLDivElement>(null);
  const shown = useRef("");
  useEffect(() => {
    if (!selected) return;
    let alive = true;
    loadThread(api, selected).then((d) => {
      if (!alive) return;
      const { project: proj } = homeOf(d);
      if (shown.current && shown.current.toLowerCase() === proj.toLowerCase()) return;
      setFocus(selected);
      if (proj) { setProject(proj); setPhoneList(false); }
    }).catch(() => {});
    return () => { alive = false; };
  }, [api, selected]);

  const now = Date.now() / 1000;
  const q = query.trim().toLowerCase();
  const rows = (list?.projects ?? []).filter((p) => !q || p.name.toLowerCase().includes(q));
  const groups: [Group, string, ThreadProjectRow[]][] = [
    ["moving", t("还在动"), rows.filter((p) => groupOf(p, now) === "moving")],
    ["recent", t("最近收尾"), rows.filter((p) => groupOf(p, now) === "recent")],
    ["older", t("更早"), rows.filter((p) => groupOf(p, now) === "older")],
  ];
  const ids = groups.flatMap(([, , l]) => l.map((p) => p.name));
  const active = project || list?.projects[0]?.name || "";
  useEffect(() => { shown.current = active; }, [active]);
  const here = useHere(api, active || null);

  const pick = (name: string) => { setProject(name); writeStore(name); setFocus(null); setPhoneList(false); };
  useListKeyboard(ids, active || null, pick);
  useActionTarget(active ? { kind: "project", name: active } : null, [active]);
  const c = list?.counts;
  useShellHeader({
    subtitle: [projectName(active), c ? t("{n} 个项目还在动", { n: c.moving }) : "", c?.today ? t("{n} 个今天有动静", { n: c.today }) : ""].filter(Boolean).join(" · "),
  }, [active, c?.moving, c?.today, t]);

  const row = (p: ThreadProjectRow) => (
    <Row key={p.name} id={p.name} data-project={p.name} selected={p.name === active} onClick={() => pick(p.name)} tooltip={`${p.name} · ${t("{n} 条线 · {m} 个任务", { n: p.lines, m: p.tasks })}`}
      icon={<Pj name={p.name} />} title={projectName(p.name)}
      accessories={[<ProjectStateTag key="s" p={p} />, <span key="w" className="num">{when(p.last_at)}</span>]} />
  );

  return (
    <div className={`thread${phoneList ? " show-list" : ""}`}>
      <aside className="tl-side">
        <div className="tl-search"><input className="tabs-filter" aria-label={t("搜索项目…")} placeholder={t("搜索项目…")} value={query} onChange={(e) => setQuery(e.target.value)} /></div>
        <div className="ld-list" role="listbox">
          {listErr && <p className="err" role="alert">{listErr}</p>}
          {!list && !listErr && <p className="muted small tl-note">{t("正在读脉络…")}</p>}
          {list && ids.length === 0 && <EmptyView icon="graph" title={q ? t("没有匹配的项目") : t("还没有项目")} description={q ? undefined : t("任务带上项目之后，这里每个项目一行。")} />}
          {groups.map(([k, label, l]) => l.length > 0 && <Section key={k} title={label} count={l.length}>{l.map(row)}</Section>)}
        </div>
      </aside>
      <div className="tl-main pv3-host" ref={main}>
        <button className="tl-back" onClick={() => setPhoneList(true)}>‹ {t("所有项目")}</button>
        {active && <ProjectTimeline key={active} api={api} me={me} project={active} version={version} here={here} focusTask={focus}
          onTask={onSelect} onSession={(id) => onOpenSession?.(id)} heading={<h2 className="pv3-h">{projectName(active)}</h2>} />}
        {!active && list && <EmptyView icon="graph" title={t("选一个项目")} description={t("左边每一行是一个项目：它做了什么按时间排在右边，新的在上。")} />}
      </div>
    </div>
  );
}
