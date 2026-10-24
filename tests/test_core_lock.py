"""The machine-readable Core pin agrees with its prose provenance and the tested Core source."""
from __future__ import annotations

import json
import os
from pathlib import Path
import re
import subprocess
import tomllib

ROOT = Path(__file__).resolve().parents[1]
LOCK = json.loads((ROOT / "core.lock.json").read_text(encoding="utf-8"))
CORE_PATH = os.environ.get("THALIRIS_CORE_PATH")
if not CORE_PATH:
    raise RuntimeError("Set THALIRIS_CORE_PATH to the main Thaliris source import root.")
SOURCE = Path(CORE_PATH).resolve()


def test_lock_shape():
    assert set(LOCK) == {"repository", "commit", "version", "state_schema_version"}
    assert LOCK["repository"] == "Iris0fTheValley/Thaliris"
    assert re.fullmatch(r"[0-9a-f]{40}", LOCK["commit"])
    assert re.fullmatch(r"\d+\.\d+\.\d+", LOCK["version"])
    package = json.loads((ROOT / "package.json").read_text(encoding="utf-8"))
    assert "core.lock.json" in package["files"], "the Core pin ships in the package"


def test_tested_core_source_matches_the_lock():
    project = tomllib.loads((SOURCE.parent / "pyproject.toml").read_text(encoding="utf-8"))
    assert project["project"]["version"] == LOCK["version"]
    core = (SOURCE / "thaliris" / "core.py").read_text(encoding="utf-8")
    assert f"_STATE_SCHEMA_VERSION = {LOCK['state_schema_version']}" in core
    head = subprocess.run(["git", "-C", str(SOURCE.parent), "rev-parse", "HEAD"], capture_output=True, text=True, check=False)
    if head.returncode == 0:
        # A Git checkout must be exactly the locked commit; an extracted source tree is checked by version only.
        assert head.stdout.strip() == LOCK["commit"]
