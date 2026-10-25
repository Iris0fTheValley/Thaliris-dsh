"""The machine-readable Core pin agrees with its prose provenance and the tested Core source."""
from __future__ import annotations

import hashlib
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
REQUIRED_KEYS = {"repository", "commit", "version", "state_schema_version", "source", "package_tree_sha256"}


def test_lock_shape():
    assert set(LOCK) == REQUIRED_KEYS
    assert LOCK["repository"] == "Iris0fTheValley/Thaliris"
    assert re.fullmatch(r"[0-9a-f]{40}", LOCK["commit"])
    assert re.fullmatch(r"\d+\.\d+\.\d+", LOCK["version"])
    source = LOCK["source"]
    assert set(source) == {"kind", "url_template", "sha256"}
    assert source["kind"] == "codeload-tarball"
    assert source["url_template"] == "https://codeload.github.com/{repository}/tar.gz/{commit}"
    assert re.fullmatch(r"[0-9a-f]{64}", source["sha256"])
    assert re.fullmatch(r"[0-9a-f]{64}", LOCK["package_tree_sha256"])
    package = json.loads((ROOT / "package.json").read_text(encoding="utf-8"))
    assert "core.lock.json" in package["files"], "the Core pin ships in the package"
    assert "setup.mjs" in package["files"], "first-run provisioning ships in the package"


def installed_metadata_version() -> str | None:
    """Version recorded by a pure-source/provisioned install (no source pyproject.toml).

    The import root is the parent of the ``thaliris`` package, so a provisioned install keeps
    ``thaliris-<version>.dist-info`` next to the package inside that same root; a source
    checkout keeps pyproject.toml one level above it.
    """
    candidates = list(SOURCE.glob("thaliris-*.dist-info")) + list(SOURCE.parent.glob("thaliris-*.dist-info"))
    for dist_info in sorted(candidates):
        metadata = dist_info / "METADATA"
        if not metadata.is_file():
            continue
        for line in metadata.read_text(encoding="utf-8").splitlines():
            if line.startswith("Version: "):
                return line.split(": ", 1)[1].strip()
    return None


def _tested_version() -> str:
    project = SOURCE.parent / "pyproject.toml"
    if project.is_file():
        return tomllib.loads(project.read_text(encoding="utf-8"))["project"]["version"]
    version = installed_metadata_version()
    assert version is not None, "Core import root has neither a source pyproject.toml nor an installed dist-info"
    return version


def package_tree_sha256() -> str:
    """Hash the package tree independently of tar packing: sorted `<relpath>:<sha256hex>` lines."""
    lines = []
    for path in (SOURCE / "thaliris").rglob("*"):
        if not path.is_file() or "__pycache__" in path.parts or path.suffix == ".pyc":
            continue
        relative = path.relative_to(SOURCE / "thaliris").as_posix()
        lines.append(f"{relative}:{hashlib.sha256(path.read_bytes()).hexdigest()}")
    return hashlib.sha256("\n".join(sorted(lines)).encode("utf-8")).hexdigest()


def test_tested_core_source_matches_the_lock():
    assert _tested_version() == LOCK["version"]
    core = (SOURCE / "thaliris" / "core.py").read_text(encoding="utf-8")
    assert f"_STATE_SCHEMA_VERSION = {LOCK['state_schema_version']}" in core
    assert package_tree_sha256() == LOCK["package_tree_sha256"], "the tested Core package tree is not the pinned source"
    head = subprocess.run(["git", "-C", str(SOURCE.parent), "rev-parse", "HEAD"], capture_output=True, text=True, check=False)
    if head.returncode == 0:
        # A Git checkout must be exactly the locked commit; an extracted source tree or an
        # installed package is checked by version and package-tree digest instead.
        assert head.stdout.strip() == LOCK["commit"]
