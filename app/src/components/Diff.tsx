import { useMemo, useState } from "react";
import { collapse, diffStat, pairRows, patchRows, type DiffRow } from "../diff";

// One diff, the way a code-review tool shows it: line numbers on both sides, +/− gutter,
// the changed words inside a replaced line highlighted, unchanged runs folded behind a
// clickable "N 行未变", a filter for "only added / only removed", and a size guard so a
// 3000-line Write does not freeze the page.
const COLLAPSE_ROWS = 400;   // above this the diff starts folded behind its stats
const HARD_CAP = 3000;       // never render more rows than this at once

type Filter = "all" | "add" | "del";
interface Props { rows: DiffRow[]; label?: string; copyText?: string; defaultOpen?: boolean; ctx?: number }

export function DiffTable({ rows: full, label, copyText, defaultOpen, ctx = 3 }: Props) {
  const stat = useMemo(() => diffStat(full), [full]);
  const [filter, setFilter] = useState<Filter>("all");
  const [open, setOpen] = useState<boolean>(defaultOpen ?? full.length <= COLLAPSE_ROWS);
  const [expanded, setExpanded] = useState<Set<number>>(() => new Set());
  const [cap, setCap] = useState(HARD_CAP);
  const [copied, setCopied] = useState(false);
  const rows = useMemo(() => {
    if (filter === "all") return collapse(full, ctx, expanded);
    // Only one side: keep hunks/gaps so the reader still knows lines were skipped.
    const out: DiffRow[] = [];
    let gap = 0;
    for (const r of full) {
      if (r.kind === filter || r.kind === "hunk") { if (gap) { out.push({ kind: "skip", count: gap, start: -1 }); gap = 0; } out.push(r); }
      else gap++;
    }
    if (gap) out.push({ kind: "skip", count: gap, start: -1 });
    return out;
  }, [full, filter, ctx, expanded]);
  const shown = rows.slice(0, cap);
  const copy = async () => { if (!copyText) return; try { await navigator.clipboard.writeText(copyText); setCopied(true); window.setTimeout(() => setCopied(false), 1500); } catch { /* clipboard unavailable */ } };
  const width = String(Math.max(...full.map((r) => (r.kind === "same" || r.kind === "add" || r.kind === "del" ? Math.max(r.oldNo ?? 0, r.newNo ?? 0) : 0)), 1)).length;

  return (
    <div className="dv">
      <div className="dv-bar">
        {label && <span className="muted small">{label}</span>}
        <span className="mono small diffstat"><span className="add">+{stat.add}</span> <span className="del">−{stat.del}</span></span>
        <span className="spacer" />
        {open && (stat.add > 0 || stat.del > 0) && <span className="views xs">
          <button className={filter === "all" ? "on" : ""} onClick={() => setFilter("all")}>全部</button>
          <button className={filter === "add" ? "on" : ""} disabled={!stat.add} onClick={() => setFilter("add")}>只看新增</button>
          <button className={filter === "del" ? "on" : ""} disabled={!stat.del} onClick={() => setFilter("del")}>只看删除</button>
        </span>}
        {copyText && <button className="link sm" onClick={copy}>{copied ? "已复制" : "复制新内容"}</button>}
        {full.length > COLLAPSE_ROWS && <button className="link sm" onClick={() => setOpen(!open)}>{open ? "收起" : `展开 ${full.length} 行`}</button>}
      </div>
      {!open && <div className="dv-folded muted small">改动较大（{full.length} 行），先看上面的统计；点「展开」再看全文。</div>}
      {open && (
        <pre className="diff dv-pre" style={{ ["--w" as string]: `${width}ch` }}>
          {shown.map((r, k) => {
            if (r.kind === "hunk") return <div key={k} className="hunk-line">{r.text}</div>;
            if (r.kind === "skip") return r.start >= 0
              ? <button key={k} className="skip" onClick={() => setExpanded((s) => new Set(s).add(r.start))} title="展开这些未变的行">… {r.count} 行未变，点开 …</button>
              : <div key={k} className="skip">… 跳过 {r.count} 行 …</div>;
            return (
              <div key={k} className={`ln ${r.kind}`}>
                <span className="no">{r.oldNo ?? ""}</span><span className="no">{r.newNo ?? ""}</span>
                <span className="mk">{r.kind === "add" ? "+" : r.kind === "del" ? "−" : " "}</span>
                <span className="tx">{r.segs ? r.segs.map((s, i) => s.changed ? <mark key={i}>{s.text}</mark> : s.text) : r.text}</span>
              </div>
            );
          })}
          {rows.length > cap && <button className="skip" onClick={() => setCap((c) => c + HARD_CAP)}>… 还有 {rows.length - cap} 行，再显示 {Math.min(HARD_CAP, rows.length - cap)} 行 …</button>}
        </pre>
      )}
    </div>
  );
}

// Old/new pair from an Edit or Write tool call.
export function PairDiff({ oldText, newText, label, defaultOpen }: { oldText: string; newText: string; label?: string; defaultOpen?: boolean }) {
  const rows = useMemo(() => pairRows(oldText, newText), [oldText, newText]);
  return <DiffTable rows={rows} label={label} copyText={newText} defaultOpen={defaultOpen} />;
}

// Unified-diff text (git diff, Codex apply_patch).
export function PatchDiff({ text, label, defaultOpen }: { text: string; label?: string; defaultOpen?: boolean }) {
  const rows = useMemo(() => patchRows(text), [text]);
  return <DiffTable rows={rows} label={label} defaultOpen={defaultOpen} />;
}
