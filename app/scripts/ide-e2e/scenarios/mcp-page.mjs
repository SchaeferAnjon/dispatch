// Settings › MCP servers (the MCP servers of every engine, kanban app/cli/mcp_config.py): after `dispatch mcp register`
// it lists Dispatch's own server for Claude Code, Codex and OpenCode next to the others. In a test instance the CLI
// writes the instance's scratch HOME (mcp_config.instance_home), never the person's files; this scenario checks that too.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFile } from 'node:fs/promises';
const exec = promisify(execFile);

export const meta = { title: 'MCP servers page lists Dispatch\'s MCP server', description: 'dispatch mcp register, then Settings › MCP servers shows the dispatch server for the three engines.' };

export default async function (ui) {
  if (!ui.rec.root.startsWith('/tmp/dide-e2e/') && !ui.rec.root.startsWith('/private/tmp/dide-e2e/')) throw new Error('Disposable instance required');
  const env = { ...process.env, BEADS_DIR: ui.rec.beads_dir, DISPATCH_DIR: ui.rec.dispatch_dir, DISPATCH_HOME: ui.rec.dispatch_home,
    DISPATCH_SESSION_ROOT: ui.rec.root, DISPATCH_IDE_USER_DATA_DIRS: `${ui.rec.user_data_dir}:${ui.rec.agents_user_data_dir}` };
  const run = async args => JSON.parse((await exec(ui.rec.cli, args, { env, timeout: 120000, maxBuffer: 8e6 })).stdout);
  const registered = await run(['mcp', 'register', '--engine', 'claude-code,codex,opencode', '--json']);
  const listed = await run(['mcp', 'list', '--json']);
  const ours = listed.servers.filter(s => s.name === 'dispatch');
  const home = process.env.HOME || '';
  const evidence = { registered, ours: ours.map(s => ({ engine: s.engine, path: s.path, builtin: s.builtin, args: s.args })) };
  await writeFile(`${ui.out}/mcp-page-evidence.json`, JSON.stringify(evidence, null, 2));
  if (ours.length !== 3 || !ours.every(s => s.builtin)) throw new Error(`dispatch server not in all three engines: ${JSON.stringify(evidence.ours)}`);
  if (ours.some(s => home && s.path.startsWith(home + '/') && !s.path.startsWith(ui.rec.root))) throw new Error(`the instance wrote a real config: ${ours.map(s => s.path).join(', ')}`);

  await ui.openAgents(ui.demoFolder);
  await ui.openCustomizations('MCP Servers');
  // Dispatch's own server is the Built-in row named Dispatch (task-lj06.23; it was the config name "dispatch")
  const row = { text: 'Dispatch', exact: true, within: '.dispatch-settings-page', webview: false };
  await ui.waitFor(row, { timeoutMs: 30000 });
  await ui.sleep(800);
  await ui.screenshot('01-mcp-servers');
  await ui.mark(row, { what: 'Dispatch 自己的 MCP 服务', where: 'MCP servers 列表里', how: '设置（⌘,）› MCP servers' });
  await ui.click(row);
  await ui.sleep(1200);
  await ui.screenshot('02-dispatch-row');
}
