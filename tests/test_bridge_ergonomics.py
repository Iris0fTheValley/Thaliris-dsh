"""Lower Controller overhead (Core 0.5.1): batch judgments, structured conflicts, compact status and write results."""
from __future__ import annotations

import json
from pathlib import Path
import sys

import pytest

from test_bridge import SOURCE, invoke, start, state_bytes, workspace  # noqa: F401 (fixture)
from test_bridge_continuity import dispatch, ok, register, state

CONFLICT = "TASK_ID_OR_REVISION_CONFLICT"


def judgment(identifier, ref, observation, outcome="satisfied"):
    return {"id": identifier, "candidate": "C1", "requirement_ref": ref, "observation_refs": [observation], "outcome": outcome, "reasoning": f"{observation} supports {ref}."}


def observe(workspace, task, identifier="O1", handoff="Habc123", child="native-child"):
    return ok(invoke(workspace, "observe", {"task_id": task["task_id"], "handoff_id": handoff, "child_id": child, "observation": {
        "id": identifier, "text": "local fact", "source_refs": ["S1"], "sources": [{"id": "S1", "kind": "local", "locator": "a.py:1", "summary": "exact"}]}}))


def finish(workspace, task, selected, child="native-child"):
    terminal = {key: selected[key] for key in ("correlation", "workstream", "role", "handoff_sha256")}
    revision = state(workspace, task["task_id"])["state"]["revision"]
    return ok(invoke(workspace, "finish", {"task_id": task["task_id"], "base_revision": revision,
                                           "observation": json.dumps({**terminal, "child_id": child, "stop_reason": "completed"})}))


def with_open_evidence(workspace, requirements=("R1", "R2")):
    task = start(workspace)
    register(workspace, task, requirements)
    selected, _ = dispatch(workspace, task, refs=requirements)
    observe(workspace, task)
    return task, selected


def revision_of(workspace, task):
    return state(workspace, task["task_id"])["state"]["revision"]


def test_batch_judgments_commit_in_order_with_one_revision(workspace):
    task, selected = with_open_evidence(workspace)
    finish(workspace, task, selected)
    base = revision_of(workspace, task)
    batch = [judgment("J1", "R1", "Habc123.O1"), judgment("J2", "R2", "Habc123.O1", "no-current-impact")]
    judged = ok(invoke(workspace, "judge", {"task_id": task["task_id"], "base_revision": base, "judgments": batch}))
    assert judged["revision"] == base + 1 and judged["appended"] == ["J1", "J2"]
    assert judged["evidence"]["unincorporated_total"] == 0 and judged["evidence"]["latest_judgments_total"] == 2
    stored = state(workspace, task["task_id"])["state"]
    assert [item["id"] for item in stored["evidence_continuity"]["judgments"]] == ["J1", "J2"]
    assert {item["producer"] for item in stored["evidence_continuity"]["judgments"]} == {"dsh:controller"}


def test_batch_judgments_are_atomic_and_validated(workspace):
    task, selected = with_open_evidence(workspace)
    finish(workspace, task, selected)
    base = revision_of(workspace, task)
    before = state_bytes(workspace, task["task_id"])
    broken = invoke(workspace, "judge", {"task_id": task["task_id"], "base_revision": base,
                                         "judgments": [judgment("J1", "R1", "Habc123.O1"), judgment("J2", "R2", "Habc123.O404")]})
    assert not broken["ok"] and broken["code"] == "CONTINUITY_REFERENCE_INVALID", broken
    assert broken["details"]["collection"] == "judgments" and broken["details"]["index"] == 1
    assert state_bytes(workspace, task["task_id"]) == before, "no judgment of a failed batch is committed"
    duplicate = invoke(workspace, "judge", {"task_id": task["task_id"], "base_revision": base,
                                            "judgments": [judgment("J1", "R1", "Habc123.O1"), judgment("J1", "R2", "Habc123.O1")]})
    assert not duplicate["ok"] and state_bytes(workspace, task["task_id"]) == before
    one = judgment("J1", "R1", "Habc123.O1")
    for arguments in ({"judgment": one, "judgments": [one]}, {"judgments": []}, {"judgments": "J1"}, {"judgments": [{**one, "producer": "child"}]}, {"judgments": [one] * 65}, {}):
        refused = invoke(workspace, "judge", {"task_id": task["task_id"], "base_revision": base, **arguments})
        assert not refused["ok"], arguments
    assert state_bytes(workspace, task["task_id"]) == before
    # The single-judgment form is unchanged.
    assert ok(invoke(workspace, "judge", {"task_id": task["task_id"], "base_revision": base, "judgment": one}))["appended"] == ["J1"]


def test_revision_conflict_carries_code_recovery_and_changes_since(workspace):
    task, selected = with_open_evidence(workspace)
    stale = revision_of(workspace, task) - 1
    finish(workspace, task, selected)
    current = revision_of(workspace, task)
    before = state_bytes(workspace, task["task_id"])
    conflict = invoke(workspace, "judge", {"task_id": task["task_id"], "base_revision": stale, "judgments": [judgment("J1", "R1", "Habc123.O1")]})
    assert not conflict["ok"] and conflict["error"] == CONFLICT and conflict["code"] == "TASK_REVISION_CONFLICT"
    details = conflict["details"]
    assert details["mismatch"] == "revision" and details["task_id"] == task["task_id"]
    assert details["base_revision"] == stale and details["current_revision"] == current
    since = details["changes_since"]
    assert since["exact"] is False and since["revision_gap"] == current - stale and since["current_revision"] == current
    assert since["evidence"]["unincorporated_total"] == 2, "open evidence is re-presented, not dropped"
    assert any(item["id"] == "Habc123.O1" for item in since["recent"]["observations"])
    assert state_bytes(workspace, task["task_id"]) == before
    # Strict CAS: the single retry at current_revision succeeds.
    retried = ok(invoke(workspace, "judge", {"task_id": task["task_id"], "base_revision": details["current_revision"], "judgments": [judgment("J1", "R1", "Habc123.O1")]}))
    assert retried["revision"] == current + 1


@pytest.mark.parametrize("operation,arguments", [
    ("context", {"milestone": "M"}),
    ("inspect", {}),
])
def test_every_cas_operation_reports_structured_conflicts(workspace, operation, arguments):
    task = start(workspace)
    refused = invoke(workspace, operation, {"task_id": task["task_id"], "base_revision": 99, **arguments})
    assert not refused["ok"] and refused["error"] == CONFLICT and refused["code"] == "TASK_REVISION_CONFLICT"
    assert refused["details"]["current_revision"] == task["revision"] and refused["details"]["changes_since"]["exact"] is False
    missing = invoke(workspace, operation, {"task_id": task["task_id"], **{key: value for key, value in arguments.items()}})
    if operation != "inspect":
        assert not missing["ok"] and missing["error"] == CONFLICT and missing["details"]["base_revision"] is None


def test_task_id_mismatch_is_distinguished_from_revision_mismatch(workspace):
    task = start(workspace)
    sys.path.insert(0, str(SOURCE))
    from thaliris import core
    import core_bridge
    core.select_task(Path(workspace["root"]), task["task_id"])
    current = core.task_show(Path(workspace["root"]))["state"]
    wrong_task = core_bridge.cas_conflict(core, current, {"task_id": "other-task", "base_revision": current["revision"]})
    assert wrong_task.message == CONFLICT and wrong_task.code == "TASK_IDENTITY_CONFLICT"
    assert wrong_task.details["mismatch"] == "task_id" and wrong_task.details["expected_task_id"] == "other-task" and wrong_task.details["task_id"] == task["task_id"]
    wrong_revision = core_bridge.cas_conflict(core, current, {"task_id": task["task_id"], "base_revision": current["revision"] + 1})
    assert wrong_revision.code == "TASK_REVISION_CONFLICT" and wrong_revision.details["mismatch"] == "revision"
    assert core_bridge.cas_conflict(core, current, {"task_id": task["task_id"], "base_revision": current["revision"]}) is None
    assert core_bridge.cas_conflict(core, current, {"task_id": task["task_id"], "base_revision": True}) is not None


def test_non_structured_errors_keep_the_historical_shape(workspace):
    task = start(workspace)
    refused = invoke(workspace, "status", {"task_id": task["task_id"], "view": "wide"})
    assert refused == {"protocol": 1, "ok": False, "error": "INVALID_STATUS_ARGUMENTS"}


def test_compact_status_is_default_and_smaller_than_full(workspace):
    task, selected = with_open_evidence(workspace)
    finish(workspace, task, selected)
    ok(invoke(workspace, "context", {"task_id": task["task_id"], "base_revision": revision_of(workspace, task),
                                     "records": [{"id": f"F{index}", "kind": "fact", "text": "x" * 700} for index in range(6)]}))
    default = invoke(workspace, "status", {"task_id": task["task_id"]})
    compact = invoke(workspace, "status", {"task_id": task["task_id"], "view": "compact"})
    full = invoke(workspace, "status", {"task_id": task["task_id"], "view": "full"})
    assert default == compact
    packet, whole = ok(default), ok(full)
    assert packet["view"] == "compact" and "view" not in whole
    assert packet["Task"]["revision"] == whole["Task"]["revision"] and packet["Authority"] == whole["Authority"]
    assert packet["Evidence"]["unincorporated_total"] == 2 and "Evidence Continuity" not in packet and "Evidence Continuity" in whole
    assert [item["id"] for item in packet["Current Records"]] == [item["id"] for item in whole["Current Records"]]
    assert all(set(item) == {"id", "kind", "text"} and len(item["text"]) <= 201 for item in packet["Current Records"])
    assert all(len(item["text"]) == 600 for item in whole["Current Records"]) and all("status" in item for item in whole["Current Records"])
    assert packet["Current Record Count"] == 6 and packet["Dispatch History"] == {"record_kind": "dsh-dispatch", "count": 1, "legacy_count": 0, "non_completed": []}
    assert whole["Dispatch History"]["recent"][0]["outcome"] == "completed"
    assert len(default["result"].__repr__()) < len(full["result"].__repr__())
    assert "task_context" in packet and "task_context" in whole


def test_compact_status_lists_dispatches_that_did_not_complete(workspace):
    task = start(workspace)
    selected = {"correlation": "thaliris:c9", "workstream": "ws", "role": "implementer", "handoff_sha256": "digest"}
    begun = ok(invoke(workspace, "begin", {"task_id": task["task_id"], "base_revision": task["revision"], "observation": json.dumps(selected)}))
    bound = ok(invoke(workspace, "bind", {"task_id": task["task_id"], "base_revision": begun["revision"], "observation": json.dumps({**selected, "child_id": "c9"})}))
    ok(invoke(workspace, "finish", {"task_id": task["task_id"], "base_revision": bound["revision"], "observation": json.dumps({**selected, "child_id": "c9", "stop_reason": "error"})}))
    history = ok(invoke(workspace, "status", {"task_id": task["task_id"]}))["Dispatch History"]
    assert history["count"] == 1 and history["non_completed"] == [{"id": history["non_completed"][0]["id"], "operation": "finish", "outcome": "error", "workstream": "ws", "role": "implementer"}]


def test_status_since_revision_adds_a_bounded_delta_hint(workspace):
    task, _ = with_open_evidence(workspace)
    base = task["revision"]
    for view in ("compact", "full"):
        packet = ok(invoke(workspace, "status", {"task_id": task["task_id"], "view": view, "since_revision": base}))
        assert packet["Changes Since"]["base_revision"] == base and packet["Changes Since"]["exact"] is False
        assert packet["Changes Since"]["revision_gap"] == revision_of(workspace, task) - base
    assert "Changes Since" not in ok(invoke(workspace, "status", {"task_id": task["task_id"]}))
    for bad in ({"since_revision": -1}, {"since_revision": "1"}, {"since_revision": True}, {"evidence_offset": -1}):
        assert not invoke(workspace, "status", {"task_id": task["task_id"], **bad})["ok"], bad


def test_write_results_carry_revision_and_compact_evidence_summary(workspace):
    task = start(workspace)
    registered = register(workspace, task, ("R1", "R2"))
    assert registered["revision"] == task["revision"] + 1 and registered["appended"] == ["R1", "R2"]
    assert registered["evidence"]["unincorporated_total"] == 0 and "Evidence Continuity" not in registered
    selected, _ = dispatch(workspace, task, refs=("R1", "R2"))
    observe(workspace, task)
    released = finish(workspace, task, selected)
    # Finishing a dispatch re-presents open evidence (no separate status read) and the new revision.
    assert released["revision"] == revision_of(workspace, task)
    assert released["evidence"]["unincorporated_total"] == 2 and released["evidence"]["unincorporated"][0]["observation_id"] == "Habc123.O1"
    judged = ok(invoke(workspace, "judge", {"task_id": task["task_id"], "base_revision": released["revision"], "judgment": judgment("J1", "R1", "Habc123.O1")}))
    assert judged["revision"] == released["revision"] + 1
    assert judged["evidence"]["unincorporated_total"] == 1 and judged["evidence"]["unincorporated"][0]["requirement_ref"] == "R2"
    context = ok(invoke(workspace, "context", {"task_id": task["task_id"], "base_revision": judged["revision"], "records": [{"id": "F1", "kind": "fact", "text": "Recorded."}]}))
    assert context["revision"] == judged["revision"] + 1 and context["evidence"]["unincorporated_total"] == 1
    assert context["Task Context"]["Current Records"] == [{"id": "F1", "kind": "fact"}] and context["Task Context"]["Current Record Count"] == 1
    assert len(json.dumps(judged["evidence"], separators=(",", ":"))) <= 1536 + 256


def test_open_evidence_is_paged_not_dropped_in_write_results(workspace):
    task = start(workspace)
    register(workspace, task, tuple(f"R{index}" for index in range(30)))
    selected, _ = dispatch(workspace, task, refs=tuple(f"R{index}" for index in range(30)))
    observe(workspace, task)
    released = finish(workspace, task, selected)
    evidence = released["evidence"]
    assert evidence["unincorporated_total"] == 30 and evidence["next_offset"] is not None, "too many open items for one compact page"
    assert len(evidence["unincorporated"]) < 30
    page = ok(invoke(workspace, "status", {"task_id": task["task_id"], "evidence_offset": evidence["next_offset"]}))["Evidence"]
    assert page["offset"] == evidence["next_offset"] and page["unincorporated"], "the rest stays reachable by paging"

