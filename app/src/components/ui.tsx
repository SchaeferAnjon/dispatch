import { useT } from "../i18n";
import type { Actor } from "../derive";
import { projectColor, statusLabel } from "../derive";
import type { Issue } from "../types";
import { Tag, type TagColor } from "./primitives";

export function Avatar({ actor, online, size }: { actor: Actor | null; online?: boolean; size?: number }) {
  if (!actor) return null;
  const style = size ? { width: size, height: size, fontSize: Math.round(size * 0.4) } : undefined;
  return (
    <span className={`av ${actor.kind}`} style={style} title={actor.id}>
      {actor.glyph}
      {online !== undefined && <span className={`dot${online ? "" : " idle"}`} />}
    </span>
  );
}

// Status and priority are tags (primitives.tsx): colour only where it means something.
export const STATUS_TONE: Record<string, TagColor | undefined> = { prog: "orange", done: "green", rev: "blue", block: "red" };
export function StatusPill({ issue, sm }: { issue: Issue; sm?: boolean }) {
  const s = statusLabel(issue);
  return <Tag color={STATUS_TONE[s.cls]} dot={!sm}>{s.text}</Tag>;
}

const PRI_TEXT: Record<number, string> = { 0: "P0 最高：马上做，阻塞别人", 1: "P1 高：本周内", 2: "P2 普通（默认）", 3: "P3 低：有空再做", 4: "P4 想法：先记着" };
export function Pri({ p }: { p: number }) {
  const t = useT();
  return <span className={`tag pri p${p}${p === 0 ? " red" : p === 1 ? " orange" : ""}`} title={t("优先级 {text}；bd update <id> -p 0 到 4 可改", { text: PRI_TEXT[p] ? t(PRI_TEXT[p]) : `P${p}` })}>P{p}</span>;
}

export function ProjectTag({ name }: { name: string }) {
  const t = useT();
  if (!name) return <span className="tag">{t("未分项目")}</span>;
  return (
    <span className="tag">
      <span className="proj" style={{ background: projectColor(name) }} />
      {name}
    </span>
  );
}

export const TYPE_LABEL: Record<string, string> = { task: "任务", bug: "缺陷", feature: "功能", epic: "史诗", chore: "杂务", decision: "决策" };
