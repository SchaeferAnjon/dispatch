// 「分配到项目」: one button next to a crumb that reads 未分项目 / 零散会话. Tasks get a `project:<name>`
// label, conversations a project_override (the same two writes the menus already make); App provides both.
import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { Activity, Issue } from "../types";
import { useT } from "../i18n";
import { MenuPanel } from "./ContextMenu";
import { Icon } from "./icons";

type Assign = { projects: string[]; task: (i: Issue, name: string) => Promise<void>; conversation: (a: Activity, name: string) => Promise<void> };
const Context = createContext<Assign | null>(null);

export function AssignProjectProvider({ value, children }: { value: Assign; children: ReactNode }) {
  return <Context.Provider value={value}>{children}</Context.Provider>;
}

export function AssignProjectButton({ issue, activity }: { issue?: Issue; activity?: Activity }) {
  const t = useT();
  const ctx = useContext(Context);
  const [at, setAt] = useState<{ x: number; y: number } | null>(null), [q, setQ] = useState(""), [busy, setBusy] = useState(false), [err, setErr] = useState("");
  const btn = useRef<HTMLButtonElement>(null), input = useRef<HTMLInputElement>(null);
  // MenuPanel focuses its first item; the search field should have it instead.
  useEffect(() => { if (at) { const id = window.setTimeout(() => input.current?.focus(), 0); return () => window.clearTimeout(id); } }, [at]);
  const matches = useMemo(() => {
    const s = q.trim().toLowerCase();
    return (ctx?.projects ?? []).filter((p) => !s || p.toLowerCase().includes(s)).slice(0, 10);
  }, [ctx, q]);
  if (!ctx || (!issue && !activity)) return null;
  const pick = async (name: string) => {
    const n = name.trim();
    if (!n || busy) return;
    setBusy(true); setErr("");
    try {
      if (issue) await ctx.task(issue, n); else await ctx.conversation(activity!, n);
      setAt(null); setQ("");
    } catch (e) { setErr(String(e)); } finally { setBusy(false); }
  };
  const exact = matches.some((p) => p.toLowerCase() === q.trim().toLowerCase());
  return <>
    <button ref={btn} className="btn sm assign-project" onClick={(e) => { e.stopPropagation(); const r = e.currentTarget.getBoundingClientRect(); setAt({ x: r.left, y: r.bottom + 6 }); }} title={t("把它归到一个项目")}>
      <Icon name="folder" size={13} />{t("分配到项目")}
    </button>
    {at && <MenuPanel x={at.x} y={at.y} label={t("分配到项目")} title={t("分配到项目")} busy={busy} onClose={() => { setAt(null); setQ(""); }} returnTo={btn.current}>
      <form className="assign-form" onSubmit={(e) => { e.preventDefault(); void pick(matches[0] && !exact && !q.trim() ? matches[0] : q.trim() || matches[0] || ""); }}>
        <input ref={input} value={q} onChange={(e) => setQ(e.target.value)} placeholder={t("搜项目，或输入新项目名")} aria-label={t("项目名")} disabled={busy} />
      </form>
      {matches.map((p) => <button key={p} role="menuitem" disabled={busy} onClick={() => void pick(p)}>{p}</button>)}
      {q.trim() && !exact && <button role="menuitem" disabled={busy} onClick={() => void pick(q)}>{t("新项目「{name}」", { name: q.trim() })}</button>}
      {err && <p role="alert" className="danger small">{t("保存失败：{err}", { err })}</p>}
    </MenuPanel>}
  </>;
}
