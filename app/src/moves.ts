// After a hand-over (`dispatch move`) the same conversation id exists on two Macs: the original is
// marked moved_to, the copy that took over is not. Once both are in a list, keep only the one that
// lives on — every list then shows the conversation where it is now. A lone original stays (the other
// Mac is offline), still tagged 已迁往.
export function dropMovedOriginals<T extends { session_id: string; moved_to?: string }>(rows: T[]): T[] {
  const current = new Set(rows.filter((r) => !r.moved_to).map((r) => r.session_id));
  return rows.filter((r) => !r.moved_to || !current.has(r.session_id));
}

export type MigrationCheck = { project: string; host: string; cwd: string; target: string; remoteCwd: string; conflicts: string[] };

export function migrationCheckPrompt(check: MigrationCheck): string {
  return [
    `检查项目 ${check.project} 迁移到 ${check.target} 被拦截的原因。`,
    `来源机器：${check.host}；来源目录：${check.cwd}`,
    `目标机器：${check.target}；目标目录：${check.remoteCwd}`,
    '预检发现：', ...check.conflicts.map(c => `- ${c}`),
    '先只读检查两台机器的 Git 状态、独有提交、未提交及未跟踪文件，列出迁移会覆盖的具体内容，并给出保留两边工作的处理方案。',
    '不要执行迁移、--force、reset、clean、删除或覆盖文件，也不要关闭现有会话。检查结果直接回复，等用户决定如何处理。',
  ].join('\n');
}
