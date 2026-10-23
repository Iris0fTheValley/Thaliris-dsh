"""One-shot JSON transport to neutral Core; authorization belongs to DSH.

The envelope's native_controller_id is supplied by the plugin from exec.agent,
not model arguments. Direct shared-OS invocation is not authentication.
"""
from __future__ import annotations

import hashlib
import json
from pathlib import Path
import stat
import sys
import tempfile

MAX_REQUEST_BYTES = 262144
CONTROLLER_PRODUCER = "dsh:controller"
LABEL_CHARACTERS = frozenset("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_.:-")
OBSERVATION_FIELDS = {"id", "text", "source_refs", "sources", "observed_state"}
SOURCE_FIELDS = {"id", "kind", "locator", "summary"}
RECORD_FIELDS = {"id", "kind", "text", "source_refs", "status", "supersedes"}
JUDGMENT_FIELDS = {"id", "candidate", "requirement_ref", "observation_refs", "outcome", "reasoning", "judgment_refs"}
CONTROLLER_OPERATIONS = {"inspect", "status", "begin", "bind", "finish", "reconcile", "proposal", "close", "context", "register", "judge", "observe", "mode"}


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
    if operation == "resume":
        if args:
            raise ValueError("INVALID_RESUME_ARGUMENTS")
        return resume(core, AuthorityStore, root, authority_directory, native_id, workspace_id)
    if operation not in CONTROLLER_OPERATIONS:
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
        return {"ok": True, "state": state, "contract": record["contract"], "authority_sha256": authority_digest(store), "task_context": task_context_text(core, state)}
    if operation == "status":
        if set(args) - {"task_id", "evidence_offset"}:
            raise ValueError("INVALID_STATUS_ARGUMENTS")
        offset = args.get("evidence_offset", 0)
        if type(offset) is not int or offset < 0:
            raise ValueError("INVALID_STATUS_ARGUMENTS")
        packet = core.task_status(root, offset)
        records, total = current_records(state)
        return {**packet, "Current Records": records, "Current Record Count": total,
                "Authority": {"status": record["status"], "execution_mode": record["contract"]["execution_mode"], "sha256": authority_digest(store)},
                "task_context": task_context_text(core, state)}
    if operation == "observe":
        # Child evidence arrives through the plugin's dispatch grant, never from
        # model-supplied provenance. The bound reservation is the association.
        result = observe(core, root, state, args)
        store.checkpoint()
        return result
    if operation == "proposal":
        if set(args) != {"task_id", "observation"} or not isinstance(args["observation"], str) or len(args["observation"]) > 3500:
            raise ValueError("INVALID_MEMORY_PROPOSAL")
        result = update(core, root, native_id, state["revision"], {"pending_results": [*state["pending_results"], args["observation"]]})
        store.checkpoint()
        return result
    if args.get("task_id") != state["task_id"] or type(args.get("base_revision")) is not int or args["base_revision"] != state["revision"]:
        raise ValueError("TASK_ID_OR_REVISION_CONFLICT")
    if operation == "context":
        return task_context_update(core, root, store, state, args)
    if operation in {"register", "judge"}:
        return continuity_append(core, root, store, args, operation)
    if operation == "mode":
        if set(args) != {"task_id", "base_revision", "expected_authority_sha256", "mode", "human_instruction"} or not isinstance(args["expected_authority_sha256"], str):
            raise ValueError("INVALID_MODE_ARGUMENTS")
        if state["active_work"]:
            raise ValueError("UNRESOLVED_ACTIVE_WORK_CANNOT_SWITCH_MODE")
        # Core CAS keeps goal, boundary, invariants and acceptance frozen.
        result = store.switch_mode(args["expected_authority_sha256"], args["base_revision"], args["mode"], args["human_instruction"])
        return {**result, "authority_sha256": authority_digest(store), "task_context": task_context_text(core, core.task_show(root)["state"])}
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
    allowed = {"task_id", "base_revision", "observation"} | ({"evidence"} if operation == "begin" else set())
    if not {"task_id", "base_revision", "observation"} <= set(args) or set(args) - allowed or not isinstance(args["observation"], str) or not args["observation"].strip() or len(args["observation"]) > 3500:
        raise ValueError("INVALID_NATIVE_OBSERVATION")
    if operation == "begin" and state["active_work"]:
        raise ValueError("UNRESOLVED_ACTIVE_WORK_CANNOT_BEGIN")
    if operation == "begin" and "evidence" in args:
        result = begin_with_evidence(core, root, args)
        store.checkpoint()
        return result
    if operation in {"bind", "finish", "reconcile"} and len(state["active_work"]) != 1:
        raise ValueError("NATIVE_RESERVATION_REQUIRED")
    if operation in {"bind", "finish", "reconcile"}:
        previous = json.loads(state["active_work"][0])
        observed = json.loads(args["observation"])
        # Dispatch-time fields may be omitted from a terminal observation (the
        # archived reservation keeps them) but can never be contradicted.
        if any(observed.get(key) != previous.get(key) for key in ("correlation", "workstream", "role", "handoff_sha256")) or not observed.get("child_id") \
                or any(key in observed and observed[key] != previous.get(key) for key in ("evidence_handoff_id", "role_sha256", "route")):
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


def authority_digest(store) -> str:
    from thaliris.authority import digest
    return digest(store.path())


def is_label(value: object, maximum: int = 64) -> bool:
    return isinstance(value, str) and 0 < len(value) <= maximum and set(value) <= LABEL_CHARACTERS


def resume(core, AuthorityStore, root: Path, authority_directory: Path, native_id: str, workspace_id: str) -> dict:
    """List this native root's ACTIVE anchored tasks with their bounded context.

    Restores the dynamic task-context summary after a process restart. It is
    read-only and matches the anchor's recorded DSH controller and workspace,
    never a caller-supplied task or actor.
    """
    tasks, unreadable = [], 0
    directory = root / ".context" / "tasks"
    candidates = sorted(path.parent.name for path in directory.glob("*/state.json")) if directory.is_dir() else []
    for task_id in candidates[:256]:
        try:
            core.select_task(root, task_id)
            store = AuthorityStore(root, authority_directory, protected_paths=(".context/config.json",), task_id=task_id)
            record = store.check()
            if record is None or record.get("task_id") != task_id or record.get("dsh_controller_id") != native_id or record.get("dsh_workspace_id") != workspace_id:
                continue
            state = core.task_show(root)["state"]
            tasks.append({"task_id": task_id, "revision": state["revision"], "execution_mode": record["contract"]["execution_mode"],
                          "task_context": task_context_text(core, state)})
        except (ValueError, OSError, KeyError, TypeError):
            unreadable += 1
    return {"ok": True, "tasks": tasks[:4], "task_count": len(tasks), "unreadable_count": unreadable}


def current_records(state: dict, limit: int = 12, text_chars: int = 600) -> tuple[list[dict], int]:
    """The most recent records no later record supersedes (bounded), and their total count."""
    superseded = {ref for item in state["records"] for ref in item.get("supersedes", [])}
    current = [item for item in state["records"] if item["id"] not in superseded]
    shown = [{"id": item["id"], "kind": item["kind"], "status": item["status"], "revision": item["revision"],
              "text": item["text"][:text_chars], "truncated": len(item["text"]) > text_chars,
              **({"supersedes": item["supersedes"]} if item.get("supersedes") else {})} for item in current[-limit:]]
    return shown, len(current)


def task_context_text(core, state: dict, budget: int = 6000) -> str | None:
    """Bounded summary of the Controller's recorded task context.

    DSH re-supplies it as dynamic context after compaction or resume, so global
    semantic state is not re-investigated. It is recorded history, not fresh
    verification, and it never carries acceptance.
    """
    if state.get("status") != "ACTIVE":
        return None
    records, total = current_records(state, limit=12, text_chars=400)
    continuity = core._continuity_status(state)
    goal = state["goal"]
    lines = [f"Thaliris task {state['task_id']} context recorded by the Controller (revision {state['revision']}; history, re-verify what a decision depends on):",
             f"- Goal: {goal[:600]}{' ...' if len(goal) > 600 else ''}"]
    if state.get("current_milestone"):
        lines.append(f"- Milestone: {state['current_milestone']}")
    if state["active_work"]:
        lines.append("- Active Work (unresolved native reservation; inspect or reconcile it):")
        lines += [f"  - {value[:300]}" for value in state["active_work"][:4]]
    if records:
        lines.append(f"- Current records ({len(records)} most recent of {total} not superseded):")
        lines += [f"  - {item['id']} [{item['kind']}] {item['text']}{' ...' if item['truncated'] else ''}" for item in records]
    if continuity["unincorporated_total"] or continuity["unresolved_judgments_total"]:
        lines.append(f"- Evidence continuity: {continuity['unincorporated_total']} unincorporated observation link(s), "
                     f"{continuity['unresolved_judgments_total']} unresolved judgment(s); read thaliris_task_status.")
    text, suffix = "\n".join(lines), "\n- ... truncated; read the rest with thaliris_task_status."
    return text if len(text) <= budget else text[:budget - len(suffix)] + suffix


def task_context_update(core, root: Path, store, state: dict, args: dict) -> dict:
    """Controller-recorded facts, decisions, progress, open items and milestone.

    Reservations and pending results stay adapter-owned; records are
    append-only and the bridge supplies their producer and revision.
    """
    if set(args) - {"task_id", "base_revision", "records", "sources", "milestone"} or not set(args) & {"records", "sources", "milestone"}:
        raise ValueError("INVALID_TASK_CONTEXT_ARGUMENTS")
    partial = {}
    if "sources" in args:
        if not isinstance(args["sources"], list) or not args["sources"] or any(not isinstance(item, dict) or set(item) - SOURCE_FIELDS for item in args["sources"]):
            raise ValueError("INVALID_TASK_CONTEXT_SOURCES")
        partial["evidence_refs"] = args["sources"]
    if "records" in args:
        if not isinstance(args["records"], list) or not args["records"] or any(not isinstance(item, dict) or set(item) - RECORD_FIELDS for item in args["records"]):
            raise ValueError("TASK_CONTEXT_RECORD_PROVENANCE: records accept id, kind, text, source_refs, status, supersedes; the bridge supplies producer and revision")
        partial["records"] = [{**item, "producer": CONTROLLER_PRODUCER, "revision": state["revision"] + 1} for item in args["records"]]
    if "milestone" in args:
        if not isinstance(args["milestone"], str) or len(args["milestone"]) > 128:
            raise ValueError("INVALID_TASK_CONTEXT_MILESTONE")
        partial["current_milestone"] = args["milestone"] or None
    result = update(core, root, CONTROLLER_PRODUCER, state["revision"], partial)
    store.checkpoint()
    current = core.task_show(root)["state"]
    records, total = current_records(current)
    return {**result, "Task Context": {"milestone": current["current_milestone"], "Current Records": records, "Current Record Count": total},
            "task_context": task_context_text(core, current)}


def continuity_append(core, root: Path, store, args: dict, operation: str) -> dict:
    """Controller requirement registration and judgments under revision CAS.

    Handoffs are registered only by the adapter at dispatch, so the Controller
    cannot fabricate the provenance that binds a child observation.
    """
    if operation == "register":
        if set(args) != {"task_id", "base_revision", "requirements"} or not isinstance(args["requirements"], list) or not args["requirements"] or len(args["requirements"]) > 64:
            raise ValueError("INVALID_REGISTER_ARGUMENTS")
        if any(not isinstance(item, dict) or set(item) != {"id", "workchain_ref"} for item in args["requirements"]):
            raise ValueError("INVALID_REGISTER_ARGUMENTS: requirements are {id, workchain_ref}; handoffs are registered by the adapter at dispatch")
        payload, kind = {"requirements": args["requirements"]}, "register"
    else:
        judgment = args.get("judgment")
        if set(args) != {"task_id", "base_revision", "judgment"} or not isinstance(judgment, dict) or set(judgment) - JUDGMENT_FIELDS:
            raise ValueError("INVALID_JUDGE_ARGUMENTS: Core assigns task_id and producer")
        payload, kind = judgment, "judgments"
    with core._lock(root):
        current = core._load_state(root, active=True)
        if current["revision"] != args["base_revision"]:
            raise ValueError("TASK_ID_OR_REVISION_CONFLICT")
        core._append_continuity_state(current, CONTROLLER_PRODUCER, payload, kind)
        core._write_state(root, current)
    store.checkpoint()
    packet = core.task_status(root)
    return {"ok": True, "task_id": current["task_id"], "revision": current["revision"], "Evidence Continuity": packet["Evidence Continuity"],
            "task_context": task_context_text(core, current)}


def begin_with_evidence(core, root: Path, args: dict) -> dict:
    """Reserve one dispatch and register its evidence handoff atomically."""
    evidence, reservation = args["evidence"], args["observation"]
    if not isinstance(evidence, dict) or set(evidence) != {"handoff_id", "candidate", "requirement_refs"} or not is_label(evidence["handoff_id"], 40) or not is_label(evidence["candidate"]):
        raise ValueError("INVALID_EVIDENCE_ASSOCIATION")
    try:
        selected = json.loads(reservation)
    except json.JSONDecodeError as error:
        raise ValueError("INVALID_EVIDENCE_ASSOCIATION") from error
    if not isinstance(selected, dict) or selected.get("evidence_handoff_id") != evidence["handoff_id"]:
        raise ValueError("EVIDENCE_RESERVATION_CONFLICT")
    handoff = {"id": evidence["handoff_id"], "parent_handoff_id": None, "candidate": evidence["candidate"],
               "producer": "handoff:" + evidence["handoff_id"], "requirement_refs": evidence["requirement_refs"]}
    with core._lock(root):
        current = core._load_state(root, active=True)
        if current["revision"] != args["base_revision"] or current["active_work"]:
            raise ValueError("TASK_ID_OR_REVISION_CONFLICT")
        current["active_work"] = [reservation]
        # Core validates requirement refs against registered requirements.
        core._register_evidence_handoff(current, handoff)
        current["revision"] += 1
        core._write_state(root, current)
    return {"ok": True, "task_id": current["task_id"], "revision": current["revision"], "status": current["status"],
            "changed": ["active_work", "evidence_continuity"], "evidence_handoff_id": handoff["id"]}


def observe(core, root: Path, state: dict, args: dict) -> dict:
    """Append one child observation with adapter-bound provenance.

    The reservation must be bound to this exact native child and carry this
    evidence handoff. Producer, candidate and requirement refs come from the
    registered handoff; child-chosen ids are namespaced by the handoff id.
    """
    if set(args) != {"task_id", "handoff_id", "child_id", "observation"} or not isinstance(args["child_id"], str) or not args["child_id"]:
        raise ValueError("INVALID_OBSERVE_ARGUMENTS")
    if len(state["active_work"]) != 1:
        raise ValueError("OBSERVATION_DISPATCH_FINISHED: no active reservation; report the observation and its sources in FINAL")
    try:
        reservation = json.loads(state["active_work"][0])
    except json.JSONDecodeError as error:
        raise ValueError("OBSERVATION_ASSOCIATION_UNAVAILABLE") from error
    if not isinstance(reservation, dict) or reservation.get("evidence_handoff_id") is None or reservation.get("evidence_handoff_id") != args["handoff_id"]:
        raise ValueError("OBSERVATION_ASSOCIATION_UNAVAILABLE: report the observation and its sources in FINAL")
    if reservation.get("child_id") != args["child_id"]:
        raise ValueError("OBSERVATION_CHILD_CONFLICT")
    handoff = next((item for item in state.get("evidence_continuity", {}).get("handoffs", []) if item["id"] == args["handoff_id"]), None)
    if handoff is None:
        raise ValueError("OBSERVATION_ASSOCIATION_UNAVAILABLE")
    payload = args["observation"]
    if not isinstance(payload, dict) or set(payload) - OBSERVATION_FIELDS:
        raise ValueError("OBSERVATION_PROVENANCE_FIELDS: the adapter supplies task, handoff, candidate, requirement refs and producer")
    if "sources" in payload and (not isinstance(payload["sources"], list) or any(not isinstance(item, dict) or set(item) - SOURCE_FIELDS for item in payload["sources"])):
        raise ValueError("INVALID_OBSERVATION_SOURCES")
    prefix = handoff["id"] + "."
    local = {item.get("id") for item in payload.get("sources", [])}

    def rename(value):
        return prefix + value if isinstance(value, str) else value

    bound = dict(payload)
    bound["id"] = rename(payload.get("id"))
    if "sources" in payload:
        bound["sources"] = [{**item, "id": rename(item.get("id"))} for item in payload["sources"]]
    if isinstance(payload.get("source_refs"), list):
        bound["source_refs"] = [rename(ref) if ref in local else ref for ref in payload["source_refs"]]
    bound.update({"handoff_id": handoff["id"], "candidate": handoff["candidate"], "requirement_refs": handoff["requirement_refs"],
                  "native_actor": "dsh-child:" + hashlib.sha256(args["child_id"].encode("utf-8")).hexdigest()[:16]})
    result = core.task_observe(root, handoff["producer"], bound)
    return {**result, "observation_id": bound["id"], "handoff_id": handoff["id"], "candidate": handoff["candidate"]}


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
