"""Tests for Overheard Lite. Run from the repo root: python -m unittest discover -s lite/tests"""
from __future__ import annotations

import contextlib
import datetime as dt
import importlib.util
import io
import json
import tempfile
import unittest
from pathlib import Path

LITE = Path(__file__).resolve().parents[1]
KIT = LITE / "kit"
SCRIPT = KIT / ".agents" / "skills" / "overheard" / "scripts" / "overheard.py"
FIXTURES = LITE.parent / "src" / "server" / "logic" / "__fixtures__" / "finalize-run"

spec = importlib.util.spec_from_file_location("overheard", SCRIPT)
oh = importlib.util.module_from_spec(spec)
spec.loader.exec_module(oh)

SETUP = {
    "assistant": "claude",
    "brand": {"name": "Acme Analytics", "other_names": ["Acme"], "domains": ["example.com"]},
    "competitors": [
        {"name": "Northwind Metrics", "domains": ["northwind.example.com"]},
        {"name": "Contoso Insights"},
    ],
    "questions": [
        {"id": "q01", "text": "What are the best analytics tools for a small team?"},
        {"id": "q02", "text": "Is Acme Analytics any good?"},
        {"id": "q03", "text": "Which search platform should a retailer pick?"},
    ],
    "repeats": 2,
}


def run_cli(*args: str) -> tuple[int, str]:
    out = io.StringIO()
    with contextlib.redirect_stdout(out):
        code = oh.main(list(args))
    return code, out.getvalue()


def answer(folder: Path, run: str, job: str, text: str, brands=None, fmt="ranked_list", failed=None) -> None:
    run_dir = folder / "runs" / run
    run_dir.mkdir(parents=True, exist_ok=True)
    if failed:
        (run_dir / f"{job}.failed.txt").write_text(failed, encoding="utf-8")
        return
    (run_dir / f"{job}.md").write_text(text, encoding="utf-8")
    if brands is not None:
        reading = {"format": fmt, "brands": [{"name": n, "position": p} for n, p in brands]}
        (run_dir / f"{job}.json").write_text(json.dumps(reading), encoding="utf-8")


def make_folder(tmp: str) -> Path:
    folder = Path(tmp)
    (folder / "overheard.json").write_text(json.dumps(SETUP), encoding="utf-8")
    return folder


def write_run(folder: Path, name: str) -> None:
    run = {
        "date": name,
        "assistant": "claude",
        "model": "sonnet",
        "questions": SETUP["questions"],
        "repeats": 2,
        "perception_question": oh.PERCEPTION_QUESTION.format(brand="Acme Analytics"),
    }
    (folder / "runs" / name).mkdir(parents=True, exist_ok=True)
    oh.write_json(folder / "runs" / name / "run.json", run)


def two_runs(folder: Path) -> None:
    """Two runs whose numbers are worked out by hand in the tests below."""
    write_run(folder, "2026-10-01")
    answer(folder, "2026-10-01", "q01-1",
           "1. Northwind Metrics\n2. Acme Analytics https://www.example.com/pricing\n3. Globex Search\n"
           "Sources: https://reviews.example.invalid/x",
           [("Northwind Metrics", 1), ("Acme Analytics", 2), ("Globex Search", 3)])
    answer(folder, "2026-10-01", "q01-2", "Northwind Metrics or Contoso Insights. https://northwind.example.com/",
           [("Northwind Metrics", None), ("Contoso Insights", None)], fmt="unranked_list")
    for job in ("q02-1", "q02-2"):
        answer(folder, "2026-10-01", job, "Acme Analytics is fine. https://example.com/", [("Acme Analytics", None)], fmt="prose")
    answer(folder, "2026-10-01", "q03-1", "I can't recommend one. https://news.example.invalid/", [], fmt="refusal")
    answer(folder, "2026-10-01", "q03-2", "It depends on your catalogue. https://news.example.invalid/", [], fmt="prose")
    answer(folder, "2026-10-01", "perception", "Acme Analytics makes dashboards. https://example.com/about", None)
    perception = {"knows_brand": True, "what_it_does": "Dashboards.", "typical_customers": "",
                  "well_regarded_for": "Speed.", "downsides": "Price."}
    oh.write_json(folder / "runs" / "2026-10-01" / "perception.json", perception)

    write_run(folder, "2026-10-08")
    answer(folder, "2026-10-08", "q01-1", "1. Acme Analytics https://example.com/\n2. Northwind Metrics",
           [("Acme Analytics", 1), ("Northwind Metrics", 2)])
    answer(folder, "2026-10-08", "q01-2", "", failed="Plan limit reached after one retry.")
    answer(folder, "2026-10-08", "q02-1", "", failed="Plan limit reached after one retry.")
    answer(folder, "2026-10-08", "q02-2", "", failed="Plan limit reached after one retry.")
    answer(folder, "2026-10-08", "q03-1", "Acme handles this well. https://blog.example.com/post",
           [("Acme", None)], fmt="prose")


class Matching(unittest.TestCase):
    """Cases ported from src/lib/brand-matching.test.ts."""

    def test_names_fold_the_way_the_app_folds_them(self):
        self.assertEqual(oh.normalize_name("Contoso (by Acme Analytics)"), oh.normalize_name("Contoso"))
        self.assertEqual(oh.normalize_name("Acme Ltd."), oh.normalize_name("Acme"))
        self.assertEqual(oh.normalize_name("Acme GmbH"), oh.normalize_name("Acme"))
        self.assertEqual(oh.normalize_name("Globex’s"), oh.normalize_name("Globex's"))
        self.assertEqual(oh.normalize_name("Incentive"), "incentive")
        self.assertNotEqual(oh.normalize_name("Globex Search"), oh.normalize_name("Search"))
        self.assertEqual(oh.normalize_name("()"), "")

    def test_hosts_match_at_a_label_boundary(self):
        self.assertTrue(oh.host_matches("blog.acme.co.uk", "acme.co.uk"))
        self.assertTrue(oh.host_matches("acme.com", "www.ACME.com"))
        self.assertFalse(oh.host_matches("notacme.com", "acme.com"))
        self.assertFalse(oh.host_matches("someblog.co.uk", "acme.co.uk"))
        self.assertEqual(oh.link_host("https://WWW.Example.com/x"), "example.com")
        self.assertIsNone(oh.link_host("javascript:alert(1)"))

    def test_a_question_naming_your_brand_is_self_referenced(self):
        self.assertTrue(oh.is_self_referenced("Is Acme Inc any good?", ["Acme Analytics", "Acme"]))
        self.assertFalse(oh.is_self_referenced("Best tools for acmes?", ["Acme"]))

    def test_urls_are_read_from_markdown_and_prose(self):
        text = "See [the guide](https://example.com/a). Also **https://example.org/b**, and https://example.net/c."
        self.assertEqual(oh.answer_urls(text), ["https://example.com/a", "https://example.org/b", "https://example.net/c"])


@unittest.skipUnless(FIXTURES.is_dir(), "the app's finalize-run fixtures sit outside this folder")
class ParityWithTheApp(unittest.TestCase):
    """score() against the numbers the app's reference implementation wrote."""

    def scored(self, data):
        tasks = [t for t in data["input"]["run_tasks"] if t["status"] == "done" and not t["is_perception"]]
        observations = data["input"]["brand_observations"]
        answers = [
            {
                "scope": f"{t['model_id']}|{t['prompt_id']}",
                "observations": [
                    (o["brand_id"], o["position"], o["is_cited"])
                    for o in observations
                    if o["run_task_id"] == t["id"] and o["brand_id"]
                ],
            }
            for t in tasks
        ]
        return oh.score(answers)

    def test_every_fixture(self):
        paths = sorted(FIXTURES.glob("*.json"))
        self.assertGreater(len(paths), 5)
        for path in paths:
            data = json.loads(path.read_text(encoding="utf-8"))
            scopes, totals = self.scored(data)
            rows = [r for r in data["expected"]["run_metrics"] if r["model_id"] is not None]
            with self.subTest(fixture=path.name):
                got = {(s, b) for s, scope in scopes.items() for b in scope["brands"]}
                self.assertEqual(got, {(f"{r['model_id']}|{r['prompt_id']}", r["brand_id"]) for r in rows})
                for r in rows:
                    scope = scopes[f"{r['model_id']}|{r['prompt_id']}"]
                    counts = scope["brands"][r["brand_id"]]
                    all_mentions = sum(c["mentions"] for c in scope["brands"].values())
                    got_rates = oh.rates(counts, scope["answers"], all_mentions)
                    self.assertEqual(scope["answers"], r["answers"])
                    for key in ("mentions", "ranked", "citations"):
                        self.assertEqual(counts[key], r[key], key)
                    for key in ("mention_rate", "top3_rate", "top_pick_share", "citation_rate", "share_of_voice"):
                        self.assertAlmostEqual(got_rates[key], float(r[key]), places=4, msg=key)
                self.assert_dashboard_totals(rows, totals)

    def assert_dashboard_totals(self, rows, totals):
        """The app's aggregate() over level 0 rows, which is what its dashboard shows."""
        scopes = {(r["model_id"], r["prompt_id"]): r["answers"] for r in rows}
        answers, all_mentions = sum(scopes.values()), sum(r["mentions"] for r in rows)
        for brand in {r["brand_id"] for r in rows}:
            mine = [r for r in rows if r["brand_id"] == brand]
            mentions = sum(r["mentions"] for r in mine)
            top3 = sum(round(float(r["top3_rate"]) * r["answers"]) for r in mine)
            self.assertAlmostEqual(totals[brand]["mention_rate"], mentions / answers, places=4)
            self.assertAlmostEqual(totals[brand]["top3_rate"], top3 / answers, places=4)
            self.assertAlmostEqual(totals[brand]["share_of_voice"], mentions / all_mentions, places=4)


class Folder(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.folder = make_folder(self.tmp.name)

    def tearDown(self):
        self.tmp.cleanup()

    def test_setup_check_names_each_problem(self):
        bad = dict(SETUP, assistant="", repeats=0, questions=[{"id": "q1", "text": ""}])
        bad["brand"] = {"name": "Acme Analytics", "domains": ["acme"]}
        (self.folder / "overheard.json").write_text(json.dumps(bad), encoding="utf-8")
        code, out = run_cli("--folder", str(self.folder), "setup-check")
        self.assertEqual(code, 1)
        for words in ("assistant: must be one of", "'acme' isn't a website domain", "needs a unique id", "needs text", "repeats:"):
            self.assertIn(words, out)

    def test_setup_check_notes_a_question_that_names_your_brand(self):
        code, out = run_cli("--folder", str(self.folder), "setup-check")
        self.assertEqual(code, 0)
        self.assertIn("note: q02 names your brand", out)
        self.assertIn("Each run asks 7 questions", out)

    def test_start_lists_the_jobs_and_resumes(self):
        code, out = run_cli("--folder", str(self.folder), "start", "--assistant", "claude", "--model", "sonnet")
        self.assertEqual(code, 0)
        today = dt.date.today().isoformat()
        self.assertIn(f"Run folder: runs/{today} (new). 7 answers to collect.", out)
        self.assertIn(f"[q03-2] save to {(self.folder / 'runs' / today / 'q03-2.md').resolve()}", out)
        self.assertIn("What do you know about Acme Analytics?", out)
        run = json.loads((self.folder / "runs" / today / "run.json").read_text(encoding="utf-8"))
        self.assertEqual((run["assistant"], run["model"], run["repeats"]), ("claude", "sonnet", 2))
        answer(self.folder, today, "q01-1", "An answer. https://example.com/")
        answer(self.folder, today, "q01-2", "", failed="no sources after a retry")
        code, out = run_cli("--folder", str(self.folder), "start", "--assistant", "claude")
        self.assertIn("(resumed). 5 answers to collect.", out)
        self.assertNotIn("[q01-1]", out)

    def test_start_refuses_the_other_assistant(self):
        code, out = run_cli("--folder", str(self.folder), "start", "--assistant", "chatgpt")
        self.assertEqual(code, 2)
        self.assertIn("This folder measures Claude", out)

    def test_check_lists_what_the_run_still_needs(self):
        two_runs(self.folder)
        answer(self.folder, "2026-10-08", "q03-2", "Contoso Insights and Northwind Metrics, no links.", [("Contoso Insights", None)])
        code, out = run_cli("--folder", str(self.folder), "check")
        self.assertEqual(code, 1)
        self.assertIn("problem: q03-2.md shows no sources", out)
        self.assertIn("problem: perception: no answer yet. Ask it.", out)
        self.assertIn("Run 2026-10-08: 2 of 7 done, 3 failed, 2 problems.", out)
        code, out = run_cli("--folder", str(self.folder), "check", "--run", "2026-10-01")
        self.assertEqual(code, 0)
        self.assertIn("7 of 7 done, 0 failed, 0 problems", out)

    def test_check_flags_a_reading_that_missed_a_tracked_brand(self):
        two_runs(self.folder)
        answer(self.folder, "2026-10-08", "q03-1", "Acme handles this. Northwind Metrics too. https://example.com/", [("Acme", None)], fmt="prose")
        answer(self.folder, "2026-10-08", "q01-1", "1. Acme Analytics https://example.com/", [("Acme Analytics", 1), ("Contoso Insights", 2)])
        _, out = run_cli("--folder", str(self.folder), "check")
        self.assertIn("note: q03-1: the answer names Northwind Metrics, but the reading doesn't list it.", out)
        self.assertIn("note: q01-1: the reading lists Contoso Insights, but the answer doesn't seem to name it.", out)
        self.assertNotIn("q01-1: the reading lists Acme", out)

    def test_check_refuses_a_broken_reading(self):
        two_runs(self.folder)
        (self.folder / "runs" / "2026-10-08" / "q01-1.json").write_text('{"format": "list", "brands": []}', encoding="utf-8")
        _, out = run_cli("--folder", str(self.folder), "check")
        self.assertIn('problem: q01-1.json needs "format": one of ranked_list', out)

    def test_scores_follow_the_rules(self):
        two_runs(self.folder)
        setup = oh.require_setup(self.folder)
        first, second = [oh.summarize_run(d, r, setup) for d, r in oh.list_runs(self.folder)]
        # Run 1: q02 names the brand and q03 names no brand, so only q01's two answers count.
        self.assertEqual(first["answers"], 2)
        acme, north = first["totals"]["Acme Analytics"], first["totals"]["Northwind Metrics"]
        self.assertEqual((acme["mention_rate"], acme["top3_rate"], acme["citation_rate"]), (0.5, 0.5, 0.5))
        self.assertEqual((north["mention_rate"], north["top_pick_share"], north["citation_rate"]), (1.0, 0.5, 0.5))
        self.assertAlmostEqual(acme["share_of_voice"], 0.2)
        self.assertEqual(first["labels"]["~globex search"], "Globex Search")
        # Run 2: one q01 answer failed, and q03-1 names Acme by its other name, linked on a subdomain.
        self.assertEqual(second["answers"], 2)
        acme = second["totals"]["Acme Analytics"]
        self.assertEqual((acme["mention_rate"], acme["top3_rate"], acme["citation_rate"]), (1.0, 0.5, 1.0))
        self.assertAlmostEqual(acme["share_of_voice"], 2 / 3)

    def test_build_writes_the_dashboard_and_a_summary(self):
        two_runs(self.folder)
        code, out = run_cli("--folder", str(self.folder), "build")
        self.assertEqual(code, 0)
        self.assertIn("Acme Analytics: named in 100% (+50 points since 2026-10-01), top 3 in 50%, linked in 100%.", out)
        self.assertIn("Competitors: Northwind Metrics 50%", out)
        self.assertIn("Problems:\n- q03-2: no answer yet. Ask it.\n- perception: no answer yet. Ask it.", out)
        page = (self.folder / "dashboard.html").read_text(encoding="utf-8")
        self.assertIn("<h1>What Claude says about Acme Analytics</h1>", page)
        self.assertIn("Not counted: it names your brand.", page)
        self.assertIn("Named you at #1, with a link to your site", page)
        self.assertIn("+50 points since 2026-10-01", page)
        self.assertIn("<polyline", page)
        self.assertEqual(run_cli("--folder", str(self.folder), "build")[0], 0)
        self.assertEqual((self.folder / "dashboard.html").read_text(encoding="utf-8"), page)

    def test_build_escapes_what_answers_say(self):
        two_runs(self.folder)
        answer(self.folder, "2026-10-08", "q03-2", "<script>alert(1)</script> https://example.com/", [("<b>Bold</b>", None)])
        run_cli("--folder", str(self.folder), "build")
        page = (self.folder / "dashboard.html").read_text(encoding="utf-8")
        self.assertNotIn("<script>alert", page)
        self.assertIn("&lt;b&gt;Bold&lt;/b&gt;", page)

    def test_build_with_no_runs(self):
        code, out = run_cli("--folder", str(self.folder), "build")
        self.assertEqual(code, 0)
        self.assertIn("No runs yet.", out)


class Kit(unittest.TestCase):
    """The kit ships each file twice, once per app. The copies must not drift."""

    def test_both_skill_copies_match(self):
        codex, claude = KIT / ".agents" / "skills" / "overheard", KIT / ".claude" / "skills" / "overheard"
        files = sorted(p.relative_to(codex) for p in codex.rglob("*") if p.is_file() and "__pycache__" not in p.parts)
        self.assertEqual(files, sorted(p.relative_to(claude) for p in claude.rglob("*") if p.is_file() and "__pycache__" not in p.parts))
        for rel in files:
            self.assertEqual((codex / rel).read_bytes(), (claude / rel).read_bytes(), str(rel))

    def test_both_helper_agents_carry_the_asker_instructions(self):
        asker = (KIT / ".agents" / "skills" / "overheard" / "references" / "asker.md").read_text(encoding="utf-8")
        body = asker.split("<!-- instructions -->", 1)[1].strip()
        self.assertIn(body, (KIT / ".claude" / "agents" / "overheard-asker.md").read_text(encoding="utf-8"))
        self.assertIn(body, (KIT / ".codex" / "agents" / "overheard_asker.toml").read_text(encoding="utf-8"))


if __name__ == "__main__":
    unittest.main()
