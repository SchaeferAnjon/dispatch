/*
 * List building blocks (DESIGN.md「组件」). Every list page is built from these, so a page reads like
 * every other page: 32px one-line rows in named sections, a 380px Detail on the right, grey hover and
 * selection, semantic colour only inside tags. A row says one thing: its title. Progress, ids, paths and
 * counts go in the Detail. Look lives in styles.css under "Primitives"; this file only picks class names.
 * Keep the API small: add a prop before a component.
 *
 *   <ListDetail tabs={<Tabs …/>} detail={selected && <DetailPane …/>}>      list + optional Detail
 *     <Section title={t("等你回复")} count={3} right={t("按最近活动")}>
 *       <Row id={a.key} selected={a.key === sel} onClick={() => setSel(a.key)} onOpen={() => open(a)}
 *            icon={<Avatar actor={…} />} title={a.title}
 *            accessories={[<Tag color="blue">{t("未读")}</Tag>, "1d"]} data-session={key} />
 *     </Section>
 *   </ListDetail>
 *
 *   useListKeyboard(ids, sel, setSel, { onEnter: open })   ↑↓ moves the selection, ↵ opens it
 *   <EmptyView icon="chat" title={t("没有会话")} description={t("…")} />
 *   <Tag color="orange">P1</Tag>  <Tag>P2</Tag>   colours: blue green orange red purple, default grey
 *   <Kbd>↵</Kbd>  <Shortcut k="K" />  → ⌘ K on a Mac, Ctrl K on Windows (never hard-code ⌘)
 *   <Meter value={2} max={7} />   3px progress bar plus "2/7"
 *   <Tabs items={[{ key: "all", label: t("全部"), count: 12 }]} value={tab} onChange={setTab} right={<Dropdown …/>} />
 *   <Dropdown value={v} onChange={setV} options={[{ value: "", label: t("所有项目") }]} label={t("项目")} />
 *   <Meta rows={[[t("主机"), "小蓝"], [t("恢复"), <code>…</code>]]} />   Detail key/value grid, 28px rows
 *   <Sep />   hairline between Detail blocks
 *
 * Mockup class → class here: .row → .lrow, .sec → .lsec, .meta → .dmeta, .sep → .dsep, .empty → .empty-view,
 * .screen.split → .ld.split (old .row/.sec/.meta/.empty are taken by dialogs, task detail and the workbench).
 * Hover is --sel at 60%, selection --sel; rows take a pointer.
 */
import { useEffect, useRef, type HTMLAttributes, type ReactNode } from "react";
import { modKey } from "../platform";
import { Icon } from "./icons";

export type TagColor = "blue" | "green" | "orange" | "red" | "purple";

/** A small bordered label for status, priority, owner, counts. Grey unless it carries meaning. */
export function Tag({ color, children, title, dot }: { color?: TagColor; children: ReactNode; title?: string; dot?: boolean }) {
  return <span className={`tag${color ? ` ${color}` : ""}`} title={title}>{dot && <span className="tag-dot" />}{children}</span>;
}

/** One key cap. */
export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="kbd">{children}</kbd>;
}

/** The platform's modifier as key-cap text: "⌘" on a Mac, "Ctrl" elsewhere (from platform.modKey()). */
export function modCap(): string {
  return modKey().replace(/\+$/, "");
}

/** A shortcut as key caps. `k` alone means modifier + k; `keys` spells every cap out. */
export function Shortcut({ k, keys, shift }: { k?: string; keys?: string[]; shift?: boolean }) {
  const caps = keys ?? [modCap(), ...(shift ? ["⇧"] : []), ...(k ? [k] : [])];
  return <span className="kbds">{caps.map((c, i) => <Kbd key={i}>{c}</Kbd>)}</span>;
}

/** Acceptance-style progress: a 48px, 3px bar and "value/max". */
/** A thin progress bar. `soft`: a second, lighter segment after `value` (acceptance items an
 *  Agent ticked for itself: shown, not counted). */
export function Meter({ value, max, label, soft = 0, title }: { value: number; max: number; label?: ReactNode; soft?: number; title?: string }) {
  const clamp = (v: number) => (max > 0 ? Math.max(0, Math.min(100, (v / max) * 100)) : 0);
  const pct = clamp(value);
  const softPct = Math.min(100 - pct, clamp(soft));
  return <span className="meter" title={title}><span className="m"><i style={{ width: `${pct}%` }} />{softPct > 0 && <i className="soft" style={{ width: `${softPct}%` }} />}</span>{label ?? `${value}/${max}`}</span>;
}

/** A named group of rows: grey 12px title, a count, optional right-hand note. */
export function Section({ title, count, right, children }: { title: ReactNode; count?: number | string; right?: ReactNode; children?: ReactNode }) {
  return (
    <div className="lsec-wrap" role="group">
      <div className="lsec">{title}{count !== undefined && <span className="n">{count}</span>}{right !== undefined && <span className="r">{right}</span>}</div>
      {children}
    </div>
  );
}

type RowProps = Omit<HTMLAttributes<HTMLDivElement>, "title"> & {
  /** Stable id: `useListKeyboard` scrolls the row with this id into view. */
  id?: string;
  /** 20px leading visual: an Avatar, a project glyph, or an <Icon>. */
  icon?: ReactNode;
  title: ReactNode;
  /** Right-hand items (tags, meters, times), 8px apart. Keep it to two or three. */
  accessories?: ReactNode[];
  selected?: boolean;
  /** Double click or ↵ (via useListKeyboard): the row's main action. A single click only selects. */
  onOpen?: () => void;
  tooltip?: string;
};

/** One 32px list row: icon, title, accessories. */
export function Row({ id, icon, title, accessories, selected, onOpen, tooltip, className, ...rest }: RowProps) {
  return (
    <div role="option" aria-selected={!!selected} data-row-id={id} title={tooltip} className={`lrow${selected ? " sel" : ""}${className ? ` ${className}` : ""}`} onDoubleClick={onOpen} {...rest}>
      <span className="lrow-ic">{icon}</span>
      <div className="lrow-main"><span className="t">{title}</span></div>
      {accessories && accessories.length > 0 && <div className="acc">{accessories.map((a, i) => <span key={i} className="acc-i">{a}</span>)}</div>}
    </div>
  );
}

/** Centered empty state: 36px icon, a title, one sentence, optional buttons. */
export function EmptyView({ icon = "inbox", title, description, actions }: { icon?: string; title: ReactNode; description?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="empty-view">
      <Icon name={icon} size={36} />
      <b>{title}</b>
      {description && <span>{description}</span>}
      {actions && <div className="empty-actions">{actions}</div>}
    </div>
  );
}

/** Filter tabs over a list, with room on the right for dropdowns. */
export function Tabs<K extends string>({ items, value, onChange, right }: { items: { key: K; label: ReactNode; count?: number; title?: string }[]; value: K; onChange: (k: K) => void; right?: ReactNode }) {
  return (
    <div className="tabs" role="tablist">
      {items.map((it) => (
        <button key={it.key} role="tab" aria-selected={it.key === value} className={it.key === value ? "on" : ""} title={it.title} onClick={() => onChange(it.key)}>
          {it.label}{it.count !== undefined && <span className="n">{it.count}</span>}
        </button>
      ))}
      <span className="sp" />
      {right}
    </div>
  );
}

/** A quiet dropdown (Raycast List.Dropdown): native select, styled as grey text with a caret. */
export function Dropdown<V extends string>({ value, onChange, options, label }: { value: V; onChange: (v: V) => void; options: { value: V; label: string }[]; label: string }) {
  return (
    <label className="dd" title={label}>
      {/* The shown text is a span: WebKit sizes a <select> to its longest option, which pushed the chevron away. */}
      <span className="dd-v">{options.find((o) => o.value === value)?.label ?? ""}</span>
      <select value={value} aria-label={label} onChange={(e) => onChange(e.target.value as V)}>
        {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
      <Icon name="down" size={10} />
    </label>
  );
}

/** Detail key/value grid: 88px grey keys, 28px rows. */
export function Meta({ rows }: { rows: [ReactNode, ReactNode][] }) {
  return <div className="dmeta">{rows.map(([k, v], i) => <div key={i} className="dmeta-r"><span className="k">{k}</span><span className="v">{v}</span></div>)}</div>;
}

export function Sep() {
  return <div className="dsep" />;
}

/** The list page frame: optional tabs row, a scrolling list, an optional 380px Detail on the right. */
export function ListDetail({ tabs, detail, children, className, listRef }: { tabs?: ReactNode; detail?: ReactNode; children: ReactNode; className?: string; listRef?: React.Ref<HTMLDivElement> }) {
  return (
    <div className={`ld${detail ? " split" : ""}${className ? ` ${className}` : ""}`}>
      <div className="ld-col">
        {tabs}
        <div className="ld-list" role="listbox" ref={listRef}>{children}</div>
      </div>
      {detail && <aside className="ld-detail">{detail}</aside>}
    </div>
  );
}

// ↑↓ and ↵ belong to the list only while nothing else wants the keys: a text field, an open menu,
// dialog or the ⌘K panel.
function keysTaken(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (el && typeof el.closest === "function" && el.closest('input,textarea,select,[contenteditable="true"]')) return true;
  return !!document.querySelector(".overlay,.task-menu-shade,.ap,.dialog");
}

/**
 * Keyboard selection for a list: ↑/↓ move `selected` through `ids` (in display order), ↵ calls
 * `onEnter` with the selected id. The newly selected row (a <Row id=…>) scrolls into view.
 * Pass `enabled: false` while the page is hidden or another list owns the keys.
 */
export function useListKeyboard(ids: string[], selected: string | null, onSelect: (id: string) => void, opts: { onEnter?: (id: string) => void; enabled?: boolean } = {}) {
  const latest = useRef({ ids, selected, onSelect, opts });
  latest.current = { ids, selected, onSelect, opts };
  useEffect(() => {
    if (opts.enabled === false) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || e.defaultPrevented) return;
      if (e.key !== "ArrowDown" && e.key !== "ArrowUp" && e.key !== "Enter") return;
      if (keysTaken(e.target)) return;
      const { ids, selected, onSelect, opts } = latest.current;
      if (!ids.length) return;
      if (e.key === "Enter") { if (selected && opts.onEnter) { e.preventDefault(); opts.onEnter(selected); } return; }
      e.preventDefault();
      const at = selected ? ids.indexOf(selected) : -1;
      const next = e.key === "ArrowDown" ? ids[Math.min(ids.length - 1, at + 1)] : ids[Math.max(0, at < 0 ? 0 : at - 1)];
      if (!next) return;
      onSelect(next);
      requestAnimationFrame(() => document.querySelector(`[data-row-id="${CSS.escape(next)}"]`)?.scrollIntoView({ block: "nearest" }));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [opts.enabled]);
}
