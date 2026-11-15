// preferences-batch.mjs on OpenCode with the cheap test model: three preferences in one message, without the Claude
// allowance (the Claude Code run is preferences-batch.mjs, skipped unless DISPATCH_E2E_CLAUDE=1).
import run, { meta as base } from './preferences-batch.mjs';

export const meta = { ...base, needs: ['opencode'], env: { ENGINE: 'OpenCode', MODEL: '' }, timeout: 900, title: `${base.title}（OpenCode）` };

export default run;
