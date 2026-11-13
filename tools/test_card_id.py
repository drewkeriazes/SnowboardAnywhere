"""Tests for card_id.py with a fake `gh` (no network). Standard library only.

    python -m unittest discover -s tools -p "test_*.py"

The fake serves each repo's issues in the order it holds them, `per_page` at a time, and can change that list
while a read is under way, the way a new issue does on GitHub (BUG-122).
"""
import io
import json
import os
import re
import subprocess
import sys
import unittest
from unittest import mock
from urllib.parse import parse_qs, urlsplit

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import card_id  # noqa: E402

GAME, MP = card_id.REPOS


def issue(number, title, state="open", pr=False):
    i = {"number": number, "title": title, "state": state}
    if pr:
        i["pull_request"] = {"url": "x"}
    return i


def many(n, title=lambda k: f"BUG-{k:03d}: card {k}"):
    """n issues numbered n down to 1 (newest first), each titled with its own id by default"""
    return [issue(k, title(k)) for k in range(n, 0, -1)]


class FakeGh:
    """Stands in for subprocess.run(["gh", "api", url]). `after_page(fake, repo, page)` runs after each page is
    served, so a test can change the listing between two pages of one read."""

    def __init__(self, repos, after_page=None, fail=()):
        self.repos = {r: list(v) for r, v in repos.items()}
        self.after_page = after_page
        self.fail = set(fail)
        self.calls = []
        self.served = {}  # repo -> numbers of every item served

    def __call__(self, cmd, **kw):
        self.calls.append((cmd, kw))
        assert cmd[:2] == ["gh", "api"], cmd
        url = cmd[2]
        repo = re.match(r"repos/([^/]+/[^/?]+)/issues", url)[1]
        q = parse_qs(urlsplit(url).query)
        page, per = int(q["page"][0]), int(q["per_page"][0])
        if repo in self.fail:
            return subprocess.CompletedProcess(cmd, 1, "", "HTTP 404: Not Found")
        items = self.repos.get(repo, [])[(page - 1) * per: page * per]
        self.served.setdefault(repo, set()).update(i["number"] for i in items)
        out = json.dumps(items, ensure_ascii=False)
        if self.after_page:
            self.after_page(self, repo, page)
        return subprocess.CompletedProcess(cmd, 0, out, "")

    def pages_read(self, repo):
        return sum(1 for cmd, _ in self.calls if f"repos/{repo}/issues" in cmd[2])


def run(fake, *args):
    """main() with the fake gh: (exit code, stdout, stderr)"""
    out = io.TextIOWrapper(io.BytesIO(), encoding="utf-8", newline="\n")  # main() reconfigures stdout, which StringIO can't
    err = io.StringIO()
    with mock.patch.object(card_id.subprocess, "run", fake), \
            mock.patch.object(sys, "argv", ["card_id.py", *args]), \
            mock.patch.object(sys, "stdout", out), mock.patch.object(sys, "stderr", err):
        code = card_id.main()
        out.flush()
        text = out.buffer.getvalue().decode("utf-8")
    return code, text, err.getvalue()


class PageShift(unittest.TestCase):
    """BUG-122: a listing that changes between the pages of one read"""

    def test_overlapping_page_is_not_a_self_duplicate(self):
        # A new issue lands at the front after page 1, so page 2 starts with the last issue of page 1 again.
        def new_issue(fake, repo, page):
            if repo == GAME and page == 1 and not any(i["number"] == 151 for i in fake.repos[GAME]):
                fake.repos[GAME].insert(0, issue(151, "BUG-151: filed mid-read"))

        code, out, err = run(FakeGh({GAME: many(150), MP: []}, after_page=new_issue))
        self.assertNotIn("duplicate", out)
        self.assertEqual(code, 0, out + err)
        self.assertIn("BUG-152", out)  # the issue filed mid-read counts too

    def test_skipped_issue_is_caught(self):
        # An issue leaves the front after page 1 (deleted, transferred), so the first issue page 2 should have
        # held moves up onto page 1, already read, and the read misses it. It holds the highest DATA id.
        listing = many(150, title=lambda k: "DATA-009: the newest DATA card" if k == 50 else f"BUG-{k:03d}: card")

        def drop_front(fake, repo, page):
            if repo == GAME and page == 1 and fake.repos[GAME][0]["number"] == 150:
                fake.repos[GAME].pop(0)

        code, out, err = run(FakeGh({GAME: listing, MP: []}, after_page=drop_front))
        self.assertIn("DATA-010", out, out + err)  # DATA-001 would hand out an id twice
        self.assertNotIn("duplicate", out)
        self.assertEqual(code, 0, out + err)

    def test_stable_listing_is_read_twice_and_no_more(self):
        fake = FakeGh({GAME: many(150), MP: many(3, title=lambda k: f"FEAT-{k:03d}: pipeline")})
        code, out, err = run(fake)
        self.assertEqual(code, 0, out + err)
        self.assertIn("next: FEAT-004, BUG-151, DATA-001", out)
        self.assertEqual(err, "")
        self.assertEqual(fake.pages_read(GAME), 4)  # pages 1 and 2, twice (page 2 is short, so the last)
        self.assertEqual(fake.pages_read(MP), 2)

    def test_listing_that_never_settles_warns_and_keeps_every_issue_seen(self):
        def new_issue_every_page(fake, repo, page):
            if repo == GAME:
                n = max(i["number"] for i in fake.repos[GAME]) + 1
                fake.repos[GAME].insert(0, issue(n, f"BUG-{n:03d}: filed mid-read"))

        fake = FakeGh({GAME: many(150), MP: []}, after_page=new_issue_every_page)
        code, out, err = run(fake)
        self.assertIn("kept changing", err)
        self.assertNotIn("duplicate", out)
        self.assertEqual(code, 0, out + err)
        self.assertIn(f"BUG-{max(fake.served[GAME]) + 1:03d}", out)  # every issue any read saw counts
        self.assertEqual(fake.pages_read(GAME), 2 * card_id.MAX_READS)  # bounded: MAX_READS reads of 2 pages


class Behaviour(unittest.TestCase):
    """What card_id.py did before BUG-122 and still does"""

    def test_twin_cards_are_not_duplicates(self):
        fake = FakeGh({GAME: [issue(5, "FEAT-222: move the pipeline")], MP: [issue(2, "FEAT-222: move the pipeline")]})
        code, out, _ = run(fake)
        self.assertEqual(code, 0)
        self.assertNotIn("duplicate", out)

    def test_two_cards_in_one_repo_sharing_an_id_are_reported(self):
        fake = FakeGh({GAME: [issue(9, "BUG-007: one"), issue(8, "BUG-007: two", state="closed")], MP: []})
        code, out, _ = run(fake)
        self.assertEqual(code, 1)
        self.assertIn("duplicate BUG-007: #8 (closed) BUG-007: two, #9 (open) BUG-007: one", out)

    def test_same_id_in_both_repos_with_different_titles_is_reported(self):
        fake = FakeGh({GAME: [issue(5, "BUG-030: game side")], MP: [issue(2, "BUG-030: pipeline side")]})
        code, out, _ = run(fake)
        self.assertEqual(code, 1)
        self.assertIn("MapPacker-SnowboardAnywhere#2", out)

    def test_pull_requests_are_skipped(self):
        fake = FakeGh({GAME: [issue(11, "FEAT-040: the PR", pr=True), issue(10, "FEAT-040: the card")], MP: []})
        code, out, _ = run(fake)
        self.assertEqual(code, 0)
        self.assertNotIn("duplicate", out)
        self.assertIn("FEAT-041", out)

    def test_unreadable_repo_fails(self):
        fake = FakeGh({GAME: [issue(1, "FEAT-001: a")], MP: []}, fail=[MP])
        code, out, err = run(fake)
        self.assertEqual(code, 2)
        self.assertEqual(out, "")
        self.assertIn("could not read", err)

    def test_allow_partial_reports_what_it_could_read(self):
        fake = FakeGh({GAME: [issue(1, "FEAT-001: a")], MP: []}, fail=[MP])
        code, out, err = run(fake, "--allow-partial", "FEAT")
        self.assertEqual(code, 0)
        self.assertEqual(out.strip(), "FEAT-002")
        self.assertIn("could not read", err)

    def test_type_argument_prints_just_the_id(self):
        fake = FakeGh({GAME: [issue(1, "BUG-041: a")], MP: [issue(1, "DATA-026: b")]})
        for arg, want in (("BUG", "BUG-042"), ("data", "DATA-027"), ("FEAT", "FEAT-001")):
            code, out, _ = run(fake, arg)
            self.assertEqual((code, out), (0, want + "\n"))

    def test_gh_output_is_decoded_as_utf8(self):
        # BUG-073: the console code page (cp1252) can't decode every title
        fake = FakeGh({GAME: [issue(1, "BUG-001: Atzmännig ✓ ≥ 2 m"), issue(2, "BUG-001: Atzmännig ✓ ≥ 2 m, again")], MP: []})
        code, out, _ = run(fake)
        self.assertEqual(code, 1)
        self.assertIn("Atzmännig ✓", out)
        self.assertTrue(all(kw.get("encoding") == "utf-8" for _, kw in fake.calls))


if __name__ == "__main__":
    unittest.main()
