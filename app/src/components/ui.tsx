import type { Actor } from "../derive";
import { projectColor, statusLabel } from "../derive";
import type { Issue } from "../types";

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

export function StatusPill({ issue, sm }: { issue: Issue; sm?: boolean }) {
  const s = statusLabel(issue);
  return <span className={`st ${s.cls}${sm ? " sm" : ""}`}>{sm ? null : <i />}{s.text}</span>;
}

export function Pri({ p }: { p: number }) {
  return <span className={`pri p${p}`}>P{p}</span>;
}

export function ProjectTag({ name }: { name: string }) {
  if (!name) return <span className="tag muted">未分项目</span>;
  return (
    <span className="tag">
      <span className="proj" style={{ background: projectColor(name) }} />
      {name}
    </span>
  );
}

export const TYPE_LABEL: Record<string, string> = { task: "任务", bug: "缺陷", feature: "功能", epic: "史诗", chore: "杂务", decision: "决策" };
