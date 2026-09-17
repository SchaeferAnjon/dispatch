import type { Dict } from "../../i18n";
// Strings shared across views: buttons, statuses, columns, sources, relative time. Keys are the
// Chinese source text. Add a string here when more than one group needs it.
const common: Dict = {
  "Dispatch 调度台": "Dispatch",
  // Buttons and verbs
  "保存": "Save", "取消": "Cancel", "删除": "Delete", "确认": "Confirm", "确定": "OK", "关闭": "Close", "复制": "Copy", "已复制": "Copied",
  "刷新": "Refresh", "重试": "Retry", "编辑": "Edit", "新建": "New", "打开": "Open", "返回": "Back", "完成": "Done", "搜索": "Search",
  "更多": "More", "展开": "Expand", "收起": "Collapse", "全部": "All", "无": "None", "是": "Yes", "否": "No", "发送": "Send", "停止": "Stop",
  "加载中…": "Loading…", "保存中…": "Saving…", "处理中…": "Working…", "正在加载…": "Loading…", "保存失败": "Save failed", "加载失败": "Load failed",
  "复制失败": "Copy failed", "已保存": "Saved", "未知": "Unknown", "本机": "this Mac", "你": "You",
  // Views (App VIEW_LABEL)
  "工作台": "Workbench", "等我": "Needs me", "全部任务": "All tasks", "脉络": "Threads", "项目": "Projects", "Agent 状态": "Agent status",
  "设置": "Settings", "会话": "Sessions", "讨论": "Discussions", "统计与额度": "Stats & quota", "技能": "Skills", "规则与资料": "Rules & docs",
  "知识库": "Knowledge base", "环境": "Environment", "回收站": "Trash", "已归档任务": "Archived tasks", "首次设置": "First-run setup", "总览": "Overview",
  "看板": "Board", "表格": "Table",
  // Task status / columns (derive.ts)
  "待办": "To do", "进行中": "In progress", "已完成": "Done", "已复核": "Reviewed", "待 Agent 复核": "Awaiting agent review", "阻塞": "Blocked", "搁置": "Deferred",
  "创建": "Created", "认领": "Claimed", "改派给 {who}": "Reassigned to {who}", "状态 → {status}": "Status → {status}", "审核通过": "Approved",
  "只能你做": "Only you can",
  // Task types and priority (ui.tsx)
  "任务": "Task", "缺陷": "Bug", "功能": "Feature", "史诗": "Epic", "杂务": "Chore", "决策": "Decision", "未分项目": "No project",
  "P0 最高：马上做，阻塞别人": "P0 Highest: do it now, blocks others", "P1 高：本周内": "P1 High: this week", "P2 普通（默认）": "P2 Normal (default)",
  "P3 低：有空再做": "P3 Low: when there is time", "P4 想法：先记着": "P4 Idea: just noted",
  "优先级 {text}；bd update <id> -p 0–4 可改": "Priority {text}; change with bd update <id> -p 0–4",
  // Session sources and states (derive.ts / activity.ts)
  "终端": "Terminal", "桌面端": "Desktop", "编辑器": "Editor", "聊天": "Chat", "定时任务": "Scheduled", "来源未知": "Unknown source", "常驻": "Resident",
  "{app} · 常驻": "{app} · resident", "会话记录": "Session log", "零散会话": "Loose sessions",
  "已结束": "Ended", "等待确认": "Needs confirmation", "状态未知": "Unknown state", "在跑": "Running", "空闲": "Idle",
  "活动已暂停更新": "Updates paused", "未读回复": "Unread reply", "本轮结束": "Turn finished", "进行中 · {activity}": "In progress · {activity}",
  "记录已停止更新（最后在处理时中断）": "Log stopped updating (interrupted while working)",
  "已收到结构化结果，打开会话查看详情。": "Structured result received; open the session for details.",
  "暂时没有可用摘要，打开会话查看记录。": "No summary yet; open the session to read the log.",
  "历史会话，打开查看完整记录": "Past session; open to read the full log",
  // Knowledge entries (derive.ts)
  "坑": "Pitfall", "做对": "Win", "复盘": "Retro", "方法": "How-to",
  // Time (derive.ts: durSince / ago)
  "刚刚": "just now", "{m} 分钟": "{m} min", "{h} 小时 {m} 分": "{h} h {m} min", "{d} 天": (p) => `${p.d} ${Number(p.d) === 1 ? "day" : "days"}`,
  "{d}前": "{d} ago", "{m} 分钟前": "{m} min ago", "{h} 小时前": "{h} h ago", "{d} 天前": (p) => `${p.d} ${Number(p.d) === 1 ? "day" : "days"} ago`,
  "最后活动 {ago}": "last active {ago}", "无活动时间": "no activity time",
  // Tool-call summaries (timeline.ts) — "%d" is filled by the caller
  "跑了 %d 条命令": "ran %d commands", "读了 %d 个文件": "read %d files", "搜了 %d 次": "searched %d times", "改了 %d 处": "made %d edits",
  "查了 %d 个网页": "fetched %d pages", "派了 %d 个子 Agent": "spawned %d subagents", "{n} 个出错": "{n} failed", "、": ", ",
  // Errors surfaced from api.ts / main.tsx
  "浏览器未允许复制，请显示内容后长按复制": "The browser blocked copying; show the text and long-press to copy",
  "活动更新不可用": "Activity updates unavailable", "读不到这个会话": "Cannot read this session",
  "与电脑的连接暂时中断，请检查网络或电脑是否在线。": "Connection to the Mac was lost; check the network or whether the Mac is online.",
  "点击复制": "Click to copy",
  "界面出错了（{kind}），刷新可恢复；请把这段发给开发者：": "The interface hit an error ({kind}); reload to recover. Please send this to the developer:",
  "打开这条任务": "Open this task", "图片": "Image", "图片不可用，点击查看原因": "Image unavailable; click to see why", "第 {n} 处": "Edit {n}",
};
export default common;
