// History › Continue for a Claude Code conversation: the same walk as history-continue-chat.mjs with Claude Code
// (needs a logged-in claude on the Mac the run is on). The build service passes no environment, so this file sets it.
process.env.HISTORY_CHAT_AGENTS ||= "claude";
const walk = await import("./history-continue-chat.mjs");

export const meta = { ...walk.meta, needs: ['claude'], title: `${walk.meta.title}（Claude Code）` };
export default walk.default;
