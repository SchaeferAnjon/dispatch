export type Status = "open" | "in_progress" | "blocked" | "closed" | "deferred";
export type Column = "todo" | "prog" | "done" | "reviewed";
export type View = "home" | "inbox" | "board" | "table" | "graph" | "projects" | "folders" | "agents" | "sessions" | "stats" | "skills" | "rules" | "pitfalls";

export interface StatsTokens { in: number; out: number; cr: number; cw: number; think: number }
export interface StatsDay { date: string; msgs: number; tokens: number; in: number; out: number; cr: number; cw: number; by: Record<string, number> }
export interface StatsRank { name: string; count: number; by: Record<string, number> }
export interface Stats {
  range_days: number;
  agent: string;
  total: { tokens: StatsTokens; total: number; sub_tokens: number; msgs: number; sessions: number; active_days: number; streak_cur: number; streak_max: number; tools_distinct: number; active_hours: number | null; first_day: string; last_day: string };
  agents: { agent: string; sessions: number; msgs: number; tokens: StatsTokens; total: number; days: number }[];
  days: StatsDay[];
  hours: number[][];
  models: { model: string; agent: string; msgs: number }[];
  tools: StatsRank[];
  skills: StatsRank[];
  subagents: StatsRank[];
  projects: { name: string; cwd: string; tokens: number; msgs: number; sessions: number; by: Record<string, number> }[];
  generated_at: number;
}
export interface Folder { cwd: string; name: string; sessions: number; agents: Record<string, number>; last_at: number; first_at: string | null; turns: number; tasks: string[]; exists: boolean }
export interface GraphEdge { from: string; to: string; type: string }
export interface GraphData { nodes: Issue[]; edges: GraphEdge[] }
export interface QuotaWindow { used_percent: number | null; resets_at: number | null; label: string }
export interface Quota { agent: string; plan: string; windows: QuotaWindow[]; updated_at: number | null; source: string; note: string }
export interface RuleTarget { agent: string; path: string; state: "synced" | "stale" | "absent" | "missing"; mode: "import" | "inline" }
export interface RulesStatus { hash: string; source: string; targets: RuleTarget[] }

export interface SubagentRef { agent_id: string; type: string; description: string; tool_use_id: string; depth: number; size: number; last_at: number; path: string }
export interface SessionRef {
  agent: string;
  session_id: string;
  cwd: string;
  project: string;
  title: string;
  first_prompt?: string;
  last_at: number;
  first_ts: string;
  last_ts: string;
  entrypoint: string;
  branch: string;
  user_msgs: number;
  assistant_msgs: number;
  tools: Record<string, number>;
  tasks: Record<string, number>;
  mentions: number;
  current_task: string | null;
  resume_cmd: string;
  path: string;
  size: number;
  subagents: SubagentRef[];
}
export interface TimelineMsg { ts: string; role: "user" | "assistant" | "tool" | "gap"; text: string; tools: { name: string; summary: string; id?: string }[] }
export interface FileChange { kind: "edit" | "write" | "patch"; old: string; new: string; ts: string; op?: string; add?: number; del?: number }
export interface SessionDetail { meta: SessionRef; messages: TimelineMsg[]; files: { path: string; changes: FileChange[] }[]; tool_counts: Record<string, number> }
export interface Memory { key: string; value: string }
export interface Skill { name: string; path: string; in_pool: boolean; description: string; agents: Record<string, boolean>; mounts?: Record<string, string | null>; usage?: Record<string, number>; last_used?: string }
export interface SkillImprove { prompt: string; command: string; top: { name: string; usage: Record<string, number>; last_used: string }[] }

export interface Issue {
  id: string;
  title: string;
  description?: string;
  status: Status;
  priority: number;
  issue_type: string;
  assignee?: string;
  owner?: string;
  created_at: string;
  created_by?: string;
  updated_at: string;
  started_at?: string;
  closed_at?: string;
  close_reason?: string;
  labels?: string[];
  acceptance_criteria?: string;
  notes?: string;
  dependency_count?: number;
  dependent_count?: number;
  comment_count?: number;
  dependencies?: (Issue & { dependency_type?: string })[];
  dependents?: (Issue & { dependency_type?: string })[];
}

export interface Comment {
  id: string;
  issue_id: string;
  author: string;
  text: string;
  created_at: string;
}

export interface HistoryEntry {
  CommitHash: string;
  Committer: string;
  CommitDate: string;
  Issue: Issue;
}

export interface Info {
  bd_bin: string;
  beads_dir: string;
  actor: string;
  version: string;
  initial_view?: string | null;
  initial_task?: string | null;
}

export type SourceKind = "terminal" | "desktop" | "editor" | "unknown";
export interface Session {
  agent: string;
  session_id: string;
  cwd: string;
  project: string;
  agent_pid: number | null;
  source_kind: SourceKind;
  source_app: string;
  entrypoint: string;
  started_at: number;
  last_at: number;
  state: "working" | "idle" | "unknown";
  prompts: number;
  alive: boolean;
  registered: boolean;
  herdr?: { pane_id: string; tab_id: string; title: string; status: string; focused: boolean };
  title?: string;
}
export interface Presence { sessions: Session[]; apps: string[] }

export interface NewIssue {
  title: string;
  description?: string;
  issue_type?: string;
  priority?: number;
  labels?: string[];
  acceptance?: string;
  deps?: string[];
}

export interface UpdateFields {
  title?: string;
  description?: string;
  priority?: number;
  assignee?: string;
  acceptance?: string;
  notes?: string;
}
