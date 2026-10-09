"""One-shot JSON transport to neutral Core; authorization belongs to DSH.

The envelope's native_controller_id is supplied by the plugin from exec.agent,
not model arguments. Direct shared-OS invocation is not authentication.
"""
from __future__ import annotations

import json
from pathlib import Path
import stat
import sys
import tempfile

MAX_REQUEST_BYTES = 262144


def validate_authority_directory(root: Path, directory: Path) -> None:
    resolved_root = root.resolve()
    if directory.resolve().is_relative_to(resolved_root) or any(
        _is_link_or_junction(path) for path in (directory, *directory.parents)
    ):
        raise ValueError("TASK_AUTHORITY_EXTERNAL_LOCATION_UNSAFE")


def _is_link_or_junction(path: Path) -> bool:
    if path.is_symlink():
        return True
    try:
        info = path.stat(follow_symlinks=False)
    except OSError:
        return False
    return bool(getattr(info, "st_file_attributes", 0) & getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0))


def dispatch(request: dict) -> dict:
    if set(request) != {"protocol", "core_path", "root", "authority_directory", "native_controller_id", "native_workspace_id", "operation", "arguments"} or type(request["protocol"]) is not int or request["protocol"] != 1:
        raise ValueError("INVALID_BRIDGE_ENVELOPE")
    for key in ("core_path", "root", "authority_directory"):
        if not isinstance(request[key], str) or not Path(request[key]).is_absolute():
            raise ValueError("BRIDGE_ABSOLUTE_PATH_REQUIRED")
    native_id = request["native_controller_id"]
    if not isinstance(native_id, str) or not native_id or len(native_id) > 128:
        raise ValueError("NATIVE_CONTROLLER_REQUIRED")
    workspace_id = request["native_workspace_id"]
    if not isinstance(workspace_id, str) or not workspace_id or len(workspace_id) > 128:
        raise ValueError("NATIVE_WORKSPACE_REQUIRED")
    sys.path.insert(0, request["core_path"])
    from thaliris import core
    from thaliris.authority import AuthorityStore, validate_contract

    root = Path(request["root"]).resolve()
    if core._repo_root(root) != root:
        raise ValueError("BRIDGE_REPOSITORY_ROOT_REQUIRED")
    authority_directory = Path(request["authority_directory"])
    # Check only the storage directory here. A path without Task ID selects
    # the legacy workspace anchor, which must not gate an independent task.
    validate_authority_directory(root, authority_directory)
    args = request["arguments"]
    if not isinstance(args, dict):
        raise ValueError("INVALID_BRIDGE_ARGUMENTS")
    operation = request["operation"]
    if operation == "start":
        if set(args) != {"goal", "contract"}:
            raise ValueError("INVALID_START_ARGUMENTS")
        validate_contract(args["contract"])
        if not isinstance(args["goal"], str) or not args["goal"].strip() or len(args["goal"]) > 16384:
            raise ValueError("INVALID_GOAL")
        core.init(root)
        result = core.task_start(root, args["goal"], None, None, actor="dsh:" + native_id)
        task_id = result["task_id"]
        core.select_task(root, task_id)
        # Failure here leaves the ACTIVE Core ledger intact for operator diagnosis.
        state = core.task_show(root)["state"]
        store = AuthorityStore(root, authority_directory, protected_paths=(".context/config.json",), task_id=task_id)
        # Validate this task target without consulting an unrelated legacy anchor.
        store.path()
        store.establish(state, args["contract"], adapter_fields={"dsh_controller_id": native_id, "dsh_workspace_id": workspace_id})
        return result
    if operation not in {"inspect", "begin", "bind", "finish", "reconcile", "proposal", "close"}:
        raise ValueError("UNSUPPORTED_BRIDGE_OPERATION")
    task_id = args.get("task_id")
    if not isinstance(task_id, str) or not task_id:
        raise ValueError("TASK_ID_REQUIRED")
    core.select_task(root, task_id)
    store = AuthorityStore(root, authority_directory, protected_paths=(".context/config.json",), task_id=task_id)
    record = store.check()
    if record is None or record.get("task_id") != task_id or record.get("dsh_controller_id") != native_id or record.get("dsh_workspace_id") != workspace_id:
        raise ValueError("DSH_CONTROLLER_MISMATCH_OR_INACTIVE")
    state = core.task_show(root)["state"]
    if operation == "inspect":
        if set(args) != {"task_id"}:
            raise ValueError("INVALID_INSPECT_ARGUMENTS")
        return {"ok": True, "state": state, "contract": record["contract"]}
    if operation == "proposal":
        if set(args) != {"task_id", "observation"} or not isinstance(args["observation"], str) or len(args["observation"]) > 3500:
            raise ValueError("INVALID_MEMORY_PROPOSAL")
        result = update(core, root, native_id, state["revision"], {"pending_results": [*state["pending_results"], args["observation"]]})
        store.checkpoint()
        return result
    if args.get("task_id") != state["task_id"] or type(args.get("base_revision")) is not int or args["base_revision"] != state["revision"]:
        raise ValueError("TASK_ID_OR_REVISION_CONFLICT")
    if operation == "close":
        if set(args) != {"task_id", "base_revision", "decision"} or not isinstance(args["decision"], str) or not args["decision"].strip() or len(args["decision"]) > 3500:
            raise ValueError("CONTROLLER_DECISION_REQUIRED")
        if state["active_work"]:
            raise ValueError("UNRESOLVED_ACTIVE_WORK_CANNOT_CLOSE")
        # Preserve the explicit model decision as a pending-result observation.
        result = update(core, root, native_id, state["revision"], {"active_work": [], "pending_results": [*state["pending_results"], "Controller close decision: " + args["decision"]]})
        store.checkpoint()
        result = core.task_close(root, result["revision"], expected_task_id=args["task_id"])
        store.checkpoint()
        return result
    if set(args) != {"task_id", "base_revision", "observation"} or not isinstance(args["observation"], str) or not args["observation"].strip() or len(args["observation"]) > 3500:
        raise ValueError("INVALID_NATIVE_OBSERVATION")
    if operation == "begin" and state["active_work"]:
        raise ValueError("UNRESOLVED_ACTIVE_WORK_CANNOT_BEGIN")
    if operation in {"bind", "finish", "reconcile"} and len(state["active_work"]) != 1:
        raise ValueError("NATIVE_RESERVATION_REQUIRED")
    if operation in {"bind", "finish", "reconcile"}:
        previous = json.loads(state["active_work"][0])
        observed = json.loads(args["observation"])
        if any(observed.get(key) != previous.get(key) for key in ("correlation", "workstream", "role", "handoff_sha256")) or not observed.get("child_id"):
            raise ValueError("NATIVE_RESERVATION_CONFLICT")
        if previous.get("child_id") and observed["child_id"] != previous["child_id"]:
            raise ValueError("NATIVE_CHILD_CONFLICT")
        if operation == "reconcile" and (observed.get("outcome") not in {"completed", "aborted", "error", "max-tokens", "blocked", "interrupted"} or observed.get("provenance") != "native-session-turn/end"):
            raise ValueError("NATIVE_TERMINAL_EVIDENCE_REQUIRED")
    partial = {"active_work": [args["observation"]]} if operation in {"begin", "bind"} else {
        "active_work": [], "pending_results": [*state["pending_results"], "Archived reservation: " + state["active_work"][0], args["observation"]]}
    result = update(core, root, native_id, state["revision"], partial)
    store.checkpoint()
    return result


def update(core, root: Path, native_id: str, revision: int, partial: dict) -> dict:
    # Core's input-file API is reused, without a second ledger or CLI facade.
    fd, name = tempfile.mkstemp(prefix="dsh-input-", suffix=".json", dir=root / ".context")
    import os
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as stream:
            json.dump(partial, stream)
        return core.task_update(root, "dsh:" + native_id, revision, name)
    finally:
        Path(name).unlink(missing_ok=True)


def main() -> int:
    try:
        raw = sys.stdin.buffer.read(MAX_REQUEST_BYTES + 1)
        if len(raw) > MAX_REQUEST_BYTES:
            raise ValueError("BRIDGE_REQUEST_TOO_LARGE")
        request = json.loads(raw)
        if not isinstance(request, dict):
            raise ValueError("INVALID_BRIDGE_ENVELOPE")
        result = dispatch(request)
        response = {"protocol": 1, "ok": True, "result": result}
        code = 0
    except (ValueError, OSError, KeyError, TypeError, ImportError) as error:
        response = {"protocol": 1, "ok": False, "error": str(error)}
        code = 1
    print(json.dumps(response, ensure_ascii=True))
    return code


if __name__ == "__main__":
    raise SystemExit(main())
