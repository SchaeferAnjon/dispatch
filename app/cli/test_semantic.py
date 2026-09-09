import argparse
import contextlib
import importlib.util
import io
import json
import os
import tempfile
import unittest
from unittest.mock import patch

HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location("dispatch", os.path.join(HERE, "dispatch.py"))
dispatch = importlib.util.module_from_spec(spec)
spec.loader.exec_module(dispatch)

import semantic  # noqa: E402  (needs HERE on sys.path, which unittest discover provides)


def item(key, text, kind="pit", project="", task="", fix=""):
    fields = {"【解法】": fix} if fix else {}
    raw = f"{text} #project:{project}" if project else text
    return {"key": key, "kind": kind, "text": text, "fields": fields, "project": project, "task": task, "raw": raw}


def fake_embed(texts, key=None, timeout=60):
    """Deterministic 4-d vectors: one axis per keyword, so ranking is predictable offline."""
    words = ["sqlite", "mac", "同步", "agent"]
    out = []
    for text in texts:
        vec = [1.0 if w in text else 0.0 for w in words]
        vec[3] = 0.05
        out.append(vec)
    return out


class HashAndMath(unittest.TestCase):
    def test_hash_follows_text_not_tags(self):
        a = item("pit-a", "同样的内容", project="x")
        b = item("pit-a", "同样的内容", project="y", task="t1")
        self.assertEqual(semantic.entry_hash(a), semantic.entry_hash(b))
        c = item("pit-a", "换了内容")
        self.assertNotEqual(semantic.entry_hash(a), semantic.entry_hash(c))

    def test_entry_text_includes_labelled_fields(self):
        it = item("pit-a", "现象", fix="解法")
        self.assertIn("解法", semantic.entry_text(it))

    def test_cosine(self):
        self.assertAlmostEqual(semantic.cosine([1, 0], [1, 0]), 1.0)
        self.assertAlmostEqual(semantic.cosine([1, 0], [0, 1]), 0.0)
        self.assertEqual(semantic.cosine([], [1]), 0.0)
        self.assertEqual(semantic.cosine([0, 0], [1, 1]), 0.0)

    def test_blob_roundtrip(self):
        vec = [0.5, -1.25, 3.0]
        self.assertEqual(semantic._unblob(semantic._blob(vec)), vec)


class Index(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp()
        self.path = os.path.join(self.dir, "semantic.sqlite")
        self.items = [
            item("pit-sqlite", "sqlite 迁移要小心", fix="先备份"),
            item("pit-mac", "两台 mac 同步任务板", fix="先提交"),
            item("pit-other", "agent 输出被过滤", fix="拆小块"),
        ]

    def test_sync_is_incremental(self):
        first = semantic.sync(self.items, key="k", path=self.path, embed_fn=fake_embed)
        self.assertEqual(first["embedded"], 3)
        self.assertEqual(first["indexed"], 3)
        again = semantic.sync(self.items, key="k", path=self.path, embed_fn=fake_embed)
        self.assertEqual(again["embedded"], 0)
        changed = [self.items[0], self.items[1], item("pit-other", "agent 输出被过滤（改了）")]
        third = semantic.sync(changed, key="k", path=self.path, embed_fn=fake_embed)
        self.assertEqual(third["embedded"], 1)

    def test_sync_drops_removed_entries(self):
        semantic.sync(self.items, key="k", path=self.path, embed_fn=fake_embed)
        report = semantic.sync(self.items[:2], key="k", path=self.path, embed_fn=fake_embed)
        self.assertEqual(report["removed"], 1)
        db = semantic.connect(self.path)
        self.assertEqual(sorted(r[0] for r in db.execute("SELECT key FROM entries")), ["pit-mac", "pit-sqlite"])
        db.close()

    def test_search_ranks_the_matching_entry_first(self):
        hits = semantic.search("sqlite 数据库", self.items, limit=3, key="k", path=self.path, embed_fn=fake_embed)
        self.assertEqual(hits[0]["key"], "pit-sqlite")
        self.assertGreater(hits[0]["score"], hits[-1]["score"])
        self.assertGreater(hits[0]["score"], 0.5)

    def test_search_still_works_without_sqlite_vec(self):
        # No vec0: the same blobs are ranked in Python, so a missing extension only costs speed.
        with patch.object(semantic, "load_vec", return_value=False):
            hits = semantic.search("sqlite 数据库", self.items, limit=3, key="k", path=self.path, embed_fn=fake_embed)
        self.assertEqual(hits[0]["key"], "pit-sqlite")

    def test_search_kind_filter_uses_the_partition(self):
        items = self.items + [item("win-sqlite", "sqlite 做对了", kind="win")]
        hits = semantic.search("sqlite", items, limit=5, kind="pit", key="k", path=self.path, embed_fn=fake_embed)
        self.assertTrue(hits)
        self.assertTrue(all(h["kind"] == "pit" for h in hits))
        self.assertNotIn("win-sqlite", [h["key"] for h in hits])

    def test_search_without_key_is_off(self):
        self.assertEqual(semantic.search("sqlite", self.items, key="", path=self.path, embed_fn=fake_embed), [])
        self.assertEqual(semantic.related("t1", "sqlite", self.items, key="", path=self.path, embed_fn=fake_embed), [])

    def test_related_keeps_the_tasks_own_entries_first(self):
        items = [item("pit-tagged", "别的项目的事", task="t1"), item("pit-sqlite", "sqlite 迁移")]
        hits = semantic.related("t1", "sqlite", items, limit=2, key="k", path=self.path, embed_fn=fake_embed)
        self.assertEqual(hits[0]["key"], "pit-tagged")
        self.assertEqual(hits[0]["score"], 1.0)
        self.assertIn("pit-sqlite", [h["key"] for h in hits])

    def test_available_follows_the_env_key(self):
        with patch.object(semantic, "api_key", return_value=""):
            self.assertFalse(semantic.available())
        with patch.object(semantic, "api_key", return_value="abc"):
            self.assertTrue(semantic.available())


class RelatedFallback(unittest.TestCase):
    """`dispatch wiki related` must still answer with the project's entries when semantic is off."""

    def test_project_fallback_when_semantic_returns_nothing(self):
        items = [item("pit-here", "本项目的坑", project="kanban"), item("pit-away", "别的项目的坑", project="other")]
        issue = {"id": "t1", "labels": ["project:kanban"], "title": "标题", "description": "描述"}
        a = argparse.Namespace(text="t1", kind="pit", limit=8, json=True)
        buf = io.StringIO()
        with patch.object(dispatch, "bd_json", return_value=issue), patch.object(semantic, "related", return_value=[]):
            with contextlib.redirect_stdout(buf):
                dispatch.wiki_related(a, items)
        rows = json.loads(buf.getvalue())
        self.assertEqual([r["key"] for r in rows], ["pit-here"])
        self.assertIsNone(rows[0]["score"])

    def test_semantic_rows_win_when_present(self):
        items = [item("pit-here", "本项目的坑", project="kanban"), item("pit-away", "别的项目的坑", project="other")]
        issue = {"id": "t1", "labels": ["project:kanban"], "title": "标题", "description": "描述"}
        a = argparse.Namespace(text="t1", kind="pit", limit=8, json=True)
        semantic_rows = [{**items[1], "score": 0.9}]
        buf = io.StringIO()
        with patch.object(dispatch, "bd_json", return_value=issue), patch.object(semantic, "related", return_value=semantic_rows):
            with contextlib.redirect_stdout(buf):
                dispatch.wiki_related(a, items)
        rows = json.loads(buf.getvalue())
        self.assertEqual([r["key"] for r in rows], ["pit-away"])


if __name__ == "__main__":
    unittest.main()
