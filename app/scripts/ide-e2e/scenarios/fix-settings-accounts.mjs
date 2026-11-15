// The second half of fix-settings.mjs: this Mac's accounts on the seeded instance (the demo project), Waiting for you
// with one item, the allowance words, and an OpenCode session on the cheap test model in Full auto.
import run, { meta as base } from './fix-settings.mjs';

export const meta = { ...base, instance: {}, needs: ['opencode'], timeout: 900, title: '设置一带的 bug：本机账号', description: 'Waiting 去重、额度说法、OpenCode 的 Full auto 和模型芯片（便宜模型发一句）。' };

export default run;
