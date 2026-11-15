/*---------------------------------------------------------------------------------------------
 *  Dispatch IDE (plain-words): a separate copy shows under its project's name (kanban task-lj06.28).
 *
 *  A session that works on a separate copy runs in `<parent>/<project>.worktrees/<copy>` (VS Code's agent host makes
 *  it there, `getWorktreesRoot`). The agent host tells the window the project for the sessions it made the copy for;
 *  a session that only works in the copy (one handed to another agent, a terminal opened in it) had the copy's folder
 *  name as its title, "create-a-simple-to-do-list-page-in" instead of "todo-web". No imports: tests run it alone.
 *--------------------------------------------------------------------------------------------*/

const COPIES = '.worktrees';

/** `/Users/me/Projects/todo-web.worktrees/fix-x` → `{ path: '/Users/me/Projects/todo-web', name: 'todo-web' }`; undefined for any other folder. */
export function separateCopyOf(path: string): { readonly path: string; readonly name: string } | undefined {
	const parts = path.replace(/\/+$/, '').split('/');
	const copy = parts.pop();
	const container = parts.pop();
	if (!copy || !container || !container.endsWith(COPIES) || container.length === COPIES.length) {
		return undefined;
	}
	const name = container.slice(0, -COPIES.length);
	return { path: [...parts, name].join('/') || '/', name };
}

/** The name a folder goes by: its project's for a separate copy, else its own. */
export function folderDisplayName(path: string): string {
	return separateCopyOf(path)?.name ?? (path.replace(/\/+$/, '').split('/').pop() || path);
}
