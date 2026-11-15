// session-liveness.mjs with OpenCode on the cheap test model (its question tool): the same walk without spending the
// Claude allowance; the permission card step stays with the Claude Code run.
import run, { meta as base } from './session-liveness.mjs';

export const meta = { ...base, needs: ['opencode'], env: { LIVENESS_ENGINE: 'opencode' }, timeout: 1200, title: `${base.title}（OpenCode）` };

export default run;
