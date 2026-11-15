# 设置

> 这一页解决什么：设置页每张卡片、每个开关的含义和默认值。大部分设置存在共享任务板上（两台 Mac 一致，命令行 `dispatch settings` 读写同一份）；标了「这台电脑」的只影响本机。

## 语言

**界面语言**：跟随系统、中文、English、Deutsch。跟随系统时按 macOS 或浏览器的语言自动选；选定后立即生效，手机网页版同样有效。

## 会话

- **普通会话多少天没有活动后自动归档**（默认 30，0 = 永不）：收藏（追踪中）的会话不受影响；归档的在会话页「已归档」和 ⌘K 里还能找到。
- **总结用的模型**：下拉列出可用模型，每项后面写「订阅」「已配 Key」或「缺 Key」。订阅模型（如 `claude:haiku`，走 Claude Code 订阅）不用 Key、计入用量；API Key 的模型（智谱、Kimi、MiniMax、OpenAI）用「环境」里的密钥。选了缺 Key 的模型会出现一个输入框，粘贴 Key 保存到本机 `dispatch env`。空着 = 自动选：环境变量 `SUMMARY_MODEL` → 第一个可用的。
- **用途表**：总结显示在哪些地方，每项一个开关，右边是最近一次的 token 数、时间和模型。用途有：会话总结、项目现状、dispatch here、讨论结论、洞察报告、记忆总结、设备盘点、语义搜索索引（只认 ZHIPU_API_KEY）。**默认全部开着**；不想让内容出机器就在这里关。命令行 `dispatch summarize uses` 看表，`dispatch settings summary_uses '{"session":0}'` 改。
- **脚本或其他 Agent 通过 SDK 启动的会话，自动当作定时会话**（默认开）：定时会话不进「等我」、不发通知、不出现在工作台；会话页「定时或脚本」里能看到。对单条会话手动标记过的，以手动为准。

## 手机通知

见 [手机 → 通知](20-phone.md#推送到手机的通知)。这张卡片里：Bark key、ntfy 主题地址（保存进 `dispatch env` 的 `BARK_KEY` / `NTFY_URL`，两个都配以 ntfy 为准）、四个事件开关（Agent 回复了、Agent 等你确认 / 提问、任务完成、只有你能做）、「发一条测试通知」。

## 项目

- **工作区根目录**（默认 `~/Projects`，一行一个）：这些文件夹的直接子文件夹各算一个项目。其它位置按 git 仓库根目录归项目，没有仓库就按所在文件夹。
- 有任务、有成果、或手动关联过的才算正式项目；其余只是「目录」。

## 讨论

「讨论一个念头」里每个成员的人设和群里的规矩，进它们的系统提示；每轮只再给新消息。空着用默认。

- **群里的规矩**：发言多长、什么时候闲聊、什么时候只回 SKIP（不显示）。
- **Claude / Codex / pi 的人设**：一句话，关注什么、怎么表达、习惯质疑什么。

## 工作台

- **已完成任务多少天后自动归档**（默认 0 = 不自动）：完成超过这些天的任务自动打归档标记，从已完成列和计数里移开；看板上仍有「归档 30 天前完成的」按钮。
- **默认展开前几个项目**（默认 2）：其余折叠成一行，有等你回复或等待确认的项目总是展开。

## 这台电脑

- **外观**：跟随系统、浅色、深色，只影响本机窗口。
- **手机访问**：内嵌二维码（链接里带登录令牌，扫一次就记住）和「复制链接」。有两台机器时可选「手机版跑在」哪台：选常驻的那台，这台带走了手机也能用；换了机器要在手机上重新打开一次链接。
- **屏幕访问**：「配置」自动装好 noVNC 与常驻服务、开通 Tailscale HTTPS（等价 `dispatch screen setup`），列出每一步结果；屏幕共享开关只能你自己在 系统设置 → 通用 → 共享 打开。配置好后显示链接和「复制屏幕链接」。
- **版本与更新**：「当前 vX，最新 vY」。「检查更新」查 GitHub Release；有新版时「更新到 vY」下载对应架构的 zip、替换 `/Applications/Dispatch.app`、清除隔离标记并自动重启，权限和登录状态保留。网页版只能查看版本。命令行 `dispatch update check|apply [--no-relaunch]`。
- **首次设置**：「打开首次设置」重新进入六步向导，每一步都能重跑。
- **机器**：`~/tasks/.dispatch/hosts.json` 里的每台 Mac：在线圆点、名字、「改名」（同步推给已知的机器）、「重新检测」（清掉缓存重新 ssh 探测）、「删除」（点两次；之后本机不再尝试连接它）。「接入另一台电脑…」打开首次设置。

## 底部

「保存」「还原」。存在共享任务板上，两台 Mac 一致。空白处右键有「检查更新」。

## 命令行对应

```sh
dispatch settings                      # 看全部
dispatch settings session_archive_days 60
dispatch settings summary_model claude:haiku
dispatch settings summary_uses '{"session": 0, "project": 0}'
dispatch summarize providers | uses | set-key zhipu
dispatch update check | apply
dispatch screen status | setup
dispatch serve url | qr | host <机器>
dispatch hosts [rename <id|local|名字> <新名字>]
dispatch init status | run <步骤>
```
