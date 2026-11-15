"""Documents for the Docs tab scenario (scenarios/docs-tab.mjs declares it: meta.instance.fixture "docs-project"):
design drafts, delivery write-ups with their "Where to look" picture, prototype pages and a few notes, written into
the instance's demo project before the app starts, the way a project that has been worked on for a while looks.
Nothing comes from a real project (design drafts stay out of the public repository), and no agent is asked."""
import json
import os
import struct
import zlib

# design drafts: (folder, title, with a prototype page next to it)
DESIGNS = [
    ("tasks-tab", "Tasks 页签重设计：会话的任务和整个项目的任务", True),
    ("waiting", "Waiting for you 页重设计：按项目收组", True),
    ("projects-page", "Projects 页：时间线和列表", False),
    ("bars", "标题栏和底栏：方块里的状态", True),
    ("settings", "设置页：方向 B", False),
    ("knowledge", "Knowledge 页：Agent 知道你什么", False),
    ("slash-menu", "斜杠菜单：一个菜单分组", False),
    ("terminal", "内置终端：和对话并列", False),
    ("history", "History 页签：电脑上所有会话", False),
    ("onboarding", "首次设置：两屏或四屏", False),
    ("turbo", "Turbo：大活拆成并行块", False),
    ("automations", "自动化页：别的工具的定时任务", False),
]
# and the many smaller drafts a project gathers over weeks: enough rows that the list scrolls in a 420 px pane
DESIGNS += [("note-%02d" % i, "设计笔记 %02d：%s" % (i, topic), False) for i, topic in enumerate(
    ["按钮的说法", "空状态", "加载中", "深色", "窄窗口", "键盘", "悬停卡", "拖拽", "通知", "搜索", "排序", "分组", "折叠",
     "错误提示", "首次使用", "撤销", "复制", "导出", "分享", "快捷键", "状态方块", "进度", "时间", "图标"], 1)]
# delivery write-ups (an impl/ folder is a delivery, docs_view.py)
DELIVERED = [
    ("waiting/impl", "Waiting for you 页：实现"),
    ("bars/impl", "标题栏和底栏：实现"),
]
WHERE = [
    ("列表", "Docs 页签", "交付一到就打开"),
    ("范围", "顶行左边", "This session 或整个项目"),
    ("搜索", "顶行右端", "点开变成搜索框"),
    ("分组", "列表里", "点组头收起"),
    ("原型", "行尾的地球", "点它开原型"),
]


def png(path, w=1600, h=1000):
    """A plain picture with a few boxes in it, as a screenshot stands in a write-up (PNG by hand: no Pillow needed)."""
    rows = []
    for y in range(h):
        row = bytearray()
        for x in range(w):
            box = (x // 320 + y // 250) % 3
            row += bytes((236, 232, 226) if box == 0 else (214, 208, 200) if box == 1 else (196, 160, 120))
        rows.append(b"\0" + bytes(row))
    raw = zlib.compress(b"".join(rows), 6)

    def chunk(kind, data):
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF)
    with open(path, "wb") as f:
        f.write(b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0)) + chunk(b"IDAT", raw) + chunk(b"IEND", b""))


def write(path, text):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        f.write(text)


def prepare(rec):
    root = rec["folder"]
    design = os.path.join(root, "design")
    for folder, title, page in DESIGNS:
        d = os.path.join(design, folder)
        write(os.path.join(d, "README.md"), "# %s\n\n这份设计稿说明 %s 的方向和取舍。\n\n## 方向 A\n\n列表按类分组，点一行就地打开。\n\n## 推荐\n\n推荐方向 A。\n" % (title, title.split("：")[0]))
        if page:
            write(os.path.join(d, "index.html"), "<!doctype html><meta charset=utf-8><title>%s</title><body style=\"font:15px system-ui;padding:40px\"><h1>%s</h1><p>原型页。</p></body>\n" % (title, title))
    for folder, title in DELIVERED:
        write(os.path.join(design, folder, "README.md"), "# %s\n\n改了什么、在哪、怎么验的。\n" % title)
    # the write-up the scenario delivers: its "Where to look" picture and the numbered boxes in 00-where.json
    d = os.path.join(design, "docs-tab", "redesign")
    os.makedirs(d, exist_ok=True)
    png(os.path.join(d, "00-where-is-what.png"))
    items = [{"n": i + 1, "box": [80 + 300 * (i % 5), 120 + 180 * (i % 4), 260, 160], "what": what, "where": where, "how": how}
             for i, (what, where, how) in enumerate(WHERE)]
    write(os.path.join(d, "00-where.json"), json.dumps({"image": "00-where-is-what.png", "size": [1600, 1000], "scale": 2, "items": items}, ensure_ascii=False))
    write(os.path.join(d, "README.md"), "# Docs 页签重设计：列表加就地打开\n\n## 在哪、看什么\n\n![在哪、看什么](00-where-is-what.png)\n\n"
          + "".join("%d. %s · %s · %s\n" % (i + 1, what, where, how) for i, (what, where, how) in enumerate(WHERE))
          + "\n## 改了什么\n\n交付一到右栏直接打开，‹ Docs 回列表，滚动和收起的组都在。\n")
    return {"record": {"docs_delivered": os.path.join(d, "README.md")}}
