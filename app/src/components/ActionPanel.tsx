import { useEffect, useMemo, useRef, useState } from "react";
import type { Activity, Issue } from "../types";
import type { ViewMenuItem } from "./ContextMenu";
import { HIT_GROUPS, HitParts, useSearchHits, type Hit } from "./Search";
import { Icon } from "./icons";
import { Kbd } from "./primitives";
import { useT } from "../i18n";

/** `searchOnly`: listed only while typing (e.g. every page by name). */
export type PanelSection = { title: string; items: ViewMenuItem[]; searchOnly?: boolean };

interface Props {
  /** Actions, top to bottom: the selected thing, this page, navigation, Dispatch. Empty sections are skipped. */
  sections: PanelSection[];
  projects: string[];
  rows: Activity[];
  issues: Issue[];
  me: string;
  archiveDays: number;
  onProject: (name: string) => void;
  onSession: (id: string) => void;
  onTask: (id: string) => void;
  onClose: () => void;
}

type Entry = { kind: "action"; key: string; item: ViewMenuItem } | { kind: "hit"; key: string; hit: Hit };

// ⌘K: the action panel above the bottom bar (Raycast's Action Panel). With an empty box it lists
// what can be done with the selection and on this page; typing filters those actions and, below
// them, searches projects, conversations and tasks (the old ⌘K search). ↑↓ move, ↵ runs, esc closes.
export function ActionPanel({ sections, projects, rows, issues, me, archiveDays, onProject, onSession, onTask, onClose }: Props) {
  const t = useT();
  const [q, setQ] = useState("");
  const [cursor, setCursor] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  useEffect(() => { input.current?.focus(); }, []);

  const hits = useSearchHits(q, projects, rows, issues);
  const groups = useMemo(() => {
    const words = q.trim().toLowerCase().split(/\s+/).filter(Boolean);
    const match = (i: ViewMenuItem) => { const s = `${i.label} ${i.sub ?? ""}`.toLowerCase(); return words.every((w) => s.includes(w)); };
    const out: { title: string; entries: Entry[] }[] = [];
    if (!words.length) {
      for (const s of sections) if (s.items.length && !s.searchOnly) out.push({ title: s.title, entries: s.items.map((item, n) => ({ kind: "action", key: `${s.title}:${n}:${item.label}`, item })) });
    } else {
      const seen = new Set<string>();
      const acts = sections.flatMap((s) => s.items.filter(match).filter((i) => !seen.has(i.label) && !!seen.add(i.label)));
      if (acts.length) out.push({ title: t("操作"), entries: acts.map((item, n) => ({ kind: "action", key: `a:${n}:${item.label}`, item })) });
      for (const g of HIT_GROUPS) { const hs = hits.filter((h) => h.kind === g.kind); if (hs.length) out.push({ title: t(g.label), entries: hs.map((hit) => ({ kind: "hit", key: hit.key, hit })) }); }
    }
    return out;
  }, [q, sections, hits, t]);
  const flat = useMemo(() => groups.flatMap((g) => g.entries), [groups]);
  useEffect(() => { setCursor(0); }, [q]);
  useEffect(() => { list.current?.querySelector(".lrow.sel")?.scrollIntoView({ block: "nearest" }); }, [cursor]);

  const run = (e: Entry | undefined) => {
    if (!e) return;
    if (e.kind === "action") { if (e.item.disabled) return; onClose(); void e.item.onClick(); return; }
    const h = e.hit;
    onClose();
    if (h.kind === "project") onProject(h.name); else if (h.kind === "session") onSession(h.a.session_id); else onTask(h.i.id);
  };
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); if (q) setQ(""); else onClose(); return; }
    if (e.key === "ArrowDown") { e.preventDefault(); setCursor((c) => Math.min(flat.length - 1, c + 1)); }
    if (e.key === "ArrowUp") { e.preventDefault(); setCursor((c) => Math.max(0, c - 1)); }
    if (e.key === "Enter" && !e.nativeEvent.isComposing) { e.preventDefault(); run(flat[cursor]); }
  };

  let n = -1;
  return (
    <div className="ap-shade" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="ap" role="dialog" aria-label={t("操作")} onKeyDown={onKey}>
        <div className="apl" ref={list} role="listbox">
          {groups.map((g) => (
            <div key={g.title} role="group">
              <div className="lsec">{g.title}</div>
              {g.entries.map((e) => {
                const idx = ++n;
                const cls = `lrow${idx === cursor ? " sel" : ""}${e.kind === "action" && e.item.disabled ? " off" : ""}${e.kind === "action" && e.item.danger ? " danger" : ""}`;
                return (
                  <div key={e.key} role="option" aria-selected={idx === cursor} className={cls} onMouseMove={() => { if (cursor !== idx) setCursor(idx); }} onClick={() => run(e)}>
                    {e.kind === "action" ? <>
                      <span className="lrow-ic">{e.item.icon ? <Icon name={e.item.icon} /> : null}</span>
                      <div className="lrow-main"><span className="t">{e.item.label}</span>{e.item.sub && <span className="s">{e.item.sub}</span>}</div>
                      <div className="acc">{e.item.keys ? <span className="kbds">{e.item.keys.map((k, i) => <Kbd key={i}>{k}</Kbd>)}</span> : e.item.hint ? <span className="kbds">{splitHint(e.item.hint).map((k, i) => <Kbd key={i}>{k}</Kbd>)}</span> : null}</div>
                    </> : <HitParts h={e.hit} me={me} archiveDays={archiveDays} />}
                  </div>
                );
              })}
            </div>
          ))}
          {q.trim() && flat.length === 0 && <div className="ap-empty">{t("没有匹配的操作、项目、会话或任务")}</div>}
        </div>
        <div className="apf">
          <Icon name="search" />
          <input ref={input} value={q} onChange={(e) => setQ(e.target.value)} placeholder={t("搜操作，或直接搜任务、会话、项目…")} aria-label={t("搜操作，或直接搜任务、会话、项目…")} autoCorrect="off" autoCapitalize="off" autoComplete="off" spellCheck={false} />
          <Kbd>esc</Kbd>
        </div>
      </div>
    </div>
  );
}

// "⌘N" / "Ctrl+N" → key caps.
function splitHint(h: string): string[] {
  if (h.startsWith("Ctrl+")) return ["Ctrl", ...splitHint(h.slice(5))];
  if (h.startsWith("⌘") || h.startsWith("⇧")) return [h[0], ...splitHint(h.slice(1))];
  return h ? [h] : [];
}
