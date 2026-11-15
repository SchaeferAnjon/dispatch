// The title a commit is shown under in the Agents window (Dispatch IDE patches/430-tasks.patch):
// the short hash and the subject, without the task id the subject ends with (`… (task-abc)`): the
// person never reads task ids (design/task-model/DECISIONS.md).

export function withoutTaskId(text: string): string {
  return text.replace(/\s*[（(]\s*task-[a-z0-9]{2,8}\s*[）)]/g, "").trim();
}

export function commitTitle(short: string, subject: string): string {
  const s = withoutTaskId(subject.split("\n")[0] ?? "");
  return s ? `${short} ${s}` : short;
}
