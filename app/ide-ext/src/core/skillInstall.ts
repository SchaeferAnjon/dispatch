// Find skills (Customizations overview): the dispatch argv that installs one search result.
export interface FoundSkill {
  name: string;
  skill_id?: string;
  source: string;
  repo?: string;
  subpath?: string;
  installed?: boolean;
  mounted?: Record<string, boolean>;
}

export type SkillEngine = { id: "claude" | "codex" | "opencode"; label: string };

/** The engine the Customizations page is showing (its harness id, `agent-host-opencode`): its skills are
 *  mounted for that one. */
export function engineOf(harness: unknown): SkillEngine {
  const h = String(harness ?? "").toLowerCase();
  if (h.includes("opencode")) return { id: "opencode", label: "OpenCode" };
  return h.includes("codex") ? { id: "codex", label: "Codex" } : { id: "claude", label: "Claude Code" };
}

/** argv for installing one search result: import it from its repo, or mount it when it is in the pool. */
export function installArgs(s: FoundSkill, agents: string[]): string[] | undefined {
  const mount = agents.flatMap((a) => ["--agent", a]);
  if (s.source === "pool" || s.source === "local") return ["skills", "enable", s.name, ...mount];
  if (!s.repo || !/^[\w.-]+\/[\w.-]+$/.test(s.repo)) return undefined;
  const as = s.skill_id || s.name;
  return ["skills", "install", s.repo, "--as", as, ...(s.subpath ? ["--path", s.subpath] : []), ...mount, "--json"];
}

