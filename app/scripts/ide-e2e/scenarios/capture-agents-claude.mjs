// capture-agents.mjs's Claude Code part: what you type to Claude Code (Haiku) in Dispatch's terminal goes on the board
// by itself. It spends the Claude allowance, which the person keeps for their dispatcher: it runs only where
// DISPATCH_E2E_CLAUDE=1 says so (meta.needs), and is skipped with that reason otherwise.
import run, { meta as base } from './capture-agents.mjs';

export const meta = { ...base, needs: ['claude'], env: { CAPTURE_STAGES: 'claude' }, title: 'Claude Code in the terminal notes what you say' };

export default run;
