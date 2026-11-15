import type { Dict } from "../../i18n";
// Dispatch IDE's chat column (idechat/*) and the Codex permission levels (ChatComposer CODEX_MODES). Keys are the Chinese source text.
const idechat: Dict = {
  "没发出去：{error}": "Not sent: {error}",
  "重发": "Send again",
  "正在启动 Agent": "Starting the agent",
  "这个文件夹还没有对话，第一句话发出去才启动 Agent。": "No conversation for this folder yet. The agent starts with your first message.",
  "还没开始": "Not started",
  "只读": "Read-only",
  "完全访问": "Full access",
};
export default idechat;
