"""Dispatch history lives in append-only Core records, never in bounded routing state."""
from __future__ import annotations

import json
from pathlib import Path
import sys
import tempfile

from test_bridge import SOURCE, invoke, start, workspace  # noqa: F401 (fixture)
from test_bridge_continuity import ok, state

ROUTING_LIMIT = 8 * 1024


def routing_bytes(values: dict) -> int:
    return len(json.dumps({"active_work": values["active_work"], "pending_results": values["pending_results"]},
                          ensure_ascii=False, separators=(",", ":")).encode("utf-8"))


def reservation(index: int) -> dict:
    # Shaped like the adapter's real reservation, so archive sizes are realistic.
    return {"workstream": f"workstream-{index}", "role": "Focused Implementer", "handoff_sha256": f"{index:064x}",
            "correlation": f"thaliris:{index:08x}-0000-4000-8000-000000000000", "role_sha256": "a" * 16, "route": "mock/child@high"}


def run_dispatch(workspace, task_id: str, index: int, *, terminal: str) -> dict:
    selected = reservation(index)
    revision = state(workspace, task_id)["state"]["revision"]
    begun = ok(invoke(workspace, "begin", {"task_id": task_id, "base_revision": revision, "observation": json.dumps(selected)}))
    child = f"child-{index:04d}-" + "c" * 24
    if terminal == "finish":
        observed = {**{key: selected[key] for key in ("workstream", "role", "handoff_sha256", "correlation")},
                    "child_id": child, "stop_reason": "completed", "provenance": "native-run-result"}
    else:
        observed = {**selected, "child_id": child, "outcome": "completed", "terminal_seq": 19,
                    "terminal_reason": {"kind": "completed"}, "provenance": "native-session-turn/end"}
    return ok(invoke(workspace, terminal, {"task_id": task_id, "base_revision": begun["revision"], "observation": json.dumps(observed)}))


def test_fifty_finished_dispatches_keep_finish_reconcile_and_close_working(workspace):
    task = start(workspace)
    task_id = task["task_id"]
    for index in range(50):
        released = run_dispatch(workspace, task_id, index, terminal="finish" if index % 2 else "reconcile")
        assert released["adapter_records"] == [f"dsh-dispatch.r{released['revision']}"]
        current = state(workspace, task_id)["state"]
        assert current["active_work"] == [] and current["pending_results"] == []
    current = state(workspace, task_id)["state"]
    archives = [item for item in current["records"] if item["kind"] == "dsh-dispatch"]
    assert len(archives) == 50 and {item["producer"] for item in archives} == {"dsh:adapter"}
    assert routing_bytes(current) < 64, "finished dispatches leave no routing residue"
    assert json.loads(archives[0]["text"])["operation"] == "reconcile"
    assert json.loads(archives[-1]["text"])["reservation"] == reservation(49)

    compact = ok(invoke(workspace, "status", {"task_id": task_id}))["Dispatch History"]
    assert compact == {"record_kind": "dsh-dispatch", "count": 50, "legacy_count": 0, "non_completed": []}, "completed dispatches are counted, not listed, in the compact view"
    status = ok(invoke(workspace, "status", {"task_id": task_id, "view": "full"}))
    history = status["Dispatch History"]
    assert history["count"] == 50 and history["legacy_count"] == 0
    assert [item["workstream"] for item in history["recent"]] == [f"workstream-{index}" for index in range(42, 50)]
    assert history["recent"][-1]["outcome"] == "completed" and history["recent"][-1]["child_id"].startswith("child-0049-")
    assert status["Current Records"] == [] and status["Current Record Count"] == 0, "adapter history never crowds Controller records"
    assert "Dispatch history: 50 finished dispatch(es)" in status["task_context"]
    assert len(status["task_context"]) < 2000

    # Controller context still works and stays visible next to the archive.
    context = ok(invoke(workspace, "context", {"task_id": task_id, "base_revision": current["revision"],
                                               "records": [{"id": "D1", "kind": "decision", "text": "Archive volume is not routing state."}]}))
    assert [item["id"] for item in context["Task Context"]["Current Records"]] == ["D1"]
    closed = ok(invoke(workspace, "close", {"task_id": task_id, "base_revision": context["revision"], "decision": "Fifty dispatches archived; closing."}))
    assert closed["status"] == "DONE"


def write_legacy_state(workspace, task_id: str, pending: list[str], active: list[str]) -> None:
    """Write routing state exactly as the earlier bridge did, then re-anchor it."""
    sys.path.insert(0, str(SOURCE))
    from thaliris import core
    from thaliris.authority import AuthorityStore
    root = Path(workspace["root"]).resolve()
    core.select_task(root, task_id)
    revision = core.task_show(root)["state"]["revision"]
    with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False, encoding="utf-8") as stream:
        json.dump({"active_work": active, "pending_results": pending}, stream)
    try:
        core.task_update(root, "dsh:" + workspace["native_controller_id"], revision, stream.name)
    finally:
        Path(stream.name).unlink()
    AuthorityStore(root, Path(workspace["authority_directory"]), protected_paths=(".context/config.json",), task_id=task_id).checkpoint()
    core.select_task(root, None)


def test_legacy_history_in_pending_results_migrates_and_unblocks_finish(workspace):
    task = start(workspace)
    task_id = task["task_id"]
    approved = {"task_id": task_id, "proposal_id": "p-approved", "provider": "local", "key": "k", "text": "kept note", "provenance": "child", "role": "Curator", "workspaceId": "w", "policy": "manual"}
    receipt = {"approval_id": "a-1", "proposal_id": "p-approved", "provider": "local", "workspaceId": "w", "outcome": "provider-write-observed", "provenance": "native-client-approval"}
    open_proposal = {**approved, "proposal_id": "p-open", "text": "awaiting review"}
    unknown = "operator note the adapter does not recognize"
    head = [json.dumps(approved), json.dumps(receipt), json.dumps(open_proposal), unknown]
    active = json.dumps({**reservation(999), "child_id": "child-live"})
    legacy, index = [], 0
    while True:
        selected = reservation(index)
        pair = ["Archived reservation: " + json.dumps(selected),
                json.dumps({**selected, "child_id": f"child-{index}", "stop_reason": "completed", "provenance": "native-run-result"})]
        if routing_bytes({"active_work": [active], "pending_results": [*head, *legacy, *pair]}) > ROUTING_LIMIT:
            break
        legacy += pair
        index += 1
    # Pad the unrecognized entry so the legacy state sits just under Core's bound.
    unknown += "." * (ROUTING_LIMIT - routing_bytes({"active_work": [active], "pending_results": [*head, *legacy]}))
    head[3] = unknown
    pending = [*head[:2], *legacy[:4], *head[2:], *legacy[4:]]
    assert routing_bytes({"active_work": [active], "pending_results": pending}) == ROUTING_LIMIT
    write_legacy_state(workspace, task_id, pending, [active])
    before = state(workspace, task_id)["state"]
    assert before["pending_results"] == pending and before["active_work"] == [active]
    # The earlier bridge appended two more entries here and Core refused it.
    stuck = ["Archived reservation: " + active, json.dumps({"child_id": "child-live", "stop_reason": "completed", "provenance": "native-run-result"})]
    assert routing_bytes({"active_work": [], "pending_results": [*pending, *stuck]}) > ROUTING_LIMIT

    status = ok(invoke(workspace, "status", {"task_id": task_id}))
    assert status["Dispatch History"]["legacy_count"] == index, "unmigrated legacy archives are still counted"

    finished = ok(invoke(workspace, "finish", {"task_id": task_id, "base_revision": before["revision"],
                                                "observation": json.dumps({**reservation(999), "child_id": "child-live", "stop_reason": "completed", "provenance": "native-run-result"})}))
    migrated_id, dispatch_id = finished["adapter_records"]
    after = state(workspace, task_id)["state"]
    assert after["active_work"] == []
    assert after["pending_results"] == [json.dumps(open_proposal), unknown], "unconsumed proposal and unknown bytes stay current"
    migrated = next(item for item in after["records"] if item["id"] == migrated_id)
    assert (migrated["kind"], migrated["producer"], migrated["revision"]) == ("dsh-legacy-pending", "dsh:adapter", finished["revision"])
    entries = json.loads(migrated["text"])["entries"]
    assert entries == [value for value in pending if value not in (json.dumps(open_proposal), unknown)], "history moves in order, byte-for-byte"
    assert json.loads(next(item for item in after["records"] if item["id"] == dispatch_id)["text"])["result"]["child_id"] == "child-live"

    history = ok(invoke(workspace, "status", {"task_id": task_id}))["Dispatch History"]
    assert history["count"] == 1 and history["legacy_count"] == index

    # The remaining proposal is consumed by approval; dispatching continues.
    approval = ok(invoke(workspace, "approval", {"task_id": task_id, "observation": json.dumps({**receipt, "approval_id": "a-2", "proposal_id": "p-open"})}))
    assert state(workspace, task_id)["state"]["pending_results"] == [unknown]
    record = next(item for item in state(workspace, task_id)["state"]["records"] if item["id"] == approval["adapter_records"][0])
    assert record["kind"] == "dsh-memory-approval" and json.loads(record["text"])["proposal"] == open_proposal
    for index in range(3):
        run_dispatch(workspace, task_id, 2000 + index, terminal="finish")
    current = state(workspace, task_id)["state"]
    assert ok(invoke(workspace, "close", {"task_id": task_id, "base_revision": current["revision"], "decision": "Legacy task closes."}))["status"] == "DONE"


def test_legacy_migration_happens_on_any_adapter_write(workspace):
    task = start(workspace)
    task_id = task["task_id"]
    legacy = ["Archived reservation: " + json.dumps(reservation(1)),
              json.dumps({**reservation(1), "child_id": "c", "stop_reason": "completed", "provenance": "native-run-result"})]
    write_legacy_state(workspace, task_id, legacy, [])
    revision = state(workspace, task_id)["state"]["revision"]
    begun = ok(invoke(workspace, "begin", {"task_id": task_id, "base_revision": revision, "observation": json.dumps(reservation(2))}))
    current = state(workspace, task_id)["state"]
    assert current["pending_results"] == [] and current["active_work"] == [json.dumps(reservation(2))]
    assert [item["kind"] for item in current["records"]] == ["dsh-legacy-pending"] and begun["adapter_records"] == [current["records"][0]["id"]]


def test_memory_proposal_and_approval_shapes(workspace):
    task = start(workspace)
    task_id = task["task_id"]
    proposal = {"task_id": task_id, "proposal_id": "p1", "provider": "local", "key": "k", "text": "note", "provenance": "c", "role": "Controller", "workspaceId": "w", "policy": "manual"}
    for observation in ("free text", json.dumps({"approval_id": "a", "proposal_id": "p1"}), json.dumps([1])):
        refused = invoke(workspace, "proposal", {"task_id": task_id, "observation": observation})
        assert not refused["ok"] and refused["error"] == "INVALID_MEMORY_PROPOSAL"
    ok(invoke(workspace, "proposal", {"task_id": task_id, "observation": json.dumps(proposal)}))
    for observation in ("free text", json.dumps({"proposal_id": "p1"})):
        refused = invoke(workspace, "approval", {"task_id": task_id, "observation": observation})
        assert not refused["ok"] and refused["error"] == "INVALID_MEMORY_APPROVAL"
    assert state(workspace, task_id)["state"]["pending_results"] == [json.dumps(proposal)]
    receipt = {"approval_id": "a1", "proposal_id": "p1", "provider": "local", "workspaceId": "w", "outcome": "provider-write-observed", "provenance": "native-client-approval"}
    approved = ok(invoke(workspace, "approval", {"task_id": task_id, "observation": json.dumps(receipt)}))
    current = state(workspace, task_id)["state"]
    assert current["pending_results"] == []
    (record,) = current["records"]
    assert record["id"] == approved["adapter_records"][0] and record["producer"] == "dsh:adapter"
    assert json.loads(record["text"]) == {"receipt": receipt, "proposal": proposal}
    # A repeated receipt (proposal already consumed) is still recorded, without a proposal.
    again = ok(invoke(workspace, "approval", {"task_id": task_id, "observation": json.dumps({**receipt, "approval_id": "a2"})}))
    last = state(workspace, task_id)["state"]["records"][-1]
    assert last["id"] == again["adapter_records"][0] and json.loads(last["text"])["proposal"] is None


def test_record_capacity_never_blocks_release_or_close(workspace):
    task = start(workspace)
    task_id = task["task_id"]
    filled = ok(invoke(workspace, "context", {"task_id": task_id, "base_revision": task["revision"],
                                              "records": [{"id": f"F{index}", "kind": "fact", "text": "x"} for index in range(512)]}))
    assert filled["Task Context"]["Current Record Count"] == 512
    released = run_dispatch(workspace, task_id, 7, terminal="finish")
    assert released["adapter_records"] == [] and released["unrecorded_reason"] == "CORE_RECORD_CAPACITY: state list exceeds limit"
    (unrecorded,) = released["unrecorded"]
    assert unrecorded["kind"] == "dsh-dispatch" and json.loads(unrecorded["text"])["reservation"] == reservation(7)
    current = state(workspace, task_id)["state"]
    assert current["active_work"] == [] and len(current["records"]) == 512
    closed = ok(invoke(workspace, "close", {"task_id": task_id, "base_revision": current["revision"], "decision": "Closing at record capacity."}))
    assert closed["status"] == "DONE"


def test_children_cannot_write_adapter_records_through_task_context(workspace):
    task = start(workspace)
    forged = invoke(workspace, "context", {"task_id": task["task_id"], "base_revision": task["revision"],
                                           "records": [{"id": "X", "kind": "dsh-dispatch", "text": "forged", "producer": "dsh:adapter"}]})
    assert not forged["ok"] and "TASK_CONTEXT_RECORD_PROVENANCE" in forged["error"]
    # A Controller record of the same kind keeps Controller provenance and is not dispatch history.
    recorded = ok(invoke(workspace, "context", {"task_id": task["task_id"], "base_revision": task["revision"],
                                                "records": [{"id": "X", "kind": "dsh-dispatch", "text": "Controller note"}]}))
    assert recorded["Task Context"]["Current Record Count"] == 1
    assert ok(invoke(workspace, "status", {"task_id": task["task_id"]}))["Dispatch History"]["count"] == 0
