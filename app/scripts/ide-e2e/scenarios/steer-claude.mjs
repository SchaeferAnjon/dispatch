// A message sent while Claude Code works goes in between two tool calls and the work carries on (task-pd2i3): the
// second message is taken after the running command, the turn is not stopped, the answer under the second message
// does what it asked, and the session ends at rest. Claude Code runs on Haiku; it only runs with DISPATCH_E2E_CLAUDE=1.
import fs from 'node:fs';
import path from 'node:path';
import { until } from './msg-bubble.mjs';

export const meta = { needs: ['claude'], timeout: 900, title: 'A message while Claude Code works', description: 'A second message goes in between two tool calls; the running turn is not stopped; the answer does what it asked.' };

const VIEW = `(() => {
  const list = document.querySelector('.part.sessionspart .interactive-list');
  return {
    requests: [...(list?.querySelectorAll('.interactive-request') || [])].map(r => r.innerText.replace(/\\s+/g, ' ').trim().slice(0, 120)),
    responses: [...(list?.querySelectorAll('.interactive-response') || [])].map(r => ({ text: r.innerText.replace(/\\s+/g, ' ').trim().slice(-400), loading: r.classList.contains('chat-response-loading') })),
    pending: [...document.querySelectorAll('.chat-pending-message, .pending-message, [class*="pending-request"]')].filter(e => e.offsetParent).map(e => e.innerText.trim().slice(0, 80)),
    working: !!document.querySelector('.interactive-session .chat-input-toolbars .codicon-stop-circle, .chat-execute-toolbar .codicon-debug-stop'),
  };
})()`;

async function type(ui, text) {
  await ui.click({ css: '.part.sessionspart .interactive-input-part .monaco-editor, .sessions-chat-editor' });
  await ui.type(text);
  await ui.press('Enter', { send: true });
}

export default async function (ui) {
  const result = {};
  const note = (k, v) => { result[k] = v; fs.writeFileSync(path.join(ui.out, 'result.json'), JSON.stringify(result, null, 2)); };
  await ui.openAgents(ui.demoFolder);
  await ui.newSession();
  await ui.pickEngine('Claude Code', 180000);
  note('queueDefault', await ui.eval(`document.querySelector('.chat-queue-picker, [class*=queue-picker]')?.innerText || ''`));

  // 1. something that takes a while: a command of 15 s, then a second one
  await type(ui, 'Use your Bash tool to run `sleep 15; echo first-done`, then run `echo second-step`, then reply with exactly: TASK FINISHED');
  await until(ui, async () => (await ui.eval(VIEW)).working, 'Claude Code working', 120000);
  await ui.sleep(6000); // the sleep is running now

  // 2. a second message while it works: it goes in, the work goes on
  await type(ui, 'Also put the word BANANA in your reply.');
  await ui.sleep(1500);
  note('right_after_second', await ui.eval(VIEW));
  await ui.screenshot('01-second-message-while-working');
  await ui.mark({ css: '.part.sessionspart .interactive-input-part' }, { what: '干活时又发了一句：不打断，在下一次工具调用间隙送进去', where: '对话输入框', how: 'Agent 在跑时直接回车' });

  // 3. the turn ends by itself, nothing stopped, both commands ran, the answer has BANANA
  const end = await until(ui, async () => { const v = await ui.eval(VIEW); return !v.working && v.responses.length && !v.responses.at(-1).loading && /BANANA/.test(v.responses.map(r => r.text).join(' ')) ? v : null; }, 'the work ending with BANANA in the answer', 300000);
  note('end', end);
  await ui.sleep(3000);
  const settled = await ui.eval(VIEW);
  note('settled', settled);
  await ui.screenshot('02-answer-with-banana');
  const all = settled.responses.map(r => r.text).join(' ');
  if (/cancel|interrupted|stopped by/i.test(all)) throw new Error('the running turn was stopped: ' + all.slice(-300));
  if (!/second-step|TASK FINISHED/.test(all)) throw new Error('the work did not carry on to its second command: ' + all.slice(-300));
  if (settled.requests.length < 2 || !/BANANA/.test(settled.requests.join(' '))) throw new Error('the second message has no bubble of its own: ' + JSON.stringify(settled.requests));
  if (settled.pending.length) throw new Error('a message is still pending: ' + JSON.stringify(settled.pending));
  if (settled.working) throw new Error('the session is still working after the answer');
}
