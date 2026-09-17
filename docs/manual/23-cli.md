# 命令行参考

> 这一页解决什么：`dispatch` 的子命令按用途分组，每条一句话、常用参数、一个例子。所有界面能看到的，`--json` 都能拿到；每条命令 `--help` 是最终依据。

在终端使用需先完成首次设置第 2 步（或手动链接 `~/.local/bin/dispatch`）。`dispatch --host <机器 id> <子命令>` 在另一台 Mac 上跑同一条命令（ssh，输入输出直通）。数据在 `~/tasks/.dispatch`（会话注册表、转录索引）和 `$BEADS_DIR`（默认 `~/tasks/.beads`）。

## 任务

| 命令 | 作用 | 常用参数 | 例子 |
|:--|:--|:--|:--|
| `begin <标题>` | 建任务并认领 | `-P 项目`、`-d 描述`、`-a "- [ ] 验收项"`、`-t 类型`、`-p 优先级`、`--deps`、`--session`、`--force` | `dispatch begin "登录页加验证码：被刷" -P web -d "…" -a "- [ ] 通过测试"` |
| `claim <id>` | 认领；别人在做会拒绝 | `--force` | `dispatch claim task-abc` |
| `log <id> [文本]` | 记进展 | `--tick 关键词…` 勾验收项 | `dispatch log task-abc "接口改完" --tick 测试` |
| `done <id>` | 关闭任务 | `--reason`（必填）、`--verified`、`--retro`、`--next 标题…`、`--review-by` | `dispatch done task-abc -r "已上线，跑过 e2e" --verified` |
| `review <id>` | 记录独立复核 | `--verdict pass\|changes`、`--reason` | `dispatch review task-abc --verdict pass --reason "复跑通过"` |
| `need-you <标题>` | 只有用户能做的事 | `-P`、`-d`、`--task`、`-p` | `dispatch need-you "给 Vercel 付款" -P web -d "账单到期"` |
| `task trash\|restore <id>` | 移到回收站 / 恢复 | `--json` | `dispatch task trash task-abc` |
| `task-archive` | 归档早于 N 天的已完成任务 | `--days` | `dispatch task-archive --days 30` |
| `commits <id>` | 任务对应的 git 提交 | | `dispatch commits task-abc` |
| `find <id>` | 转录里提到这个任务的会话及恢复命令 | | `dispatch find task-abc` |
| `graph` | 任务脉络的节点和边 | | `dispatch graph --json` |
| `review`、`discuss`、`split` 等 | 见下「多 Agent」 | | |

## 会话

| 命令 | 作用 | 常用参数 | 例子 |
|:--|:--|:--|:--|
| `sessions` | 正在跑的会话（谁在哪、忙还是等） | `--local` | `dispatch sessions` |
| `list` | 浏览全部会话 | `--agent`、`--project`、`--cwd`、`-q`、`--limit`、`--cached`、`--local` | `dispatch list --project web -q 登录` |
| `session <id\|task>` | 一段会话的时间线和文件改动 | `--since offset`（实时 tail） | `dispatch session 3fa2 --json` |
| `resume <id\|task>` | 打印恢复命令 | `--copy`、`--on 机器` | `dispatch resume 3fa2 --copy` |
| `focus <id\|task>` | 跳到 Herdr 里那个标签 | `--on` | `dispatch focus task-abc` |
| `adopt <id\|pid-N>` | 把别的终端里的会话接进 Herdr | `--keep`、`--force` | `dispatch adopt 3fa2` |
| `reply status\|send\|commands\|answer\|control\|revive <id>` | 回复原会话（界面用的接口） | `--agent`、`--mode queue\|interrupt`、`--image`、`--request` | `echo "继续" \| dispatch reply send 3fa2 --agent claude-code` |
| `seen <key> <reply\|unread>` | 标记已读 / 未读 | | `dispatch seen claude-code:3fa2 unread` |
| `session-preferences <key> <json>` | 收藏、归档、改名、关联项目、定时标记 | | `dispatch session-preferences claude-code:3fa2 '{"starred":true}'` |
| `activity` | 增量会话活动和未读回复 | `--events`、`--key`、`--local` | `dispatch activity --json` |
| `editing` | 最近 30 分钟每个会话改的文件，含冲突 | `--dir`、`--window` | `dispatch editing --dir .` |
| `attachment <key> [ref]` | 读会话里链接的文件 | `--thumbs` | `dispatch attachment claude-code:3fa2 --thumbs` |
| `save-image` / `save-file` | 从 stdin 存图片或文件（界面用） | | |
| `index` | 重建转录索引 | | `dispatch index` |
| `folders` | 浏览文件夹（新建会话用） | `-q`、`--cached` | |
| `session-control open\|browse\|start\|status\|adopt` | 打开、浏览、新建、查询会话（界面用） | | |
| `terminal` | 在 Herdr 开不带 Agent 的终端 | `--cwd`、`--host`、`--label` | `dispatch terminal --cwd ~/Projects/x` |
| `session-summary run\|auto\|providers\|unread <key>` | 让模型总结一段会话 | `--force`、`--limit` | `dispatch session-summary run claude-code:3fa2` |
| `move <id>` | 把会话连同目录搬到另一台 | `--to`、`--prompt`、`--no-files`、`--dry-run`、`--force`、`--keep-original` | `dispatch move 3fa2 --to mini` |
| `moves list\|mark` | 迁移过的会话哪份是原件 | `--to`、`--from` | `dispatch moves` |

## 项目

| 命令 | 作用 | 常用参数 | 例子 |
|:--|:--|:--|:--|
| `projects` | 列出项目 | `--json` | `dispatch projects` |
| `project <名>` | 收藏、归档、迁移、归属 | `--star/--unstar`、`--archive/--unarchive`、`--move-to`、`--owner`、`--dry-run`、`--background`、`--force`、`--keep-original` | `dispatch project web --move-to mini --background` |
| `project-moves` | 后台迁移进度 | | `dispatch project-moves` |
| `here [项目]` / `project-view` | 项目此刻：现状、时间线、未完成、活会话 | `--dir`、`--days`、`--no-summary`、`--refresh-summary`、`--summary-model`、`--local` | `dispatch here --no-summary` |
| `lineage [项目]` | 项目 → 任务 → 会话 → 进展 | `--dir`、`--days` | `dispatch lineage web --json` |
| `project-summary <名>` | 让模型写项目一段话 | `--force`、`--if-stale` | `dispatch project-summary web --if-stale` |
| `docs <项目>` | 项目文档列表 | | `dispatch docs web --json` |
| `docs add\|rm\|read <项目> <路径\|URL\|id>` | 登记、移除、读文档 | `--title`、`--kind`、`--asset` | `dispatch docs add web design/x.md --kind 设计` |
| `facts show\|get\|search\|write\|sections\|docs\|vaults\|topics\|import` | 常用信息 | `-P 项目`、`--path` | `dispatch facts get 服务器 -P web` |

## 知识库与记忆

| 命令 | 作用 | 常用参数 | 例子 |
|:--|:--|:--|:--|
| `wiki add\|list\|search\|show\|related` | 坑、做对、复盘、做法 | `-k`、`--fix`、`--why`、`--tech/--good/--bad`、`-P`、`--task`、`--semantic`、`--limit`、`--all` | `dispatch wiki search "端口占用" --semantic` |
| `pit add\|list\|show` | = `wiki --kind pit` | `--fix`、`-P` | `dispatch pit add "现象" --fix "解法"` |
| `memories list\|show\|archive\|summary` | 各 Agent 的长期记忆 | `--agent`、`--path`、`-P`、`--force` | `dispatch memories list --agent codex` |
| `profile show\|add\|upcoming\|done\|inventory\|write\|path` | 关于我 | `--refresh`、`--due` | `dispatch profile add "改用 zsh"` |
| `insights [report\|list\|show\|open\|schedule\|due]` | 跨 Agent 复盘 | `--days`、`--alerts`、`--ack`、`--every`、`--wait`、`--force`、`--model` | `dispatch insights report --days 14` |

## 规则、技能、密钥

| 命令 | 作用 | 常用参数 | 例子 |
|:--|:--|:--|:--|
| `rules show\|path\|open\|status\|sync\|write\|inspect\|optimize\|check\|apply\|restore\|push\|pull\|peers\|auto` | 共同规则 | `--path`、`--project`、`--profile`、`--model`、`--backup`、`--host`、`--file`、`--refresh`、`--due` | `dispatch rules sync` |
| `skills list\|show\|path\|open\|enable\|disable\|improve\|write\|trash\|new\|import` | 技能池与挂载 | `--agent claude\|codex\|all`、`--file`、`--reveal`、`--description`、`--trigger`、`--constraint`、`--path`、`--as`、`--force`、`--days`、`--copy` | `dispatch skills enable pdf --agent claude` |
| `catalog` | 默认没挂的技能和插件 | `-q`、`--kind skill\|plugin` | `dispatch catalog -q pdf` |
| `env list\|get\|set\|unset\|export\|import\|path` | 密钥 | `--note`、`-P`、`--stdin`、`--fish` | `echo sk-… \| dispatch env set OPENAI_API_KEY --stdin --note "总结用"` |
| `zcode-plugin install\|status\|remove` | ZCode 插件（注入 prime 和技能） | | `dispatch zcode-plugin install` |

## 多 Agent

| 命令 | 作用 | 常用参数 | 例子 |
|:--|:--|:--|:--|
| `agent list\|start\|ask\|read\|wait\|keys\|close` | 通过 Herdr 派活 | `--host`、`--cwd`、`--label`、`--name`、`--model`、`--task`、`-p`、`--no-wait`、`--timeout`、`--lines`、`--extra`、`--auto`、`--focus` | `dispatch agent start codex --cwd ~/Projects/x --task task-abc -p "修测试"` |
| `discuss [task]` | 几个 Agent 各说一次 | `--topic`、`-P`、`--with`、`--leader`、`--rounds`、`-q`、`--conclude`、`--image`、`--everyone`、`--fresh`、`--tui` | `dispatch discuss --topic "要不要换框架" --with claude:opus,codex` |
| `discuss-judge`、`discuss-conclude`、`discuss-doc`、`discuss-live` | 裁判试算、写结论、整理文档、实时状态 | | `dispatch discuss-doc task-abc` |
| `discuss-aside <task> [问题]` | 顺便问：看讨论时有没听懂的，问旁边的「同学」。回答存在讨论旁边，不写进任务，参加者看不到 | `--stdin`、`--quote`、`--clear` | `dispatch discuss-aside task-abc "CKShare 是什么"` |
| `split <id>` | 按讨论建子任务并派出 | `--to kind:"标题\|说明"` | `dispatch split task-abc --to codex:"接口\|…"` |

## 机器、手机、系统

| 命令 | 作用 | 常用参数 | 例子 |
|:--|:--|:--|:--|
| `hosts [rename …]` | 这台和其他 Mac、远程桌面能力 | `--local`、`--refresh` | `dispatch hosts rename local 书房` |
| `serve [run\|url\|qr\|host]` | 手机网页版 | `--svg` | `dispatch serve qr` |
| `screen [status\|setup]` | 手机看屏幕的一键配置 | | `dispatch screen setup` |
| `notify <标题> [正文]` | 推到手机或 Mac 通知 | `--url`、`--level normal\|high`、`--key` | `dispatch notify "好了" "可以看了"` |
| `notify-watch` | 手动跑一趟手机推送检查 | `--json` | `dispatch notify-watch --json` |
| `quota` | 各 Agent 额度 | `--local` | `dispatch quota` |
| `stats` | token、热力图、工具、技能 | `--agent`、`--days`、`--local`、`--cached` | `dispatch stats --days 30` |
| `settings [key] [value]` | 共享设置 | | `dispatch settings session_archive_days 60` |
| `summarize providers\|set-key\|uses` | 总结模型与用途 | | `dispatch summarize uses` |
| `update [check\|apply]` | 检查 / 安装新版本 | `--no-relaunch` | `dispatch update apply` |
| `init [wizard\|status\|run\|…]` | 首次设置向导 | `run deps\|cli\|board\|agents\|rules\|review\|reverse-ssh`、`rename-self`、`rename-peer`、`remove-host`、`skip`、`finish`、`reset`、`peers` | `dispatch init status --json` |
| `prime` | 会话启动注入 | `--hook-json`、`--cwd`、`--limit` | `dispatch prime` |
