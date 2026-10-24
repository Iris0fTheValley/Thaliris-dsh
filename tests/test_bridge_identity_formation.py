"""Natural identity formation (Core 0.5.2) through the real bridge: basis notes, suggestions and the close-time offer."""
from __future__ import annotations

from pathlib import Path

from test_bridge import invoke, start, workspace  # noqa: F401 (fixture)
from test_bridge_identity import ok, refused, revision, status


def coded(response, code):
    assert not response["ok"] and response.get("code") == code, response

QUOTE = "This project exists to keep the user's data on their own machine."
TRACKED = Path(".project" + "-identity")
CONTEXT = Path("." + "context")


def note(workspace, **input):
    return invoke(workspace, "identity_note", {"input": input})


def suggestions(workspace, task):
    return status(workspace, task)["suggestions"]


def close(workspace, task):
    return ok(invoke(workspace, "close", {"task_id": task["task_id"], "base_revision": revision(workspace, task), "decision": "Accepted."}))


def test_note_add_list_retract_need_no_task_and_no_authority(workspace):
    added = ok(note(workspace, quote=QUOTE, kind="purpose", context="stated at kickoff"))
    assert added["note"]["id"] == "N-0001" and added["task_id"] is None and added["note"]["task_id"] is None
    listed = ok(invoke(workspace, "identity_note_list", {}))
    assert [item["id"] for item in listed["notes"]] == ["N-0001"] and listed["notes"][0]["quote"] == QUOTE
    ok(note(workspace, retract="N-0001", reason="user withdrew it"))
    assert ok(invoke(workspace, "identity_note_list", {}))["notes"] == []
    assert len(ok(invoke(workspace, "identity_note_list", {"include_retracted": True}))["notes"]) == 1
    coded(note(workspace, retract="N-0001", reason="again"), "IDENTITY_NOTE_ALREADY_RETRACTED")
    coded(note(workspace, quote=""), "IDENTITY_NOTE_INVALID")
    assert not (Path(workspace["root"]) / TRACKED).exists()
    assert not (Path(workspace["root"]) / CONTEXT).exists()


def test_note_with_a_task_present_and_arguments_are_bounded(workspace):
    start(workspace)
    # The one-shot bridge process selects no task for a note, so Core records task_id null.
    assert ok(note(workspace, quote=QUOTE))["task_id"] is None
    refused(invoke(workspace, "identity_note", {"input": {"quote": QUOTE}, "task_id": "x"}), "INVALID_IDENTITY_ARGUMENTS")
    refused(invoke(workspace, "identity_note_list", {"stray": 1}), "INVALID_IDENTITY_ARGUMENTS")
    refused(invoke(workspace, "identity_suggest", {"scope": "session"}), "INVALID_IDENTITY_ARGUMENTS")


def test_suggest_scopes_and_session_key_passthrough(workspace):
    task = start(workspace)
    assert suggestions(workspace, task) == {"enabled": True, "source": "default"}
    ok(invoke(workspace, "identity_suggest", {"scope": "session", "setting": "off"}))
    assert suggestions(workspace, task) == {"enabled": False, "source": "session"}
    ok(invoke(workspace, "identity_suggest", {"scope": "session", "setting": "clear"}))
    ok(invoke(workspace, "identity_suggest", {"scope": "project", "setting": "off"}))
    assert suggestions(workspace, task) == {"enabled": False, "source": "project"}
    ok(invoke(workspace, "identity_suggest", {"scope": "workspace", "setting": "on"}))
    assert suggestions(workspace, task) == {"enabled": True, "source": "workspace"}
    coded(invoke(workspace, "identity_suggest", {"scope": "galaxy", "setting": "off"}), "IDENTITY_PREFERENCE_INVALID")
    observed = status(workspace, task)
    assert observed["basis"]["total"] == 0 and observed["state"] == "ABSENT"


def test_session_scope_is_keyed_by_the_native_controller_id(workspace):
    task = start(workspace)
    ok(invoke(workspace, "identity_suggest", {"scope": "session", "setting": "off"}))
    assert suggestions(workspace, task)["source"] == "session"
    # A different native Controller id is a different session: it resolves without the first one's setting.
    other = {**workspace, "native_controller_id": "other-root"}
    ok(invoke(other, "identity_suggest", {"scope": "session", "setting": "on"}))
    assert suggestions(workspace, task) == {"enabled": False, "source": "session"}


def test_close_carries_identity_offer_once_per_new_note(workspace):
    assert "identity_offer" not in close(workspace, start(workspace))
    ok(note(workspace, quote=QUOTE))
    offered = close(workspace, start(workspace))
    assert "identity-note" in offered["identity_offer"] and offered["status"] == "DONE"
    assert "identity_offer" not in close(workspace, start(workspace))
    ok(note(workspace, quote="Never add telemetry."))
    assert "identity_offer" in close(workspace, start(workspace))


def test_close_offer_absent_when_suggestions_off(workspace):
    ok(invoke(workspace, "identity_suggest", {"scope": "project", "setting": "off"}))
    ok(note(workspace, quote=QUOTE))
    assert "identity_offer" not in close(workspace, start(workspace))
    assert status(workspace, start(workspace))["basis"]["pending"] == 1
