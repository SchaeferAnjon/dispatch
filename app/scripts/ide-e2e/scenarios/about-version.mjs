// Help › About (kanban task-mpidn): the first line is Dispatch's version (app/cli/VERSION), VS Code's under it as
// "VS Code: …". The native macOS box cannot be read over CDP, so the window draws its own (window.dialogStyle custom,
// set in the instance's settings); both are made from the same lines (dialog.ts).
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const meta = { title: 'About shows Dispatch\'s version', description: 'Help › About: "Dispatch 0.9.5" first, then "VS Code: 1.139.1…".' };

export default async function (ui) {
  const settings = join(ui.rec.user_data_dir, 'User', 'settings.json');
  const s = JSON.parse(readFileSync(settings, 'utf8'));
  writeFileSync(settings, JSON.stringify({ ...s, 'window.dialogStyle': 'custom' }, null, 2));
  await ui.openEditor();
  await ui.sleep(2000);
  await ui.press('F1');
  await ui.type('About', { into: { css: '.quick-input-box input' } });
  await ui.waitFor({ text: 'Help: About' }, { timeoutMs: 15000 });
  await ui.press('Enter');
  await ui.waitFor({ css: '.monaco-dialog-box' }, { timeoutMs: 15000 });
  const text = await ui.eval(`document.querySelector('.monaco-dialog-box').innerText`);
  writeFileSync(join(ui.out, 'about.txt'), text);
  await ui.screenshot('about');
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
  const first = lines.findIndex(l => /^Dispatch \d+\.\d+\.\d+$/.test(l));
  const vscode = lines.findIndex(l => /^VS Code: /.test(l));
  if (first < 0 || vscode < 0 || vscode < first) {
    throw new Error(`About does not put Dispatch's version first: ${JSON.stringify(lines.slice(0, 6))}`);
  }
  await ui.mark({ css: '.monaco-dialog-box' }, { what: 'Dispatch 的版本在第一行', where: '关于对话框', how: 'Help › About' });
  await ui.press('Escape');
}
