import { useState } from "react";
import type { NewIssue } from "../types";
import { PROJECT_PREFIX } from "../derive";
import { TYPE_LABEL } from "./ui";

interface Props { projects: string[]; otherProjects?: string[]; defaultProject: string | null; onCancel: () => void; onCreate: (input: NewIssue) => Promise<void> }

export function NewTask({ projects, otherProjects = [], defaultProject, onCancel, onCreate }: Props) {
  const [title, setTitle] = useState("");
  const [desc, setDesc] = useState("");
  const [type, setType] = useState("task");
  const [priority, setPriority] = useState(2);
  const [project, setProject] = useState(defaultProject ?? "");
  const [newProject, setNewProject] = useState("");
  const [ac, setAc] = useState("");
  const [busy, setBusy] = useState(false);
  const proj = project === "__new" ? newProject.trim() : project;
  const submit = async () => {
    if (!title.trim() || busy) return;
    setBusy(true);
    try {
      await onCreate({ title: title.trim(), description: desc.trim() || undefined, issue_type: type, priority, labels: proj ? [PROJECT_PREFIX + proj] : [], acceptance: ac.trim() || undefined });
    } finally { setBusy(false); }
  };
  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onCancel()}>
      <div className="dialog" role="dialog" aria-label="新任务" onKeyDown={(e) => { if (e.key === "Escape") onCancel(); if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) submit(); }}>
        <h3>新任务</h3>
        <label>标题<input autoFocus value={title} onChange={(e) => setTitle(e.target.value)} placeholder="一句话说清要做什么" /></label>
        <label>描述<textarea value={desc} onChange={(e) => setDesc(e.target.value)} placeholder="背景 + 要做什么 + 怎么算做完。写给下一个接手的 Agent 看。" /></label>
        <div className="row">
          <label>类型<select value={type} onChange={(e) => setType(e.target.value)}>{Object.entries(TYPE_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
          <label>优先级<select value={priority} onChange={(e) => setPriority(Number(e.target.value))}>{[0, 1, 2, 3, 4].map((p) => <option key={p} value={p}>P{p}{p === 0 ? " 最急" : p === 4 ? " 最低" : ""}</option>)}</select></label>
          <label>项目<select value={project} onChange={(e) => setProject(e.target.value)}><option value="">（不分 · 会进「未归类」）</option><optgroup label="项目">{projects.map((p) => <option key={p} value={p}>{p}</option>)}</optgroup>{otherProjects.length > 0 && <optgroup label="只是有过会话的目录">{otherProjects.map((p) => <option key={p} value={p}>{p}</option>)}</optgroup>}<option value="__new">＋ 新项目…</option></select></label>
        </div>
        {project === "__new" && <label>新项目名<input value={newProject} onChange={(e) => setNewProject(e.target.value)} placeholder="例如 poker-trainer" /></label>}
        <label>验收标准（每行一条，可选）<textarea value={ac} onChange={(e) => setAc(e.target.value)} placeholder={"- 测试通过\n- 截图确认"} /></label>
        <div className="foot">
          <button className="btn ghost" onClick={onCancel}>取消</button>
          <button className="btn primary" disabled={!title.trim() || busy} onClick={submit}>创建 ⌘⏎</button>
        </div>
      </div>
    </div>
  );
}
