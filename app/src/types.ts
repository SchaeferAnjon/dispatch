export type Status = "open" | "in_progress" | "blocked" | "closed" | "deferred";
export type Column = "todo" | "prog" | "done" | "reviewed";
export type View = "board" | "table" | "agents" | "pitfalls";

export interface SessionRef {
  agent: string;
  session_id: string;
  cwd: string;
  project: string;
  last_at: number;
  mentions: number;
  resume_cmd: string;
}
export interface Memory { key: string; value: string }

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
