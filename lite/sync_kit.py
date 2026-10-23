"""Copy the skill from kit/.agents/skills/overheard to kit/.claude/skills/overheard.

Codex reads skills from .agents/skills and Claude Code from .claude/skills, so
the kit ships both. Edit the .agents copy, then run: python lite/sync_kit.py
The tests fail when the two copies differ.
"""
import shutil
from pathlib import Path

KIT = Path(__file__).resolve().parent / "kit"
SOURCE = KIT / ".agents" / "skills" / "overheard"
TARGET = KIT / ".claude" / "skills" / "overheard"

shutil.rmtree(TARGET, ignore_errors=True)
shutil.copytree(SOURCE, TARGET, ignore=shutil.ignore_patterns("__pycache__"))
print(f"Copied {SOURCE.relative_to(KIT)} to {TARGET.relative_to(KIT)}")
