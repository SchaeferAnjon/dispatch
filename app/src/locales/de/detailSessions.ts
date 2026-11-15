import type { Dict } from "../../i18n";
// Das Task-Detail im Raycast-Stil (Detail.tsx) und die Sitzungsseite (Sessions.tsx, SessionReply.tsx).
// Schlüssel sind der chinesische Quelltext.
const detailSessions: Dict = {
  // ---- Task-Detail ----
  "占满宽度": "Volle Breite",
  "占满宽度：看文件改动和产物": "Volle Breite: Platz für Dateiänderungen und Ergebnisse",
  "收回右栏": "Zurück in die Seitenleiste",
  "关闭 esc": "Schließen (esc)",
  // ---- Sitzungsliste ----
  "未读": "Ungelesen", "定时": "Geplant", "回复": "Antworten",
  "今天": "Heute", "昨天": "Gestern", "7 天内": "Letzte 7 Tage", "更早": "Früher",
  "筛选": "Filtern", "所有 Agent": "Alle Agents", "所有项目": "Alle Projekte", "按项目筛选": "Nach Projekt filtern",
  "索引中…": "Indexiere…", "首次要读完全部历史": "Beim ersten Mal wird der ganze Verlauf gelesen",
  "没有归档的会话": "Keine archivierten Sitzungen",
  "{days} 天没有活动的会话会自动归到这里": "Sitzungen ohne Aktivität seit {days} Tagen landen automatisch hier",
  "还没有收藏的会话": "Noch keine markierten Sitzungen",
  "右键一条会话，选「收藏：长期追踪」。": "Rechtsklick auf eine Sitzung und „Markieren: dauerhaft verfolgen“ wählen.",
  "没有匹配的会话": "Keine passenden Sitzungen",
  "换个筛选条件，或清空搜索。": "Anderen Filter wählen oder die Suche leeren.",
  "没有在跑的会话": "Keine laufenden Sitzungen",
  "没有定时或脚本会话": "Keine geplanten oder per Skript gestarteten Sitzungen",
  "还没有会话": "Noch keine Sitzungen",
  "在终端里开一个 Agent，或点「＋ 会话」。": "Einen Agent im Terminal starten oder auf „+ Sitzung“ klicken.",
  "暂时读不到这段会话": "Diese Sitzung ist gerade nicht lesbar",
  // ---- Sitzungsdetail ----
  "主机": "Rechner", "改动": "Änderungen", "正在改": "Bearbeitet gerade", "改过的文件": "Geänderte Dateien",
  "还有 {n} 个": "{n} weitere",
  "{n} 个，{m} 个在跑": "{n}, davon {m} laufend",
  "{n} 个，都已完成": (p) => (Number(p.n) === 1 ? "1, fertig" : `${p.n}, alle fertig`),
  "还没有摘要。打开会话看完整记录。": "Noch keine Zusammenfassung. Sitzung öffnen für das ganze Protokoll.",
  "分屏": "Geteilte Ansicht",
};
export default detailSessions;
