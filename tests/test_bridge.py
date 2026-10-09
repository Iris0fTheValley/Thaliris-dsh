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
    assert json.loads(closed_state["pending_results"][1])["stop_reason"] == "error"
    assert "Controller close decision" in closed_state["pending_results"][2]
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
    assert state["active_work"] == []
    assert "Archived reservation" in state["pending_results"][0]
    assert json.loads(state["pending_results"][1])["outcome"] == "error"
    assert not invoke(workspace, "inspect", {"task_id": task["task_id"]}, native_workspace_id="other-workspace")["ok"]
