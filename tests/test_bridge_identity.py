"""Project Identity operations through the real bridge and Core (0.5.0), with no DSH doubles."""
from __future__ import annotations

import json
from pathlib import Path

import pytest

from test_bridge import authority_bytes, invoke, start, state_bytes, workspace  # noqa: F401 (fixture)

TEXT_V1 = "# Project identity\n\n## INV-1 Local first\nData stays on the user's machine.\n\n## P-1 Small surface\nKeep the public surface small.\n"
TEXT_V2 = "# Project identity\n\n## INV-1 Local first\nData stays on the user's machine unless the owner opts in.\n\n## P-1 Small surface\nKeep the public surface small.\n"
DECISION = {"decided_by": "owner", "human_instruction": "Establish the identity exactly as drafted."}


def ok(response):
    assert response["ok"], response
    return response["result"]


def refused(response, fragment=""):
    assert not response["ok"], response
    assert fragment in response["error"], response["error"]
    return response["error"]


def revision(workspace, task):
    return ok(invoke(workspace, "inspect", {"task_id": task["task_id"]}))["state"]["revision"]


def amend(workspace, task, text=TEXT_V1, base_version=0, base_sha256=None, **extra):
    payload = {"base_version": base_version, "base_sha256": base_sha256, "text": text, "summary": "Record the identity",
               "rationale": "The owner asked for a project baseline.", "decision": DECISION, **extra}
    return invoke(workspace, "identity_amend", {"task_id": task["task_id"], "base_revision": revision(workspace, task), "input": payload})


def status(workspace, task):
    return ok(invoke(workspace, "identity_status", {"task_id": task["task_id"]}))


def identity_files(workspace):
    root = Path(workspace["root"]) / ".project-identity"
    return sorted(path.relative_to(root).as_posix() for path in root.rglob("*") if path.is_file()) if root.exists() else []


def test_absent_identity_changes_nothing(workspace):
    task = start(workspace)
    observed = status(workspace, task)
    assert observed["state"] == "ABSENT" and observed["summary"] is None and observed["version"] is None
    assert not (Path(workspace["root"]) / ".project-identity").exists()
    assert observed["task_context"] and "Project identity" not in observed["task_context"]
    inspected = ok(invoke(workspace, "inspect", {"task_id": task["task_id"]}))
    assert "Project identity" not in inspected["task_context"]
    refused(invoke(workspace, "identity_get", {"task_id": task["task_id"]}), "ABSENT")
    traced = ok(invoke(workspace, "identity_trace", {"task_id": task["task_id"], "ref": "identity"}))
    assert traced["state"] == "ABSENT" and traced["edges"] == []
    assert ok(invoke(workspace, "status", {"task_id": task["task_id"]}))["task_context"] == inspected["task_context"]


def test_establish_v1_keeps_task_revision_and_updates_context(workspace):
    task = start(workspace)
    before_state = state_bytes(workspace, task["task_id"])
    written = ok(amend(workspace, task))
    assert (written["version"], written["amendment"], written["items"]["added"]) == (1, "A-0001", ["INV-1", "P-1"])
    assert written["registered_dependents"] == [] and "Nothing is revalidated" in written["notice"]
    assert "Project identity v1 (A-0001, CURRENT); 0 open challenges." in written["task_context"]
    # Identity writes do not bump the task revision or rewrite its ledger.
    assert state_bytes(workspace, task["task_id"]) == before_state
    assert revision(workspace, task) == task["revision"]
    assert "Project identity v1" in ok(invoke(workspace, "inspect", {"task_id": task["task_id"]}))["task_context"]
    assert "Project identity v1" in ok(invoke(workspace, "status", {"task_id": task["task_id"]}))["task_context"]
    observed = status(workspace, task)
    assert observed["state"] == "CURRENT" and observed["version"] == 1 and [item["id"] for item in observed["items"]] == ["INV-1", "P-1"]
    assert observed["summary"] in observed["task_context"]
    assert (Path(workspace["root"]) / ".project-identity" / "IDENTITY.md").read_text(encoding="utf-8") == TEXT_V1
    # The adapter-bound Controller identity, never a model argument, is the recorded actor.
    record = ok(invoke(workspace, "identity_get", {"task_id": task["task_id"], "amendment": "A-0001"}))["record"]
    assert record["actor"] == "dsh:native-root" and record["task_id"] == task["task_id"] and record["decision"] == DECISION
    # The authority anchor still verifies after the identity write.
    assert ok(invoke(workspace, "inspect", {"task_id": task["task_id"]}))["state"]["status"] == "ACTIVE"


def test_get_selects_version_items_amendment_and_challenge(workspace):
    task = start(workspace)
    tid = task["task_id"]
    ok(amend(workspace, task))
    current = ok(invoke(workspace, "identity_get", {"task_id": tid}))
    assert current["kind"] == "version" and current["text"] == TEXT_V1 and current["on_disk_divergent"] is False
    assert ok(invoke(workspace, "identity_get", {"task_id": tid, "version": 1}))["text"] == TEXT_V1
    items = ok(invoke(workspace, "identity_get", {"task_id": tid, "items": ["INV-1"]}))
    assert items["kind"] == "items" and [item["id"] for item in items["items"]] == ["INV-1"] and "Local first" in items["items"][0]["text"]
    opened = ok(invoke(workspace, "identity_challenge", {"task_id": tid, "base_revision": revision(workspace, task), "input": {
        "targets": ["identity:INV-1"], "summary": "Opt-in sync may be needed", "text": "Evidence shows users want opt-in sync."}}))
    challenge = ok(invoke(workspace, "identity_get", {"task_id": tid, "challenge": opened["challenge"]}))
    assert challenge["status"] == "open" and challenge["challenge"]["id"] == opened["challenge"]
    refused(invoke(workspace, "identity_get", {"task_id": tid, "challenge": opened["challenge"], "amendment": "A-0001"}))
    refused(invoke(workspace, "identity_get", {"task_id": tid, "actor": "someone"}), "INVALID_IDENTITY_ARGUMENTS")


def test_challenge_open_dismiss_and_amendment_resolves(workspace):
    task = start(workspace)
    tid = task["task_id"]
    ok(amend(workspace, task))
    first = ok(invoke(workspace, "identity_challenge", {"task_id": tid, "base_revision": revision(workspace, task), "input": {
        "targets": ["identity"], "summary": "Lower repair may suffice", "text": "Observed limit in one module."}}))
    second = ok(invoke(workspace, "identity_challenge", {"task_id": tid, "base_revision": revision(workspace, task), "input": {
        "targets": ["identity:INV-1"], "summary": "Opt-in sync", "text": "Owner may allow opt-in sync.", "proposed_change": "Add an opt-in clause."}}))
    assert first["status"] == second["status"] == "open" and first["challenge"] != second["challenge"]
    assert "2 open challenges" in status(workspace, task)["task_context"]
    dismissed = ok(invoke(workspace, "identity_challenge", {"task_id": tid, "base_revision": revision(workspace, task), "input": {
        "dismiss": first["challenge"], "reason": "A lower-level repair suffices."}}))
    assert dismissed["status"] == "dismissed"
    refused(invoke(workspace, "identity_challenge", {"task_id": tid, "base_revision": revision(workspace, task), "input": {
        "dismiss": first["challenge"], "reason": "again"}}), "not open")
    amended = ok(amend(workspace, task, TEXT_V2, base_version=1, base_sha256=status(workspace, task)["on_disk_sha256"],
                       resolves=[second["challenge"]], summary="Allow opt-in sync", challenge_text="Owner allowed opt-in sync."))
    assert amended["version"] == 2 and amended["challenges_resolved"] == [second["challenge"]] and amended["items"]["changed"] == ["INV-1"]
    assert ok(invoke(workspace, "identity_get", {"task_id": tid, "challenge": second["challenge"]}))["status"] == "amended"
    assert ok(invoke(workspace, "identity_get", {"task_id": tid, "challenge": first["challenge"]}))["status"] == "dismissed"
    assert "0 open challenges" in status(workspace, task)["task_context"]
    assert ok(invoke(workspace, "identity_get", {"task_id": tid, "version": 1}))["text"] == TEXT_V1


def test_relate_trace_and_dependents(workspace):
    task = start(workspace)
    tid = task["task_id"]
    ok(amend(workspace, task))
    related = ok(invoke(workspace, "identity_relate", {"task_id": tid, "base_revision": revision(workspace, task), "input": {
        "add": [{"from": "commit:abc1234", "rel": "serves", "to": "identity:INV-1", "note": "The sync design serves local first."}]}}))
    assert len(related["added"]) == 1 and "Registered relations only" in related["notice"]
    traced = ok(invoke(workspace, "identity_trace", {"task_id": tid, "ref": "identity:INV-1", "direction": "down", "depth": 2}))
    assert [edge["id"] for edge in traced["edges"]] == related["added"] and traced["edges"][0]["to_state"] == "CURRENT"
    assert "absence of a relation is not evidence" in traced["notice"]
    refused(invoke(workspace, "identity_trace", {"task_id": tid, "ref": "identity:INV-1", "depth": 9}))
    refused(invoke(workspace, "identity_trace", {"task_id": tid}), "INVALID_IDENTITY_ARGUMENTS")
    refused(invoke(workspace, "identity_relate", {"task_id": tid, "base_revision": revision(workspace, task), "input": {
        "add": [{"from": "commit:abc1234", "rel": "challenges", "to": "identity"}]}}), "identity-challenge")
    amended = ok(amend(workspace, task, TEXT_V2, base_version=1, base_sha256=status(workspace, task)["on_disk_sha256"], summary="Allow opt-in sync"))
    assert [item["id"] for item in amended["registered_dependents"]] == related["added"] and amended["registered_dependents_total"] == 1
    retracted = ok(invoke(workspace, "identity_relate", {"task_id": tid, "base_revision": revision(workspace, task), "input": {
        "retract": [{"id": related["added"][0], "reason": "Superseded design."}]}}))
    assert retracted["retracted"] == related["added"]
    assert ok(invoke(workspace, "identity_trace", {"task_id": tid, "ref": "identity:INV-1"}))["edges"] == []
    refused(invoke(workspace, "identity_relate", {"task_id": tid, "base_revision": revision(workspace, task), "input": {
        "retract": [{"id": related["added"][0], "reason": "again"}]}}), "already retracted")


def test_cas_conflict_unknown_task_and_argument_shape_leave_files_unchanged(workspace):
    task = start(workspace)
    tid = task["task_id"]
    before = (state_bytes(workspace, tid), authority_bytes(workspace, tid), identity_files(workspace))
    payload = {"base_version": 0, "base_sha256": None, "text": TEXT_V1, "summary": "s", "rationale": "r", "decision": DECISION}
    refused(invoke(workspace, "identity_amend", {"task_id": tid, "base_revision": 9, "input": payload}), "TASK_ID_OR_REVISION_CONFLICT")
    refused(invoke(workspace, "identity_amend", {"task_id": tid, "input": payload}), "TASK_ID_OR_REVISION_CONFLICT")
    refused(invoke(workspace, "identity_amend", {"task_id": tid, "base_revision": 1, "input": payload, "actor": "forged"}), "INVALID_IDENTITY_ARGUMENTS")
    refused(invoke(workspace, "identity_amend", {"task_id": tid, "base_revision": 1, "input": "payload.json"}), "INVALID_IDENTITY_ARGUMENTS")
    refused(invoke(workspace, "identity_amend", {"task_id": tid, "base_revision": 1, "input": {**payload, "extra": 1}}), "invalid identity-amend input fields")
    refused(invoke(workspace, "identity_amend", {"task_id": tid, "base_revision": 1, "input": {**payload, "decision": {"decided_by": "owner"}}}), "decision")
    refused(invoke(workspace, "identity_amend", {"task_id": "00000000-0000-0000-0000-000000000000", "base_revision": 1, "input": payload}))
    refused(invoke(workspace, "identity_status", {}), "TASK_ID_REQUIRED")
    refused(invoke(workspace, "identity_status", {"task_id": "00000000-0000-0000-0000-000000000000"}))
    refused(invoke(workspace, "identity_status", {"task_id": tid}, native_controller_id="child-id"), "MISMATCH")
    refused(invoke(workspace, "identity_amend", {"task_id": tid, "base_revision": 1, "input": payload}, native_workspace_id="other-workspace"), "MISMATCH")
    assert (state_bytes(workspace, tid), authority_bytes(workspace, tid), identity_files(workspace)) == before


def test_hand_edit_is_observed_not_adopted_and_stale_base_is_refused(workspace):
    task = start(workspace)
    tid = task["task_id"]
    ok(amend(workspace, task))
    recorded = status(workspace, task)["on_disk_sha256"]
    (Path(workspace["root"]) / ".project-identity" / "IDENTITY.md").write_text(TEXT_V2, encoding="utf-8")
    observed = status(workspace, task)
    assert observed["state"] == "UNRECORDED_CHANGE" and "differs from the recorded version" in observed["task_context"]
    served = ok(invoke(workspace, "identity_get", {"task_id": tid}))
    assert served["text"] == TEXT_V1 and served["on_disk_divergent"] is True
    refused(amend(workspace, task, TEXT_V2, base_version=1, base_sha256=recorded), "base_sha256 conflict")
    assert ok(amend(workspace, task, TEXT_V2 + "\nOwner note.\n", base_version=1, base_sha256=observed["on_disk_sha256"]))["version"] == 2
    assert "UNRECORDED_CHANGE" not in status(workspace, task)["task_context"]


def test_two_tasks_share_one_project_identity_but_not_task_ledgers(workspace):
    first, second = start(workspace), start(workspace)
    ok(amend(workspace, first))
    assert "Project identity v1" in status(workspace, second)["task_context"]
    assert revision(workspace, second) == second["revision"]
    refused(invoke(workspace, "identity_challenge", {"task_id": second["task_id"], "base_revision": 7, "input": {
        "targets": ["identity"], "summary": "s", "text": "t"}}), "TASK_ID_OR_REVISION_CONFLICT")
    closed = ok(invoke(workspace, "close", {"task_id": first["task_id"], "base_revision": revision(workspace, first), "decision": "Done."}))
    assert closed["status"] == "DONE"
    # A closed task is inactive for every bridge operation, identity included; the baseline outlives it.
    refused(invoke(workspace, "identity_status", {"task_id": first["task_id"]}), "INACTIVE")
    refused(invoke(workspace, "identity_relate", {"task_id": first["task_id"], "base_revision": closed["revision"], "input": {
        "add": [{"from": "url:https://example.com/a", "rel": "supports", "to": "url:https://example.com/b"}]}}), "INACTIVE")
    assert "Project identity v1" in status(workspace, second)["task_context"]


def test_resume_context_carries_identity_line_only_when_recorded(workspace):
    task = start(workspace)
    assert "Project identity" not in ok(invoke(workspace, "resume", {}))["tasks"][0]["task_context"]
    ok(amend(workspace, task))
    assert "Project identity v1" in ok(invoke(workspace, "resume", {}))["tasks"][0]["task_context"]


@pytest.mark.parametrize("operation", ["identity_amend", "identity_challenge", "identity_relate"])
def test_mutating_identity_operations_require_task_and_native_controller(workspace, operation):
    refused(invoke(workspace, operation, {"base_revision": 1, "input": {}}), "TASK_ID_REQUIRED")
