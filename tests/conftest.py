"""Isolate Core's machine-local identity formation store (THALIRIS_HOME) from the real home for every test."""
import pytest


@pytest.fixture(autouse=True)
def isolated_thaliris_home(tmp_path, monkeypatch):
    monkeypatch.setenv("THALIRIS_HOME", str(tmp_path / "thaliris-home"))
