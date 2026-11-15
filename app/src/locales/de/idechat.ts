import type { Dict } from "../../i18n";
// Dispatch IDE's chat column (idechat/*) and the Codex permission levels (ChatComposer CODEX_MODES). Keys are the Chinese source text.
const idechat: Dict = {
  "没发出去：{error}": "Nicht gesendet: {error}",
  "重发": "Erneut senden",
  "正在启动 Agent": "Agent wird gestartet",
  "这个文件夹还没有对话，第一句话发出去才启动 Agent。": "Für diesen Ordner gibt es noch keine Unterhaltung. Der Agent startet mit Ihrer ersten Nachricht.",
  "还没开始": "Nicht gestartet",
  "只读": "Nur lesen",
  "完全访问": "Vollzugriff",
};
export default idechat;
