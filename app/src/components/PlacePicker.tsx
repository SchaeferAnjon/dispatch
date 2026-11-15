import { useEffect, useMemo, useRef, useState } from "react";
import { useT } from "../i18n";
import { middlePath } from "../activity";
export { middlePath };
import { Icon } from "./icons";
import "../place-picker.css";

// The 项目或文件夹 chip of 新建 Agent: a popover with a search, the projects and recent folders, and one fixed row
// at the bottom: the folder browser of the 派活 dialog.

/** A folder Agents only pass through: /tmp, macOS temp folders, scratchpads and sandboxes. */
export const isScratch = (cwd: string) => /^(\/private)?\/tmp\/|^\/var\/folders\/|\/(scratchpad|sandbox|spike)(\/|$)/.test(cwd || "");

export interface PlaceItem { kind: "project" | "folder"; name: string; dir: string }

/** Projects first, then folders (the current one and the recent ones) that are no project's folder; `q` filters by name and path.
 *  Folders Agents only pass through (/tmp, scratchpads: isScratch) are left out unless one is the current folder (`folders[0]`). */
export function placeItems(projects: { name: string; dir?: string }[], folders: string[], q: string): PlaceItem[] {
  const keep = (d?: string) => !d || !isScratch(d) || d === folders[0];
  const dirs = new Set(projects.map((p) => p.dir));
  const all: PlaceItem[] = [
    ...projects.filter((p) => keep(p.dir)).map((p) => ({ kind: "project" as const, name: p.name, dir: p.dir ?? "" })),
    ...[...new Set(folders.filter(Boolean))].filter((f) => !dirs.has(f) && keep(f)).map((f) => ({ kind: "folder" as const, name: f.replace(/\/+$/, "").split("/").pop() || f, dir: f })),
  ];
  const s = q.trim().toLowerCase();
  return s ? all.filter((i) => i.name.toLowerCase().includes(s) || i.dir.toLowerCase().includes(s)) : all;
}

interface Props {
  label: string;
  cwd: string;
  project: string;
  projects: { name: string; dir?: string }[];
  recent: string[];
  disabled?: boolean;
  onProject: (name: string) => void;
  onFolder: (dir: string) => void;
  /** The bottom row, 其他文件夹…: the folder browser. */
  onOther: () => void;
}

export function PlacePicker({ label, cwd, project, projects, recent, disabled, onProject, onFolder, onOther }: Props) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [cursor, setCursor] = useState(0);
  const wrap = useRef<HTMLSpanElement>(null);
  const chip = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const items = useMemo(() => placeItems(projects, [cwd, ...recent], q), [projects, cwd, recent, q]);
  // The project picked, or the project whose folder is picked; a folder row only when neither.
  const curProject = projects.some((p) => p.name === project) ? project : projects.find((p) => p.dir && p.dir === cwd)?.name;
  const isCurrent = (i: PlaceItem) => (i.kind === "project" ? i.name === curProject : i.dir === cwd && !curProject);
  const close = () => { setOpen(false); chip.current?.focus(); };
  const pick = (i: PlaceItem) => { close(); if (i.kind === "project") onProject(i.name); else onFolder(i.dir); };
  const bottom = () => { close(); onOther(); };
  const show = () => { setQ(""); setCursor(Math.max(0, placeItems(projects, [cwd, ...recent], "").findIndex(isCurrent))); setOpen(true); };
  useEffect(() => {
    if (!open) return;
    const down = (e: MouseEvent) => { if (!wrap.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", down);
    return () => document.removeEventListener("mousedown", down);
  }, [open]);
  useEffect(() => { if (open) list.current?.querySelector(".pp-row.on")?.scrollIntoView({ block: "nearest" }); }, [open, cursor]);
  return (
    <span className="pp" ref={wrap}>
      <button ref={chip} type="button" className="dd fit" aria-label={t("项目或文件夹")} aria-expanded={open} title={cwd || undefined} disabled={disabled} onClick={() => (open ? setOpen(false) : show())}>
        <Icon name="folder" size={14} /><span className="v">{label || t("选文件夹")}</span><Icon name="down" size={12} className="caret" />
      </button>
      {open && (
        <div className="pp-pop" role="dialog" aria-label={t("项目或文件夹")}>
          <div className="pp-q"><Icon name="search" size={14} />
            <input autoFocus value={q} placeholder={t("搜项目")} aria-label={t("搜项目")} onChange={(e) => { setQ(e.target.value); setCursor(0); }}
              onKeyDown={(e) => {
                if (e.nativeEvent.isComposing || e.keyCode === 229) return;
                if (e.key === "Escape") { e.preventDefault(); close(); }
                else if (e.key === "ArrowDown") { e.preventDefault(); setCursor((c) => Math.min(items.length - 1, c + 1)); }
                else if (e.key === "ArrowUp") { e.preventDefault(); setCursor((c) => Math.max(0, c - 1)); }
                else if (e.key === "Enter") { e.preventDefault(); if (items[cursor]) pick(items[cursor]); }
              }} />
          </div>
          <div className="pp-list" ref={list} role="listbox">
            {items.map((i, n) => (
              <div key={`${i.kind}:${i.name}:${i.dir}`} role="option" aria-selected={isCurrent(i)} className={`pp-row${n === cursor ? " on" : ""}${isCurrent(i) ? " cur" : ""}`}
                onMouseEnter={() => setCursor(n)} onMouseDown={(e) => e.preventDefault()} onClick={() => pick(i)} title={i.dir || undefined}>
                <Icon name="folder" />
                <span className="pp-t"><span className="pp-n">{i.name}</span>{i.dir && <span className="pp-d">{middlePath(i.dir)}</span>}</span>
                {isCurrent(i) && <Icon name="check" size={14} />}
              </div>
            ))}
            {!items.length && <div className="pp-none">{t("没有匹配的项目或文件夹")}</div>}
          </div>
          <div className="pp-foot">
            <button type="button" className="pp-row" onClick={bottom}><Icon name="plus" /><span className="pp-n">{t("其他文件夹…")}</span></button>
          </div>
        </div>
      )}
    </span>
  );
}
