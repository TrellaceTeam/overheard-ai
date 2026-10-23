#!/usr/bin/env python3
"""Overheard Lite: start a run, check it, and build the dashboard.

Run it from the folder that holds overheard.json. Standard library only,
Python 3.9 or later.

  python overheard.py setup-check
  python overheard.py start --assistant claude --model sonnet
  python overheard.py check
  python overheard.py retry q01-2
  python overheard.py build --open

The counting rules follow Overheard AI's finalize_run and lib/metrics.ts, and
the tests run the app's own fixtures through score().
"""
from __future__ import annotations

import argparse
import datetime as dt
import html
import json
import re
import sys
import webbrowser
from pathlib import Path
from urllib.parse import urlparse

SETUP_FILE = "overheard.json"
DASHBOARD_FILE = "dashboard.html"
ASSISTANTS = {"claude": "Claude", "chatgpt": "ChatGPT"}
FORMATS = ("ranked_list", "unranked_list", "prose", "refusal")
PERCEPTION_FIELDS = (
    ("what_it_does", "What it does"),
    ("typical_customers", "Typical customers"),
    ("well_regarded_for", "Well regarded for"),
    ("downsides", "Downsides"),
)
# The app's perception template (src/lib/perception.ts), word for word.
PERCEPTION_QUESTION = (
    "What do you know about {brand}?\n\n"
    "Please cover, in order: what {brand} does; who its typical customers are, including "
    "their size and the industries they work in; what it is well regarded for; and what "
    "criticisms, weaknesses or common complaints come up, with specifics rather than "
    "generalities.\n\n"
    "If you are not familiar with {brand}, say so plainly instead of guessing."
)
QUESTION_ID = re.compile(r"^q\d{2,3}$")
URL = re.compile(r"https?://[^\s<>()\[\]{}\"'`|]+")


class SetupError(Exception):
    pass


# ---------------------------------------------------------------- matching
# Ports of src/lib/brand-matching.ts and src/lib/selfReference.ts, so a brand
# and a question are recognised the same way in both products.

LEGAL = re.compile(r"\b(inc|llc|ltd|limited|gmbh|corp|corporation|co|plc|sa|bv|ag)\b", re.ASCII)
PUNCTUATION = re.compile("[.,'‘’\"“”`]")


def normalize_name(name: str) -> str:
    text = re.sub(r"\([^)]*\)", " ", name).lower()
    text = PUNCTUATION.sub(" ", text)
    text = LEGAL.sub(" ", text)
    return re.sub(r"[^a-z0-9]+", " ", text).strip()


def normalize_domain(domain: str) -> str:
    text = domain.strip().lower()
    text = re.sub(r"^https?://", "", text)
    text = re.sub(r"^www\.", "", text)
    return re.sub(r"[/?#].*$", "", text)


def is_plausible_domain(value: str) -> bool:
    labels = normalize_domain(value).split(".")
    if len(labels) < 2 or any(not re.fullmatch(r"[a-z0-9]([a-z0-9-]*[a-z0-9])?", x) for x in labels):
        return False
    return re.fullmatch(r"[a-z]{2,}", labels[-1]) is not None


def link_host(url: str) -> str | None:
    try:
        parts = urlparse(url)
    except ValueError:
        return None
    if parts.scheme not in ("http", "https") or not parts.hostname:
        return None
    return re.sub(r"^www\.", "", parts.hostname.lower()) or None


def host_matches(host: str, domain: str) -> bool:
    d = normalize_domain(domain)
    return bool(d) and (host == d or host.endswith("." + d))


def is_self_referenced(text: str, names: list[str]) -> bool:
    haystack = f" {normalize_name(text)} "
    needles = [normalize_name(n) for n in names]
    return any(len(n) >= 3 and f" {n} " in haystack for n in needles)


def answer_urls(text: str) -> list[str]:
    return [u.rstrip(".,;:!?*_") for u in URL.findall(text)]


# ------------------------------------------------------------------ setup


def read_json(path: Path):
    return json.loads(path.read_text(encoding="utf-8-sig"))


def write_json(path: Path, data) -> None:
    path.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")


def text_list(value, where: str, problems: list[str]) -> list[str]:
    if value is None:
        return []
    if not isinstance(value, list):
        problems.append(f"{where}: must be a list, such as [\"one\", \"two\"].")
        return []
    return [str(v).strip() for v in value if str(v).strip()]


def brand_entry(raw, where: str, problems: list[str]) -> dict:
    if not isinstance(raw, dict) or not str(raw.get("name", "")).strip():
        problems.append(f"{where}: needs a name.")
        return {"name": "", "other_names": [], "domains": []}
    entry = {
        "name": str(raw["name"]).strip(),
        "other_names": text_list(raw.get("other_names"), f"{where}.other_names", problems),
        "domains": [normalize_domain(d) for d in text_list(raw.get("domains"), f"{where}.domains", problems)],
    }
    for domain in entry["domains"]:
        if not is_plausible_domain(domain):
            problems.append(f"{where}: '{domain}' isn't a website domain, such as example.com.")
    return entry


def load_setup(folder: Path) -> tuple[dict, list[str]]:
    path = folder / SETUP_FILE
    if not path.exists():
        raise SetupError(f"No {SETUP_FILE} in {folder}. Run setup first, or run this from the Overheard folder.")
    try:
        raw = read_json(path)
    except ValueError as error:
        raise SetupError(f"{SETUP_FILE} isn't valid JSON: {error}") from error
    problems: list[str] = []
    assistant = str(raw.get("assistant", "")).lower()
    if assistant not in ASSISTANTS:
        problems.append(f"assistant: must be one of {', '.join(ASSISTANTS)}.")
    brand = brand_entry(raw.get("brand"), "brand", problems)
    if brand["name"] and not brand["domains"]:
        problems.append("brand: needs at least one domain, such as example.com, to count links.")
    competitors = [brand_entry(c, f"competitors[{i}]", problems) for i, c in enumerate(raw.get("competitors") or [])]
    questions, seen = [], set()
    for i, q in enumerate(raw.get("questions") or []):
        q = q if isinstance(q, dict) else {}
        qid, text = str(q.get("id", "")), str(q.get("text", "")).strip()
        if not QUESTION_ID.match(qid) or qid in seen:
            problems.append(f"questions[{i}]: needs a unique id such as q01.")
        if not text:
            problems.append(f"questions[{i}]: needs text.")
        seen.add(qid)
        questions.append({"id": qid, "text": text})
    if not questions:
        problems.append("questions: add at least one buyer question.")
    repeats = raw.get("repeats", 2)
    if not isinstance(repeats, int) or not 1 <= repeats <= 10:
        problems.append("repeats: must be a whole number from 1 to 10.")
    setup = {
        "assistant": assistant,
        "brand": brand,
        "competitors": competitors,
        "questions": questions,
        "repeats": repeats,
        "perception": raw.get("perception", True) is not False,
    }
    return setup, problems


def own_names(setup: dict) -> list[str]:
    return [setup["brand"]["name"], *setup["brand"]["other_names"]]


def setup_notes(setup: dict) -> list[str]:
    return [
        f"{q['id']} names your brand, so its answers are kept but never counted."
        for q in setup["questions"]
        if is_self_referenced(q["text"], own_names(setup))
    ]


def require_setup(folder: Path) -> dict:
    setup, problems = load_setup(folder)
    if problems:
        raise SetupError(f"{SETUP_FILE} has problems:\n" + "\n".join(f"- {p}" for p in problems))
    return setup


# ------------------------------------------------------------------- runs


def run_jobs(run: dict) -> list[dict]:
    jobs = [
        {"id": f"{q['id']}-{r}", "question_id": q["id"], "repeat": r, "text": q["text"]}
        for q in run["questions"]
        for r in range(1, run["repeats"] + 1)
    ]
    if run.get("perception_question"):
        jobs.append({"id": "perception", "question_id": None, "repeat": None, "text": run["perception_question"]})
    return jobs


def list_runs(folder: Path) -> list[tuple[Path, dict]]:
    runs, root = [], folder / "runs"
    for run_dir in sorted(p for p in (root.iterdir() if root.is_dir() else []) if p.is_dir()):
        try:
            runs.append((run_dir, read_json(run_dir / "run.json")))
        except (OSError, ValueError):
            print(f"note: skipped {run_dir.name}, its run.json is missing or broken.")
    return runs


def cmd_start(folder: Path, args) -> int:
    setup = require_setup(folder)
    if args.assistant.lower() != setup["assistant"]:
        raise SetupError(
            f"This folder measures {ASSISTANTS[setup['assistant']]}. "
            "Make a second folder to measure another assistant."
        )
    run_dir = folder / "runs" / dt.date.today().isoformat()
    run_file = run_dir / "run.json"
    if run_file.exists():
        run, state = read_json(run_file), "resumed"
    else:
        run_dir.mkdir(parents=True, exist_ok=True)
        run = {
            "date": run_dir.name,
            "started": dt.datetime.now().isoformat(timespec="seconds"),
            "assistant": setup["assistant"],
            "model": args.model or "",
            "questions": setup["questions"],
            "repeats": setup["repeats"],
            "perception_question": PERCEPTION_QUESTION.format(brand=setup["brand"]["name"])
            if setup["perception"]
            else "",
        }
        write_json(run_file, run)
        state = "new"
    todo = [
        j
        for j in run_jobs(run)
        if not (run_dir / f"{j['id']}.md").exists() and not (run_dir / f"{j['id']}.failed.txt").exists()
    ]
    print(f"Run folder: runs/{run_dir.name} ({state}). {len(todo)} answers to collect.")
    print("Ask each one in its own fresh helper. Give the helper only the question and the path.\n")
    for job in todo:
        print_job(run_dir, job)
    return 0


def print_job(run_dir: Path, job: dict) -> None:
    print(f"[{job['id']}] save to {run_dir.resolve() / (job['id'] + '.md')}\n{job['text']}\n")


# ------------------------------------------------------------------ check


def read_reading(path: Path) -> tuple[dict | None, str | None]:
    try:
        data = read_json(path)
    except ValueError as error:
        return None, f"isn't valid JSON ({error})"
    if not isinstance(data, dict) or data.get("format") not in FORMATS:
        return None, f"needs \"format\": one of {', '.join(FORMATS)}"
    brands = data.get("brands")
    if not isinstance(brands, list):
        return None, 'needs "brands": a list, empty when no brand is named'
    for i, b in enumerate(brands):
        if not isinstance(b, dict) or not str(b.get("name", "")).strip():
            return None, f"brands[{i}] needs a name"
        position = b.get("position")
        if position is not None and (not isinstance(position, int) or isinstance(position, bool) or position < 1):
            return None, f"brands[{i}].position must be a whole number from 1, or null"
    return data, None


def read_perception(path: Path) -> tuple[dict | None, str | None]:
    try:
        data = read_json(path)
    except ValueError as error:
        return None, f"isn't valid JSON ({error})"
    if not isinstance(data, dict) or not isinstance(data.get("knows_brand"), bool):
        return None, 'needs "knows_brand": true or false'
    for key, _ in PERCEPTION_FIELDS:
        if not isinstance(data.get(key, ""), str):
            return None, f'"{key}" must be text'
    return data, None


def job_state(run_dir: Path, job: dict) -> dict:
    """What one job left on disk, and every problem the agent must fix."""
    base = run_dir / job["id"]
    md, failed = base.with_suffix(".md"), Path(f"{base}.failed.txt")
    state = {"job": job, "status": "missing", "answer": "", "urls": [], "reading": None, "problems": []}
    if failed.exists():
        state["status"], state["reason"] = "failed", failed.read_text(encoding="utf-8-sig").strip()
        return state
    if not md.exists():
        state["problems"].append(f"{job['id']}: no answer yet. Ask it.")
        return state
    state["answer"] = md.read_text(encoding="utf-8-sig")
    state["urls"] = answer_urls(state["answer"])
    if not state["answer"].strip():
        state["status"] = "empty"
        state["problems"].append(f"{job['id']}.md is empty. Run retry {job['id']} and ask it again.")
        return state
    if not state["urls"]:
        state["status"] = "no_sources"
        state["problems"].append(
            f"{job['id']}.md shows no sources, so it may not have searched. Run retry {job['id']} and ask it "
            f"again once. If the new answer still has none, write the reason to {job['id']}.failed.txt."
        )
        return state
    reader = read_perception if job["id"] == "perception" else read_reading
    reading_path = base.with_suffix(".json")
    if not reading_path.exists():
        state["status"] = "unread"
        state["problems"].append(f"{job['id']}: not read yet. Write {job['id']}.json.")
        return state
    state["reading"], error = reader(reading_path)
    if error:
        state["status"] = "bad_reading"
        state["problems"].append(f"{job['id']}.json {error}.")
        return state
    state["status"] = "done"
    return state


def reading_notes(state: dict, setup: dict) -> list[str]:
    """Tracked brands the answer names that the reading left out, and the reverse."""
    if state["status"] != "done" or state["job"]["id"] == "perception":
        return []
    text, folded = state["answer"], f" {normalize_name(state['answer'])} "
    listed = {normalize_name(b["name"]) for b in state["reading"]["brands"]}
    notes = []
    for brand in [setup["brand"], *setup["competitors"]]:
        names = [brand["name"], *brand["other_names"]]
        keys = {normalize_name(n) for n in names} - {""}
        in_text = any(re.search(rf"(?<!\w){re.escape(n)}(?!\w)", text) for n in names)
        if in_text and not keys & listed:
            notes.append(f"{state['job']['id']}: the answer names {brand['name']}, but the reading doesn't list it.")
        if keys & listed and not any(f" {k} " in folded for k in keys):
            notes.append(f"{state['job']['id']}: the reading lists {brand['name']}, but the answer doesn't seem to name it.")
    return notes


def cmd_check(folder: Path, args) -> int:
    setup = require_setup(folder)
    runs = list_runs(folder)
    if args.run:
        runs = [r for r in runs if r[0].name == args.run]
    if not runs:
        print("No run to check. Start one with: overheard.py start")
        return 1
    run_dir, run = runs[-1]
    states = [job_state(run_dir, j) for j in run_jobs(run)]
    problems = [p for s in states for p in s["problems"]]
    notes = [n for s in states for n in reading_notes(s, setup)]
    for problem in problems:
        print(f"problem: {problem}")
    for note in notes:
        print(f"note: {note} Read the answer again and fix the reading if it's wrong.")
    done = sum(s["status"] == "done" for s in states)
    failed = sum(s["status"] == "failed" for s in states)
    print(f"Run {run_dir.name}: {done} of {len(states)} done, {failed} failed, {len(problems)} problems.")
    return 1 if problems else 0


# ------------------------------------------------------------------ score


def score(answers: list[dict]) -> tuple[dict, dict]:
    """Scope rows and run totals from counted answers.

    Each answer is {"scope": str, "observations": [(brand, position, cited)]}.
    An answer counts one mention per brand however often it names it, with
    the best position and any citation. A scope where no answer named a brand
    adds nothing to the totals' denominator, as in the app's dashboard.
    """
    scopes: dict[str, dict] = {}
    for answer in answers:
        scope = scopes.setdefault(answer["scope"], {"answers": 0, "brands": {}})
        scope["answers"] += 1
        folded: dict[str, dict] = {}
        for brand, position, cited in answer["observations"]:
            row = folded.setdefault(brand, {"pos": None, "cited": False})
            if position is not None:
                row["pos"] = position if row["pos"] is None else min(row["pos"], position)
            row["cited"] = row["cited"] or bool(cited)
        for brand, row in folded.items():
            counts = scope["brands"].setdefault(
                brand, {"mentions": 0, "ranked": 0, "citations": 0, "tops": 0, "top3": 0}
            )
            counts["mentions"] += 1
            counts["citations"] += row["cited"]
            if row["pos"] is not None:
                counts["ranked"] += 1
                counts["tops"] += row["pos"] == 1
                counts["top3"] += row["pos"] <= 3
    totals: dict[str, dict] = {}
    denominator = sum(s["answers"] for s in scopes.values() if s["brands"])
    all_mentions = sum(c["mentions"] for s in scopes.values() for c in s["brands"].values())
    for scope in scopes.values():
        for brand, counts in scope["brands"].items():
            total = totals.setdefault(brand, {k: 0 for k in counts})
            for key, value in counts.items():
                total[key] += value
    for total in totals.values():
        total.update(rates(total, denominator, all_mentions))
    return scopes, totals


def rates(counts: dict, answers: int, all_mentions: int) -> dict:
    def div(a, b):
        return a / b if b else None

    return {
        "answers": answers,
        "mention_rate": div(counts["mentions"], answers),
        "top3_rate": div(counts["top3"], answers),
        "top_pick_share": div(counts["tops"], answers),
        "citation_rate": div(counts["citations"], answers),
        "share_of_voice": div(counts["mentions"], all_mentions),
    }


def resolver(setup: dict):
    tracked = [setup["brand"], *setup["competitors"]]

    def resolve(raw_name: str) -> tuple[str, dict | None]:
        lowered, norm = raw_name.strip().lower(), normalize_name(raw_name)
        for brand in tracked:
            if any(n.lower() == lowered for n in [brand["name"], *brand["other_names"]]):
                return brand["name"], brand
        for brand in tracked:
            if norm and any(normalize_name(n) == norm for n in [brand["name"], *brand["other_names"]]):
                return brand["name"], brand
        return "~" + (norm or lowered), None

    return resolve


def summarize_run(run_dir: Path, run: dict, setup: dict) -> dict:
    resolve = resolver(setup)
    labels: dict[str, str] = {}
    counted, rows = [], []
    states = [job_state(run_dir, j) for j in run_jobs(run)]
    for state in states:
        job = state["job"]
        if job["id"] == "perception":
            continue
        row = {"state": state, "named": [], "counted": False}
        self_referenced = is_self_referenced(job["text"], own_names(setup))
        if self_referenced:
            row["excluded"] = "it names your brand"
        rows.append(row)
        if state["status"] != "done":
            continue
        hosts = [h for h in (link_host(u) for u in state["urls"]) if h]
        observations = []
        for b in state["reading"]["brands"]:
            key, brand = resolve(str(b["name"]))
            labels.setdefault(key, brand["name"] if brand else str(b["name"]).strip())
            cited = bool(brand) and any(host_matches(h, d) for h in hosts for d in brand["domains"])
            observations.append((key, b.get("position"), cited))
            row["named"].append((key, b.get("position"), cited))
        if self_referenced:
            continue
        row["counted"] = True
        counted.append({"scope": job["question_id"], "observations": observations})
    scopes, totals = score(counted)
    for row in rows:
        scope = scopes.get(row["state"]["job"]["question_id"])
        if row["counted"] and scope and not scope["brands"]:
            row["excluded"] = "no answer to this question named any brand"
    perception = next((s for s in states if s["job"]["id"] == "perception"), None)
    return {
        "dir": run_dir,
        "run": run,
        "rows": rows,
        "totals": totals,
        "labels": labels,
        "answers": next(iter(totals.values()))["answers"] if totals else 0,
        "planned": len(rows),
        "problems": [p for s in states for p in s["problems"]],
        "failed": [s for s in states if s["status"] == "failed"],
        "perception": perception,
    }


# ------------------------------------------------------------------ build


def pct(value) -> str:
    return "n/a" if value is None else f"{round(value * 100)}%"


def plural(count: int, noun: str) -> str:
    return f"{count} {noun}{'' if count == 1 else 's'}"


def model_label(run: dict) -> str:
    name = ASSISTANTS.get(run.get("assistant", ""), run.get("assistant", ""))
    return f"{name} ({run['model']})" if run.get("model") else name


def build_summary(setup: dict, summaries: list[dict], path: Path) -> str:
    own = setup["brand"]["name"]
    lines = [f"Built {path.name} from {plural(len(summaries), 'run')}."]
    if not summaries:
        return "\n".join(lines + ["No runs yet."])
    latest = summaries[-1]
    collected = sum(r["state"]["status"] == "done" for r in latest["rows"])
    lines.append(
        f"Latest run {latest['dir'].name}, {model_label(latest['run'])}: "
        f"{collected} of {latest['planned']} answers read, {latest['answers']} counted."
    )
    you, empty = latest["totals"].get(own, {}), (0 if latest["answers"] else None)
    previous = summaries[-2] if len(summaries) > 1 else None
    change = ""
    if previous and previous["answers"] and latest["answers"]:
        before = previous["totals"].get(own, {}).get("mention_rate") or 0
        diff = round(((you.get("mention_rate") or 0) - before) * 100)
        change = f" ({f'{diff:+d} points' if diff else 'no change'} since {previous['dir'].name})"
    lines.append(
        f"{own}: named in {pct(you.get('mention_rate', empty))}{change}, "
        f"top 3 in {pct(you.get('top3_rate', empty))}, linked in {pct(you.get('citation_rate', empty))}."
    )
    others = sorted(
        ((k, v) for k, v in latest["totals"].items() if k != own),
        key=lambda kv: -kv[1]["mentions"],
    )
    tracked = [f"{latest['labels'][k]} {pct(v['mention_rate'])}" for k, v in others if not k.startswith("~")]
    found = [f"{latest['labels'][k]} ({v['mentions']})" for k, v in others if k.startswith("~")][:5]
    lines.append(f"Competitors: {', '.join(tracked) or 'none named'}.")
    lines.append(f"Also named, not tracked: {', '.join(found) or 'none'}.")
    lines.append("Problems: none." if not latest["problems"] else "Problems:")
    lines += [f"- {p}" for p in latest["problems"]]
    return "\n".join(lines)


def cmd_build(folder: Path, args) -> int:
    setup = require_setup(folder)
    summaries = [summarize_run(d, r, setup) for d, r in list_runs(folder)]
    path = folder / DASHBOARD_FILE
    path.write_text(render_dashboard(setup, summaries), encoding="utf-8")
    print(build_summary(setup, summaries, path))
    if args.open:
        webbrowser.open(path.resolve().as_uri())
    return 0


def cmd_setup_check(folder: Path, args) -> int:
    setup, problems = load_setup(folder)
    for problem in problems:
        print(f"problem: {problem}")
    for note in setup_notes(setup):
        print(f"note: {note}")
    if problems:
        print(f"{SETUP_FILE}: {plural(len(problems), 'problem')}.")
        return 1
    jobs = len(setup["questions"]) * setup["repeats"] + (1 if setup["perception"] else 0)
    print(f"{SETUP_FILE}: 0 problems. Each run asks {jobs} questions.")
    return 0


def cmd_retry(folder: Path, args) -> int:
    require_setup(folder)
    runs = list_runs(folder)
    if not runs:
        print("No run yet. Start one with: overheard.py start")
        return 1
    run_dir, run = runs[-1]
    job = next((j for j in run_jobs(run) if j["id"] == args.id), None)
    if not job:
        raise SetupError(f"{args.id} isn't an answer in run {run_dir.name}.")
    answer = run_dir / f"{job['id']}.md"
    if answer.exists():
        # A helper can't overwrite a file it hasn't read, so the old answer moves aside.
        answer.replace(run_dir / f"{job['id']}.retried.md")
        print(f"Set {answer.name} aside as {job['id']}.retried.md.")
    reading = run_dir / f"{job['id']}.json"
    if reading.exists():
        reading.unlink()
    print("Ask it again in a fresh helper:\n")
    print_job(run_dir, job)
    return 0


# --------------------------------------------------------------- dashboard

CSS = """
:root{--bg:#08090a;--surface:#0f1011;--line:#25272b;--text:#fff;--soft:#d6dbe3;--muted:#8a909b;
--green:#2aa94a;--teal:#02b6cc;--violet:#6b6ff0;--amber:#c7a12a;--red:#ee5656}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--soft);
font:15px/1.55 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;font-variant-numeric:tabular-nums}
main{max-width:980px;margin:0 auto;padding:40px 24px 64px}h1{color:var(--text);font-size:28px;margin:0 0 6px}
h2{color:var(--text);font-size:18px;margin:44px 0 12px}p{margin:6px 0}.muted{color:var(--muted)}
.stats{display:grid;grid-template-columns:repeat(3,1fr);gap:1px;background:var(--line);border:1px solid var(--line);margin-top:28px}
.stat{background:var(--surface);padding:18px 20px}.stat b{display:block;color:var(--text);font-size:34px;font-weight:600}
.up{color:var(--green)}.down{color:var(--red)}table{width:100%;border-collapse:collapse}
th,td{text-align:left;padding:8px 10px;border-bottom:1px solid var(--line);vertical-align:top}
th{color:var(--muted);font-weight:500}td.n,th.n{text-align:right}tr.you td{color:var(--text);font-weight:600}
.q{border-top:1px solid var(--line);padding:14px 0}.q h3{color:var(--text);font-size:15px;margin:0 0 6px}
details{margin:2px 0 8px}summary{cursor:pointer;color:var(--teal)}pre{white-space:pre-wrap;background:var(--surface);
border:1px solid var(--line);padding:14px;font:13px/1.5 ui-monospace,Consolas,monospace;color:var(--soft)}
svg text{fill:var(--muted);font-size:12px}a{color:var(--teal)}dl{margin:0}dt{color:var(--text);margin-top:12px}dd{margin:2px 0 0}
footer{margin-top:56px;border-top:1px solid var(--line);padding-top:16px;color:var(--muted);font-size:13px}
@media (max-width:640px){.stats{grid-template-columns:1fr}}
"""
LINES = (("mention_rate", "Named", "#2aa94a"), ("top3_rate", "Top 3", "#02b6cc"), ("citation_rate", "Linked", "#6b6ff0"))


def esc(value) -> str:
    return html.escape(str(value), quote=True)


def trend_svg(own: str, summaries: list[dict]) -> str:
    if len(summaries) < 2:
        return '<p class="muted">The trend appears after the second run.</p>'
    w, h, left, top, bottom = 900, 240, 44, 12, 28
    step = (w - left - 20) / (len(summaries) - 1)

    def y(value: float) -> float:
        return top + (1 - value) * (h - top - bottom)

    parts = [f'<svg viewBox="0 0 {w} {h}" width="100%" role="img" aria-label="Trend for {esc(own)}">']
    for level in (0, 0.5, 1):
        parts.append(f'<line x1="{left}" x2="{w - 20}" y1="{y(level):.1f}" y2="{y(level):.1f}" stroke="#25272b"/>')
        parts.append(f'<text x="0" y="{y(level) + 4:.1f}">{round(level * 100)}%</text>')
    last = len(summaries) - 1
    for i, s in enumerate(summaries):
        if i in (0, last) or last < 8:
            anchor = "start" if i == 0 else "end" if i == last else "middle"
            parts.append(f'<text x="{left + i * step:.1f}" y="{h - 6}" text-anchor="{anchor}">{esc(s["dir"].name)}</text>')
    for key, name, color in LINES:
        points = [
            (left + i * step, y(s["totals"].get(own, {}).get(key) or 0))
            for i, s in enumerate(summaries)
            if s["answers"]
        ]
        if points:
            path = " ".join(f"{px:.1f},{py:.1f}" for px, py in points)
            parts.append(f'<polyline points="{path}" fill="none" stroke="{color}" stroke-width="2.5"/>')
            parts += [f'<circle cx="{px:.1f}" cy="{py:.1f}" r="3.5" fill="{color}"/>' for px, py in points]
    parts.append("</svg>")
    legend = " ".join(f'<span style="color:{c}">&#9632;</span> {n}&nbsp;&nbsp;' for _, n, c in LINES)
    return "".join(parts) + f'<p class="muted">{legend}</p>'


def stat_block(label: str, key: str, own: str, latest: dict, previous: dict | None, meaning: str) -> str:
    value = latest["totals"].get(own, {}).get(key, 0 if latest["answers"] else None)
    change = ""
    if previous and previous["answers"] and value is not None:
        diff = round((value - (previous["totals"].get(own, {}).get(key) or 0)) * 100)
        css = "up" if diff > 0 else "down" if diff < 0 else "muted"
        words = f"{diff:+d} points" if diff else "No change"
        change = f'<span class="{css}">{words} since {esc(previous["dir"].name)}</span>'
    return f'<div class="stat" title="{esc(meaning)}">{esc(label)}<b>{pct(value)}</b>{change}<p class="muted">{esc(meaning)}</p></div>'


def brand_table(setup: dict, latest: dict) -> str:
    own = setup["brand"]["name"]
    with_domains = {b["name"] for b in [setup["brand"], *setup["competitors"]] if b["domains"]}
    def mentions(key: str) -> int:
        return -latest["totals"].get(key, {}).get("mentions", 0)

    tracked = [own] + sorted((c["name"] for c in setup["competitors"]), key=mentions)
    found = sorted((k for k in latest["totals"] if k.startswith("~")), key=mentions)
    rows = []
    for key in tracked + found[:10]:
        t = latest["totals"].get(key, {})
        empty = 0 if latest["answers"] else None
        linked = pct(t.get("citation_rate", empty)) if key in with_domains else "no site"
        name = latest["labels"].get(key, key) + ("" if key in tracked else " (not tracked)")
        rows.append(
            f'<tr class="{"you" if key == own else ""}"><td>{esc(name)}</td>'
            f'<td class="n">{pct(t.get("mention_rate", empty))}</td><td class="n">{pct(t.get("top3_rate", empty))}</td>'
            f'<td class="n">{linked}</td><td class="n">{pct(t.get("share_of_voice", empty))}</td></tr>'
        )
    head = (
        '<tr><th>Brand</th><th class="n" title="Share of counted answers that name the brand">Named</th>'
        '<th class="n" title="Share of counted answers that put the brand in the first three places of a ranked list">Top 3</th>'
        '<th class="n" title="Share of counted answers that name the brand and link one of its domains">Linked</th>'
        '<th class="n" title="The brand\'s mentions divided by every brand mention in the same answers">Share of voice</th></tr>'
    )
    return f"<table>{head}{''.join(rows)}</table>"


def question_blocks(setup: dict, latest: dict) -> str:
    own, blocks = setup["brand"]["name"], []
    by_question: dict[str, list] = {}
    for row in latest["rows"]:
        by_question.setdefault(row["state"]["job"]["question_id"], []).append(row)
    for qid, rows in by_question.items():
        job = rows[0]["state"]["job"]
        excluded = next((r["excluded"] for r in rows if r.get("excluded")), "")
        note = f'<p class="muted">Not counted: {esc(excluded)}.</p>' if excluded else ""
        items = []
        for row in rows:
            state = row["state"]
            label = f"Answer {state['job']['repeat']}"
            if state["status"] == "failed":
                items.append(f"<p>{label}: failed. {esc(state.get('reason', ''))}</p>")
                continue
            if state["status"] != "done":
                items.append(f"<p>{label}: {esc(state['problems'][0] if state['problems'] else state['status'])}</p>")
                continue
            you = next((n for n in row["named"] if n[0] == own), None)
            if you:
                where = f" at #{you[1]}" if you[1] else ""
                verdict = f"Named you{where}" + (", with a link to your site" if you[2] else "")
            else:
                verdict = "Didn't name you"
            others = [latest["labels"][k] + (f" #{p}" if p else "") for k, p, _ in row["named"] if k != own]
            also = f". Also named: {esc(', '.join(others))}" if others else ""
            items.append(
                f"<p>{label}: {esc(verdict)}{also}.</p><details><summary>Read the answer</summary>"
                f"<pre>{esc(state['answer'])}</pre></details>"
            )
        blocks.append(f'<div class="q"><h3>{esc(qid)}. {esc(job["text"])}</h3>{note}{"".join(items)}</div>')
    return "".join(blocks)


def perception_block(setup: dict, latest: dict) -> str:
    state = latest["perception"]
    if not state:
        return '<p class="muted">Perception is off for this folder.</p>'
    if state["status"] != "done":
        return f'<p class="muted">Not available for this run: {esc(state["problems"][0] if state["problems"] else state["status"])}</p>'
    data = state["reading"]
    if not data["knows_brand"]:
        return f"<p>{esc(ASSISTANTS[setup['assistant']])} didn't recognise {esc(setup['brand']['name'])}.</p>"
    items = "".join(
        f"<dt>{esc(label)}</dt><dd>{esc(data.get(key) or 'Not covered.')}</dd>" for key, label in PERCEPTION_FIELDS
    )
    return f"<dl>{items}</dl><details><summary>Read the answer</summary><pre>{esc(state['answer'])}</pre></details>"


def history_table(setup: dict, summaries: list[dict]) -> str:
    rows = []
    for s in reversed(summaries):
        t, empty = s["totals"].get(setup["brand"]["name"], {}), (0 if s["answers"] else None)
        issues = len(s["problems"]) + len(s["failed"])
        rows.append(
            f"<tr><td>{esc(s['dir'].name)}</td><td>{esc(model_label(s['run']))}</td>"
            f'<td class="n">{s["answers"]} of {s["planned"]}</td><td class="n">{pct(t.get("mention_rate", empty))}</td>'
            f'<td class="n">{pct(t.get("top3_rate", empty))}</td><td class="n">{pct(t.get("citation_rate", empty))}</td>'
            f'<td class="n">{issues or ""}</td></tr>'
        )
    head = (
        '<tr><th>Run</th><th>Assistant</th><th class="n">Answers counted</th><th class="n">Named</th>'
        '<th class="n">Top 3</th><th class="n">Linked</th><th class="n" title="Failed or unfinished answers">Issues</th></tr>'
    )
    return f"<table>{head}{''.join(rows)}</table>"


def render_dashboard(setup: dict, summaries: list[dict]) -> str:
    own, assistant = setup["brand"]["name"], ASSISTANTS[setup["assistant"]]
    title = f"What {assistant} says about {own}"
    if not summaries:
        body = "<p>No runs yet. Ask your assistant to run Overheard.</p>"
    else:
        latest, previous = summaries[-1], (summaries[-2] if len(summaries) > 1 else None)
        meanings = (
            ("Named", "mention_rate", "Share of counted answers that name you."),
            ("Top 3", "top3_rate", "Share of counted answers that put you in the first three places of a ranked list."),
            ("Linked", "citation_rate", "Share of counted answers that name you and link one of your domains."),
        )
        stats = "".join(stat_block(label, key, own, latest, previous, m) for label, key, m in meanings)
        body = (
            f'<p class="muted">Latest run {esc(latest["dir"].name)}, {esc(model_label(latest["run"]))}. '
            f'{latest["answers"]} of {latest["planned"]} answers counted. {plural(len(summaries), "run")} since {esc(summaries[0]["dir"].name)}.</p>'
            f'<div class="stats">{stats}</div>'
            f"<h2>Over time</h2>{trend_svg(own, summaries)}"
            f"<h2>You and the brands named beside you, latest run</h2>{brand_table(setup, latest)}"
            f"<h2>How {esc(assistant)} describes {esc(own)}</h2>{perception_block(setup, latest)}"
            f"<h2>Every answer, latest run</h2>{question_blocks(setup, latest)}"
            f"<h2>Runs</h2>{history_table(setup, summaries)}"
        )
    footer = (
        "<footer><p>How it counts. Each answer counts a brand once, however often it names it. Answers to a question "
        "that names your own brand are kept but never counted. A question whose answers name no brand at all adds "
        "nothing to the rates. Failed answers never count. Share of voice divides a brand's mentions by every brand "
        "mention in the same answers, including brands you don't track.</p>"
        '<p>Overheard Lite by <a href="https://www.trellace.com/?utm_source=overheard-lite&amp;utm_medium=dashboard">Trellace</a>. '
        'The full app compares ChatGPT, Claude and Gemini: <a href="https://github.com/TrellaceTeam/overheard-ai">Overheard AI</a>.</p></footer>'
    )
    return (
        f'<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
        f"<title>{esc(title)}</title><style>{CSS}</style></head><body><main><h1>{esc(title)}</h1>{body}{footer}</main></body></html>\n"
    )


# -------------------------------------------------------------------- cli


def main(argv: list[str] | None = None) -> int:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(errors="replace")
    parser = argparse.ArgumentParser(prog="overheard.py", description="Overheard Lite")
    parser.add_argument("--folder", default=".", help="the folder that holds overheard.json")
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("setup-check", help="check overheard.json")
    start = sub.add_parser("start", help="start or resume today's run and list the answers to collect")
    start.add_argument("--assistant", required=True, choices=sorted(ASSISTANTS))
    start.add_argument("--model", default="", help="the model the helpers use, as the app names it")
    check = sub.add_parser("check", help="list what the latest run still needs")
    check.add_argument("--run", help="a run folder name, such as 2026-10-23")
    retry = sub.add_parser("retry", help="set one answer of the latest run aside so it can be asked again")
    retry.add_argument("id", help="the answer's id, such as q01-2 or perception")
    build = sub.add_parser("build", help="score every run and write dashboard.html")
    build.add_argument("--open", action="store_true", help="open the dashboard afterwards")
    args = parser.parse_args(argv)
    commands = {
        "setup-check": cmd_setup_check,
        "start": cmd_start,
        "check": cmd_check,
        "retry": cmd_retry,
        "build": cmd_build,
    }
    try:
        return commands[args.command](Path(args.folder), args)
    except SetupError as error:
        print(f"problem: {error}")
        return 2


if __name__ == "__main__":
    sys.exit(main())
