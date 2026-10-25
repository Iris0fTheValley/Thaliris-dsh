"""One-shot JSON transport to neutral Core; authorization belongs to DSH.

The envelope's native_controller_id is supplied by the plugin from exec.agent,
not model arguments. Direct shared-OS invocation is not authentication.
"""
from __future__ import annotations

import base64
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
# Project Identity plane (Core 0.5.0): `.project-identity/` is Core-owned, repository-tracked
# state, separate from the task ledger and from the Memory Provider. Reads follow `status`;
# mutations are Controller-only and apply Core's own task-revision CAS.
IDENTITY_READ_OPERATIONS = frozenset({"identity_status", "identity_get", "identity_trace"})
IDENTITY_WRITE_OPERATIONS = frozenset({"identity_amend", "identity_challenge", "identity_relate"})
# Natural formation (Core 0.5.2): basis notes and suggestion preferences are machine-local,
# Controller-only and need no ACTIVE task; the session key is the native Controller id.
IDENTITY_FORMATION_OPERATIONS = frozenset({"identity_note", "identity_note_list", "identity_suggest"})
IDENTITY_GET_FIELDS = frozenset({"version", "items", "amendment", "challenge"})
IDENTITY_TRACE_FIELDS = frozenset({"direction", "depth"})
CONTROLLER_OPERATIONS = {"inspect", "status", "begin", "bind", "finish", "reconcile", "dispose", "proposal", "approval", "close", "context", "register", "judge", "observe", "mode"} | IDENTITY_READ_OPERATIONS | IDENTITY_WRITE_OPERATIONS
# Explicit Controller recovery of the external anchor (Core AuthorityStore.recover): CAS on
# the anchor digest with a reason; never an automatic roll-forward or re-anchor.
RECOVERY_OPERATIONS = frozenset({"recover", "attach"})
STATE_CHANGED = "TASK_AUTHORITY_STATE_CHANGED"
MISMATCH = "DSH_CONTROLLER_MISMATCH_OR_INACTIVE"
ROLLBACK_RECOVERY = ("the task ledger differs from its last anchored state: a write was interrupted before it was anchored, or the file was edited. "
                     "Nothing is accepted automatically. Only as an explicit Controller decision, call thaliris_task_recover action rollback with "
                     "details.authority_sha256 and a reason: it archives the current bytes and restores the last anchored state")
ATTACH_RECOVERY = ("this ACTIVE task is anchored to another native root session of this workspace. Only on the user's instruction to continue it "
                   "in this session, call thaliris_task_recover action attach with details.authority_sha256 and a reason; the previous root is refused afterwards")
DISPOSE_LIVENESS = frozenset({"cancelled", "not-resident", "UNKNOWN"})
RESUME_SHOWN = 4
# Active Work and Pending Results hold only current routing state (Core bounds
# them to 8 KiB together). Finished dispatches, consumed memory proposals and
# legacy history move to append-only Core records with adapter provenance.
ADAPTER_PRODUCER = "dsh:adapter"
# Strict CAS keeps its historical error text; Core's stable code, a recovery hint and a
# bounded changes_since review hint ride along as additive fields (never a rebase or merge).
LEGACY_CONFLICT = "TASK_ID_OR_REVISION_CONFLICT"
CONFLICT_RECOVERY = ("retry the same write once with base_revision = details.current_revision after reading details.changes_since "
                     "(recent handoffs, observations and judgments, open evidence; an approximate hint that can omit items and does not track Active Work, Pending Results, milestone, status or sources) "
                     "and, if the write still applies, retry once; read compact thaliris_task_status when you need Active Work/Pending Results or anything the hint does not cover")
STATUS_VIEWS = ("compact", "full")
COMPACT_RECORD_CHARS = 200
COMPACT_NON_COMPLETED_MAX = 4
DISPATCH_KIND = "dsh-dispatch"
LEGACY_KIND = "dsh-legacy-pending"
APPROVAL_KIND = "dsh-memory-approval"
CLOSE_KIND = "dsh-close-decision"
ADAPTER_KINDS = frozenset({DISPATCH_KIND, LEGACY_KIND, APPROVAL_KIND})
RECORD_TEXT_MAX = 16384
TERMINAL_PROVENANCE = frozenset({"native-run-result", "native-session-turn/end"})
ARCHIVE_PREFIX = "Archived reservation: "
LEGACY_PREFIXES = (ARCHIVE_PREFIX, "Controller close decision: ")
# Core's record-count and state-size bounds; any other refusal stays an error.
# Core 0.5.3 marks capacity refusals with TASK_STATE_CAPACITY_EXCEEDED; the plain-text messages cover older Core.
CORE_CAPACITY_CODE = "TASK_STATE_CAPACITY_EXCEEDED"
CORE_CAPACITY_ERRORS = frozenset({"state list exceeds limit", "invalid task records", "task state exceeds 512 KiB"})


def is_core_capacity_error(error: ValueError) -> bool:
    return getattr(error, "code", None) == CORE_CAPACITY_CODE or str(error) in CORE_CAPACITY_ERRORS


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
    if operation in IDENTITY_FORMATION_OPERATIONS:
        return identity_formation(root, native_id, operation, args)
    if operation not in CONTROLLER_OPERATIONS | RECOVERY_OPERATIONS:
        raise ValueError("UNSUPPORTED_BRIDGE_OPERATION")
    task_id = args.get("task_id")
    if not isinstance(task_id, str) or not task_id:
        raise ValueError("TASK_ID_REQUIRED")
    core.select_task(root, task_id)
    store = AuthorityStore(root, authority_directory, protected_paths=(".context/config.json",), task_id=task_id)
    if operation in RECOVERY_OPERATIONS:
        return authority_recover(core, store, root, task_id, native_id, workspace_id, operation, args)
    try:
        record = store.check()
    except ValueError as error:
        # Only the failure text is explained; the check itself is never relaxed.
        raise authority_failure(store, error, task_id, native_id, workspace_id) from None
    if record is None or record.get("task_id") != task_id or record.get("dsh_controller_id") != native_id or record.get("dsh_workspace_id") != workspace_id:
        raise controller_mismatch(store, record, task_id, native_id, workspace_id)
    state = core.task_show(root)["state"]
    if operation == "inspect":
        if set(args) - {"task_id", "base_revision"}:
            raise ValueError("INVALID_INSPECT_ARGUMENTS")
        if "base_revision" in args:
            # Reconcile uses this to refuse a stale revision with the structured conflict details.
            check_cas(core, state, args)
        return {"ok": True, "state": state, "contract": record["contract"], "authority_sha256": authority_digest(store), "task_context": task_context_text(core, state, root)}
    if operation == "status":
        if set(args) - {"task_id", "evidence_offset", "view", "since_revision"}:
            raise ValueError("INVALID_STATUS_ARGUMENTS")
        offset = args.get("evidence_offset", 0)
        view, since = args.get("view", "compact"), args.get("since_revision")
        if type(offset) is not int or offset < 0 or view not in STATUS_VIEWS or (since is not None and (type(since) is not int or since < 0)):
            raise ValueError("INVALID_STATUS_ARGUMENTS")
        packet = core.task_status_packet(state, offset, view=view, since_revision=since)
        authority = {"status": record["status"], "execution_mode": record["contract"]["execution_mode"], "sha256": authority_digest(store)}
        if view == "compact":
            records, total = current_records(state, text_chars=COMPACT_RECORD_CHARS, compact=True)
            return {**packet, "Current Records": records, "Current Record Count": total, "Dispatch History": dispatch_history_compact(state),
                    "Authority": authority, "task_context": task_context_text(core, state, root)}
        records, total = current_records(state)
        return {**packet, "Current Records": records, "Current Record Count": total, "Dispatch History": dispatch_history(state),
                "Authority": authority, "task_context": task_context_text(core, state, root)}
    if operation in IDENTITY_READ_OPERATIONS:
        return identity_read(core, root, state, operation, args, native_id)
    if operation == "observe":
        # Child evidence arrives through the plugin's dispatch grant, never from
        # model-supplied provenance. The bound reservation is the association.
        result = observe(core, root, state, args)
        store.checkpoint()
        return result
    if operation == "proposal":
        if set(args) != {"task_id", "observation"} or not isinstance(args["observation"], str) or len(args["observation"]) > 3500:
            raise ValueError("INVALID_MEMORY_PROPOSAL")
        proposal = parse_json(args["observation"])
        if not isinstance(proposal, dict) or not isinstance(proposal.get("proposal_id"), str) or "approval_id" in proposal:
            raise ValueError("INVALID_MEMORY_PROPOSAL")
        # An unapproved proposal is a pending result the Controller has not consumed.
        result = write(core, root, native_id, state, {"pending_results": [*state["pending_results"], args["observation"]]})
        store.checkpoint()
        return result
    if operation == "approval":
        result = approval(core, root, native_id, state, args)
        store.checkpoint()
        return result
    check_cas(core, state, args)
    if operation in IDENTITY_WRITE_OPERATIONS:
        return identity_write(core, root, native_id, state, operation, args)
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
        return {**result, "authority_sha256": authority_digest(store), "task_context": task_context_text(core, core.task_show(root)["state"], root)}
    if operation == "close":
        if set(args) != {"task_id", "base_revision", "decision"} or not isinstance(args["decision"], str) or not args["decision"].strip() or len(args["decision"]) > 3500:
            raise ValueError("CONTROLLER_DECISION_REQUIRED")
        if state["active_work"]:
            raise ValueError("UNRESOLVED_ACTIVE_WORK_CANNOT_CLOSE")
        # Preserve the explicit model decision as an append-only Controller record.
        result = write(core, root, native_id, state, {"active_work": []}, [(CLOSE_KIND, "Controller close decision: " + args["decision"], CONTROLLER_PRODUCER)])
        store.checkpoint()
        result = core.task_close(root, result["revision"], expected_task_id=args["task_id"])
        store.checkpoint()
        offer = identity_offer_line(root, native_id)
        return {**result, "identity_offer": offer} if offer else result
    if operation == "dispose":
        return dispose(core, root, store, native_id, state, args)
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
    if operation in {"begin", "bind"}:
        result = write(core, root, native_id, state, {"active_work": [args["observation"]]})
    else:
        # The released reservation and its terminal observation become one
        # append-only dispatch record; routing state keeps no history.
        archive = {"operation": operation, "reservation": parse_json(state["active_work"][0], raw=True), "result": parse_json(args["observation"], raw=True)}
        result = write(core, root, native_id, state, {"active_work": []}, [(DISPATCH_KIND, compact(archive), ADAPTER_PRODUCER)])
        # Still-open evidence returns with the release, so the Controller needs no separate status read.
        result["evidence"] = core.evidence_summary(core.task_show(root)["state"])
    store.checkpoint()
    return result


def cas_conflict(core, state: dict, args: dict):
    """Structured strict-CAS refusal, or None when task id and revision both match.

    The error text stays the historical TASK_ID_OR_REVISION_CONFLICT; Core's code,
    a recovery hint and bounded details are additive, and details.mismatch says
    which half failed. Nothing is rebased or merged.
    """
    from thaliris.errors import ThalirisError, TASK_IDENTITY_CONFLICT
    if args.get("task_id") != state["task_id"]:
        return ThalirisError(TASK_IDENTITY_CONFLICT, LEGACY_CONFLICT, recovery="select the intended task_id; the revision was not compared",
                             details={"mismatch": "task_id", "expected_task_id": args.get("task_id"), "task_id": state["task_id"], "current_revision": state["revision"]})
    if type(args.get("base_revision")) is int and args["base_revision"] == state["revision"]:
        return None
    conflict = core.revision_conflict(state, args.get("base_revision"))
    return ThalirisError(conflict.code, LEGACY_CONFLICT, recovery=CONFLICT_RECOVERY, details={"mismatch": "revision", **(conflict.details or {})})


def check_cas(core, state: dict, args: dict) -> None:
    conflict = cas_conflict(core, state, args)
    if conflict is not None:
        raise conflict


def error_response(error: BaseException) -> dict:
    """Bridge failure envelope: the historical text plus Core's code, recovery and details when present."""
    response = {"protocol": 1, "ok": False, "error": str(error)}
    code = getattr(error, "code", None)
    if isinstance(code, str) and callable(getattr(error, "to_dict", None)):
        structured = error.to_dict()
        if structured.get("code") == "TASK_REVISION_CONFLICT":
            # Core's own CAS fired inside a locked write (a race after the bridge check): same text, no CLI hint.
            structured = {**structured, "error": LEGACY_CONFLICT, "recovery": CONFLICT_RECOVERY}
        response.update({key: structured[key] for key in ("error", "code", "recovery", "details") if key in structured})
    return response


def identity_summary_line(root: Path | None) -> str | None:
    """Core's one-line identity summary, or None when absent, unreadable or unsupported.

    Identity text is never injected; this is navigation only. A failure here
    must not break task context, so the read is best effort.
    """
    if root is None:
        return None
    try:
        from thaliris import identity
        return identity.identity_summary(root)
    except (ValueError, OSError, KeyError, TypeError, ImportError):
        return None


def identity_offer_line(root: Path, session_key: str) -> str | None:
    """Core's once-per-note identity offer for a successful task close; any failure means no offer."""
    try:
        from thaliris import identity_basis
        return identity_basis.identity_offer(root, session_key)
    except Exception:  # noqa: BLE001 - an offer must never disturb a completed close
        return None


def identity_formation(root: Path, native_id: str, operation: str, args: dict) -> dict:
    """Controller-only basis notes and suggestion preferences (Core 0.5.2); no ACTIVE task is required.

    The actor and session key come from the adapter-bound native Controller id,
    never from model arguments. Nothing here touches the task ledger.
    """
    from thaliris import identity_basis
    if operation == "identity_note":
        if set(args) != {"input"} or not isinstance(args["input"], dict):
            raise ValueError("INVALID_IDENTITY_ARGUMENTS")
        return identity_basis.identity_note(root, "dsh:" + native_id, args["input"])
    if operation == "identity_note_list":
        if set(args) - {"include_retracted"} or type(args.get("include_retracted", False)) is not bool:
            raise ValueError("INVALID_IDENTITY_ARGUMENTS")
        return identity_basis.identity_note_list(root, include_retracted=args.get("include_retracted", False))
    if set(args) != {"scope", "setting"} or not isinstance(args["scope"], str) or not isinstance(args["setting"], str):
        raise ValueError("INVALID_IDENTITY_ARGUMENTS")
    return identity_basis.identity_suggest(root, "dsh:" + native_id, args["scope"], args["setting"], session_key=native_id)


def identity_read(core, root: Path, state: dict, operation: str, args: dict, native_id: str) -> dict:
    """Read-only Project Identity observation for the selected, authority-checked task."""
    from thaliris import identity
    if operation == "identity_status":
        if set(args) != {"task_id"}:
            raise ValueError("INVALID_IDENTITY_ARGUMENTS")
        # The summary rides along so a changed baseline (for example after a Git pull) refreshes the cached task context.
        return {**identity.identity_status(root, session_key=native_id), "task_context": task_context_text(core, state, root)}
    if operation == "identity_get":
        if set(args) - {"task_id"} - IDENTITY_GET_FIELDS:
            raise ValueError("INVALID_IDENTITY_ARGUMENTS")
        return identity.identity_get(root, **{key: args[key] for key in IDENTITY_GET_FIELDS if key in args})
    if set(args) - {"task_id", "ref"} - IDENTITY_TRACE_FIELDS or not isinstance(args.get("ref"), str):
        raise ValueError("INVALID_IDENTITY_ARGUMENTS")
    return identity.identity_trace(root, args["ref"], **{key: args[key] for key in IDENTITY_TRACE_FIELDS if key in args})


def identity_write(core, root: Path, native_id: str, state: dict, operation: str, args: dict) -> dict:
    """Controller-only Project Identity mutation under the task revision CAS.

    The actor comes from the adapter-bound native Controller identity, never
    from model arguments. Core does not bump the task revision for identity
    writes, but the dynamic task context is rebuilt because its identity line
    may have changed.
    """
    from thaliris import identity
    if set(args) != {"task_id", "base_revision", "input"} or not isinstance(args["input"], dict):
        raise ValueError("INVALID_IDENTITY_ARGUMENTS")
    call = {"identity_amend": identity.identity_amend, "identity_challenge": identity.identity_challenge, "identity_relate": identity.identity_relate}[operation]
    result = call(root, "dsh:" + native_id, args["base_revision"], args["input"])
    return {**result, "task_context": task_context_text(core, core.task_show(root)["state"], root)}


def authority_digest(store) -> str:
    from thaliris.authority import digest
    return digest(store.path())


def is_label(value: object, maximum: int = 64) -> bool:
    return isinstance(value, str) and 0 < len(value) <= maximum and set(value) <= LABEL_CHARACTERS


def ledger_revisions(core, store, record: dict) -> dict:
    """Best-effort revisions of the anchored ledger snapshot and of the current ledger bytes (None when unreadable)."""
    def revision(content: bytes):
        value = parse_json(content)
        return value["revision"] if isinstance(value, dict) and type(value.get("revision")) is int else None
    path = core._state_path(store.root, record["task_id"])
    encoded = (record.get("snapshots") or {}).get(path.relative_to(store.root).as_posix())
    try:
        anchored = revision(base64.b64decode(encoded, validate=True)) if isinstance(encoded, str) else None
    except ValueError:
        anchored = None
    try:
        current = revision(path.read_bytes()) if path.is_file() else None
    except OSError:
        current = None
    return {"anchored_revision": anchored, "ledger_revision": current}


def authority_failure(store, error: ValueError, task_id: str, native_id: str, workspace_id: str) -> ValueError:
    """Explain a TASK_AUTHORITY_STATE_CHANGED refusal to the anchored Controller (or a same-workspace root).

    The text stays exactly TASK_AUTHORITY_STATE_CHANGED and nothing is accepted: Core's code,
    the explicit recovery path and the anchor digest needed for its CAS ride along. Any
    other failure, or an anchor of another workspace, is returned unchanged.
    """
    if str(error) != STATE_CHANGED:
        return error
    try:
        record = store.read()
    except (ValueError, OSError, KeyError, TypeError):
        return error
    if not isinstance(record, dict) or record.get("task_id") != task_id or record.get("status") != "ACTIVE" or record.get("dsh_workspace_id") != workspace_id:
        return error
    from thaliris import core
    from thaliris.errors import ThalirisError
    own = record.get("dsh_controller_id") == native_id
    recovery = ROLLBACK_RECOVERY if own else ATTACH_RECOVERY + "; the ledger also changed, so use action attach-and-rollback, which also restores the last anchored state"
    return ThalirisError(STATE_CHANGED, STATE_CHANGED, recovery=recovery, details={
        "task_id": task_id, "authority_sha256": authority_digest(store), "anchored_controller": "this-session" if own else "another-root",
        **ledger_revisions(core, store, record)})


def controller_mismatch(store, record: dict | None, task_id: str, native_id: str, workspace_id: str) -> ValueError:
    """The historical refusal; for an ACTIVE task of this workspace anchored to another root, also how it can be attached."""
    if isinstance(record, dict) and record.get("task_id") == task_id and record.get("status") == "ACTIVE" \
            and record.get("dsh_workspace_id") == workspace_id and record.get("dsh_controller_id") != native_id:
        from thaliris.errors import ThalirisError
        return ThalirisError("DSH_CONTROLLER_ANCHORED_ELSEWHERE", MISMATCH, recovery=ATTACH_RECOVERY,
                             details={"task_id": task_id, "authority_sha256": authority_digest(store)})
    return ValueError(MISMATCH)


def authority_recover(core, store, root: Path, task_id: str, native_id: str, workspace_id: str, operation: str, args: dict) -> dict:
    """Explicit Controller recovery of one anchor through Core's locked, archived AuthorityStore.recover.

    Rollback (operation recover, or attach with rollback) archives the current ledger bytes and
    restores the last anchored ones, which discards the one write whose caller never received a
    confirmation; it is refused while the ledger still matches its anchor, so a healthy task is
    never rolled back. Attach moves the single Controller anchor to this native root of the same
    workspace; Task ID, goal, contract, mode, ledger and evidence stay. Both need a reason and the
    anchor digest as CAS. Nothing is rolled forward or re-anchored as current.
    """
    from thaliris.authority import digest
    from thaliris.errors import ThalirisError
    fields = {"task_id", "expected_authority_sha256", "reason"} | ({"rollback"} if operation == "attach" else set())
    reason = args.get("reason")
    if set(args) != fields or not isinstance(args["expected_authority_sha256"], str) or not isinstance(reason, str) or not reason.strip() \
            or len(reason) > 3500 or operation == "attach" and type(args["rollback"]) is not bool:
        raise ValueError("INVALID_RECOVERY_ARGUMENTS")
    rollback = operation == "recover" or args["rollback"]

    def admit(record) -> None:
        if not isinstance(record, dict) or record.get("task_id") != task_id or record.get("status") != "ACTIVE" or record.get("dsh_workspace_id") != workspace_id:
            raise ValueError(MISMATCH)
        if operation == "recover" and record.get("dsh_controller_id") != native_id:
            raise ValueError(MISMATCH)
        if operation == "attach" and record.get("dsh_controller_id") == native_id:
            raise ValueError("DSH_CONTROLLER_ALREADY_ATTACHED")

    admit(store.read())
    state_path = core._state_path(root, task_id)
    discarded = {}

    def precondition(record: dict) -> dict:
        # Core calls this under its lock before any archive or repository write: a refusal here changes nothing.
        admit(record)
        if any(digest(root / name) != expected for name, expected in record["security"].items()):
            raise ValueError("TASK_AUTHORITY_SECURITY_CHANGED")
        changed = digest(state_path) != record["state_sha256"]
        if changed and not rollback:
            raise ThalirisError(STATE_CHANGED, STATE_CHANGED, recovery="the ledger also differs from its anchored state; only if discarding that unconfirmed write is intended, use action attach-and-rollback",
                                details={"task_id": task_id, "authority_sha256": args["expected_authority_sha256"], **ledger_revisions(core, store, record)})
        if rollback and not changed:
            raise ValueError("TASK_AUTHORITY_RECOVERY_NOT_REQUIRED: the ledger matches its anchored state; nothing is rolled back")
        discarded.update(ledger_revisions(core, store, record))
        return {}

    def restore(record: dict) -> None:
        record.setdefault("dsh_attachments", []).append({"previous_controller_id": record.get("dsh_controller_id"), "reason": reason, "rollback": rollback})
        record["dsh_controller_id"] = native_id

    store.recover(args["expected_authority_sha256"], reason, archive_paths=precondition, restore_adapter=restore if operation == "attach" else None)
    anchor = store.read()
    state = core.task_show(root)["state"]
    if rollback:
        hint = ("The unconfirmed write was archived, not applied. Repeat it only if it still applies: a dispatch whose begin was discarded is dispatched again; "
                "a reservation that reappears is resolved with thaliris_reconcile (reconcile, or dispose with a reason).")
    else:
        hint = ""
    if operation == "attach":
        hint += (" This root is now the task's only Controller; the previous root is refused. A reservation the previous root dispatched has no native evidence "
                 "in this session: resolve it with thaliris_reconcile action dispose and a reason.")
    return {"ok": True, "status": "TASK_AUTHORITY_RECOVERED" if operation == "recover" else "DSH_CONTROLLER_ATTACHED", "task_id": task_id,
            "revision": state["revision"], "rolled_back": rollback, **({"discarded_revision": discarded.get("ledger_revision")} if rollback else {}),
            "archive": anchor["recoveries"][-1]["archive"], "authority_sha256": authority_digest(store), "active_work": len(state["active_work"]),
            "next": hint.strip(), "task_context": task_context_text(core, state, root)}


def dispose(core, root: Path, store, native_id: str, state: dict, args: dict) -> dict:
    """Controller-decided release of one reservation that native evidence cannot reconcile.

    The archived result is `disposed` with native outcome UNKNOWN, never completed, and keeps
    the Controller's reason. The adapter reports the child's liveness (a child resident in
    its process is cancelled first); outcome and provenance are supplied here. Evidence,
    records and the rest of the task stay unchanged.
    """
    reason = args.get("reason")
    if set(args) != {"task_id", "base_revision", "reason", "observation"} or not isinstance(reason, str) or not reason.strip() or len(reason) > 3500 \
            or not isinstance(args["observation"], str) or len(args["observation"]) > 3500:
        raise ValueError("INVALID_DISPOSE_ARGUMENTS")
    if len(state["active_work"]) != 1:
        raise ValueError("NATIVE_RESERVATION_REQUIRED")
    observed = parse_json(args["observation"])
    if not isinstance(observed, dict) or set(observed) - {"correlation", "child_id", "child_liveness", "liveness_reason"} or observed.get("child_liveness") not in DISPOSE_LIVENESS:
        raise ValueError("DISPOSE_OBSERVATION_FIELDS: the adapter reports correlation, child_id and child_liveness; the bridge records outcome and provenance")
    reservation = parse_json(state["active_work"][0])
    reservation = reservation if isinstance(reservation, dict) else {}
    child_id = observed.get("child_id") or reservation.get("child_id")
    if observed.get("correlation") != reservation.get("correlation") or reservation.get("child_id") and child_id != reservation["child_id"]:
        raise ValueError("NATIVE_RESERVATION_CONFLICT")
    released = {"outcome": "disposed", "native_outcome": "UNKNOWN", "child_id": child_id, "child_liveness": observed["child_liveness"],
                **({"liveness_reason": observed["liveness_reason"]} if "liveness_reason" in observed else {}), "reason": reason, "provenance": "controller-dispose"}
    archive = {"operation": "dispose", "reservation": parse_json(state["active_work"][0], raw=True), "result": released}
    result = write(core, root, native_id, state, {"active_work": []}, [(DISPATCH_KIND, compact(archive), ADAPTER_PRODUCER)])
    result["evidence"] = core.evidence_summary(core.task_show(root)["state"])
    store.checkpoint()
    return {**result, "outcome": "disposed", "native_outcome": "UNKNOWN"}


def resume(core, AuthorityStore, root: Path, authority_directory: Path, native_id: str, workspace_id: str) -> dict:
    """List this native root's ACTIVE anchored tasks with their bounded context.

    Restores the dynamic task-context summary after a process restart. It is
    read-only and matches the anchor's recorded DSH controller and workspace,
    never a caller-supplied task or actor. A task of this root whose ledger
    differs from its anchor is listed as needing recovery, not dropped; ACTIVE
    tasks of this workspace anchored to another root are listed as attachable
    summaries (no context). Counts report what is not shown.
    """
    tasks, recovery, attachable, unreadable = [], [], [], 0
    directory = root / ".context" / "tasks"
    candidates = sorted(path.parent.name for path in directory.glob("*/state.json")) if directory.is_dir() else []
    for task_id in candidates[:256]:
        try:
            core.select_task(root, task_id)
            store = AuthorityStore(root, authority_directory, protected_paths=(".context/config.json",), task_id=task_id)
            try:
                record = store.check()
            except ValueError as error:
                failure = authority_failure(store, error, task_id, native_id, workspace_id)
                if getattr(failure, "code", None) != STATE_CHANGED:
                    raise
                details = failure.details
                entry = {"task_id": task_id, "code": STATE_CHANGED, "authority_sha256": details["authority_sha256"],
                         "anchored_revision": details["anchored_revision"], "ledger_revision": details["ledger_revision"]}
                if details["anchored_controller"] == "this-session":
                    recovery.append(entry)
                else:
                    attachable.append({**entry, "state_changed": True})
                continue
            if record is None or record.get("task_id") != task_id or record.get("dsh_workspace_id") != workspace_id:
                continue
            if record.get("dsh_controller_id") != native_id:
                attachable.append({"task_id": task_id, "goal": record["goal"][:200], "execution_mode": record["contract"]["execution_mode"],
                                   "authority_sha256": authority_digest(store), "state_changed": False})
                continue
            state = core.task_show(root)["state"]
            tasks.append({"task_id": task_id, "revision": state["revision"], "execution_mode": record["contract"]["execution_mode"],
                          "task_context": task_context_text(core, state, root)})
        except (ValueError, OSError, KeyError, TypeError):
            unreadable += 1
    return {"ok": True, "tasks": tasks[:RESUME_SHOWN], "task_count": len(tasks), "truncated": len(tasks) > RESUME_SHOWN,
            "omitted_task_ids": [task["task_id"] for task in tasks[RESUME_SHOWN:RESUME_SHOWN + 32]],
            "recovery_required": recovery[:16], "recovery_required_count": len(recovery),
            "attachable": attachable[:16], "attachable_count": len(attachable),
            "unreadable_count": unreadable, "scan_limited": len(candidates) > 256}


def parse_json(value: str, raw: bool = False):
    """Parse adapter JSON; on failure return the raw string (raw=True) or None."""
    try:
        return json.loads(value)
    except (TypeError, ValueError):
        return value if raw else None


def compact(value) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def is_adapter_record(item: dict, kinds=ADAPTER_KINDS) -> bool:
    return item.get("producer") == ADAPTER_PRODUCER and item.get("kind") in kinds


def split_pending(values: list[str]) -> tuple[list[str], list[str]]:
    """Separate current pending results from history earlier versions kept there.

    Legacy history is archived reservations, terminal dispatch observations,
    close decisions, approval receipts and the proposals those receipts
    consumed. Unapproved proposals and unrecognized entries stay, unchanged.
    """
    parsed = [parse_json(value) for value in values]
    approved = {item["proposal_id"] for item in parsed if isinstance(item, dict) and isinstance(item.get("approval_id"), str) and isinstance(item.get("proposal_id"), str)}
    current, legacy = [], []
    for value, item in zip(values, parsed):
        historical = value.startswith(LEGACY_PREFIXES) or isinstance(item, dict) and (
            isinstance(item.get("approval_id"), str) or item.get("provenance") in TERMINAL_PROVENANCE
            or isinstance(item.get("proposal_id"), str) and item["proposal_id"] in approved)
        (legacy if historical else current).append(value)
    return current, legacy


def bounded_text(text: str) -> str:
    if len(text) <= RECORD_TEXT_MAX:
        return text
    # Adapter-built texts stay well below the bound (their inputs are bounded);
    # this keeps a record from ever failing a release or close on size.
    return compact({"truncated": True, "sha256": hashlib.sha256(text.encode("utf-8")).hexdigest(), "prefix": text[:RECORD_TEXT_MAX // 2]})


def write(core, root: Path, actor: str, state: dict, partial: dict, additions: list[tuple[str, str, str]] = ()) -> dict:
    """One CAS update: routing change, adapter-supplied records, legacy migration.

    Legacy history found in Pending Results moves into one bounded record on
    this write. Record producer and revision are supplied here, never by the
    caller. If Core's record-count or state-size bound refuses the records,
    the routing change is applied alone and the unrecorded text is returned,
    so history volume never blocks a release or close.
    """
    current, legacy = split_pending(partial.get("pending_results", state["pending_results"]))
    taken = core._task_object_ids(state) | {item.get("id") for item in partial.get("records", []) if isinstance(item, dict)}
    revision = state["revision"] + 1

    def record(kind: str, text: str, producer: str) -> dict:
        base = f"{kind}.r{revision}"
        identifier, suffix = base, 1
        while identifier in taken:
            suffix += 1
            identifier = f"{base}.{suffix}"
        taken.add(identifier)
        return {"id": identifier, "kind": kind, "text": bounded_text(text), "producer": producer, "revision": revision}

    built = [record(LEGACY_KIND, json.dumps({"migrated_from": "pending_results", "entries": legacy}, ensure_ascii=False), ADAPTER_PRODUCER)] if legacy else []
    built += [record(kind, text, producer) for kind, text, producer in additions]
    full = {**partial, **({"pending_results": current} if legacy else {})}
    if built:
        full["records"] = [*partial.get("records", []), *built]
    try:
        result = update(core, root, actor, state["revision"], full)
    except ValueError as error:
        if not built or not is_core_capacity_error(error):
            raise
        result = update(core, root, actor, state["revision"], partial)
        return {**result, "adapter_records": [], "unrecorded_reason": "CORE_RECORD_CAPACITY: " + str(error),
                "unrecorded": [{"kind": item["kind"], "text": item["text"]} for item in built if item["kind"] != LEGACY_KIND]}
    return {**result, "adapter_records": [item["id"] for item in built]}


def approval(core, root: Path, native_id: str, state: dict, args: dict) -> dict:
    """Consume one proposal: drop it from Pending Results and record the receipt."""
    if set(args) != {"task_id", "observation"} or not isinstance(args["observation"], str) or len(args["observation"]) > 3500:
        raise ValueError("INVALID_MEMORY_APPROVAL")
    receipt = parse_json(args["observation"])
    if not isinstance(receipt, dict) or not isinstance(receipt.get("approval_id"), str) or not isinstance(receipt.get("proposal_id"), str):
        raise ValueError("INVALID_MEMORY_APPROVAL")
    remaining, consumed = [], None
    for value in state["pending_results"]:
        item = parse_json(value)
        if consumed is None and isinstance(item, dict) and item.get("proposal_id") == receipt["proposal_id"] and "approval_id" not in item:
            consumed = item
        else:
            remaining.append(value)
    # The provider write already happened; its receipt is recorded even when
    # the proposal is no longer pending.
    text = compact({"receipt": receipt, "proposal": consumed})
    return write(core, root, native_id, state, {"pending_results": remaining}, [(APPROVAL_KIND, text, ADAPTER_PRODUCER)])


def dispatch_history(state: dict, limit: int = 8) -> dict:
    """Bounded projection of finished dispatches archived as adapter records."""
    archives = [item for item in state["records"] if is_adapter_record(item, {DISPATCH_KIND})]
    migrated = [entry for item in state["records"] if is_adapter_record(item, {LEGACY_KIND})
                for entry in ((parse_json(item["text"]) or {}).get("entries") or []) if isinstance(entry, str)]
    legacy = sum(entry.startswith(ARCHIVE_PREFIX) for entry in [*migrated, *state["pending_results"]])

    def summary(item: dict) -> dict:
        archive = parse_json(item["text"])
        archive = archive if isinstance(archive, dict) else {}
        reservation = archive.get("reservation") if isinstance(archive.get("reservation"), dict) else {}
        result = archive.get("result") if isinstance(archive.get("result"), dict) else {}
        return {"id": item["id"], "revision": item["revision"], "operation": archive.get("operation"),
                **{key: reservation[key] for key in ("workstream", "role", "route", "evidence_handoff_id") if key in reservation},
                "child_id": result.get("child_id", reservation.get("child_id")), "outcome": result.get("stop_reason", result.get("outcome"))}

    return {"record_kind": DISPATCH_KIND, "count": len(archives), "legacy_count": legacy,
            "recent": [summary(item) for item in archives[-limit:]] if limit else []}


def dispatch_history_compact(state: dict) -> dict:
    """Compact dispatch projection: counts plus only the recent dispatches that did not complete.

    Completed dispatches are counted; failed, aborted or unknown outcomes stay
    listed (bounded), because those are the ones a Controller may need to act on.
    The full view still lists every recent dispatch.
    """
    full = dispatch_history(state, limit=0)
    archives = [item for item in state["records"] if is_adapter_record(item, {DISPATCH_KIND})]
    summaries = []
    for item in reversed(archives):
        archive = parse_json(item["text"])
        archive = archive if isinstance(archive, dict) else {}
        result = archive.get("result") if isinstance(archive.get("result"), dict) else {}
        outcome = result.get("stop_reason", result.get("outcome"))
        if outcome != "completed":
            reservation = archive.get("reservation") if isinstance(archive.get("reservation"), dict) else {}
            summaries.append({"id": item["id"], "operation": archive.get("operation"), "outcome": outcome,
                              **{key: reservation[key] for key in ("workstream", "role") if key in reservation}})
        if len(summaries) == COMPACT_NON_COMPLETED_MAX:
            break
    return {"record_kind": DISPATCH_KIND, "count": full["count"], "legacy_count": full["legacy_count"], "non_completed": summaries[::-1]}


def current_records(state: dict, limit: int = 12, text_chars: int = 600, compact: bool = False) -> tuple[list[dict], int]:
    """The most recent Controller-facing records no later record supersedes (bounded), and their total count.

    Adapter history records (dispatch archives, memory receipts, legacy
    migration) are projected by dispatch_history instead, so they never
    crowd Controller decisions out of the bounded task context.
    """
    superseded = {ref for item in state["records"] for ref in item.get("supersedes", [])}
    current = [item for item in state["records"] if item["id"] not in superseded and not is_adapter_record(item)]
    if compact:
        # Navigation view: id, kind and a clipped text (a trailing ellipsis marks clipping); status and revision stay in the full view.
        return [{"id": item["id"], "kind": item["kind"], "text": item["text"][:text_chars] + ("…" if len(item["text"]) > text_chars else "")}
                for item in current[-limit:]], len(current)
    shown = [{"id": item["id"], "kind": item["kind"], "status": item["status"], "revision": item["revision"],
              "text": item["text"][:text_chars], "truncated": len(item["text"]) > text_chars,
              **({"supersedes": item["supersedes"]} if item.get("supersedes") else {})} for item in current[-limit:]]
    return shown, len(current)


def task_context_text(core, state: dict, root: Path | None = None, budget: int = 6000) -> str | None:
    """Bounded summary of the Controller's recorded task context.

    DSH re-supplies it as dynamic context after compaction or resume, so global
    semantic state is not re-investigated. It is recorded history, not fresh
    verification, and it never carries acceptance. With a root it also carries
    Core's one-line Project Identity summary, only when an identity is recorded.
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
    summary = identity_summary_line(root)
    if summary:
        lines.append(f"- {summary}")
    if state["active_work"]:
        lines.append("- Active Work (unresolved native reservation; check, reconcile or dispose it with thaliris_reconcile):")
        lines += [f"  - {value[:300]}" for value in state["active_work"][:4]]
    if records:
        lines.append(f"- Current records ({len(records)} most recent of {total} not superseded):")
        lines += [f"  - {item['id']} [{item['kind']}] {item['text']}{' ...' if item['truncated'] else ''}" for item in records]
    history = dispatch_history(state, limit=0)
    if history["count"] or history["legacy_count"]:
        legacy = f" (+{history['legacy_count']} legacy)" if history["legacy_count"] else ""
        lines.append(f"- Dispatch history: {history['count']} finished dispatch(es){legacy} archived as {DISPATCH_KIND} records; read thaliris_task_status.")
    if continuity["unincorporated_total"] or continuity["unresolved_judgments_total"]:
        lines.append(f"- Evidence continuity: {continuity['unincorporated_total']} unincorporated observation link(s), "
                     f"{continuity['unresolved_judgments_total']} unresolved judgment(s); read thaliris_task_status.")
    text, suffix = "\n".join(lines), "\n- ... truncated; read the rest with thaliris_task_status."
    return text if len(text) <= budget else text[:budget - len(suffix)] + suffix


def task_context_update(core, root: Path, store, state: dict, args: dict) -> dict:
    """Controller-recorded facts, decisions, progress, open items and milestone.

    Reservations and pending results stay adapter-owned; records are
    append-only and the bridge supplies their producer and revision. Legacy
    history still in Pending Results is migrated on this write.
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
    result = write(core, root, CONTROLLER_PRODUCER, state, partial)
    store.checkpoint()
    current = core.task_show(root)["state"]
    records, total = current_records(current, text_chars=0, compact=True)
    # Ids only: the Controller just wrote the texts; the bounded dynamic context re-supplies them.
    return {**result, "Task Context": {"milestone": current["current_milestone"], "Current Records": [{"id": item["id"], "kind": item["kind"]} for item in records],
                                       "Current Record Count": total},
            "evidence": core.evidence_summary(current), "task_context": task_context_text(core, current, root)}


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
        # One judgment, or an ordered batch committed atomically in one revision (Core: all-or-nothing, 1-64 items).
        judgment, batch = args.get("judgment"), args.get("judgments")
        if set(args) not in ({"task_id", "base_revision", "judgment"}, {"task_id", "base_revision", "judgments"}):
            raise ValueError("INVALID_JUDGE_ARGUMENTS: give exactly one of judgment or judgments; Core assigns task_id and producer")
        items = [judgment] if "judgment" in args else batch
        if not isinstance(items, list) and "judgment" not in args:
            raise ValueError("INVALID_JUDGE_ARGUMENTS: judgments must be a list")
        if not items or any(not isinstance(item, dict) or set(item) - JUDGMENT_FIELDS for item in items):
            raise ValueError("INVALID_JUDGE_ARGUMENTS: Core assigns task_id and producer")
        payload, kind = ({"judgments": batch} if "judgments" in args else judgment), "judgments"
    with core._lock(root):
        current = core._load_state(root, active=True)
        check_cas(core, current, args)
        appended = core._append_continuity_state(current, CONTROLLER_PRODUCER, payload, kind)
        core._write_state(root, current)
    store.checkpoint()
    # Compact write result: revision, appended ids and the open-evidence summary instead of a status echo.
    return {**core.task_write_response(current, ["evidence_continuity"], appended=appended), "task_context": task_context_text(core, current, root)}


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
        check_cas(core, current, args)
        if current["active_work"]:
            raise ValueError(LEGACY_CONFLICT)
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
        response = error_response(error)
        code = 1
    print(json.dumps(response, ensure_ascii=True))
    return code


if __name__ == "__main__":
    raise SystemExit(main())
