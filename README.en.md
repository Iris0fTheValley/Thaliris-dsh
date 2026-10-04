# Thaliris for DeepSeek Harness

Language: English | [简体中文](README.md)

## DSH Host adapter

@thaliris/dsh-plugin adds task records and explicit Controller tools to [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness), using its native Workspaces, persistent Sessions, Agents, subagents, Settings, model catalog, Plugin Manager, and lifecycle. The Python Core is a separate [Thaliris distribution](https://github.com/Iris0fTheValley/Thaliris); this repository contains no Core or Codex adapter copy.

The runtime package has optional Remote API and shared Web/Desktop client entries. Its policy page edits native role, model, workspace, and memory settings. Memory capability and the default local provider are separate optional packages, while task routing and close work without them or the client UI. Contracts and limits are in [CLIENT-CONTRACT.md](CLIENT-CONTRACT.md), [CAPABILITIES.md](CAPABILITIES.md), and [CORE-BASELINE.md](CORE-BASELINE.md).

### Install and configure

The package targets DSH source revision 639ed015397290b3745d163aafe02ffee4aa3f84 and Core 0.4.3 at source revision 7f4d9acf2e642e7b3c987d4ee45ebc6589d7cc15. It requires Node.js 22.19+ in the 22.x line or 24+, plus Python 3.11+. Core supplies thaliris.core and thaliris.authority to the plugin's configured Python environment. Runtime, Remote API, and optional memory entries are disabled by default. Install the local archives through the native Plugin Manager:

    dsh plugin --profile <profile> add <artifact-dir>/thaliris-dsh-plugin-0.2.0.tgz <artifact-dir>/thaliris-dsh-memory-0.1.0.tgz <artifact-dir>/thaliris-dsh-memory-local-0.1.0.tgz

Before enabling runtime, configure absolute pythonExecutable, corePath, and authorityDirectory values. corePath identifies the Core installation for that Python environment. Keep authorityDirectory outside the governed Workspace and do not store credentials in plugin configuration. Register the canonical Git root as a native Workspace, create or resume its persistent root Session, then bind the native Workspace ID and exact root in policy.workspaces.

Build the profile patch with npm run build:bundle and the client with DSH_SOURCE=<checkout> npm run build:client from the pinned DSH checkout. The Web client preset is shared with Desktop. Run npm pack in this repository and each optional component directory to create the three archives. The patch is regenerated from visible role templates and leaves runtime/API disabled by default; bundled Zod licensing is listed in [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md). The native policy form edits role records, prompts, tool grants, model routes, memory grants, and context permissions. Route modes are inherit, fixed, and allowed; Thaliris does not rank models or rewrite user settings.

### Behavior and limits

The native root Agent, persisted Session ancestry, and configured native Workspace must match the Core authority anchor. A same-path unrelated Session cannot continue the task. Delegation creates a fresh native child and passes only the selected bounded handoff, exact role prompt, and explicitly selected memory context. Controller acceptance is explicit; a child result leaves the task active until Controller close.

Recovery uses exact native child correlation and durable terminal Session evidence. Catalog membership or inactivity alone does not prove completion. If identity, persistence, or terminal reason is missing, the result remains UNKNOWN and the reservation remains; the broader UNKNOWN-abandonment flow is not implemented. Shared OS access and writer leases are governance facts, not universal actor authentication.

Memory is disabled by default. The optional capability accepts replaceable async providers; @thaliris/dsh-memory-local adds a bounded text provider over native storage. There are no embeddings, vector/RAG system, credential manager, or automatic retrieval. Manual and review writes create Core proposals; automatic writes require a separate persisted autoAuthorized: true opt-in. Removing either optional package leaves task routing and close available.

The extracted repository checks use a scripted LLM and pinned DSH source; they do not use online models or a current installed profile. The original source repository separately verified live Web integration against Core source revision 256f760, including a real task, fifth child, denial of native root tools to that child, and explicit DONE close. This does not mean the extracted package smoke launched a browser. Desktop shares the Web client bundle, but no Desktop binary was launched. Detailed commands and scopes are in the original Chinese README and linked contract docs.

The Core repository contains the [ABCD benchmark protocol](https://github.com/Iris0fTheValley/Thaliris/blob/main/docs/thaliris-benchmark-protocol.md) and canonical results. The sibling [Thaliris Codex adapter](https://github.com/Iris0fTheValley/Thaliris-codex) uses the same Core.

### Development and verification

Use the pinned DSH source and matching Core source or distribution. Set DSH_SOURCE to the DSH checkout, THALIRIS_CORE_PATH to the directory containing the thaliris source package, and THALIRIS_TEST_PYTHON to an isolated Python 3.11+ environment. The source bridge and native composition checks use that checkout. For packed activation smoke, build a fresh Core wheel from the pinned source, install it into the isolated environment, and set THALIRIS_TEST_CORE_PATH to the installed package directory. Then run:

    npm run build:bundle
    npm run build:client
    npm run test:native
    npm run test:client
    python -m pytest tests/test_bridge.py -q

The client build and tests use temporary package workspaces under DSH and remove them on exit; native tests use temporary fixture repositories. The packed smoke also needs THALIRIS_PACK_DIR (all three local archives), THALIRIS_TEST_CORE_PATH (the installed Core package), and THALIRIS_TEST_TMP_ROOT (task-owned scratch space), then runs npm run test:install. It verifies the packed runtime imports Core, starts, inspects, and closes a task through DSH, and retains those tools after optional memory bundles are removed.

## Shared Thaliris Core

Thaliris is a Git-native mechanical context and lifecycle layer. It does not
run agents and does not decide what is relevant, correct, or sufficient to
finish a task.

> Models own semantics. The mechanical layer executes model decisions.

For runtime drift and offline recovery, see [Runtime drift and recovery](https://github.com/Iris0fTheValley/Thaliris/blob/main/docs/thaliris-runtime-recovery.md).

Persistent human task intent, reconnect recovery, and explicit Controller-direct and single-agent modes are described in [Task authority](https://github.com/Iris0fTheValley/Thaliris/blob/main/docs/thaliris-task-authority.md).

## Production flow

```text
Controller
    │ explicit task + selected information
    ▼
selected role session
    ├── private working set
    ├── optional detailed Artifact
    └── distilled result
            │
            ▼
        Controller
            └── decides the next handoff
```

The authorized parent's native spawn message is each role session's only task-specific
semantic input. `SubagentStart` validates authorization, identity, role, and
session and binds lifecycle and handoff metadata. It does not construct a context
packet or return task-specific `additionalContext`.

There is no production path from task state through a role projection into a
role session, and no hidden model auditor that corrects or blocks the Controller.

## Responsibilities

The Controller owns routing, context selection, interpretation, acceptance,
and completion. For ACTIVE and degraded work, it selects the minimum necessary
fresh roles; roles divide cognitive load rather than define mandatory stages.
The current design separates the main loads: the Controller preserves the goal
and selects context; Investigator carries large working sets, repository scans,
and fact compression; Implementer owns implementation; Reviewer independently
challenges the result. Complex implementation may use a more focused,
higher-capability execution binding, while implementation decisions stay with
the executor. Reasoning Specialist is reserved for reframing the problem when
the problem definition, abstraction, or assumptions are themselves unclear.
Durable-knowledge admission belongs to the Controller. During normal task work,
Root notices reusable knowledge in user input, its own decisions, Investigator
evidence, Executor results, Reviewer findings, and Specialist challenges. This
remains private working-context awareness; it creates no candidate register,
saved admission state, counter, score, threshold, extra checkpoint, or
interruption of an active Workstream. Executors return their normal result and
do not track candidates, spawn Curator, maintain durable INDEX navigation, or
add a separate memory-governance section to FINAL.

Near the task's natural end, as part of ordinary closure before `task-close`,
the Controller decides whether evidence established, revised, invalidated, or
materially clarified reusable project knowledge and whether a concise, sourced
memory entry would improve, constrain, or accelerate future decisions or
recovery. This is not limited to facts a future agent would otherwise need to
reinvestigate. With selected candidates, Root supplies a fresh Curator with the
facts and supporting evidence, exact relevant prior memory and INDEX navigation,
and canonical sources needed to reconcile them. With no candidates or no future value, it skips Curator; small ordinary
tasks can skip it entirely. Task size or architecture work alone never makes
Curator mandatory.

Existing docs, source, instructions, tests, commits, and rollouts are neither
automatic exclusions nor reasons by themselves to create memory. Use them as
evidence and avoid duplicating canonical text. Memory can act as a future-Agent
recovery entrance by linking or summarizing easy-to-locate canonical material,
or by compressing a decision basis spread across code, Host, history, or design.
Curator reconciles selected candidates with the supplied sources and can report
that existing knowledge is sufficient and no write is needed. When adding,
revising, merging, splitting, narrowing, superseding, or deleting selected
memory, Curator also judges whether relevant INDEX navigation needs an update
and updates it when needed. The ordinary Implementer keeps product and protocol
documentation and the README aligned with verified behavior in the assigned
Workstream. Focused Implementer synchronizes those documents only when needed
to establish core semantics; after its endpoint, deterministic documentation
synchronization belongs to a fresh ordinary Implementer Workstream when
assigned. Compatibility or specialized profiles may exist without becoming
mandatory workflow stages.

Both Implementer and Focused Implementer execute implementation work. Keep the
working set focused. Investigator may carry a large private working set and
compress broad scans, call sites, and residual references into facts, locations,
evidence, and unknowns. Executors use that evidence while retaining implementation
decisions. Reasoning Specialist reframes ill-defined problems. Verifier is a
read-only compatibility role and is not recommended as a workflow stage.
Focused Implementer owns semantic convergence of its candidate and continues
only verification or repair that could still change the core semantic solution.
It returns FINAL when hard invariants hold, decision-changing unknowns are
resolved, focused evidence demonstrates core semantics, and no remaining work
is likely to materially change the causal model, accepted architecture,
contract, scope, acceptance, or direction. A focused-test PASS alone is not
sufficient. After this endpoint, ordinary regression, lint, build, generated
or documentation synchronization, mechanical compatibility, small deterministic
fixes, installation, and Git closure belong to a fresh ordinary Implementer
Workstream when assigned. Semantic defects exposed by installation or smoke
feedback remain with Focused Implementer while they could change the core
solution.

Controller has no fixed model, effort, or native profile; Host/user selection
applies. Investigator, Curator, and standard Implementer default to
`gpt-6-luna/xhigh`; Focused Implementer, Reasoning Specialist, and Reviewer to
`gpt-6.1-sol/high`; compatibility Verifier to `gpt-6-luna/xhigh`.
Only Controller may select static Astra medium or xhigh profiles before spawn,
and only with current-task user authorization. Automatic routing stops at Sol,
including cross-surface uncertainty. Those profiles map to the same stable
role IDs. Per-spawn
model/effort overrides are denied.

Role sessions keep intermediate work private and normally return only a
distilled conclusion, key findings, decision-changing unknowns, contradictions,
verification, and optional Artifact pointers.

Core provides identities, revisions and compare-and-swap, locking, atomic
writes and rollback, hashes, provenance, supersession history, objective file
freshness observations, mechanical verification and task-surface observations,
Artifact addressing, and explicit retrieval.

Core does not decide relevance, importance, correctness, role applicability,
task completion, or whether changed evidence invalidates a model conclusion.

The Codex adapter provides fresh spawn isolation, `fork_turns="none"`, an
authorized bounded depth-two native Codex child lifecycle, handoff hashes, SubagentStart/Stop identity,
bounded missing-stop reconciliation, and native blocking waits. An automatic
long-wait normalization occurs only when a pending reservation or managed native Codex child
exists and a current-session effective maximum is mechanically verified;
otherwise the requested timeout is preserved without automatic expansion.
The Controller is carried by the Host/user-selected root session; child-profile
model and effort choices belong to adapter role bindings.

Only Implementer, Focused Implementer, and Reviewer may delegate one fresh
Investigator/Scanner. There is one active top-level role session and at most
one nested Scanner; its result belongs to its requesting parent. Exact parent
agent/session/turn/role identity is required, with missing/conflicting fields
denied. One live managed Codex CLI `0.155.0-alpha.9.2` probe verified the exact
reservation, Start, and bound Scanner PreToolUse acceptance for a depth-two
Scanner; the Scanner result returned and the Focused parent continued. See the
[durable probe evidence](https://github.com/Iris0fTheValley/Thaliris/blob/main/docs/codex-nested-scanner-live-20260925.md). That
evidence covers only this CLI build and probe; raw Host wire-byte equality,
other Host builds, and other Desktop scenarios remain UNKNOWN. A separate
Codex Desktop probe on 2026-09-28 observed `list_agents` return an exact child
name and native `completed` status; end-to-end Desktop `task-close` remains
unobserved. Task-close requires the latest Controller-direct handoff's matching
Start, Stop, and native `Completed` observation, with no pending or active
descendants.

## Task ledger

The task ledger is a revisioned mechanical record. The Controller supplies records with identity, kind, text, producer, status, source references, and optional supersession. Kind and status are descriptive labels; Core validates schema, identity, and reference integrity without assigning workflow meaning. task-close checks task identity, revision, basic state consistency, and authorized adapter lifecycle. It does not decide whether tests are sufficient or the task is semantically complete.

## Artifacts, memory, and milestones

Artifacts store an ID, producer, repo-relative path, content hash, created
revision, optional source references, and optional supersession. Core never
reads an Artifact body for automatic propagation. The Controller explicitly
retrieves it and selects any material for a later handoff.

Durable navigation uses `catalog` and explicit exact-path `document-get` only.
The root INDEX maps are model-maintained semantic navigation, not bare file
listings. Their concise descriptions say what linked knowledge covers, when it
is useful to read, and current versus historical applicability where useful;
Root uses them to select exact recovery documents, with currently relevant
knowledge discoverable first. Models choose natural paths, hierarchy, and
wording without a fixed schema or taxonomy. Core never interprets, generates,
or rebuilds INDEX content; it performs only mechanical path, CAS, size, link,
and atomic-write checks. Legacy semantic metadata is opaque compatibility data,
never search, display, or routing authority.
SessionStart only points to the two root INDEX paths; it does not inject their
contents. Before starting managed work, the Controller explicitly reads the
root navigation and creates a minimal thin INDEX first if one is missing.
Navigation is not reread automatically during the task unless the map changed,
is insufficient, freshness is invalid, or resume/compact requires recovery.

Milestones are ordinary documents. Curator is an optional knowledge-enhancement
role, not a mandatory task stage. `task-promote` stores what the Controller
explicitly selected without an epistemic qualification gate. When a
`task-promote` call changes durable navigation, the Controller provides its
optional `index_update` in the same call. Curator maintains relevant memory
navigation during curation. Core checks paths, CAS, size, links, and atomic
commit; it does not generate INDEX content.
If Codex explicitly reports a native spawn failure before `SubagentStart`, the
Controller may call `thaliris recover-pending-spawn HANDOFF_ID` for that exact
handoff; Core never infers failure from a missing event, timeout, or retry.

## Verification and task surface

Freshness reports only FRESH, PARTIAL, RECORDED, CHANGED, MISSING, or UNKNOWN file facts. Verification records the command or tool, outcome, candidate identity, observed files, timestamp, and result hash. Task surface records the starting HEAD, dirty baseline, current state, and delta. Both are mechanical observations; neither establishes correctness, ownership, or semantic completion.

## Persistent task authority

The Controller's explicit task-start selects the actual human intent, scope, invariants, acceptance, and execution mode (delegated, controller-direct, or single-agent), and records the task anchor outside the repository. Host actor identity may remain UNKNOWN; prompt fields, session equality, PID, environment, and SessionSource do not prove human identity. Ordinary turn, network, Hook, session, or daemon interruptions do not require a new Root proof to continue the same task. Human revocation, task closure, Controller abandonment, or replacement ends that authority.

task-recover-authority accepts only the exact external authority hash and a reason. It archives conflicts, restores recorded bytes, and fences known old children. It cannot bless changed security configuration as a new baseline, and it does not prove an old process has terminated. Changing the goal, scope, acceptance, execution mode, removing fences, or establishing a new security baseline requires a new superior human decision; a child cannot authorize those changes.

## Commands

On READY, write the UTF-8 JSON authority contract in a separate step, then pass its absolute path in a separate task-start invocation.

For substantive work in a Git repository, run the installed
`thaliris-run.cmd --root <repo> codex-bootstrap` first. If it returns READY,
pass its bootstrap receipt to `thaliris-run.cmd --root <repo> task-start "goal" --bootstrap-receipt <receipt> --authority-contract <absolute-path-to-contract.json>`
in the same session; the current Host Hook supplies the one-shot task-start
attestation.

```text
thaliris init
thaliris-run.cmd --root <repo> task-start "goal" --bootstrap-receipt <receipt> --authority-contract <absolute-path-to-contract.json>
thaliris task-status
thaliris task-get OBJECT_ID
thaliris task-update --role controller --base-revision N --input update.json
thaliris task-artifact --base-revision N --id A-001 --path path/to/file.md --summary "..."
thaliris catalog
thaliris document-get .agent-memory/model-chosen/a.md .milestones/current/status.md
thaliris task-promote --role controller --base-revision N --input promotion.json
thaliris task-close --base-revision N
thaliris task-recover-authority --expected-authority-sha256 <hash> --reason "recover interrupted work"
thaliris recover-pending-spawn HANDOFF_ID
thaliris stale
thaliris rollback BACKUP_ID
thaliris doctor
```

## ABCD benchmark results

We ran a controlled single-task benchmark to separate **model capability**, **orchestration**, and **heterogeneous intelligence allocation**. A/B/C used the same task, BASE revision, Codex version, isolated workspace/CODEX_HOME and environment; D is a previously sealed production-architecture run and was not rerun.

The four completed arms test two primary hypotheses:

**Orchestration Gain — B → C:** does role decomposition and isolated multi-agent execution improve a Luna-only system over a single Luna agent?

**Intelligence Allocation Gain — C → D:** once orchestration exists, does selectively placing stronger models at semantic implementation/review/closure points materially improve the result?

### Results

| Arm | Configuration | Coverage | Correctness | Compatibility | Implementation | Verification | Mean | Completion | Wall time | Cost proxy |
|---|---|---:|---:|---:|---:|---:|---:|---|---:|---:|
| **A** | Sol medium, single agent | 6 | 4 | 6 | 6 | 7 | **5.8** | Partial | **21m36s** | **$0.883** |
| **B** | Luna xhigh, single agent | 6 | 5 | 6 | 6 | 4 | **5.4** | Partial | **54m09s** | **$0.232–0.235** |
| **C** | Thaliris, Luna-only | 4 | 6 | 7 | 6 | 4 | **5.4** | Managed DONE / product partial | **41m11s** | **$0.272** |
| **D** | Thaliris, heterogeneous routing | **9** | **8** | **8** | **8.5** | **8** | **8.3** | Largely complete; one P2 remains | **64m47s** | **$2.475** |
| **E?** | D topology, **all-Sol workers** | **9?** | **8?** | **8?** | **8.5?** | **8?** | **8.3?** | D-like? | **64m47s?** | **~$3.67 predicted** |
| **F?** | D + **semantic-convergence cut** | **9?** | **8?** | **8?** | **8.5?** | **8?** | **8.3?** | D-like? | **64m47s?** | **~$2.06–2.07 predicted** |

A/B/C's independent scores and runtime/cost measurements come from the fresh benchmark assessment. D's original sealed assessment rated all five dimensions `GOOD`; the numeric 8.3/10 row above is a later read-only re-evaluation of the same frozen candidate using the A/B/C rubric. The original D run itself remains sealed and unchanged. Its production routing was Luna Investigator → Sol Focused Implementer → Sol Reviewer → Luna repair → Sol Reviewer → Luna repair.

### Token structure

`cached input` is a subset of input, not additional tokens.

| Arm | Input | Cached | Fresh input | Output | Reasoning output | Model distribution |
|---|---:|---:|---:|---:|---:|---|
| **A** | **3.104M** | 2.962M | 0.142M | 30.3k | 7.1k | 100% Sol medium |
| **B** | **16.70M** | 16.39M | 0.309M | 79.8k | 46.8k | 100% Luna xhigh |
| **C** | **15.73M** | 15.03M | 0.695M | 105.0k | 66.3k | 100% Luna xhigh |
| **D** | **15.22M** | 14.51M | 0.706M | 108.2k | 44.2k | Sol: 9.96M input / 64.3k output; Luna: 5.26M / 43.9k |
| **E? all-Sol** | **~15.22M?** | ~14.51M? | ~0.706M? | **~80.9k predicted** | ? | Same D topology, Luna nodes replaced by Sol |
| **F? semantic cut** | **~14.05–14.65M predicted** | ? | ? | **~100.9–108.9k predicted** | ? | Sol ~8.09M input; Luna ~5.96–6.56M |

Observed D usage was 15.219M input, of which 14.513M was cached. Luna consumed 5.260M input / 43.9k output, while Sol consumed 9.959M input / 64.3k output.

### What each arm shows

| Arm | Strength | Main weakness |
|---|---|---|
| **A — Sol solo** | Fastest run; strong implementation and extensive self-generated verification. | A single trajectory developed a coherent but incomplete semantic model. Its tests largely validated its own assumptions, leaving cross-surface ownership/replay/shutdown defects. |
| **B — Luna solo** | Extremely cheap. With much more compute and time, Luna reached nearly the same aggregate score as A. | ~5.4× A's input and ~2.5× wall time; weak global semantic convergence and verification. Large compute did not eliminate lifecycle/authority gaps. |
| **C — Luna orchestration** | Clear role separation, managed lifecycle, ~13 minutes faster than B, and slightly better correctness/compatibility. | **No aggregate quality gain over B.** Coverage fell 6→4. Treatment review produced a false-negative closure and the managed task reached DONE while product acceptance remained incomplete. |
| **D — heterogeneous Thaliris** | Only configuration to cross into substantially stronger completion. Independent review → repair → re-review actually changed the candidate and closed defects. | Most expensive and slowest observed arm. Sol accumulated large cached-context replay; one later P2 presentation-lifecycle defect remained and real GPU/audio/UI behavior was still unverified. |

A/B/C's principal independent defects are documented in the assessment: each reached a different partially-correct implementation rather than failing in exactly the same way.

### Hypothesis 1 — Orchestration Gain

**Method:** compare **B vs C** while holding actual execution capability at Luna xhigh. B is one Luna agent; C uses Thaliris roles, isolated child contexts and managed lifecycle, but every observed worker remains Luna xhigh.

**Observed result:**

`5.4 → 5.4`

No product-quality gain was observed. C was about **13 minutes faster** and used slightly fewer total tokens, but its estimated cost was **~16–18% higher** because more input was uncached. Its quality distribution changed rather than improving overall: coverage −2, correctness +1, compatibility +1.

**Conclusion:** orchestration alone did not make the weaker model materially stronger in this sample. It showed workflow/lifecycle and throughput benefits, but not aggregate quality improvement.

### Hypothesis 2 — Intelligence Allocation Gain

**Method:** compare **C vs D**. Both use Thaliris orchestration, but D selectively assigns Sol to the Controller, core semantic implementation and independent review while retaining Luna for investigation and bounded repair.

**Observed result:**

`5.4 → 8.3`

The largest rubric jumps were:

`Coverage: 4 → 9 (+5)`<br>
`Verification: 4 → 8 (+4)`<br>
`Implementation: 6 → 8.5 (+2.5)`<br>
`Correctness: 6 → 8 (+2)`<br>
`Compatibility: 7 → 8 (+1)`<br>

D cost about **9.1× C** and took about **1.57× longer**, but it was the only arm to substantially cross the product-completion threshold. D used no parallel execution; the main observable mechanism was repeated **Reviewer → bounded repair → re-review**, not agent count or parallel compute.

**Conclusion:** the result supports **selective intelligence allocation**, not “more agents are automatically better.”

### Two cost hypotheses to test next

**E — All-Sol counterfactual.** Keep D's task, topology, role sequence and lifecycle unchanged, but replace Luna Investigator/Implementer nodes with Sol. Input/context replay is held approximately constant; only output is adjusted using the observed A/B output-efficiency ratio (`79.8k / 30.3k ≈ 2.64×`). This predicts approximately **$3.67** for an all-Sol D-shaped run versus **$2.475 observed**, implying roughly **32.6% routing savings** from heterogeneous execution if D-level quality is preserved. Without the output-efficiency adjustment, the simple same-token estimate is about **$3.94**. This remains a counterfactual until run.

**F — Semantic-Convergence Cut.** Keep D's architecture and high-capability semantic nodes, but terminate the Sol Focused Implementer once the core implementation and hard invariants are established. Broad tests, build/lint closure, deterministic compatibility fallout and small repairs move to a fresh Luna Implementer; a fresh Sol Reviewer remains responsible for semantic acceptance. Trace-based estimation removes roughly **1.87M Sol input / 15.3k Sol output** and adds approximately **0.7–1.3M Luna input / 8–16k output**, predicting **~$2.06–2.07**, or roughly **16–17% below D**, while targeting the same 8.3-level result. Quality remains explicitly unknown until tested.

### Bottom line

The benchmark currently supports a narrower claim than “multi-agent is better”:

> **Weak-model orchestration alone did not improve aggregate quality. Selective placement of stronger intelligence at semantic implementation, review and closure points did.**

It also exposes the next optimization target: **not less high-capability implementation, but shorter expensive-context lifetime**. High-capability models should remain available for work that genuinely requires their reasoning during execution; once the semantic solution has converged, deterministic closure can move to cheaper fresh workers instead of repeatedly replaying a large Sol context.

## Benchmark boundary

`benchmarks/abcd/` may contain complex collectors, formal authority, and
offline scoring. The production `thaliris` package does not depend on D11,
formal registries, capture authority, or benchmark receipt issuers. Benchmarks
observe production; they do not define production architecture.

See [DESIGN.md](https://github.com/Iris0fTheValley/Thaliris/blob/main/DESIGN.md) and
[docs/thaliris-routing-protocol.md](https://github.com/Iris0fTheValley/Thaliris/blob/main/docs/thaliris-routing-protocol.md).

## README maintenance

Shared explanations and the full ABCD results in this file follow the [Thaliris Core Chinese README](https://github.com/Iris0fTheValley/Thaliris/blob/main/README.md) and [English README](https://github.com/Iris0fTheValley/Thaliris/blob/main/README.en.md). Keep DSH-specific features, dependencies, and limits here; update both Core language variants for shared changes and keep this repository's English and Chinese READMEs aligned.
