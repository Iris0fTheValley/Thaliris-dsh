"""Exercise the real one-shot process and neutral Core, with no DSH doubles."""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys

import pytest

BRIDGE = Path(__file__).resolve().parents[1] / "core_bridge.py"
CORE_PATH = os.environ.get("THALIRIS_CORE_PATH")
if not CORE_PATH:
    raise RuntimeError("Set THALIRIS_CORE_PATH to the main Thaliris source import root.")
SOURCE = Path(CORE_PATH).resolve()
CONTRACT = {"human_instruction": "Selected fixture instruction", "boundary": "Temporary fixture", "invariants": "Controller selects semantics", "acceptance": "Explicit Controller decision", "execution_mode": "delegated"}


@pytest.fixture
def workspace(tmp_path):
    root = tmp_path / "repo"
    root.mkdir()
    subprocess.run(["git", "init", "-q", str(root)], check=True)
    return {"protocol": 1, "core_path": str(SOURCE), "root": str(root), "authority_directory": str(tmp_path / "authority"), "native_controller_id": "native-root", "native_workspace_id": "native-workspace"}


def invoke(workspace, operation, arguments, **changes):
    payload = {**workspace, "operation": operation, "arguments": arguments, **changes}
    process = subprocess.run([sys.executable, "-I", str(BRIDGE)], input=json.dumps(payload), text=True, capture_output=True, check=False)
    assert process.stderr == ""
    response = json.loads(process.stdout)
    assert response["protocol"] == 1
    assert process.returncode == (0 if response["ok"] else 1)
    return response


def start(workspace):
    result = invoke(workspace, "start", {"goal": "Bounded bridge fixture", "contract": CONTRACT})
    assert result["ok"]
    return result["result"]


def authority_key(workspace):
    root = Path(workspace["root"]).resolve()
    identity = str(root).casefold() if os.name == "nt" else str(root)
    return hashlib.sha256(identity.encode()).hexdigest()


def legacy_anchor_path(workspace):
    return Path(workspace["authority_directory"]) / (authority_key(workspace) + ".json")


def task_anchor_path(workspace, task_id):
    return Path(workspace["authority_directory"]) / authority_key(workspace) / (task_id + ".json")


def make_directory_link(link, target):
    if os.name == "nt":
        result = subprocess.run(["cmd", "/c", "mklink", "/J", str(link), str(target)], text=True, capture_output=True)
        assert result.returncode == 0, result.stdout + result.stderr
    else:
        link.symlink_to(target, target_is_directory=True)

def state_path(workspace, task_id):
    context = Path(workspace["root"]) / ".context"
    legacy = context / "state.json"
    if legacy.is_file() and json.loads(legacy.read_text()).get("task_id") == task_id:
        return legacy
    return context / "tasks" / task_id / "state.json"


def state_bytes(workspace, task_id):
    return state_path(workspace, task_id).read_bytes()


def authority_path(workspace, task_id):
    anchors = [path for path in Path(workspace["authority_directory"]).rglob("*.json")
               if json.loads(path.read_text()).get("task_id") == task_id]
    assert len(anchors) == 1
    return anchors[0]


def authority_bytes(workspace, task_id):
    return authority_path(workspace, task_id).read_bytes()


def test_same_core_task_explicit_close_and_external_anchor(workspace):
    task = start(workspace)
    assert task["status"] == "ACTIVE"
    assert not (Path(workspace["root"]) / "AGENTS.md").exists()
    inspected = invoke(workspace, "inspect", {"task_id": task["task_id"]})["result"]
    assert inspected["state"]["task_id"] == task["task_id"]
    assert inspected["contract"] == CONTRACT
    begun = invoke(workspace, "begin", {"task_id": task["task_id"], "base_revision": 1, "observation": json.dumps({"correlation": "selected", "workstream": "fixture", "role": "editable", "handoff_sha256": "digest"})})["result"]
    assert begun["revision"] == 2
    finished = invoke(workspace, "finish", {"task_id": task["task_id"], "base_revision": 2, "observation": json.dumps({"correlation": "selected", "workstream": "fixture", "role": "editable", "handoff_sha256": "digest", "child_id": "native-child", "stop_reason": "error"})})["result"]
    assert finished["revision"] == 3 and finished["status"] == "ACTIVE"
    closed = invoke(workspace, "close", {"task_id": task["task_id"], "base_revision": 3, "decision": "Controller decided the bounded goal is achieved."})["result"]
    assert closed["status"] == "DONE" and closed["revision"] == 5
    anchor = json.loads(authority_path(workspace, task["task_id"]).read_text())
    assert anchor["task_id"] == task["task_id"] and anchor["status"] == "DONE"
    assert anchor["dsh_controller_id"] == "native-root"
    assert anchor["contract"] == CONTRACT
    closed_state = json.loads(state_bytes(workspace, task["task_id"]))
    assert closed_state["pending_results"] == [] and closed_state["active_work"] == []
    dispatch, decision = closed_state["records"]
    assert (dispatch["kind"], dispatch["producer"], dispatch["revision"]) == ("dsh-dispatch", "dsh:adapter", 3)
    assert json.loads(dispatch["text"])["result"]["stop_reason"] == "error"
    assert (decision["kind"], decision["producer"]) == ("dsh-close-decision", "dsh:controller")
    assert "Controller close decision" in decision["text"]
    assert anchor["provenance"] == "SELECTED_TASK_INTENT"
    assert "host_actor_assurance" not in anchor
    assert "death_proof" not in anchor and "child_death_proof" not in anchor
    assert not list((Path(workspace["root"]) / ".context").glob("dsh-input-*"))


def test_independent_task_starts_while_old_active_task_has_orphan_reservation(workspace):
    old = start(workspace)
    reservation = json.dumps({"correlation": "orphan", "workstream": "old", "role": "editable", "handoff_sha256": "old-digest"})
    old_state = invoke(workspace, "begin", {"task_id": old["task_id"], "base_revision": old["revision"], "observation": reservation})["result"]
    assert old_state["status"] == "ACTIVE"

    current = start(workspace)
    assert current["task_id"] != old["task_id"]
    inspected = invoke(workspace, "inspect", {"task_id": current["task_id"]})["result"]
    assert inspected["state"]["status"] == "ACTIVE"
    assert inspected["state"]["active_work"] == []
    omitted = invoke(workspace, "inspect", {})
    assert not omitted["ok"] and omitted["error"] == "TASK_ID_REQUIRED"
    closed = invoke(workspace, "close", {"task_id": current["task_id"], "base_revision": current["revision"], "decision": "Independent task accepted."})
    assert closed["ok"] and closed["result"]["status"] == "DONE"

    old_again = invoke(workspace, "inspect", {"task_id": old["task_id"]})["result"]["state"]
    assert old_again["status"] == "ACTIVE" and old_again["active_work"] == [reservation]


def test_corrupt_old_task_authority_does_not_block_independent_task(workspace):
    old = start(workspace)
    current = start(workspace)
    old_anchor = authority_path(workspace, old["task_id"])
    old_anchor.write_text("{damaged old authority\n")

    inspected = invoke(workspace, "inspect", {"task_id": current["task_id"]})
    assert inspected["ok"] and inspected["result"]["state"]["task_id"] == current["task_id"]
    assert not invoke(workspace, "inspect", {"task_id": old["task_id"]})["ok"]


def test_two_task_ledgers_and_reservations_interleave_without_crossing(workspace):
    first, second = start(workspace), start(workspace)
    first_reservation = {"correlation": "first", "workstream": "alpha", "role": "editable", "handoff_sha256": "alpha"}
    second_reservation = {"correlation": "second", "workstream": "beta", "role": "editable", "handoff_sha256": "beta"}
    first_begun = invoke(workspace, "begin", {"task_id": first["task_id"], "base_revision": 1, "observation": json.dumps(first_reservation)})["result"]
    first_before_stale = state_bytes(workspace, first["task_id"])
    stale = invoke(workspace, "begin", {"task_id": first["task_id"], "base_revision": 1, "observation": "stale competing update"})
    assert not stale["ok"] and stale["error"] == "TASK_ID_OR_REVISION_CONFLICT"
    assert state_bytes(workspace, first["task_id"]) == first_before_stale
    assert invoke(workspace, "inspect", {"task_id": second["task_id"]})["result"]["state"]["revision"] == 1
    second_begun = invoke(workspace, "begin", {"task_id": second["task_id"], "base_revision": 1, "observation": json.dumps(second_reservation)})["result"]
    first_done = invoke(workspace, "finish", {"task_id": first["task_id"], "base_revision": first_begun["revision"], "observation": json.dumps({**first_reservation, "child_id": "child-alpha", "stop_reason": "completed"})})["result"]
    assert first_done["revision"] == 3
    assert invoke(workspace, "inspect", {"task_id": second["task_id"]})["result"]["state"]["active_work"] == [json.dumps(second_reservation)]
    second_done = invoke(workspace, "finish", {"task_id": second["task_id"], "base_revision": second_begun["revision"], "observation": json.dumps({**second_reservation, "child_id": "child-beta", "stop_reason": "completed"})})["result"]
    assert second_done["revision"] == 3
    assert invoke(workspace, "inspect", {"task_id": first["task_id"]})["result"]["state"]["active_work"] == []
    assert invoke(workspace, "inspect", {"task_id": second["task_id"]})["result"]["state"]["active_work"] == []


@pytest.mark.parametrize(
    ("operation", "arguments", "error"),
    [
        ("begin", {"observation": "replacement Workstream"}, "UNRESOLVED_ACTIVE_WORK_CANNOT_BEGIN"),
        ("close", {"decision": "Controller says done."}, "UNRESOLVED_ACTIVE_WORK_CANNOT_CLOSE"),
    ],
)
def test_unresolved_work_rejects_replacement_and_close_without_mutation(workspace, operation, arguments, error):
    task = start(workspace)
    reservation = "selected Workstream/role/handoff digest"
    begun = invoke(workspace, "begin", {"task_id": task["task_id"], "base_revision": task["revision"], "observation": reservation})["result"]
    assert begun["revision"] == 2
    state_before = state_bytes(workspace, task["task_id"])
    anchor_before = authority_bytes(workspace, task["task_id"])

    blocked = invoke(workspace, operation, {"task_id": task["task_id"], "base_revision": begun["revision"], **arguments})
    assert not blocked["ok"]
    assert blocked["error"] == error
    assert state_bytes(workspace, task["task_id"]) == state_before
    assert authority_bytes(workspace, task["task_id"]) == anchor_before
    inspected = invoke(workspace, "inspect", {"task_id": task["task_id"]})["result"]["state"]
    assert inspected["active_work"] == [reservation]
    assert inspected["pending_results"] == []


@pytest.mark.parametrize("operation,args", [("recover", {}), ("expand", {}), ("close", {"task_id": "wrong", "base_revision": 1, "decision": "done"})])
def test_unsupported_or_conflicting_operations_preserve_ledger(workspace, operation, args):
    task = start(workspace)
    before = state_bytes(workspace, task["task_id"])
    assert not invoke(workspace, operation, args)["ok"]
    assert state_bytes(workspace, task["task_id"]) == before


def test_native_id_mismatch_stale_revision_and_caller_actor_rejected(workspace):
    task = start(workspace)
    before = state_bytes(workspace, task["task_id"])
    assert "MISMATCH" in invoke(workspace, "inspect", {"task_id": task["task_id"]}, native_controller_id="child-id")["error"]
    assert not invoke(workspace, "close", {"task_id": task["task_id"], "base_revision": 2, "decision": "done"})["ok"]
    assert not invoke(workspace, "inspect", {"task_id": task["task_id"]}, actor="native-root")["ok"]
    assert state_bytes(workspace, task["task_id"]) == before


def test_corrupt_legacy_anchor_does_not_block_new_task(workspace):
    legacy = legacy_anchor_path(workspace)
    legacy.parent.mkdir(parents=True)
    damaged = b"{damaged legacy authority"
    legacy.write_bytes(damaged)

    current = start(workspace)

    assert task_anchor_path(workspace, current["task_id"]).is_file()
    assert legacy.read_bytes() == damaged


@pytest.mark.skipif(os.name != "nt", reason="Windows Junction regression")
def test_legacy_anchor_junction_does_not_block_new_task(workspace, tmp_path):
    authority_directory = Path(workspace["authority_directory"])
    authority_directory.mkdir(parents=True)
    external = tmp_path / "external-legacy-anchor"
    external.mkdir()
    sentinel = external / "preserve.txt"
    sentinel.write_text("user-owned bytes")
    legacy = legacy_anchor_path(workspace)
    make_directory_link(legacy, external)

    current = start(workspace)

    assert current["status"] == "ACTIVE"
    assert task_anchor_path(workspace, current["task_id"]).is_file()
    assert legacy.resolve() == external.resolve()
    assert sentinel.read_text() == "user-owned bytes"


def test_redirected_task_anchor_key_still_fails(workspace, tmp_path):
    authority_directory = Path(workspace["authority_directory"])
    authority_directory.mkdir(parents=True)
    redirected_key = authority_directory / authority_key(workspace)
    external = tmp_path / "external-task-anchor"
    external.mkdir()
    sentinel = external / "preserve.txt"
    sentinel.write_text("user-owned bytes")
    make_directory_link(redirected_key, external)

    denied = invoke(workspace, "start", {"goal": "redirected task anchor", "contract": CONTRACT})

    assert not denied["ok"]
    assert "TASK_AUTHORITY_EXTERNAL_LOCATION_UNSAFE" in denied["error"]
    assert sentinel.read_text() == "user-owned bytes"
    state_files = list((Path(workspace["root"]) / ".context" / "tasks").glob("*/state.json"))
    assert len(state_files) == 1
    assert json.loads(state_files[0].read_text())["status"] == "ACTIVE"

def test_unsafe_external_location_fails_before_init(workspace):
    response = invoke(workspace, "start", {"goal": "fixture", "contract": CONTRACT}, authority_directory=str(Path(workspace["root"]) / "authority"))
    assert not response["ok"]
    assert "EXTERNAL_LOCATION_UNSAFE" in response["error"]
    assert not (Path(workspace["root"]) / ".context").exists()


def test_security_conflict_does_not_bless_new_bytes(workspace):
    start(workspace)
    task = start(workspace)
    before = state_bytes(workspace, task["task_id"])
    (Path(workspace["root"]) / ".context/config.json").write_text("{}\n")
    assert "SECURITY_CHANGED" in invoke(workspace, "inspect", {"task_id": task["task_id"]})["error"]
    assert state_bytes(workspace, task["task_id"]) == before


def test_invalid_contract_and_oversized_request(workspace):
    assert not invoke(workspace, "start", {"goal": "fixture", "contract": {**CONTRACT, "execution_mode": "guessed"}})["ok"]
    assert not (Path(workspace["root"]) / ".context").exists()
    process = subprocess.run([sys.executable, "-I", str(BRIDGE)], input=" " * 262145, text=True, capture_output=True, check=False)
    assert process.returncode == 1
    assert json.loads(process.stdout)["error"] == "BRIDGE_REQUEST_TOO_LARGE"


def test_bridge_imports_no_codex_facade(workspace):
    code = '''
import importlib.abc, importlib.util, json, sys
class BlockCodex(importlib.abc.MetaPathFinder):
        def find_spec(self, fullname, path=None, target=None):
            if fullname in {"thaliris.cli", "thaliris.task_authority", "thaliris.codex", "thaliris.hooks", "thaliris.runtime_identity"}:
                raise AssertionError("Neutral bridge attempted Codex import: " + fullname)
            return None
spec = importlib.util.spec_from_file_location("dsh_bridge_under_test", sys.argv[1])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
sys.meta_path.insert(0, BlockCodex())
result = module.dispatch(json.loads(sys.stdin.read()))
assert result["status"] == "ACTIVE"
assert "thaliris.task_authority" not in sys.modules
assert "thaliris.cli" not in sys.modules
print("neutral imports verified")
'''
    process = subprocess.run([sys.executable, "-I", "-c", code, str(BRIDGE)], input=json.dumps({**workspace, "operation": "start", "arguments": {"goal": "neutral import fixture", "contract": CONTRACT}}), text=True, capture_output=True, check=False)
    assert process.returncode == 0, process.stderr
    assert process.stdout.strip() == "neutral imports verified"


def test_correlated_binding_and_unknown_reconciliation_preserve_original(workspace):
    task = start(workspace)
    reservation = {"correlation": "unique", "workstream": "selected", "role": "editable", "handoff_sha256": "digest"}
    invoke(workspace, "begin", {"task_id": task["task_id"], "base_revision": 1, "observation": json.dumps(reservation)})
    bound = invoke(workspace, "bind", {"task_id": task["task_id"], "base_revision": 2, "observation": json.dumps({**reservation, "child_id": "native-child"})})
    assert bound["ok"] and bound["result"]["revision"] == 3
    preserved = state_bytes(workspace, task["task_id"]), authority_bytes(workspace, task["task_id"])
    for observation in ({**reservation, "child_id": "other-child"}, {**reservation, "child_id": "native-child", "outcome": "UNKNOWN", "provenance": "native-session-turn/end"}):
        denied = invoke(workspace, "reconcile", {"task_id": task["task_id"], "base_revision": 3, "observation": json.dumps(observation)})
        assert not denied["ok"]
        assert (state_bytes(workspace, task["task_id"]), authority_bytes(workspace, task["task_id"])) == preserved
    reconciled = invoke(workspace, "reconcile", {"task_id": task["task_id"], "base_revision": 3, "observation": json.dumps({**reservation, "child_id": "native-child", "outcome": "error", "provenance": "native-session-turn/end"})})
    assert reconciled["ok"] and reconciled["result"]["status"] == "ACTIVE"
    state = invoke(workspace, "inspect", {"task_id": task["task_id"]})["result"]["state"]
    assert state["active_work"] == [] and state["pending_results"] == []
    archive = json.loads(state["records"][-1]["text"])
    assert archive["operation"] == "reconcile" and archive["reservation"] == {**reservation, "child_id": "native-child"}
    assert archive["result"]["outcome"] == "error"
    assert not invoke(workspace, "inspect", {"task_id": task["task_id"]}, native_workspace_id="other-workspace")["ok"]


# Explicit Controller recovery: rollback of an unanchored write, dispose of an unresolvable
# reservation and attach of a new root. Nothing here is automatic or widens a refusal.

RESERVATION = {"correlation": "thaliris:lost", "workstream": "selected", "role": "editable", "handoff_sha256": "digest"}


def ok(response):
    assert response["ok"], response
    return response["result"]


def files(workspace, task_id):
    return state_bytes(workspace, task_id), task_anchor_path(workspace, task_id).read_bytes()


def anchor_digest(workspace, task_id):
    return hashlib.sha256(task_anchor_path(workspace, task_id).read_bytes()).hexdigest()


def unanchored(workspace, task_id, operation, arguments):
    """Run one write, then put the previous anchor bytes back: the write landed but its checkpoint did not."""
    anchor = task_anchor_path(workspace, task_id)
    before = anchor.read_bytes()
    result = ok(invoke(workspace, operation, {"task_id": task_id, **arguments}))
    anchor.write_bytes(before)
    return result


def test_state_changed_is_explained_never_accepted_and_rollback_restores_the_anchor(workspace):
    task = start(workspace)
    task_id = task["task_id"]
    begun = ok(invoke(workspace, "begin", {"task_id": task_id, "base_revision": 1, "observation": json.dumps(RESERVATION)}))
    anchored_state = state_bytes(workspace, task_id)
    unanchored(workspace, task_id, "finish", {"base_revision": begun["revision"], "observation": json.dumps({**RESERVATION, "child_id": "native-child", "stop_reason": "completed"})})
    changed = files(workspace, task_id)

    refused = invoke(workspace, "inspect", {"task_id": task_id})
    assert not refused["ok"] and refused["error"] == "TASK_AUTHORITY_STATE_CHANGED" and refused["code"] == "TASK_AUTHORITY_STATE_CHANGED"
    assert "thaliris_task_recover action rollback" in refused["recovery"]
    assert refused["details"] == {"task_id": task_id, "authority_sha256": anchor_digest(workspace, task_id), "anchored_controller": "this-session",
                                  "anchored_revision": 2, "ledger_revision": 3}
    # Never accepted on its own: every operation still refuses and nothing is re-anchored.
    for operation, arguments in (("status", {}), ("begin", {"base_revision": 3, "observation": json.dumps(RESERVATION)}), ("close", {"base_revision": 3, "decision": "done"})):
        assert invoke(workspace, operation, {"task_id": task_id, **arguments})["error"] == "TASK_AUTHORITY_STATE_CHANGED"
    other = invoke(workspace, "inspect", {"task_id": task_id}, native_workspace_id="other-workspace")
    assert other["error"] == "TASK_AUTHORITY_STATE_CHANGED" and "details" not in other
    resumed = ok(invoke(workspace, "resume", {}))
    assert resumed["tasks"] == [] and resumed["unreadable_count"] == 0 and resumed["recovery_required_count"] == 1
    assert resumed["recovery_required"][0]["task_id"] == task_id and resumed["recovery_required"][0]["ledger_revision"] == 3
    assert files(workspace, task_id) == changed

    digest = anchor_digest(workspace, task_id)
    for arguments, changes, error in (
        ({"expected_authority_sha256": digest, "reason": "Controller rollback"}, {"native_controller_id": "child-id"}, "DSH_CONTROLLER_MISMATCH_OR_INACTIVE"),
        ({"expected_authority_sha256": digest, "reason": "Controller rollback"}, {"native_workspace_id": "other-workspace"}, "DSH_CONTROLLER_MISMATCH_OR_INACTIVE"),
        ({"expected_authority_sha256": "0" * 64, "reason": "Controller rollback"}, {}, "TASK_AUTHORITY_CHANGED"),
        ({"expected_authority_sha256": digest, "reason": " "}, {}, "INVALID_RECOVERY_ARGUMENTS"),
        ({"expected_authority_sha256": digest}, {}, "INVALID_RECOVERY_ARGUMENTS"),
    ):
        denied = invoke(workspace, "recover", {"task_id": task_id, **arguments}, **changes)
        assert not denied["ok"] and denied["error"] == error, denied
        assert files(workspace, task_id) == changed

    recovered = ok(invoke(workspace, "recover", {"task_id": task_id, "expected_authority_sha256": digest, "reason": "Bridge timed out before the finish was anchored"}))
    assert recovered["status"] == "TASK_AUTHORITY_RECOVERED" and recovered["rolled_back"] is True
    assert (recovered["revision"], recovered["discarded_revision"], recovered["active_work"]) == (2, 3, 1)
    assert state_bytes(workspace, task_id) == anchored_state
    archive = Path(recovered["archive"])
    assert archive.is_relative_to(Path(workspace["authority_directory"])) and (archive / "authority.json").read_bytes() == changed[1]
    assert changed[0] in [path.read_bytes() for path in archive.rglob("state.json")]
    anchor = json.loads(task_anchor_path(workspace, task_id).read_bytes())
    assert anchor["recoveries"][-1]["reason"] == "Bridge timed out before the finish was anchored"
    assert (anchor["dsh_controller_id"], anchor["contract"], anchor["status"]) == ("native-root", CONTRACT, "ACTIVE")
    # A healthy ledger is never rolled back.
    healthy = invoke(workspace, "recover", {"task_id": task_id, "expected_authority_sha256": anchor_digest(workspace, task_id), "reason": "again"})
    assert not healthy["ok"] and healthy["error"].startswith("TASK_AUTHORITY_RECOVERY_NOT_REQUIRED")
    # The next legal operations succeed: the reappeared reservation is released, then the task closes.
    finished = ok(invoke(workspace, "finish", {"task_id": task_id, "base_revision": 2, "observation": json.dumps({**RESERVATION, "child_id": "native-child", "stop_reason": "completed"})}))
    assert finished["revision"] == 3
    assert ok(invoke(workspace, "close", {"task_id": task_id, "base_revision": 3, "decision": "Controller accepted."}))["status"] == "DONE"


def test_rolled_back_begin_is_dispatched_again(workspace):
    task = start(workspace)
    task_id = task["task_id"]
    unanchored(workspace, task_id, "begin", {"base_revision": 1, "observation": json.dumps(RESERVATION)})
    assert invoke(workspace, "inspect", {"task_id": task_id})["error"] == "TASK_AUTHORITY_STATE_CHANGED"
    recovered = ok(invoke(workspace, "recover", {"task_id": task_id, "expected_authority_sha256": anchor_digest(workspace, task_id), "reason": "begin was never confirmed"}))
    assert (recovered["revision"], recovered["active_work"]) == (1, 0)
    assert ok(invoke(workspace, "begin", {"task_id": task_id, "base_revision": 1, "observation": json.dumps(RESERVATION)}))["revision"] == 2


def test_security_change_is_not_recoverable_here(workspace):
    task = start(workspace)
    task_id = task["task_id"]
    unanchored(workspace, task_id, "begin", {"base_revision": 1, "observation": json.dumps(RESERVATION)})
    (Path(workspace["root"]) / ".context/config.json").write_text("{}\n")
    before = files(workspace, task_id)
    denied = invoke(workspace, "recover", {"task_id": task_id, "expected_authority_sha256": anchor_digest(workspace, task_id), "reason": "rollback"})
    assert not denied["ok"] and denied["error"] == "TASK_AUTHORITY_SECURITY_CHANGED"
    assert files(workspace, task_id) == before and (Path(workspace["root"]) / ".context/config.json").read_text() == "{}\n"
    assert not (Path(workspace["authority_directory"]) / "recovery").exists()


def test_dispose_releases_only_the_slot_and_never_records_completion(workspace):
    task = start(workspace)
    task_id = task["task_id"]
    ok(invoke(workspace, "register", {"task_id": task_id, "base_revision": 1, "requirements": [{"id": "R1", "workchain_ref": "W1"}]}))
    selected = {**RESERVATION, "evidence_handoff_id": "Hlost1"}
    begun = ok(invoke(workspace, "begin", {"task_id": task_id, "base_revision": 2, "observation": json.dumps(selected),
                                           "evidence": {"handoff_id": "Hlost1", "candidate": "C1", "requirement_refs": ["R1"]}}))
    bound = ok(invoke(workspace, "bind", {"task_id": task_id, "base_revision": begun["revision"], "observation": json.dumps({**selected, "child_id": "native-child"})}))
    ok(invoke(workspace, "observe", {"task_id": task_id, "handoff_id": "Hlost1", "child_id": "native-child", "observation": {"id": "O1", "text": "kept fact", "source_refs": ["S1"], "sources": [{"id": "S1", "kind": "local", "locator": "a.py:1", "summary": "exact"}]}}))
    revision = ok(invoke(workspace, "inspect", {"task_id": task_id}))["state"]["revision"]
    preserved = files(workspace, task_id)
    liveness = {"correlation": selected["correlation"], "child_id": "native-child", "child_liveness": "not-resident"}
    for arguments, changes, error in (
        ({"reason": "lost", "observation": json.dumps(liveness)}, {"native_controller_id": "child-id"}, "DSH_CONTROLLER_MISMATCH_OR_INACTIVE"),
        ({"observation": json.dumps(liveness)}, {}, "INVALID_DISPOSE_ARGUMENTS"),
        ({"reason": " \n\t", "observation": json.dumps(liveness)}, {}, "INVALID_DISPOSE_ARGUMENTS"),
        ({"reason": "x" * 3501, "observation": json.dumps(liveness)}, {}, "INVALID_DISPOSE_ARGUMENTS"),
        ({"reason": "lost", "observation": json.dumps({**liveness, "outcome": "completed"})}, {}, "DISPOSE_OBSERVATION_FIELDS"),
        ({"reason": "lost", "observation": json.dumps({**liveness, "child_liveness": "dead"})}, {}, "DISPOSE_OBSERVATION_FIELDS"),
        ({"reason": "lost", "observation": json.dumps({**liveness, "correlation": "thaliris:other"})}, {}, "NATIVE_RESERVATION_CONFLICT"),
        ({"reason": "lost", "observation": json.dumps({**liveness, "child_id": "other-child"})}, {}, "NATIVE_RESERVATION_CONFLICT"),
    ):
        denied = invoke(workspace, "dispose", {"task_id": task_id, "base_revision": revision, **arguments}, **changes)
        assert not denied["ok"] and denied["error"].startswith(error), denied
        assert files(workspace, task_id) == preserved
    stale = invoke(workspace, "dispose", {"task_id": task_id, "base_revision": revision - 1, "reason": "lost", "observation": json.dumps(liveness)})
    assert stale["error"] == "TASK_ID_OR_REVISION_CONFLICT" and files(workspace, task_id) == preserved
    # Without native terminal evidence reconcile still refuses to release.
    assert not invoke(workspace, "reconcile", {"task_id": task_id, "base_revision": revision, "observation": json.dumps({**selected, "child_id": "native-child", "outcome": "completed", "provenance": "controller"})})["ok"]

    disposed = ok(invoke(workspace, "dispose", {"task_id": task_id, "base_revision": revision, "reason": "Root crashed; the child Session file is gone", "observation": json.dumps(liveness)}))
    assert (disposed["outcome"], disposed["native_outcome"], disposed["revision"]) == ("disposed", "UNKNOWN", revision + 1)
    state = ok(invoke(workspace, "inspect", {"task_id": task_id}))["state"]
    assert state["active_work"] == [] and state["status"] == "ACTIVE"
    archive = json.loads(state["records"][-1]["text"])
    assert state["records"][-1]["kind"] == "dsh-dispatch" and archive["operation"] == "dispose" and archive["reservation"] == {**selected, "child_id": "native-child"}
    assert archive["result"] == {"outcome": "disposed", "native_outcome": "UNKNOWN", "child_id": "native-child", "child_liveness": "not-resident",
                                 "reason": "Root crashed; the child Session file is gone", "provenance": "controller-dispose"}
    # Evidence and its handoff stay; the dispatch counts as not completed.
    assert [item["id"] for item in state["evidence_continuity"]["observations"]] == ["Hlost1.O1"]
    assert [item["id"] for item in state["evidence_continuity"]["handoffs"]] == ["Hlost1"]
    history = ok(invoke(workspace, "status", {"task_id": task_id}))["Dispatch History"]
    assert history["count"] == 1 and history["non_completed"][0]["outcome"] == "disposed"
    late = invoke(workspace, "observe", {"task_id": task_id, "handoff_id": "Hlost1", "child_id": "native-child", "observation": {"id": "O2", "text": "late", "source_refs": ["Hlost1.S1"]}})
    assert not late["ok"] and "OBSERVATION_DISPATCH_FINISHED" in late["error"]
    assert not invoke(workspace, "dispose", {"task_id": task_id, "base_revision": revision + 1, "reason": "again", "observation": json.dumps(liveness)})["ok"]
    assert ok(invoke(workspace, "begin", {"task_id": task_id, "base_revision": revision + 1, "observation": json.dumps({**RESERVATION, "correlation": "thaliris:next"})}))["revision"] == revision + 2


def test_unbound_reservation_without_json_is_disposable(workspace):
    task = start(workspace)
    begun = ok(invoke(workspace, "begin", {"task_id": task["task_id"], "base_revision": 1, "observation": "legacy reservation text"}))
    disposed = ok(invoke(workspace, "dispose", {"task_id": task["task_id"], "base_revision": begun["revision"], "reason": "subagent start failed",
                                                "observation": json.dumps({"child_liveness": "UNKNOWN", "liveness_reason": "no correlated child"})}))
    assert disposed["outcome"] == "disposed"
    assert ok(invoke(workspace, "close", {"task_id": task["task_id"], "base_revision": disposed["revision"], "decision": "Abandoned dispatch, accepted."}))["status"] == "DONE"


def test_attach_moves_the_single_controller_anchor_and_keeps_the_task(workspace):
    task = start(workspace)
    task_id = task["task_id"]
    ok(invoke(workspace, "context", {"task_id": task_id, "base_revision": 1, "records": [{"id": "F1", "kind": "fact", "text": "carried over"}]}))
    begun = ok(invoke(workspace, "begin", {"task_id": task_id, "base_revision": 2, "observation": json.dumps(RESERVATION)}))
    before = files(workspace, task_id)
    new_root = {"native_controller_id": "new-root"}

    refused = invoke(workspace, "inspect", {"task_id": task_id}, **new_root)
    assert refused["error"] == "DSH_CONTROLLER_MISMATCH_OR_INACTIVE" and refused["code"] == "DSH_CONTROLLER_ANCHORED_ELSEWHERE"
    digest = refused["details"]["authority_sha256"]
    assert digest == anchor_digest(workspace, task_id) and "thaliris_task_recover action attach" in refused["recovery"]
    listed = ok(invoke(workspace, "resume", {}, **new_root))
    assert listed["tasks"] == [] and listed["attachable_count"] == 1
    assert listed["attachable"] == [{"task_id": task_id, "goal": "Bounded bridge fixture", "execution_mode": "delegated", "authority_sha256": digest, "state_changed": False}]
    assert ok(invoke(workspace, "resume", {}, native_workspace_id="other-workspace", **new_root))["attachable_count"] == 0

    attach = {"task_id": task_id, "expected_authority_sha256": digest, "reason": "User continues the task in a new session", "rollback": False}
    for arguments, changes, error in (
        (attach, {"native_controller_id": "new-root", "native_workspace_id": "other-workspace"}, "DSH_CONTROLLER_MISMATCH_OR_INACTIVE"),
        (attach, {}, "DSH_CONTROLLER_ALREADY_ATTACHED"),
        ({**attach, "expected_authority_sha256": "0" * 64}, new_root, "TASK_AUTHORITY_CHANGED"),
        ({**attach, "rollback": True}, new_root, "TASK_AUTHORITY_RECOVERY_NOT_REQUIRED"),
        ({**attach, "reason": ""}, new_root, "INVALID_RECOVERY_ARGUMENTS"),
        ({key: value for key, value in attach.items() if key != "rollback"}, new_root, "INVALID_RECOVERY_ARGUMENTS"),
    ):
        denied = invoke(workspace, "attach", arguments, **changes)
        assert not denied["ok"] and denied["error"].startswith(error), denied
        assert files(workspace, task_id) == before

    attached = ok(invoke(workspace, "attach", attach, **new_root))
    assert (attached["status"], attached["rolled_back"], attached["revision"], attached["active_work"]) == ("DSH_CONTROLLER_ATTACHED", False, 3, 1)
    assert "carried over" in attached["task_context"]
    assert state_bytes(workspace, task_id) == before[0], "the ledger, its records and Active Work are unchanged"
    anchor = json.loads(task_anchor_path(workspace, task_id).read_bytes())
    previous = json.loads(before[1])
    assert anchor["dsh_controller_id"] == "new-root" and anchor["dsh_workspace_id"] == "native-workspace"
    assert {key: anchor[key] for key in ("task_id", "goal", "contract", "status", "state_sha256")} == {key: previous[key] for key in ("task_id", "goal", "contract", "status", "state_sha256")}
    assert anchor["dsh_attachments"] == [{"previous_controller_id": "native-root", "reason": "User continues the task in a new session", "rollback": False}]
    # Single Controller anchor: the previous root is refused, the new one continues the same task.
    for operation, arguments in (("inspect", {}), ("finish", {"base_revision": 3, "observation": json.dumps({**RESERVATION, "child_id": "c", "stop_reason": "completed"})})):
        assert invoke(workspace, operation, {"task_id": task_id, **arguments})["error"] == "DSH_CONTROLLER_MISMATCH_OR_INACTIVE"
    assert ok(invoke(workspace, "resume", {}))["tasks"] == []
    disposed = ok(invoke(workspace, "dispose", {"task_id": task_id, "base_revision": begun["revision"], "reason": "dispatched by the previous root",
                                                "observation": json.dumps({"correlation": RESERVATION["correlation"], "child_liveness": "UNKNOWN"})}, **new_root))
    assert ok(invoke(workspace, "close", {"task_id": task_id, "base_revision": disposed["revision"], "decision": "Accepted in the new session."}, **new_root))["status"] == "DONE"


def test_attach_to_a_changed_ledger_requires_an_explicit_rollback(workspace):
    task = start(workspace)
    task_id = task["task_id"]
    unanchored(workspace, task_id, "begin", {"base_revision": 1, "observation": json.dumps(RESERVATION)})
    new_root = {"native_controller_id": "new-root"}
    refused = invoke(workspace, "inspect", {"task_id": task_id}, **new_root)
    assert refused["error"] == "TASK_AUTHORITY_STATE_CHANGED" and refused["details"]["anchored_controller"] == "another-root"
    assert "attach-and-rollback" in refused["recovery"]
    assert ok(invoke(workspace, "resume", {}, **new_root))["attachable"][0]["state_changed"] is True
    changed = files(workspace, task_id)
    digest = anchor_digest(workspace, task_id)
    plain = invoke(workspace, "attach", {"task_id": task_id, "expected_authority_sha256": digest, "reason": "continue", "rollback": False}, **new_root)
    assert plain["error"] == "TASK_AUTHORITY_STATE_CHANGED" and files(workspace, task_id) == changed
    attached = ok(invoke(workspace, "attach", {"task_id": task_id, "expected_authority_sha256": digest, "reason": "continue; discard the unconfirmed begin", "rollback": True}, **new_root))
    assert (attached["rolled_back"], attached["discarded_revision"], attached["revision"], attached["active_work"]) == (True, 2, 1, 0)
    assert ok(invoke(workspace, "begin", {"task_id": task_id, "base_revision": 1, "observation": json.dumps(RESERVATION)}, **new_root))["revision"] == 2


def test_resume_reports_tasks_it_does_not_show(workspace):
    tasks = [start(workspace) for _ in range(5)]
    resumed = ok(invoke(workspace, "resume", {}))
    assert resumed["task_count"] == 5 and len(resumed["tasks"]) == 4 and resumed["truncated"] is True
    assert sorted(resumed["omitted_task_ids"] + [item["task_id"] for item in resumed["tasks"]]) == sorted(task["task_id"] for task in tasks)
    task_anchor_path(workspace, tasks[0]["task_id"]).write_text("{damaged\n")
    assert ok(invoke(workspace, "resume", {}))["unreadable_count"] == 1
