import type { Dict } from "../../i18n";
// Strings shared across views: buttons, statuses, columns, sources, relative time. Keys are the
// Chinese source text. Add a string here when more than one group needs it.
const common: Dict = {
  "Dispatch 调度台": "Dispatch",
  // Buttons and verbs
  "保存": "Sichern", "取消": "Abbrechen", "删除": "Löschen", "确认": "Bestätigen", "确定": "OK", "关闭": "Schließen", "复制": "Kopieren", "已复制": "Kopiert",
  "刷新": "Aktualisieren", "重试": "Erneut versuchen", "编辑": "Bearbeiten", "新建": "Neu", "打开": "Öffnen", "返回": "Zurück", "完成": "Fertig", "搜索": "Suchen",
  "更多": "Mehr", "展开": "Ausklappen", "收起": "Einklappen", "全部": "Alle", "无": "Keine", "是": "Ja", "否": "Nein", "发送": "Senden", "停止": "Stopp",
  "加载中…": "Wird geladen …", "保存中…": "Wird gesichert …", "处理中…": "In Arbeit …", "正在加载…": "Wird geladen …", "保存失败": "Sichern fehlgeschlagen", "加载失败": "Laden fehlgeschlagen",
  "复制失败": "Kopieren fehlgeschlagen", "已保存": "Gesichert", "未知": "Unbekannt", "本机": "dieser Mac", "你": "Sie",
  // Views (App VIEW_LABEL)
  "工作台": "Arbeitsplatz", "等我": "Wartet auf mich", "全部任务": "Alle Aufgaben", "脉络": "Verlauf", "项目": "Projekte", "Agent 状态": "Agent-Status",
  "设置": "Einstellungen", "会话": "Sitzungen", "讨论": "Diskussionen", "统计与额度": "Statistik & Kontingent", "技能": "Skills", "规则与资料": "Regeln & Unterlagen",
  "知识库": "Wissensbasis", "环境": "Umgebung", "回收站": "Papierkorb", "已归档任务": "Archivierte Aufgaben", "首次设置": "Ersteinrichtung", "总览": "Übersicht",
  "看板": "Board", "表格": "Tabelle",
  // Task status / columns (derive.ts)
  "待办": "Offen", "进行中": "In Arbeit", "已完成": "Erledigt", "已复核": "Geprüft", "待 Agent 复核": "Wartet auf Agent-Prüfung", "阻塞": "Blockiert", "搁置": "Zurückgestellt",
  "创建": "Erstellt", "认领": "Übernommen", "改派给 {who}": "Übergeben an {who}", "状态 → {status}": "Status → {status}", "审核通过": "Freigegeben",
  "只能你做": "Nur Sie können",
  // Task types and priority (ui.tsx)
  "任务": "Aufgabe", "缺陷": "Fehler", "功能": "Funktion", "史诗": "Epic", "杂务": "Routine", "决策": "Entscheidung", "未分项目": "Kein Projekt",
  "P0 最高：马上做，阻塞别人": "P0 Höchste: sofort erledigen, blockiert andere", "P1 高：本周内": "P1 Hoch: diese Woche", "P2 普通（默认）": "P2 Normal (Standard)",
  "P3 低：有空再做": "P3 Niedrig: bei Gelegenheit", "P4 想法：先记着": "P4 Idee: nur notiert",
  "优先级 {text}；bd update <id> -p 0–4 可改": "Priorität {text}; ändern mit bd update <id> -p 0–4",
  // Session sources and states (derive.ts / activity.ts)
  "脚本运行": "Skriptlauf", "网关": "Gateway",
  "终端": "Terminal", "桌面端": "Desktop", "编辑器": "Editor", "聊天": "Chat", "定时任务": "Geplant", "来源未知": "Unbekannte Quelle", "常驻": "Dauerhaft",
  "{app} · 常驻": "{app} · dauerhaft", "会话记录": "Sitzungsprotokoll", "零散会话": "Lose Sitzungen",
  "已结束": "Beendet", "等待确认": "Wartet auf Bestätigung", "状态未知": "Status unbekannt", "在跑": "Läuft", "空闲": "Inaktiv",
  "活动已暂停更新": "Aktualisierung pausiert", "未读回复": "Ungelesene Antwort", "本轮结束": "Runde beendet", "进行中 · {activity}": "In Arbeit · {activity}",
  "记录已停止更新（最后在处理时中断）": "Protokoll wird nicht mehr aktualisiert (während der Arbeit unterbrochen)",
  "已收到结构化结果，打开会话查看详情。": "Strukturiertes Ergebnis erhalten; Details in der Sitzung.",
  "暂时没有可用摘要，打开会话查看记录。": "Noch keine Zusammenfassung; Protokoll in der Sitzung öffnen.",
  "历史会话，打开查看完整记录": "Frühere Sitzung; zum vollständigen Protokoll öffnen",
  // Knowledge entries (derive.ts)
  "坑": "Stolperfalle", "做对": "Bewährt", "复盘": "Rückblick", "方法": "Anleitung",
  // Time (derive.ts: durSince / ago)
  "刚刚": "gerade eben", "{m} 分钟": "{m} Min.", "{h} 小时 {m} 分": "{h} Std. {m} Min.", "{d} 天": (p) => `${p.d} ${Number(p.d) === 1 ? "Tag" : "Tage"}`,
  "{d}前": "vor {d}", "{m} 分钟前": "vor {m} Min.", "{h} 小时前": "vor {h} Std.", "{d} 天前": (p) => `vor ${p.d} ${Number(p.d) === 1 ? "Tag" : "Tagen"}`,
  "最后活动 {ago}": "zuletzt aktiv {ago}", "无活动时间": "keine Aktivitätszeit",
  // Tool-call summaries (timeline.ts) — "%d" is filled by the caller
  "跑了 %d 条命令": "%d Befehle ausgeführt", "读了 %d 个文件": "%d Dateien gelesen", "搜了 %d 次": "%d-mal gesucht", "改了 %d 处": "%d Änderungen",
  "查了 %d 个网页": "%d Webseiten abgerufen", "派了 %d 个子 Agent": "%d Subagenten gestartet", "{n} 个出错": "{n} fehlgeschlagen", "、": ", ",
  // Errors surfaced from api.ts / main.tsx
  "浏览器未允许复制，请显示内容后长按复制": "Der Browser hat das Kopieren blockiert; Text anzeigen und lange drücken, um zu kopieren",
  "活动更新不可用": "Aktivitätsaktualisierung nicht verfügbar", "读不到这个会话": "Diese Sitzung kann nicht gelesen werden",
  "与电脑的连接暂时中断，请检查网络或电脑是否在线。": "Die Verbindung zum Mac ist unterbrochen; Netzwerk prüfen oder ob der Mac online ist.",
  "点击复制": "Zum Kopieren klicken",
  "界面出错了（{kind}），刷新可恢复；请把这段发给开发者：": "Fehler in der Oberfläche ({kind}); neu laden hilft. Bitte diesen Text an den Entwickler senden:",
  "打开这条任务": "Diese Aufgabe öffnen", "图片": "Bild", "图片不可用，点击查看原因": "Bild nicht verfügbar; klicken für den Grund", "第 {n} 处": "Änderung {n}",
};
export default common;
