import type { RefObject } from "react";
import type { View } from "../types";
import type { Filters } from "./Sidebar";
import { BOARD_SORTS, type BoardSort } from "./views";
import { Dropdown, Tabs } from "./primitives";
import { Icon } from "./icons";
import { useT } from "../i18n";

// The tab row over 全部任务 (Raycast List with a filter bar): 列表 / 看板 / 表格 / 脉络, then 回收站 and
// 已归档, and on the right the text filter, the three quick filters, the sort and the count.
// ＋新任务 and 归档旧任务 are in ⌘K and the right-click menu.
export type TaskView = "list" | "board" | "table" | "graph" | "trash" | "archive";

interface Props {
  view: View;
  onView: (v: TaskView) => void;
  query: string;
  onQuery: (q: string) => void;
  searchRef?: RefObject<HTMLInputElement | null>;
  sort: BoardSort;
  onSort: (s: BoardSort) => void;
  filters: Filters;
  onFilters: (f: Filters) => void;
  onClear: () => void;
  counts: { review: number; blocked: number; trash: number; archive: number; shown: number };
}

export function TaskTabs({ view, onView, query, onQuery, searchRef, sort, onSort, filters, onFilters, onClear, counts }: Props) {
  const t = useT();
  const filtering = view === "list" || view === "board" || view === "table";
  const any = Object.values(filters).some(Boolean) || filters.project !== null || !!query;
  const items: { key: TaskView; label: string; count?: number; title?: string }[] = [
    { key: "list", label: t("列表") },
    { key: "board", label: t("看板") },
    { key: "table", label: t("表格") },
    { key: "graph", label: t("脉络") },
    { key: "trash", label: t("回收站"), count: counts.trash || undefined, title: t("移到回收站的任务，可恢复") },
    { key: "archive", label: t("已归档"), count: counts.archive || undefined, title: t("归档过的已完成任务：不进已完成列，不计数") },
  ];
  return (
    <Tabs items={items} value={view as TaskView} onChange={onView} right={filtering ? (
      <div className="lst-filters">
        <label className="lst-find" title={t("筛任务、ID、Agent…")}>
          <Icon name="search" size={13} />
          <input ref={searchRef} placeholder={t("筛选")} aria-label={t("筛任务、ID、Agent…")} value={query} onChange={(e) => onQuery(e.target.value)} />
          {query && <button aria-label={t("清除任务筛选")} onClick={() => onQuery("")}><Icon name="x" size={12} /></button>}
        </label>
        {filters.project !== null && <button className="dd on" onClick={() => onFilters({ ...filters, project: null })} title={t("清除项目筛选")}>{filters.project || t("未分项目")}<Icon name="x" size={10} /></button>}
        {filters.agent && <button className="dd on" onClick={() => onFilters({ ...filters, agent: null })}>{filters.agent}<Icon name="x" size={10} /></button>}
        <button className={`dd${filters.urgent ? " on" : ""}`} aria-pressed={filters.urgent} onClick={() => onFilters({ ...filters, urgent: !filters.urgent })}>{t("P0 到 P1")}</button>
        <button className={`dd${filters.blocked ? " on" : ""}`} aria-pressed={filters.blocked} disabled={!counts.blocked && !filters.blocked} onClick={() => onFilters({ ...filters, blocked: !filters.blocked, review: false })}>{t("阻塞 {n}", { n: counts.blocked })}</button>
        <button className={`dd${filters.review ? " on" : ""}`} aria-pressed={filters.review} disabled={!counts.review && !filters.review} onClick={() => onFilters({ ...filters, review: !filters.review, blocked: false })}>{t("Agent 复核 {n}", { n: counts.review })}</button>
        <Dropdown value={sort} onChange={onSort} label={t("任务排序")} options={BOARD_SORTS.map((o) => ({ value: o.key, label: t(o.label) }))} />
        <span className="dd num">{t("{n} 项", { n: counts.shown })}</span>
        {any && <button className="dd" onClick={onClear}>{t("清除筛选")}</button>}
      </div>
    ) : undefined} />
  );
}
