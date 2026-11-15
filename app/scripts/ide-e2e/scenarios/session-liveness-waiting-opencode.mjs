// session-liveness-waiting.mjs with OpenCode on the cheap test model: its question answered from Waiting for you.
import run, { meta as base } from './session-liveness-waiting.mjs';

export const meta = { ...base, needs: ['opencode'], env: { LIVENESS_ENGINE: 'opencode' }, timeout: 900, title: `${base.title}（OpenCode）` };

export default run;
