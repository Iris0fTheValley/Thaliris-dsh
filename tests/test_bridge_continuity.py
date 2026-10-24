"""Evidence continuity, task context and mode switching through the real bridge and Core."""
from __future__ import annotations

import json

import pytest

from test_bridge import CONTRACT, authority_bytes, invoke, start, state_bytes, workspace  # noqa: F401 (fixture)


def ok(response):
    assert response["ok"], response
    return response["result"]


def state(workspace, task_id):
    return ok(invoke(workspace, "inspect", {"task_id": task_id}))


def register(workspace, task, ids=("R1",)):
    revision = state(workspace, task["task_id"])["state"]["revision"]
    return ok(invoke(workspace, "register", {"task_id": task["task_id"], "base_revision": revision,
                                             "requirements": [{"id": value, "workchain_ref": "W1"} for value in ids]}))


def reservation(handoff_id="Habc123", **extra):
    return {"correlation": "thaliris:c1", "workstream": "ws", "role": "implementer", "handoff_sha256": "digest",
            "role_sha256": "r" * 16, "route": "inherit", "evidence_handoff_id": handoff_id, **extra}


def dispatch(workspace, task, handoff_id="Habc123", child="native-child", refs=("R1",)):
    revision = state(workspace, task["task_id"])["state"]["revision"]
    selected = reservation(handoff_id)
    begun = ok(invoke(workspace, "begin", {"task_id": task["task_id"], "base_revision": revision, "observation": json.dumps(selected),
                                           "evidence": {"handoff_id": handoff_id, "candidate": "C1", "requirement_refs": list(refs)}}))
    bound = ok(invoke(workspace, "bind", {"task_id": task["task_id"], "base_revision": begun["revision"], "observation": json.dumps({**selected, "child_id": child})}))
    return selected, bound


def test_dispatch_registers_handoff_and_child_observation_is_adapter_bound(workspace):
    task = start(workspace)
    register(workspace, task)
    selected, _ = dispatch(workspace, task)
    observed = ok(invoke(workspace, "observe", {"task_id": task["task_id"], "handoff_id": "Habc123", "child_id": "native-child", "observation": {
        "id": "O1", "text": "local fact", "source_refs": ["S1"], "sources": [{"id": "S1", "kind": "local", "locator": "a.py:1", "summary": "exact"}]}}))
    assert observed["observation_id"] == "Habc123.O1" and observed["candidate"] == "C1"
    continuity = state(workspace, task["task_id"])["state"]["evidence_continuity"]
    assert continuity["handoffs"] == [{"id": "Habc123", "parent_handoff_id": None, "candidate": "C1", "producer": "handoff:Habc123", "requirement_refs": ["R1"]}]
    item = continuity["observations"][0]
    assert item["producer"] == "handoff:Habc123" and item["requirement_refs"] == ["R1"] and item["source_refs"] == ["Habc123.S1"]
    assert item["native_actor"].startswith("dsh-child:") and "native-child" not in item["native_actor"]
    status = ok(invoke(workspace, "status", {"task_id": task["task_id"], "view": "full"}))
    assert status["Evidence Continuity"]["unincorporated"] == [{"requirement_ref": "R1", "observation_id": "Habc123.O1", "candidate": "C1", "handoff_id": "Habc123"}]
    assert "1 unincorporated" in status["task_context"]
    # Finishing the dispatch ends the child's observation grant.
    revision = state(workspace, task["task_id"])["state"]["revision"]
    contradicted = invoke(workspace, "finish", {"task_id": task["task_id"], "base_revision": revision, "observation": json.dumps({**selected, "route": "other/model", "child_id": "native-child", "stop_reason": "completed"})})
    assert not contradicted["ok"] and "NATIVE_RESERVATION_CONFLICT" in contradicted["error"]
    terminal = {key: selected[key] for key in ("correlation", "workstream", "role", "handoff_sha256")}
    ok(invoke(workspace, "finish", {"task_id": task["task_id"], "base_revision": revision, "observation": json.dumps({**terminal, "child_id": "native-child", "stop_reason": "completed"})}))
    late = invoke(workspace, "observe", {"task_id": task["task_id"], "handoff_id": "Habc123", "child_id": "native-child", "observation": {"id": "O2", "text": "late", "source_refs": ["Habc123.S1"]}})
    assert not late["ok"] and "OBSERVATION_DISPATCH_FINISHED" in late["error"]
    revision = state(workspace, task["task_id"])["state"]["revision"]
    judged = ok(invoke(workspace, "judge", {"task_id": task["task_id"], "base_revision": revision, "judgment": {
        "id": "J1", "candidate": "C1", "requirement_ref": "R1", "observation_refs": ["Habc123.O1"], "outcome": "satisfied", "reasoning": "Observation supports R1."}}))
    assert judged["evidence"]["unincorporated_total"] == 0 and judged["appended"] == ["J1"]
    assert state(workspace, task["task_id"])["state"]["evidence_continuity"]["judgments"][0]["producer"] == "dsh:controller"


@pytest.mark.parametrize("change,error", [
    ({"child_id": "other-child"}, "OBSERVATION_CHILD_CONFLICT"),
    ({"handoff_id": "Hforged"}, "OBSERVATION_ASSOCIATION_UNAVAILABLE"),
    ({"observation": {"id": "O1", "text": "x", "source_refs": ["S"], "candidate": "C9"}}, "OBSERVATION_PROVENANCE_FIELDS"),
    ({"observation": {"id": "O1", "text": "x", "source_refs": ["S"], "requirement_refs": ["R9"]}}, "OBSERVATION_PROVENANCE_FIELDS"),
    ({"observation": {"id": "O1", "text": "x", "source_refs": ["S"], "producer": "controller"}}, "OBSERVATION_PROVENANCE_FIELDS"),
])
def test_observation_provenance_cannot_be_forged(workspace, change, error):
    task = start(workspace)
    register(workspace, task)
    dispatch(workspace, task)
    before = state_bytes(workspace, task["task_id"]), authority_bytes(workspace, task["task_id"])
    arguments = {"task_id": task["task_id"], "handoff_id": "Habc123", "child_id": "native-child", "observation": {"id": "O1", "text": "x", "source_refs": ["S"]}, **change}
    denied = invoke(workspace, "observe", arguments)
    assert not denied["ok"] and error in denied["error"]
    assert (state_bytes(workspace, task["task_id"]), authority_bytes(workspace, task["task_id"])) == before


def test_observation_requires_bound_child_and_evidence_association(workspace):
    task = start(workspace)
    register(workspace, task)
    plain = json.dumps({"correlation": "c", "workstream": "w", "role": "r", "handoff_sha256": "d"})
    begun = ok(invoke(workspace, "begin", {"task_id": task["task_id"], "base_revision": state(workspace, task["task_id"])["state"]["revision"], "observation": plain}))
    bound = ok(invoke(workspace, "bind", {"task_id": task["task_id"], "base_revision": begun["revision"], "observation": json.dumps({**json.loads(plain), "child_id": "kid"})}))
    assert bound["revision"] == begun["revision"] + 1
    denied = invoke(workspace, "observe", {"task_id": task["task_id"], "handoff_id": "Habc123", "child_id": "kid", "observation": {"id": "O1", "text": "x", "source_refs": ["S"]}})
    assert not denied["ok"] and "OBSERVATION_ASSOCIATION_UNAVAILABLE" in denied["error"]
    other = start(workspace)
    register(workspace, other)
    selected = reservation()
    ok(invoke(workspace, "begin", {"task_id": other["task_id"], "base_revision": state(workspace, other["task_id"])["state"]["revision"], "observation": json.dumps(selected),
                                   "evidence": {"handoff_id": "Habc123", "candidate": "C1", "requirement_refs": ["R1"]}}))
    unbound = invoke(workspace, "observe", {"task_id": other["task_id"], "handoff_id": "Habc123", "child_id": "kid", "observation": {"id": "O1", "text": "x", "source_refs": ["S"]}})
    assert not unbound["ok"] and "OBSERVATION_CHILD_CONFLICT" in unbound["error"]


def test_dispatch_evidence_requires_registered_requirements_and_matching_reservation(workspace):
    task = start(workspace)
    revision = state(workspace, task["task_id"])["state"]["revision"]
    before = state_bytes(workspace, task["task_id"])
    unregistered = invoke(workspace, "begin", {"task_id": task["task_id"], "base_revision": revision, "observation": json.dumps(reservation()),
                                               "evidence": {"handoff_id": "Habc123", "candidate": "C1", "requirement_refs": ["R1"]}})
    assert not unregistered["ok"]
    mismatched = invoke(workspace, "begin", {"task_id": task["task_id"], "base_revision": revision, "observation": json.dumps(reservation("Hother")),
                                             "evidence": {"handoff_id": "Habc123", "candidate": "C1", "requirement_refs": []}})
    assert not mismatched["ok"] and "EVIDENCE_RESERVATION_CONFLICT" in mismatched["error"]
    assert state_bytes(workspace, task["task_id"]) == before
    assert not invoke(workspace, "bind", {"task_id": task["task_id"], "base_revision": revision, "observation": "{}", "evidence": {}})["ok"]


def test_controller_cannot_register_handoffs_or_assert_judgment_identity(workspace):
    task = start(workspace)
    revision = state(workspace, task["task_id"])["state"]["revision"]
    before = state_bytes(workspace, task["task_id"])
    handoff = invoke(workspace, "register", {"task_id": task["task_id"], "base_revision": revision, "requirements": [
        {"id": "H1", "parent_handoff_id": None, "candidate": "C1", "producer": "handoff:H1", "requirement_refs": []}]})
    assert not handoff["ok"] and "registered by the adapter" in handoff["error"]
    extra = invoke(workspace, "register", {"task_id": task["task_id"], "base_revision": revision, "requirements": [{"id": "R1", "workchain_ref": "W"}], "handoffs": []})
    assert not extra["ok"]
    forged = invoke(workspace, "judge", {"task_id": task["task_id"], "base_revision": revision, "judgment": {"id": "J1", "producer": "child", "candidate": "C1"}})
    assert not forged["ok"] and "INVALID_JUDGE_ARGUMENTS" in forged["error"]
    stale = invoke(workspace, "register", {"task_id": task["task_id"], "base_revision": revision + 5, "requirements": [{"id": "R1", "workchain_ref": "W"}]})
    assert not stale["ok"] and stale["error"] == "TASK_ID_OR_REVISION_CONFLICT" and stale["code"] == "TASK_REVISION_CONFLICT"
    assert stale["details"]["current_revision"] == revision and stale["details"]["base_revision"] == revision + 5 and stale["details"]["mismatch"] == "revision"
    assert state_bytes(workspace, task["task_id"]) == before
    other = invoke(workspace, "register", {"task_id": task["task_id"], "base_revision": revision, "requirements": [{"id": "R1", "workchain_ref": "W"}]}, native_controller_id="child-id")
    assert not other["ok"] and "MISMATCH" in other["error"]


def test_task_context_update_records_provenance_and_bounded_summary(workspace):
    task = start(workspace)
    updated = ok(invoke(workspace, "context", {"task_id": task["task_id"], "base_revision": task["revision"], "milestone": "M2",
                                               "sources": [{"id": "S1", "kind": "local", "locator": "README.md", "summary": "claim"}],
                                               "records": [{"id": "F1", "kind": "fact", "text": "Bridge tests pass.", "source_refs": ["S1"]},
                                                           {"id": "D1", "kind": "decision", "text": "Keep external Core."}]}))
    assert updated["revision"] == task["revision"] + 1
    assert [item["id"] for item in updated["Task Context"]["Current Records"]] == ["F1", "D1"]
    assert "Milestone: M2" in updated["task_context"] and "D1 [decision] Keep external Core." in updated["task_context"]
    records = state(workspace, task["task_id"])["state"]["records"]
    assert {item["producer"] for item in records} == {"dsh:controller"} and {item["revision"] for item in records} == {updated["revision"]}
    superseded = ok(invoke(workspace, "context", {"task_id": task["task_id"], "base_revision": updated["revision"], "records": [{"id": "D2", "kind": "decision", "text": "Revised.", "supersedes": ["D1"]}]}))
    assert [item["id"] for item in superseded["Task Context"]["Current Records"]] == ["F1", "D2"]
    before = state_bytes(workspace, task["task_id"])
    for arguments in ({"records": [{"id": "X", "kind": "fact", "text": "t", "producer": "child"}]},
                      {"records": [{"id": "X", "kind": "fact", "text": "t", "revision": 99}]},
                      {"active_work": []}, {"pending_results": ["forged"]}, {}):
        denied = invoke(workspace, "context", {"task_id": task["task_id"], "base_revision": superseded["revision"], **arguments})
        assert not denied["ok"], arguments
    assert state_bytes(workspace, task["task_id"]) == before
    big = ok(invoke(workspace, "context", {"task_id": task["task_id"], "base_revision": superseded["revision"],
                                           "records": [{"id": f"N{index}", "kind": "progress", "text": "x" * 3000} for index in range(20)]}))
    assert len(big["task_context"]) <= 6000 and big["Task Context"]["Current Record Count"] == 22


def test_resume_lists_only_this_controllers_active_tasks(workspace):
    mine = start(workspace)
    ok(invoke(workspace, "context", {"task_id": mine["task_id"], "base_revision": mine["revision"], "records": [{"id": "F1", "kind": "fact", "text": "resume me"}]}))
    other = invoke(workspace, "start", {"goal": "Rival", "contract": CONTRACT}, native_controller_id="rival-root")
    assert other["ok"]
    closed = start(workspace)
    ok(invoke(workspace, "close", {"task_id": closed["task_id"], "base_revision": closed["revision"], "decision": "Accepted."}))
    resumed = ok(invoke(workspace, "resume", {}))
    assert [item["task_id"] for item in resumed["tasks"]] == [mine["task_id"]]
    assert "resume me" in resumed["tasks"][0]["task_context"]
    assert not invoke(workspace, "resume", {"task_id": mine["task_id"]})["ok"]


def test_mode_switch_requires_instruction_digest_and_no_active_work(workspace):
    task = start(workspace)
    inspected = state(workspace, task["task_id"])
    digest, revision = inspected["authority_sha256"], inspected["state"]["revision"]
    base = {"task_id": task["task_id"], "base_revision": revision, "expected_authority_sha256": digest, "mode": "controller-direct"}
    before = state_bytes(workspace, task["task_id"]), authority_bytes(workspace, task["task_id"])
    for arguments in ({**base, "human_instruction": " "}, {**base, "human_instruction": "Switch.", "expected_authority_sha256": "0" * 64},
                      {**base, "human_instruction": "Switch.", "mode": "unbounded"}, base):
        assert not invoke(workspace, "mode", arguments)["ok"], arguments
    assert (state_bytes(workspace, task["task_id"]), authority_bytes(workspace, task["task_id"])) == before
    switched = ok(invoke(workspace, "mode", {**base, "human_instruction": "The user selected controller-direct."}))
    assert switched["execution_mode"] == "controller-direct" and switched["revision"] == revision + 1
    after = state(workspace, task["task_id"])
    assert after["contract"] == {**CONTRACT, "execution_mode": "controller-direct"}
    assert after["authority_sha256"] == switched["authority_sha256"] != digest
    reserved = ok(invoke(workspace, "begin", {"task_id": task["task_id"], "base_revision": after["state"]["revision"], "observation": "reservation"}))
    blocked = invoke(workspace, "mode", {"task_id": task["task_id"], "base_revision": reserved["revision"], "expected_authority_sha256": switched["authority_sha256"],
                                         "mode": "delegated", "human_instruction": "Back."})
    assert not blocked["ok"] and "UNRESOLVED_ACTIVE_WORK_CANNOT_SWITCH_MODE" in blocked["error"]
    assert not invoke(workspace, "mode", {**base, "human_instruction": "x"}, native_controller_id="child-id")["ok"]
