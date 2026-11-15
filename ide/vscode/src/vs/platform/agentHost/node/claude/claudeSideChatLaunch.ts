/*---------------------------------------------------------------------------------------------
 *  Dispatch IDE: how a side chat's Claude Code starts. Every chat is a Claude Code process of its own, and before
 *  it reads the first message it starts every MCP server the person has (playwright through npx, user settings,
 *  plugins: the CLI waits for them, up to MCP_TIMEOUT) and runs the SessionStart hooks (Dispatch's session brief
 *  reads the task board, 20 to 40 s while the board is slow). A side chat asks one question about the conversation
 *  it came from: it starts with only Dispatch's own tools (the built-in browser's among them) and without the
 *  brief, which the forked conversation already has (kanban, 2026-10-10).
 *--------------------------------------------------------------------------------------------*/

/** Set in a side chat's Claude Code environment; Dispatch's hook (app/cli/hook.py) skips the session brief then. */
export const DISPATCH_SIDE_CHAT_ENV = 'DISPATCH_SIDE_CHAT';

/** What a side chat changes in the SDK options: only the MCP servers passed in, and the marker for the hooks. */
export function sideChatLaunch(sideChat: boolean | undefined): { readonly strictMcpConfig?: true; readonly env: Readonly<Record<string, string>> } {
	return sideChat ? { strictMcpConfig: true, env: { [DISPATCH_SIDE_CHAT_ENV]: '1' } } : { env: {} };
}
