// History › Continue for an OpenCode conversation: the same walk as history-continue-chat.mjs with OpenCode
// (a free OpenCode Zen model). The build service passes no environment, so this file sets it.
process.env.HISTORY_CHAT_AGENTS ||= "opencode";
const walk = await import("./history-continue-chat.mjs");

export const meta = { ...walk.meta, needs: ['opencode'], title: `${walk.meta.title}（OpenCode）` };
export default walk.default;
