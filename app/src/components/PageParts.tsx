/*
 * Small pieces shared by the Agent, usage and knowledge pages (Agent 状态, 统计与额度, 技能, 规则与资料,
 * 知识库). They sit on top of primitives.tsx and keep those pages alike: a filter field in the tabs row,
 * one Detail heading, a folded "where this comes from" note. Look lives in styles.css under
 * "==== agents-knowledge ====".
 *
 *   <SearchField value={q} onChange={setQ} placeholder={t("搜技能名、描述…")} />
 *   <DetailHead crumb={[t("技能"), path]} title={name} tag={<Tag>…</Tag>} actions={<button className="btn sm">…</button>} />
 *   <About summary={t("数据来源")}>{long explanatory copy}</About>
 *   hostName(hosts, host)   the machine a config page reads and writes, for the header summary
 *   revealDetail()   on a phone the Detail sits under the list; call after a click selects a row
 */
import type { ReactNode } from "react";
import type { Host } from "../types";
import { t } from "../i18n";
import { Icon } from "./icons";

/** A quiet text filter for the right side of a <Tabs> row. */
export function SearchField({ value, onChange, placeholder, label, wide }: { value: string; onChange: (v: string) => void; placeholder: string; label?: string; wide?: boolean }) {
  return (
    <label className={`ak-search${wide ? " wide" : ""}`}>
      <Icon name="search" size={14} />
      <input type="search" value={value} placeholder={placeholder} aria-label={label ?? placeholder} onChange={(e) => onChange(e.target.value)} />
    </label>
  );
}

/** Detail heading: grey crumb, 17px title with an optional tag, then a row of buttons. */
export function DetailHead({ crumb, title, tag, actions, icon, mono }: { crumb?: ReactNode[]; title: ReactNode; tag?: ReactNode; actions?: ReactNode; icon?: ReactNode; mono?: boolean }) {
  const parts = (crumb ?? []).filter((c) => c !== undefined && c !== null && c !== "");
  return (
    <>
      {parts.length > 0 && <div className="akd-crumb">{parts.map((c, i) => <span key={i} className="akd-crumb-i">{i > 0 && <Icon name="right" size={10} />}<span>{c}</span></span>)}</div>}
      <div className="akd-h">{icon}<h2 className={mono ? "mono" : undefined}>{title}</h2>{tag}</div>
      {actions && <div className="akd-acts">{actions}</div>}
    </>
  );
}

/** Long explanatory copy, folded: shown only when someone asks where the numbers come from. */
export function About({ summary, children, className }: { summary: ReactNode; children: ReactNode; className?: string }) {
  return (
    <details className={`ak-about${className ? ` ${className}` : ""}`}>
      <summary><Icon name="help" size={14} />{summary}</summary>
      <div className="ak-about-b">{children}</div>
    </details>
  );
}

/** A grey sub-heading inside a Detail, with an optional count. */
export function DetailSection({ title, count, children, right }: { title: ReactNode; count?: number; children: ReactNode; right?: ReactNode }) {
  return (
    <section className="akd-sec">
      <h3 className="akd-sub">{title}{count !== undefined && <span className="n">{count}</span>}{right !== undefined && <span className="r">{right}</span>}</h3>
      {children}
    </section>
  );
}

/** On a phone the list and the Detail stack; bring the Detail into view after a tap. */
export function revealDetail() {
  if (typeof window === "undefined" || !window.matchMedia?.("(max-width:640px)").matches) return;
  requestAnimationFrame(() => document.querySelector(".ak-page .ld-detail")?.scrollIntoView({ block: "start", behavior: "smooth" }));
}

/** The name of the machine a config page works on ("local" is this one). */
export function hostName(hosts: Host[], host: string): string {
  if (host === "local") return hosts.find((h) => h.local)?.name || t("本机");
  return hosts.find((h) => h.id === host)?.name || host;
}
