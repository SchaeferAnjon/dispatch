# 已知限制

> 这一页解决什么：如实列出当前版本（v0.7.29）已知的坑，来自对源码的审读。装之前看一遍，能省掉不少排错时间。会随版本更新。

## 会挡住新用户的

- **Python 3.12+ 是硬要求，但应用不检查也不安装。** 应用调用 PATH 里的 `python3`；macOS 自带的 3.9 会在 CLI 的两处语法上直接报错，首次设置向导也不出现，看到的是空工作台。解决：`brew install python@3.12` 或更新，见 [排错](24-troubleshooting.md)。
- **只有 Apple 芯片的包。** README 和官网提到 Intel 包，但 Release 里目前只有 `macos-apple-silicon.zip`；Intel 机器需要从源码构建（`cd app && npm ci && npm run tauri build`，需要 Node 20.19+ / 22.12+、Rust、Xcode 命令行工具、Python 3.12+）。应用内更新在找不到匹配架构时可能推错包。
- **依赖缺失时是裸的 traceback，不是可读提示。** bd、git、herdr 不在 PATH 时，某些命令直接抛 Python 异常；没有任务板时 `dispatch prime` 会失败并在每个 Claude Code 会话开头显示一条英文 bd 错误。跑完首次设置第 1 步和第 3 步即可避免。
- **手机访问需要 `dispatch serve` 在跑，而安装常驻任务的脚本没有打进 .app。** 设置页照样画二维码。临时办法：终端里 `dispatch serve` 前台跑，或从源码目录跑 `app/scripts/serve-setup.sh`。

## 关于「不向模型发送内容」

官网和 README 说「默认不向任何模型发送你的文档或对话」，这句话在当前版本**不准确**：

- 会话自动总结默认开（每 3 分钟总结一两段，历史会话逐步补齐），用途表里的八项（会话总结、项目现状、dispatch here、讨论结论、洞察报告、记忆总结、设备盘点、语义搜索索引）默认全开。
- 没有任何 API Key 时，只要装了 Claude Code，就会用你的 Claude Code 订阅跑 `claude -p` 来总结。
- 打开「Agent 记忆」页、项目「回顾」页、任务详情（语义搜索）会不经确认发起请求。

想完全不出机器：设置 → 会话 → 用途表全部关掉，并把「总结用的模型」留空且不配任何 Key。

## 界面文案与实现的出入

- 「手机访问」说的「一次性登录令牌」实际是长期有效的静态令牌加一年的 cookie，令牌在 `~/tasks/.dispatch/serve.json`。别把链接发到公开的地方。
- 没有 Tailscale 时网页服务绑到局域网地址，同一 Wi‑Fi 的设备都能访问端口 7799（有令牌保护）。
- 设置里没有一个叫「自动总结」的总开关，只有用途表。
- README 把 DeepSeek 列为可用总结模型，但代码里停用了它（只有 DeepSeek Key 的人总结不工作）。
- 技能池只支持挂给 Claude Code 和 Codex；pi、ZCode、Gemini、OpenCode 勾选后不会挂任何技能。
- 首次设置第 1 步的依赖表里有 tmux，README 的依赖列表漏了它。

## 只装一种 Agent 的人

- 新建会话、派活、讨论的默认 Agent 是 Claude Code / Claude，不看本机装没装；未装的也会出现在下拉里。
- 额度页会列出全部 Agent，没装的显示「没拿到数据」。
- 洞察报告固定用 `claude -p` 生成，无视「总结用的模型」；没装 Claude Code 会报「No such file: claude」。
- 迁移冲突助手写死了用 pi + GLM 模型，需要智谱 Key。

## Claude Code hook 的副作用

- 首次设置第 4 步会**无条件覆盖**你 `~/.claude/settings.json` 里已有的 `statusLine` 设置，且不备份；状态行脚本里写死了作者的 claude-hud 插件，别人的状态行可能变空白。
- hook 命令依赖 `~/.local/bin/dispatch`（第 2 步建立的链接），跳过第 2 步每次开会话都会报错。
- 编辑互斥 hook 默认装上：同一文件 30 分钟内被另一个会话改过就拒绝，单机 `/clear` 或开第二个窗口也会被拦一次。
- prime hook 热缓存也要几秒，另一台机器离线时可能等到 ssh 超时。

## 其他

- **台式机屏幕永不休眠**：无电池的 Mac 上应用常驻时用 `caffeinate` 阻止息屏，没有开关。
- **终端只认 Ghostty**：「跳到会话」和回复原会话的自动切换只对 Ghostty 做了；iTerm2、Terminal、Warp 用户能用 Herdr 路径，但得手动切窗口。
- **技能池路径写死** `~/.cc-switch/skills`。
- **`BEADS_DIR` 只对本机部分生效**：远端命令和同步脚本仍写死 `~/tasks/.beads`。
- **局域网接入（无 Tailscale）迁移后**对端不会自动标记「已搬走」，会话两边各出现一次。
- **更新器**只认 `/Applications/Dispatch.app`；报错文案里提到「仓库是私有的」是过时的；下载后没有校验和；替换成功后重启网页服务失败会被报成更新失败。
- **签名**：包用作者的开发证书签名、未公证；首次运行 CLI 会往 .app 里写 `__pycache__` 破坏签名校验，权限可能反复询问。
- **性能**：工作台每 10 秒重拉全部进行中任务的评论；活动扫描每 3 秒遍历全部转录；洞察缓存任何会话写入都会全量重算。会话很多时会感觉到。
- **`dispatch env` 只生成 fish 的自动加载文件**（`env.fish`），zsh / bash 用户要 `eval "$(dispatch env export)"`。
- **读取索引上限**：本机会话列表 500 条、远端 200 条；历史条目不显示未读或推断运行状态。
- **工作区 Git 差异**可能包含其他会话的改动。
- **附件**：只能读当前会话明确附加或链接的文件，单个 20 MB；依赖外部库的 HTML 产物需要在原项目里运行。
- **「潜在冲突」是静态检查**，不是完整语义证明。
- **全局快捷键在输入框内也会触发**。
- 不接入 ChatGPT 网页会话；拿不到原 Agent 应用的「已读」回执。
