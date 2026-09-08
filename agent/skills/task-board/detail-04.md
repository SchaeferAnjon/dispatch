# 环境变量 / API Key（`dispatch env`）

密钥统一存 `~/.config/dispatch/env`（0600），不进板、不进 wiki、不进 commit。`dispatch prime` 只列名字和用途；需要时 `dispatch env get NAME`；用户给新 Key 时 `dispatch env set NAME VALUE --note "用途"`（或 `--stdin`）；`dispatch env list`；shell 里 `eval "$(dispatch env export)"`（fish 新终端已自动加载）。
