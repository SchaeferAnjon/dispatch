# Dispatch IDE 界面端到端测试

Agent 验证 Dispatch IDE 的界面改动用这一套，不各写各的 CDP 脚本。CLI 在 `app/cli/ide_e2e.py`（`dispatch ide instance …` / `dispatch ide e2e …`），这里是跑在测试实例里的那一半：

- `cdp.mjs`：几十行的 CDP 客户端，只连 127.0.0.1。不依赖任何 npm 包，用 App 自己的 Electron 当 Node 跑（`ELECTRON_RUN_AS_NODE=1`），所以装了 Dispatch IDE 就能用。
- `runner.mjs`：`dispatch ide e2e run` 起的就是它，给场景一个 `ui` 帮手对象，每一步写进 `steps.json`。
- `locate.mjs`：按人说的话找元素：可见文字、aria-label、placeholder，先找窗口页面，找不到再进 webview。
- `hide-windows.mjs`：`instance start` 起完 App 马上跑它，从主进程里把测试窗口藏起来（见下面「窗口不出现在你屏幕上」）。
- `focus.mjs`：打字前的焦点判定（纯函数，`test_ide_e2e.py` 和 vitest 都测它）。
- `scenarios/`：自带场景，`dispatch ide e2e scenarios` 列出来，`dispatch ide e2e run waiting-for-you` 直接按名字跑。`guards` 在真实窗口里自检两道闸（往打开的文件打字被拒、聊天框回车被拒），改了 runner 之后跑一遍。示例产出在仓库的 design/e2e/。

## 用法

```bash
dispatch ide instance start e2e --agents       # 隔离实例：/tmp/dide-e2e/e2e，自动端口，临时任务板，演示项目 demo
dispatch ide e2e run waiting-for-you --out design/e2e/waiting
dispatch ide e2e run my-check.mjs               # 自己写的场景
dispatch ide e2e annotate design/e2e/waiting    # run 有 mark() 时已经自动做了；改了说明可以重做
# 不给 --out 时写到 /tmp/dide-e2e/_runs/<场景>-<时间>；同一个 --out 再跑会先删掉上一次的产出
dispatch ide instance stop e2e

# 一个场景，照它 meta.instance 新起一个实例，跑完就关（不用自己记它要什么参数）
dispatch ide e2e run first-run --fresh --app "<Dispatch IDE.app>"
# 整套：每个场景各起一个新实例；summary.json / summary.md / suite.log 写在 --out，每跑完一个就更新
dispatch ide e2e suite --app "<Dispatch IDE.app>" --out ~/e2e-runs/today --repeat 2 --lanes 2
dispatch ide e2e suite first-run onboarding --app …    # 只跑这几个
```

整套在 mini 上跑（10-07 起的做法）：mini 上有一份 kanban 的检出（它的 git 里要有构建用的提交，`instance start` 从那里取 CLI），`dispatch build start … --on mini` 出的 App 在 `~/dispatch-builds/<名>/Dispatch IDE.app`，在那份检出里跑 `python3 app/cli/ide_e2e.py e2e suite --app … --out …`。结果：`passed`、`failed`（哪一步、出错的话、`error.png` 和窗口当时的文字 `error.txt`）、`skipped`（缺什么、怎么补，见下面 needs）、`partial`（场景自己写了 not-tested.json）。

`instance start` 做的事：独立的 user data、扩展、shared data、Agents 窗口的 user data 和插件目录（这个构建默认把几样放在 `~/.dispatch-ide*`，全部改到实例目录里）；`--force-disable-user-env`（macOS 上 VS Code 会拿登录 shell 的环境盖掉进程环境，`~/.zshrc` 里的 `BEADS_DIR` 会让测试实例读写真任务板）；`--password-store=basic`（不用钥匙串，临时签名的构建不会弹授权框）；预写 settings.json 关掉更新检查和遥测；用构建自己那个 kanban 提交的 dispatch CLI（`git archive` 到实例目录），界面、bridge 和 CLI 是同一版。记录在 `~/.dispatch/state/instances/<名>.json`。

窗口不出现在你屏幕上：`instance start` 让 App 的主进程带 `--inspect=<端口>`（只听 127.0.0.1）起来，第一个窗口出来之前 `hide-windows.mjs` 连进去，把每个窗口设成全透明、鼠标穿透，显示时不激活 App（不抢焦点），App 也不进 Dock。透明的窗口照样渲染，截图、点击、打字都走 CDP；runner 连上窗口时让页面按「有焦点」处理，再查一遍屏幕上有没有看得见的窗口，有就重新藏一次，还看得见就在 stderr 报出来并写进 steps.json 的 `on_screen`。App 自己也认测试实例（环境变量 `DISPATCH_E2E_INSTANCE`）：窗口先不显示地建好，再用 showInactive 显示。建窗时就显示的话，macOS 会立刻把 App 换到最前面，透明的窗口拿走你的键盘焦点（task-4cpnb 查到）。场景 `stays-hidden` 验这两条：读窗口列表和 `lsappinfo front`，不截屏。`instance start` 藏不住就不起：hide-windows.mjs 没答上（缺这个文件、没连上 inspector、超时），或者起好以后再藏一次窗口仍看得见，都结束这个实例并报 `not_hidden`，不留窗口在你屏幕上。想亲眼看着跑就设 `DISPATCH_E2E_SHOW=1`。不用的做法：CDP 的 `Browser.setWindowBounds` 这个 Electron 没有；`window.moveTo` 挪到屏幕边就停；⌘H 把 App 藏起来的话，藏着时才显示的窗口一直不画，截图永远等不到。

`e2e run` 之前会查三件事：记录里的 pid 还是这个 App、带这个 user data；CDP 端口现在是这个实例的进程在听（lsof）；App 在磁盘上没被别的构建换掉（product.json、bridge 和 workbench 的指纹）。任何一条不对就不连。

## 写场景

等真 Agent 干活的场景在 `meta` 里写 `timeout`（秒），runner 取它和 `--timeout` 里大的那个（默认 300）。

场景自己说要什么样的实例、这台 Mac 要有什么，不写在注释里让人照着敲（`e2e_suite.py`）：

- `meta.instance`：`--fresh` 和 `suite` 怎么起它的实例。`onboarding: 'fresh' | 'terminal'`（新用户的 HOME 和向导）、`seed: false`（不建演示项目）、`tips: true`（Getting started 的提示照常弹；测试实例默认关掉，免得它在别的场景点东西时盖上来）、`motion: true`（动效照常；默认关掉：藏起来的窗口照样画动画，GPU 进程常年占三分之一个核，同一台 Mac 上几个实例一起跑会互相拖慢）、`fixture: '<名>'`（启动前跑 `fixtures/<名>.py` 的 `prepare(rec)`，返回 `{env, record}`：给 App 的环境变量，`PATH_PREPEND` 放在 PATH 最前；写进实例记录给场景读的东西）、`env: {…}`（`instance start` 的环境变量，比如 onboarding fixture 的开关）。
- `meta.exclusive: true`：用到这台 Mac 的剪贴板、屏幕或鼠标的场景，`suite --lanes N` 时等别的跑完单独跑。
- `meta.env`：场景自己的环境变量（分段、模型）；调用的人设了同名变量时以人的为准。
- `meta.needs`：这台 Mac 得有的东西：`opencode`、`codex`（装了且登录）、`claude`（登录了，而且设了 `DISPATCH_E2E_CLAUDE=1`：Claude 额度留给调度，测试不花）、`gh`（登录 GitHub）、`internet`、`other-mac`（`DISPATCH_E2E_OTHER_MAC=user@host`，ssh 用本机钥匙连得上）、`accessibility`（跑测试的程序有辅助功能权限，只能人去系统设置里开）。缺一样就不起实例，结果是 `skipped` 加缺什么、怎么补；拼错的名字也算缺。
- 跑到一半才知道缺东西（比如某个服务今天不通）就 `ui.skip("缺什么，怎么补")`：结果是 skipped，不算通过。

`DISPATCH_E2E_TIME_SCALE=3`：忙的 Mac 上（mini 同时还跑着别人的构建和 Agent），`waitFor`、`waitForText` 和场景总时限都乘这个数；查的东西不变。场景自己写的等待（各自的 `until`、按 `Date.now()` 算的循环）也乘它：文件开头 `const SCALE = Math.max(1, Number(process.env.DISPATCH_E2E_TIME_SCALE) || 1);`，期限写成 `ms * SCALE`。

测试实例里 OpenCode 默认用便宜模型：`instance start` 给实例自己的 opencode.json 写 `model`：Z.AI Coding Plan 的 GLM 5.3 Flash，没登录就 DeepSeek Flash，再没有就 OpenCode Zen 的免费 MiMo Flash（mini 上只有免费的；`DISPATCH_E2E_OPENCODE_MODEL` 可以指定）。场景在 /model 菜单里挑模型用 `ui.cheapModel(rows)`，同一个顺序，永远挑不到 Claude 或大模型。只有免费模型的 Mac 上，哪个免费模型能答话一小时一变（10-07 MiMo 和 Big Pickle 一度不回话）：`--fresh` 和 `suite` 跑要 OpenCode 的场景前，先用一句 PONG 依次问 MiMo Flash、Nemotron 3.5 Lightning、Nemotron 3 Ultra、Big Pickle（临时 HOME，45 秒），第一个答上的记 15 分钟（/tmp/dide-e2e/_tools/free-model.json），经 `DISPATCH_E2E_OPENCODE_MODEL` 交给实例的 opencode.json 和 `ui.cheapModel`。

场景是一个 ES 模块，默认导出一个 async 函数：

```js
export const meta = { title: "Waiting for you 页", description: "一句话说这页是什么" };

export default async function (ui) {
  await ui.openAgents(ui.demoFolder);            // Agents 窗口，落在演示项目上
  await ui.click("Waiting for you");
  await ui.waitFor("Approve the demo release");
  await ui.screenshot("waiting");
  await ui.mark("Waiting for you", { what: "入口", where: "左侧栏第一行", how: "点它" });
}
```

找元素的写法（`click` / `hover` / `waitFor` / `mark` / `type` 的 `into` 都一样）：

- 字符串：先比 aria-label（去掉快捷键和 `, 0` 这样的计数），再比 placeholder，再比可见文字。
- `{ text }` 只比文字，`{ aria }` 只比 aria-label，`{ css }` 用选择器；`exact: true` 不做前缀匹配；`within: ".选择器"` 只在这块里找；`index: n` 取第 n 个同分的；`webview: false | true` 只找窗口页面或只找 webview。
- 同分时取页面上靠前的；框住文字的块元素会收成文字本身的范围。

`ui` 上的方法：

| 方法 | 做什么 |
| --- | --- |
| `openAgents(folder?)` | 切到 Agents 窗口；给目录时经 dispatch-bridge 的 `ide/agents-request` 把窗口带到那个目录（要有编辑器窗口，`instance start` 默认就开着演示项目） |
| `openEditor()` | 切到编辑器窗口 |
| `attach(kind, timeoutMs?, title?)` | 在当前测试实例中选择窗口；双机测试可传精确标题，例如 `Dispatch Agent · mini` |
| `newSession(folder?)` | 新会话页，不发任何消息 |
| `openSession(title)` | 侧栏里按标题开一个会话 |
| `openCustomizations(section)` | 原 Customizations 的一页，现在在设置（⌘,）里：Overview 是 Abilities，MCP Servers 是 MCP servers 页，Agents 是 Sub-agents，Claude / Codex / OpenCode 是 Agents 下各自的页 |
| `setTheme(mode)` | 设置 › Appearance 里点 System / Light / Dark，等窗口换好颜色；原来没开设置就再关上 |
| `openTab(name)` | 右栏页签（Changes、Files、Docs、Tasks），没开时从 + 里加 |
| `click(x)` / `hover(x)` | 真实的鼠标事件，打在元素中心 |
| `clickWhenEnabled(x)` | 等按钮能按了再点（向导的 Set up Dispatch 要等计划读完才亮） |
| `type(text, { into? })` | 只往聚焦的输入框里打；焦点在打开的文件里、按钮上、或什么都没聚焦时报错停下，并截 `refused-type.png` |
| `press(key, { send? })` | Enter、Escape、Tab、方向键、Backspace、Delete、F1（命令面板）、`Cmd+,`（设置）；焦点在文件里时改字的键被拒；在聊天框里按 Enter 等于给真实 Agent 发消息，要 `{ send: true }` |
| `waitFor(x, { timeoutMs, gone })` | 等它出现（或消失） |
| `waitForText(text, { timeoutMs, gone })` | 等窗口文字里有这句（滚到看不见的地方也算）：只说「它在了」；要点它、看它用 `waitFor` |
| `exists(x)` | 现在在不在，不记步骤 |
| `scrollTo(text)` | 把这段文字滚到可见区中间（整段文字，或一句话的开头） |
| `wheelUntil(x, { over })` | 鼠标滚轮在 `over` 那块上往下（再往上）滚，直到 x 出现：只画看得见那几行的长列表（VS Code 的列表）要这样找 |
| `showSidePane()` | 右栏没开时点标题栏的 Show Side Panel |
| `openNowTab()` | 会话右栏的 Now 页签：右栏没开就打开，别的页签在前就点 Now |
| `cheapModel(rows)` | 模型菜单的行（`{name, desc}` 或名字）里挑测试用的便宜模型，见上 |
| `skip(reason)` | 缺条件，停下记成 skipped |
| `screenshot(name)` | 整个窗口，`<out>/<name>.png`；顺带查一条规矩（keep-clear.mjs）：自己弹出的提示卡和第一次的 What's new 不许压在消息框和它周围的按钮上，压了就记在这一步的 `covers` 里，跑完整个场景判失败（meta 里 `allowCovers: true` 可以关掉） |
| `mark(x, note)` | 记下元素的位置和一句说明，给标注图用；note 是 `"是什么 · 在哪 · 怎么用"` 或 `{ what, where, how }`，缺的 where 按位置猜，缺的 how 用这之前点过的路径 |
| `eval(expr)` | 读状态用 |
| `windowsOnScreen()` | 这个实例在屏幕上看得见的窗口 `[[x, y, w, h], …]`，没有是 `[]`（macOS；读不了是 `null`） |
| `browserPage(urlPart)` | 内置浏览器里打开的页面（右栏的 HTML 交付页）：它是单独的 CDP 目标，窗口的 click / screenshot 进不去。返回的对象有 `click(css)`（在那一页上真实鼠标点击）、`type(css, text)`、`eval(expr)`、`screenshot(name)`（只截那一页） |
| `demoFolder` / `rec` | 演示项目目录 / 实例记录 |

实例只列它自己的会话：Agents 窗口的会话目录读实例的 user data（`DISPATCH_IDE_USER_DATA_DIRS`），会话列表、索引和 Waiting for you 只认工作目录在实例文件夹下（或 `--folder` 指定的文件夹下）的会话（`DISPATCH_SESSION_ROOT`）。Claude Code 用你真实的配置目录，登录照旧；Codex 用实例里的 `CODEX_HOME`，启动时把真实的 `auth.json` 和 `config.toml` 软链进去。OpenCode 用实例里的 `XDG_DATA_HOME`（`<实例>/xdg-data`），会话库 opencode.db 在实例里，启动时把真实 `~/.local/share` 里别的东西（mise、uv、Claude Code 的版本目录…）整个软链进去，`opencode/` 里只链登录文件 `auth.json`、`mcp-auth.json` 和它下载的工具 `bin/`，你自己的 OpenCode 会话列表和 History 不再混进测试会话。`XDG_CONFIG_HOME` 也指到实例里（`<实例>/xdg-config`）：`~/.config` 里的东西整个链进去，只有 `opencode/` 是实例自己的，`opencode.json` 抄一份去掉 `plugin`，不带 `plugins/`，所以你装的第三方 OpenCode 插件（oh-my-openagent 会把每个会话抄进 `~/.claude/transcripts`）在测试里不跑；Dispatch 自己的插件照样从 `OPENCODE_CONFIG_CONTENT` 进来。你自己用 OpenCode 时什么都没变。Agents 窗口自己从 `~/.claude` 发现的外部会话，CLI 的列表按同样的规则过滤掉，但窗口自带的会话列表里仍可能看到，测试里别打开它们往里打字。Dispatch 自己的终端读完你的 shell 配置（`~/.zshrc` 里的 `BEADS_DIR` 之类）以后，把实例的 `BEADS_DIR`、所有 `DISPATCH_*` 和 `DISPATCH_TERMINAL_KEEP` 里列的变量（实例的 `CODEX_HOME`、`XDG_*`）放回去，终端里建的任务落在实例板上；`dispatch assistant` 的文件夹在实例的 `DISPATCH_HOME` 里（新对话页的入门建议读它）。`isolation` 场景验这两条。

## 输出

`<out>/steps.json`：每一步的时间、动作、目标、元素框、截图、出错信息；`marks` 和 `frames` 给标注图用。失败时有 `error.png`。`00-where-is-what.png`：真实截图、编号红框、每号一行「是什么 · 在哪 · 怎么用」；`README.md`：标注图、说明、截图列表和这次跑的构建，改几句就能交付。
