/*---------------------------------------------------------------------------------------------
 *  Dispatch IDE: who writes a session's commit message (kanban task-dekzn). The Commit button's message came from
 *  the default agent whatever the session ran on; now the session's own agent writes it, with the session's model
 *  (`dispatch write commit-message --agent --model`, kanban app/cli/fixit.py). No imports: tests/fixit-writer.test.mjs.
 *--------------------------------------------------------------------------------------------*/

/**
 * The agent and model a session runs on, as `dispatch write --agent --model` takes them: the agent from the session's
 * type (agent-host-opencode → opencode), the model without the provider's own prefix (`<scheme>:provider/model`).
 */
export function writerOf(session: { readonly sessionType: string; readonly resource: { readonly scheme: string }; readonly modelId: { get(): string | undefined } }): { engine: string; model: string } {
	const engine = /(?:^|[-:])(claude|codex|opencode)$/.exec(session.sessionType)?.[1] ?? '';
	const raw = engine ? session.modelId.get() ?? '' : '';
	const prefix = `${session.resource.scheme}:`;
	return { engine, model: raw.startsWith(prefix) ? raw.slice(prefix.length) : raw };
}
