import type { Dict } from "../../i18n";
// The Raycast-style task Detail (Detail.tsx) and the sessions page (Sessions.tsx, SessionReply.tsx).
// Keys are the Chinese source text.
const detailSessions: Dict = {
  // ---- Task Detail ----
  "占满宽度": "Full width",
  "占满宽度：看文件改动和产物": "Full width: room for file changes and outputs",
  "收回右栏": "Back to side panel",
  "关闭 esc": "Close (esc)",
  // ---- Sessions list ----
  "未读": "Unread", "定时": "Scheduled", "回复": "Reply",
  "今天": "Today", "昨天": "Yesterday", "7 天内": "Last 7 days", "更早": "Earlier",
  "筛选": "Filter", "所有 Agent": "All agents", "所有项目": "All projects", "按项目筛选": "Filter by project",
  "索引中…": "Indexing…", "首次要读完全部历史": "The first run reads the whole history",
  "没有归档的会话": "No archived sessions",
  "{days} 天没有活动的会话会自动归到这里": "Sessions idle for {days} days move here on their own",
  "还没有收藏的会话": "No starred sessions yet",
  "右键一条会话，选「收藏：长期追踪」。": "Right-click a session and choose “Star: track long-term”.",
  "没有匹配的会话": "No matching sessions",
  "换个筛选条件，或清空搜索。": "Try another filter, or clear the search.",
  "没有在跑的会话": "No running sessions",
  "没有定时或脚本会话": "No scheduled or scripted sessions",
  "还没有会话": "No sessions yet",
  "在终端里开一个 Agent，或点「＋ 会话」。": "Start an agent in a terminal, or click “+ Session”.",
  "暂时读不到这段会话": "Can't read this session right now",
  // ---- Session Detail ----
  "主机": "Host", "改动": "Changes", "正在改": "Editing", "改过的文件": "Files changed",
  "还有 {n} 个": "{n} more",
  "{n} 个，{m} 个在跑": "{n}, {m} running",
  "{n} 个，都已完成": (p) => (Number(p.n) === 1 ? "1, finished" : `${p.n}, all finished`),
  "还没有摘要。打开会话看完整记录。": "No summary yet. Open the session for the full log.",
  "分屏": "Split view",
};
export default detailSessions;
