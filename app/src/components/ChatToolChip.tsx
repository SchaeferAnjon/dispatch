import { useMemo, useRef, useState, type ReactNode } from "react";
import { toolLabel, type ChatDiff, type ToolChip as Chip, type ToolKind } from "../chatProtocol";
import { diffOfTool, diffRows, diffStat, relPath, type ToolDiff } from "../diff";
import { t, useT } from "../i18n";
import { middlePath } from "../activity";
import { DiffTable } from "./Diff";
import { Icon } from "./icons";

// One tool call of a live turn, as one quiet line in the conversation (design/conversation-cursor):
// an icon for its kind, the tool, the argument that identifies it and a gray measure; click it open
// in place. A shell call opens to its command, the
// first 8 lines of output, exit code and time; an edit opens to its diff with 「撤销这处」; a read or
// search stays one line until opened. The data comes from chatd's tool_start / tool_end.

export const OUTPUT_LINES = 8;

/** "0.4s", "12s", "2 分 10 秒": how long a call or a turn took. */
export function fmtDuration(ms: number | undefined): string {
  if (ms === undefined || ms < 0 || !Number.isFinite(ms)) return "";
  if (ms < 10_000) return `${(ms / 1000).toFixed(1)}s`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  return t("{m} 分 {s} 秒", { m: Math.floor(s / 60), s: s % 60 });
}

/** chatd's diff (Edit/Write from the input, Codex fileChange) as the ToolDiff the diff table draws. */
export function chipDiff(chip: Pick<Chip, "name" | "input" | "diff">): ToolDiff | null {
  const d: ChatDiff | undefined = chip.diff;
  if (d) {
    if (d.kind === "patch") return { kind: "patch", path: d.path, text: d.new, truncated: false };
    if (d.kind === "write") return { kind: "write", path: d.path, new: d.new, truncated: false };
    return { kind: "pair", path: d.path, old: d.old, new: d.new, truncated: false };
  }
  return diffOfTool(chip.name, chip.input);
}

/** The first `n` lines of a tool's output and how many were left out. */
export function headLines(text: string, n = OUTPUT_LINES): { shown: string; more: number } {
  const lines = text.replace(/\n+$/, "").split("\n");
  if (!text.trim()) return { shown: "", more: 0 };
  return { shown: lines.slice(0, n).join("\n"), more: Math.max(0, lines.length - n) };
}

const str = (v: unknown) => (typeof v === "string" ? v : "");
/** The argument that says what the call does: the command, the path, the pattern, the URL. */
export function chipSummary(chip: Pick<Chip, "name" | "input" | "summary" | "kind">, cwd?: string): string {
  const i = chip.input || {};
  if (chip.kind === "shell") return str(i.command) || str(i.cmd) || chip.summary;
  if (chip.kind === "search" && str(i.pattern)) return str(i.pattern);
  const path = str(i.file_path) || str(i.path) || str(i.notebook_path);
  if (path) return relPath(path, cwd);
  return chip.summary || str(i.pattern) || str(i.url) || str(i.query) || str(i.description) || "";
}

interface Props {
  chip: Chip;
  cwd?: string;
  onCopy?: (text: string) => void;
  onUndo?: (chip: Chip, path: string) => void;
  onOpenFile?: (path: string) => void;
}

const KIND_ICON: Record<ToolKind, string> = { shell: "term", edit: "pen", read: "doc", search: "search", agent: "agent", web: "globe", question: "help", other: "bolt" };

/** A read or edit names a file: the row says its name, the whole path sits grey on the right. */
const isPath = (kind: ToolKind, arg: string) => (kind === "read" || kind === "edit") && !/\s/.test(arg);
const baseName = (p: string) => { const s = p.replace(/\/+$/, ""); return s.slice(s.lastIndexOf("/") + 1) || s; };
export type ToolState = "running" | "done" | "error" | "none";

/** The 28px line a tool call reads as, live or in a transcript (DESIGN.md 工具行):
 *  [14 icon] [verb 500] [argument, mono 60%] … [path, mono 11 40%] [measure] [state 14: spinner, then a check that springs in]. */
export function ToolHead({ kind, verb, arg, path, meta, state, popped, count }: { kind: ToolKind; verb: string; arg?: string; path?: string; meta?: ReactNode; state: ToolState; popped?: boolean; count?: boolean }) {
  const file = !!arg && !path && isPath(kind, arg);
  const shown = file ? baseName(arg!) : arg;
  const right = path ?? (file && arg !== shown ? middlePath(arg!, 48) : "");
  return <>
    <span className="ci"><Icon name={KIND_ICON[kind]} size={14} /></span>
    <b className={state === "error" ? "bad" : undefined}>{verb}</b>
    {shown && (count ? <span className="arg count">{shown}</span> : <code className={`arg${state === "running" ? " shimmer" : ""}`}>{shown}</code>)}
    <span className="sp" />
    {right && <code className="path">{right}</code>}
    {meta}
    <span className="st">{state === "running" ? <span className="spin" /> : state === "error" ? <Icon name="x" size={14} className="bad" /> : state === "done" ? <Icon name="check" size={14} className={`ok${popped ? " pop" : ""}`} /> : null}</span>
  </>;
}

/** Consecutive finished calls of one kind (four Reads in a row) read as one line that opens to them. Pure. */
export function groupTools(chips: Chip[]): (Chip | Chip[])[] {
  const out: (Chip | Chip[])[] = [];
  for (const c of chips) {
    const prev = out[out.length - 1];
    const run = Array.isArray(prev) ? prev : prev ? [prev] : null;
    if (run && c.status !== "running" && run[0].kind === c.kind && run.every((x) => x.status !== "running")) { out[out.length - 1] = [...run, c]; continue; }
    out.push(c);
  }
  return out;
}
const GROUP_COUNT: Record<ToolKind, string> = { shell: "{n} 条命令", read: "{n} 个文件", edit: "{n} 处改动", search: "{n} 次搜索", web: "{n} 个网页", agent: "{n} 个子 Agent", question: "{n} 个问题", other: "{n} 次调用" };
const GROUP_VERB: Partial<Record<ToolKind, string>> = { shell: "Bash", read: "Read", edit: "Edit", search: "Search", web: "Web", agent: "Agent" };
/** 「Read 3 个文件 … Media.tsx, SessionThread.tsx, styles.css ✓」: one line, opens (150ms) to the calls. */
export function ToolGroup({ chips, ...rest }: Omit<Props, "chip"> & { chips: Chip[] }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const kind = chips[0].kind;
  const same = chips.every((c) => c.name === chips[0].name);
  const verb = same && kind !== "edit" ? toolLabel(chips[0].name) : GROUP_VERB[kind] ?? toolLabel(chips[0].name);
  const failed = chips.some((c) => c.status === "error" || (c.kind === "shell" && !!c.exit_code));
  const names = chips.map((c) => { const s = chipSummary(c, rest.cwd); return kind === "read" || kind === "edit" ? baseName(s) : s; }).join(", ");
  return <div className={`callgrp${open ? " open" : ""}`}>
    <button type="button" className="call grp" aria-expanded={open} onClick={() => setOpen((o) => !o)} title={names}>
      <ToolHead kind={kind} verb={verb} arg={t(GROUP_COUNT[kind], { n: chips.length })} count path={names} state={failed ? "error" : "done"} />
    </button>
    <div className="grp-body"><div>{chips.map((c) => <ToolChip key={c.tool_id} chip={c} {...rest} />)}</div></div>
  </div>;
}

export function ToolChip({ chip, cwd, onCopy, onUndo, onOpenFile }: Props) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [all, setAll] = useState(false);
  const diff = useMemo(() => (chip.kind === "edit" ? chipDiff(chip) : null), [chip]);
  const blocks = useMemo(() => (diff ? diffRows(diff) : null), [diff]);
  const stat = useMemo(() => blocks?.reduce((s, b) => { const d = diffStat(b.rows); return { add: s.add + d.add, del: s.del + d.del }; }, { add: 0, del: 0 }), [blocks]);
  const running = chip.status === "running";
  // the check springs in only for a call you watched run, not for every row of a page you open
  const ran = useRef(running);
  if (running) ran.current = true;
  const summary = diff ? relPath(diff.path, cwd) : chipSummary(chip, cwd);
  const verb = diff ? (diff.kind === "write" ? "Write" : "Update") : toolLabel(chip.name);
  const out = all ? { shown: chip.output.replace(/\n+$/, ""), more: 0 } : headLines(chip.output);
  const lines = chip.output ? chip.output.replace(/\n+$/, "").split("\n").length : 0;
  const failed = chip.status === "error" || (!!chip.exit_code && chip.kind === "shell");
  const meta = <span className="meta">
    {running ? null
      : <>
        {stat && (stat.add > 0 || stat.del > 0) && <span className="ds"><span className="add">+{stat.add}</span> <span className="del">−{stat.del}</span></span>}
        {chip.kind === "read" && lines > 0 && <span>{t("{n} 行", { n: lines })}</span>}
        {failed && chip.exit_code ? <span className="bad">{`exit ${chip.exit_code}`}</span> : null}
        {chip.duration_ms !== undefined && chip.duration_ms >= 2000 && <span>{fmtDuration(chip.duration_ms)}</span>}
      </>}
  </span>;
  return (
    <div className={`callx${open ? " open" : ""}`} data-tool={chip.tool_id}>
      <button type="button" className={`call${running ? " run" : ""}`} aria-expanded={open} onClick={() => setOpen((o) => !o)} title={summary || undefined}>
        <ToolHead kind={chip.kind} verb={verb} arg={summary} meta={meta} state={running ? "running" : failed ? "error" : "done"} popped={ran.current && !running} />
      </button>
      {open && <div className={`callbody${chip.kind === "shell" ? " term" : ""}`}>
        {chip.kind === "shell" && <>
          <div className="cmd sel-text">{str(chip.input.command) || str(chip.input.cmd) || chip.summary}</div>
          {out.shown ? <div className="out sel-text">{out.shown}</div> : !running && <div className="out muted">{t("（没有输出）")}</div>}
          <div className="ft">
            {chip.exit_code !== undefined && chip.exit_code !== null && <span className={chip.exit_code === 0 ? "ok" : "bad"}>{t("退出码 {n}", { n: chip.exit_code })}</span>}
            {chip.duration_ms !== undefined && <span>{fmtDuration(chip.duration_ms)}</span>}
            {out.more > 0 && <button type="button" className="lk" onClick={() => setAll(true)}>{t("还有 {n} 行", { n: out.more })}</button>}
            {chip.truncated && <span>{t("输出过长，已截断")}</span>}
            {chip.output && onCopy && <button type="button" className="lk" onClick={() => onCopy(chip.output)}>{t("复制输出")}</button>}
          </div>
        </>}
        {chip.kind === "edit" && <>
          {blocks ? blocks.map((b, i) => <div key={i} className="hunk">{b.label && <div className="hunk-h muted small">{b.label}</div>}<DiffTable rows={b.rows} /></div>)
            : <div className="out muted">{t("这次改动没有可显示的差异")}</div>}
          {chip.status === "error" && chip.output && <div className="out err-out sel-text">{headLines(chip.output).shown}</div>}
          <div className="ft">
            {stat && <span className="ds"><span className="add">+{stat.add}</span><span className="del">−{stat.del}</span></span>}
            {diff?.path && onOpenFile && <button type="button" className="lk" onClick={() => onOpenFile(diff.path)}>{t("打开整个文件")}</button>}
            {diff?.path && onUndo && chip.status === "done" && <button type="button" className="lk" onClick={() => onUndo(chip, diff.path)} title={t("发一句话让 Agent 把这处改回去，不动 git")}>{t("撤销这处")}</button>}
          </div>
        </>}
        {chip.kind !== "shell" && chip.kind !== "edit" && <>
          {Object.keys(chip.input).length > 0 && <div className="args">{Object.entries(chip.input).slice(0, 8).map(([k, v]) => <div key={k}><span className="k">{k}</span><span className="v sel-text">{typeof v === "string" ? v : JSON.stringify(v)}</span></div>)}</div>}
          {chip.kind !== "read" && out.shown ? <><div className="out sel-text">{out.shown}</div>{(out.more > 0 || chip.truncated) && <div className="ft">{out.more > 0 && <button type="button" className="lk" onClick={() => setAll(true)}>{t("还有 {n} 行", { n: out.more })}</button>}{chip.truncated && <span>{t("输出过长，已截断")}</span>}</div>}</> : null}
        </>}
      </div>}
    </div>
  );
}
