import unittest

import summarize as S


def m(role, text, ts, tools=()):
    return {"role": role, "text": text, "ts": ts, "tools": [{"name": t} for t in tools]}


class UnreadTurnTest(unittest.TestCase):
    def test_takes_the_agent_side_of_the_turn_that_ended_with_the_reply(self):
        msgs = [m("user", "改一下按钮", "2026-09-14T00:00:00Z"), m("assistant", "看一下代码", "2026-09-14T00:00:05Z", ["Read", "Read"]),
                m("assistant", "改好了，已推送", "2026-09-14T00:01:00Z", ["Edit"]),
                m("user", "再来一个", "2026-09-14T00:02:00Z"), m("assistant", "正在做", "2026-09-14T00:02:10Z")]
        reply_at = S._msg_epoch(msgs[2])
        text = S.unread_turn(msgs, reply_at)
        self.assertTrue(text.endswith("【最终回复】\n改好了，已推送"))
        self.assertIn("（过程中的进度说明）\n看一下代码", text)
        self.assertNotIn("Read", text); self.assertNotIn("正在做", text)
        # No anchor: the latest turn.
        self.assertIn("正在做", S.unread_turn(msgs))

    def test_turn_without_text_is_empty(self):
        msgs = [m("user", "跑测试", "2026-09-14T00:00:00Z"), m("assistant", "", "2026-09-14T00:00:05Z", ["Bash"])]
        self.assertEqual(S.unread_turn(msgs), "")


if __name__ == "__main__":
    unittest.main()
