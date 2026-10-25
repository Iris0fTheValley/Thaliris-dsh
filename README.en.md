# Thaliris

[简体中文](README.md)

**Attention is the most expensive resource.**

Thaliris is a **cognitive orchestration layer** for AI coding agents. It does not shorten context; it addresses three problems in long-running work:

- A capable model's attention is diluted by noise. Exploration, debugging and logs should not stay in the reasoning path responsible for key judgments.
- Original requirements and counterevidence can disappear during handoffs. A local “done” report must not silently overwrite an issue already found.
- A project's identity drifts over long-running work. Why the project exists and what must not change should not be silently rewritten by one local task, experiment or implementation limit after another.

The three form one causal chain, and attention dilution is where it starts. To protect key reasoning, work has to be split across Agents with fresh contexts and across many sessions; the split protects attention but creates handoff boundaries. Within one task, counterevidence is easily lost at those boundaries. Across tasks, if nobody holds what the project is for, each local decision can turn an implementation limit into a new principle, and the project's identity drifts a little at a time. In turn, lost evidence and drifted identity bring old problems and noise back into the key reasoning. So Thaliris does more than isolate noise: it states explicitly what must cross the boundaries after isolation, and who holds it.

> **Protect the reasoning. Isolate the noise. Isolation without amnesia.**

Thaliris builds on the native Agent capabilities of Hosts such as Codex, DeepSeek Harness and Claude Code, adding a layer for isolation, handoffs, evidence continuity and project identity rather than creating another Agent Runtime.

> **Status: Beta.** Real refactoring work has shown an implementer dispatching an investigation, a Controller starting an independent review, and counterevidence driving repairs. The sample is too small to establish a general quality or cost advantage. See [empirical observations](#empirical-observations).
>
> **Versions:** this document describes the source versions on each repository's `main` branch: Core 0.5.3, Codex adapter 0.5.2, Claude Code plugin 0.4.2 and DSH plugin 0.5.0. Version numbers describe source, not an installation on a given machine; updated files in a repository or on disk do not prove that a running Host has loaded the new version.

## Why more than context management

Common approaches manage more context within one Agent through compaction, retrieval or memory. Thaliris sees a larger problem than token count: too many competing goals share one reasoning path. The same Agent may be expected to investigate, design, implement, debug, review its own work and remember earlier failures.

Thaliris manages **who reasons and with what reasoning context**:

> **Give each reasoning context the information it needs; do not include other information merely because it exists.**

The name combines Thalamus, which filters and routes information, and Iris, which regulates how much light reaches the eye.

## Three pillars

### 1. Cognitive isolation: focus capable models on the work that needs them

A long-lived **Controller** retains the user goal, hard constraints and acceptance criteria. Short-lived roles work in fresh contexts and return conclusions, sources, verification results and decision-changing unknowns rather than the full working trail.

| Role | Responsibility |
| --- | --- |
| Investigator | Investigate facts within the selected scope |
| Implementer | Implement an accepted direction and verify it |
| Focused Implementer | Handle tightly coupled design and implementation until the core semantics converge |
| Reviewer | Optionally challenge a candidate independently and read-only |
| Reasoning Specialist | Independently challenge a framing or decision basis when that could change direction; no implementation or broad fact gathering |
| Curator | Reconcile selected reusable knowledge with provenance |

Roles are selected as needed, not used as a fixed pipeline. Single-Agent work, direct Controller execution and delegation are all valid. Different roles can use models with different capabilities, keeping stronger models at decision-critical points.

### 2. Evidence continuity: isolate without forgetting

The main risk of isolation is that a counterexample found by a reviewer can disappear after several handoffs and repairs behind a simple “tests pass.” Thaliris addresses that risk with these rules:

1. **Record counterevidence.** When a child discovers a fact that changes a local conclusion, local acceptance or critical unknown, record an observation with sources, handoff provenance and its associated user requirement.
2. **Keep it visible until disposition.** Relevant observations remain visible in later handoffs until the Controller explicitly judges each related requirement satisfied, unknown, needing repair, or no longer relevant with a reason.
3. **Good news does not erase bad news.** A later test PASS, Reviewer READY, child Completed or Core DONE does not retire an earlier repair or unknown basis. The Controller must explicitly respond to it.
4. **Present evidence before the next decision.** The Adapter returns still-unresolved evidence with the child result before the Controller's next broad completion decision. This needs no extra Agent, fixed stage or polling.
5. **Append history instead of rewriting it.** Earlier observations and judgments remain in the record without automatically becoming current facts.

Core stores these links and append-only history; it does not decide what matters. The Controller decides relevance and acceptance.

~~~text
Reviewer finds a counterexample -> observation with source and requirement
                    |
      repair, test PASS, child Completed ... do not erase it
                    |
Controller disposition: satisfied / unknown / repair / no longer relevant
~~~

### 3. Semantics belong to the model; mechanics belong to Thaliris

The mechanical layer handles native Agent identity, sources, versions, continuity and bounded retrieval; semantic judgments stay with the model. Conclusions carry sources such as file hashes, Git blobs or test observations. Freshness only says whether declared sources changed; it does not prove every dependency stayed unchanged. When evidence is insufficient, keep the state UNKNOWN rather than upgrading an inference to a confirmed fact.

## Core design: four kinds of state, each with its own job

After isolation, what crosses Agent and session boundaries is not conversation history but four kinds of explicit state. They answer different questions, change in different ways and do not substitute for each other:

| State | Answers | Who can change it | How it crosses Agents and sessions |
| --- | --- | --- | --- |
| **Project identity** (`.project-identity/`, optional) | Why the project exists; which identity, invariants, principles, directions and non-goals lower-level work must not silently rewrite | Only an amendment the Controller records on the human owner's explicit decision; evidence can only raise a challenge against it | Tracked in Git, across all tasks and Hosts; the Controller sees a one-line summary and reads on demand, and a child sees it only when the Controller quotes selected items into its handoff |
| **Per-task authority** (Task Authority) | The intent the user selected for this one task: goal, scope, hard constraints, acceptance criteria and execution mode | Established and frozen by the Controller from the user's instruction at task start; changing goal, scope, acceptance or mode needs a new user decision; children cannot establish, expand, rewrite or reactivate it | Anchored outside the repository by the Adapter and kept across interruptions and reconnects; it is user intent recorded by the Controller, not authentication of the Host owner, and it does not include authority to maintain a live Host |
| **Evidence** (task ledger) | What this task found, from which sources, for which requirement, and how the Controller disposed of it | Children record observations; only the Controller judges; history is append-only | Bound to the Task ID and handoff chain; unresolved critical evidence is re-presented before the Controller's next judgment and survives compaction, resume and continuing the task in a new session |
| **Durable knowledge** (`.agent-memory/`, `.milestones/`) | Project knowledge and long-lived progress worth reusing later | Written when the Controller selects it, or reconciled by a Curator from selected material; carries sources and freshness | Kept in the repository and retrieved on demand through INDEX files; recording something does not push it into every role |

From the top down, project identity constrains tasks, task authority constrains this piece of work, evidence tests the current candidate, and durable knowledge keeps what was learned. A lower layer may challenge a higher one but cannot silently rewrite it: evidence does not overturn task authority, a task's conclusion does not become project identity on its own, and amending project identity does not rewrite the frozen authority of a running task. A project without an identity runs as usual and is never blocked or nagged.

## Components

| Component | Responsibility |
| --- | --- |
| [Thaliris Core](https://github.com/Iris0fTheValley/Thaliris/blob/main/README.en.md) (shared Core) | Task IDs and task records, task authority, observation/judgment links, evidence and freshness, project memory, milestones, project identity, compare-and-swap writes and rollback |
| [Thaliris-codex](https://github.com/Iris0fTheValley/Thaliris-codex/blob/main/README.md) | Native Codex integration: Fresh Children, role profiles, native Agent identity and lifecycle, and evidence re-presentation |
| [Thaliris-dsh](https://github.com/Iris0fTheValley/Thaliris-dsh/blob/main/README.md) | DeepSeek Harness plugin: Workspace/Session/Agent integration and optional Memory |
| [Thaliris-claude](https://github.com/Iris0fTheValley/Thaliris-claude/blob/main/README.en.md) | Claude Code plugin: Controller skill, role subagents, hook-based native identity binding and evidence re-presentation |

There is one shared Core. Core does not run models, schedule Agents or authenticate callers; native execution belongs to each Adapter.

## Role capabilities and recommended models

> **Never use a small or low-capability model as the Controller.** Savings should come from giving narrow work to cheaper child roles, not from downgrading the Controller. A Controller's mistakes are not corrected by its children; they are amplified. In practice, weak Controllers skipped the managed flow, fell back to single-agent work after an isolation refusal, or declared completion while review counterevidence was still unresolved.

The Controller needs all of these capabilities; each one matters:

| Capability | The question the Controller must answer |
| --- | --- |
| Global Coherence | After dozens or hundreds of steps, does it still remember why the work is being done? |
| Strategic Planning | Can it work backwards from the end goal, identify dependencies and allocate resources, rather than only looking at the next step? |
| Retrospective Reasoning | Can it trace a root error in earlier decisions instead of repeatedly patching symptoms? |
| Metacognitive Monitoring | Can it notice that it is drifting, duplicating work or stuck on an impossible task? |
| Prospective Reasoning | Can it predict how a current decision affects later stages and avoid future structural problems? |
| Adaptive Replanning | When the plan fails or conditions change, can it reorganize the overall work instead of mechanically continuing the old plan? |

Capabilities each role needs, and recommended models:

| Role | Capabilities needed | GPT (Codex) | Claude (Claude Code) |
| --- | --- | --- | --- |
| Controller | All six above; integrates the original objective, acceptance criteria and evidence to decide product acceptance | gpt-6.1-sol (high or above); gpt-6-astra when the user explicitly selects it | Opus |
| Investigator | Gathers facts and sources broadly and accurately within the selected scope, stating covered and uncovered scope | gpt-6-luna (max) | Sonnet |
| Implementer | Implements, verifies and repairs ordinary defects within an accepted direction until deterministic convergence | gpt-6-luna (max) | Sonnet |
| Focused Implementer | Sustained reasoning over coupled invariants, absorbing runtime feedback until semantic convergence | gpt-6.1-sol (high); gpt-6-astra when the user explicitly selects it | Sonnet or Opus, chosen by the Controller per task difficulty |
| Reviewer | Independently challenges a converged candidate and seeks cross-boundary counterevidence without adopting the author's framing | gpt-6.1-sol (high) | Opus |
| Reasoning Specialist | Challenges the problem framing, causal model and decision basis | gpt-6.1-sol (high); gpt-6-astra when the user explicitly selects it | Opus |
| Curator | Maintains selected durable knowledge and INDEX entries precisely from supplied material | gpt-6-luna (max) | Sonnet |
| Verifier (Codex compatibility role) | Read-only check of acceptance evidence, modification boundaries and synchronization | gpt-6-luna (max) | — |

Recommendations are a starting point, not a quality guarantee. A role and its execution model are independent; the model that actually ran is what the Host observed, not what a configuration file says.

These are recommendations only. Choosing each role's model is the Controller's job, made freely within any constraint the user wrote into the task; where the adapter supports it (such as `register-role` in Claude Code), the Controller can also register new roles. A user may also have the Controller do all the work itself: whether and how much to delegate is the user's decision.

## Empirical observations

**What this benchmark measures:** We chose a difficult single-turn refactor: desktop and WebUI share Live2D behavior, with model selection, voice/action queues and exit lifecycle involved. The benchmark does not rank candidates by how many bugs remain. It compares how original requirements guide investigation, plan convergence, implementation and verification, especially whether checks cover real consumer paths and whether counterevidence changes the plan. A/B are single-agent runs; C/D provide collaborative comparisons.

**How to read the results:** Frozen candidates received independent product post-reviews. The table separates in-run independent review and repair from the later post-review. A/B had no independent Reviewer during their runs; their later GPT-6.1 Sol/high reviews were separate assessments, not in-run self-review or repair. Their original high/medium severity labels and V3 coverage finding are preserved rather than converted to this table's P1/P2 scale. Each sample has unresolved requirements, some of which were already present in the starting code; defect counts are not a quality score.

| Sample (execution date) | Execution | In-run independent review/repair | Independent post-review of frozen candidate | P1 | P2 | Runtime | API-equivalent cost |
| --- | --- | --- | --- | ---: | ---: | ---: | ---: |
| A · 10/03 | Single agent, Sol/medium | No | Oct 14–15: NOT_READY; 1 high, 2 medium, plus V3 renderer coverage gap | — | — | 21.6 min | $0.88 |
| B · 10/03 | Single agent, Luna/xhigh | No | Oct 14–15: NOT_READY; 2 high, 3 medium | — | — | 54.1 min | $0.23 |
| C · 10/14 | Luna multi-agent | Yes, local | NOT_READY | 2 | 3 | 57.1 min | $0.46 |
| D · 10/14 | Sol + Luna multi-agent | Yes | NOT_READY | 1 | 2 | 40.4 min | $2.62 |
| C · 10/19 | Luna (dispatch rejected; single-agent fallback) | No | NOT_READY | 3 | 3 | 19.8 min | $0.22 |
| **D · 10/19** | **Sol + Luna native multi-agent** | **Yes, two counterexamples triggered repairs** | **PARTIALLY SUPPORTED / NOT_READY** | **0** | **3** | **34.4 min** | **$2.91** |

A and B ran on October 3, 2026; GPT-6.1 Sol/high independently reviewed their frozen candidates on October 14–15. API-equivalent costs are reference estimates for comparison, not actual billed amounts.

A had a shared behavior-policy and renderer-adapter direction by 16:46 UTC, then brought desktop audio blocking and WebUI segment scheduling into implementation. Its final relevant Python suite reported 92 passed and 1 deselected, with 20 frontend tests and successful build/lint. Its post-review still found that desktop conversion replaced an explicitly selected custom model with a Sakiko costume and Web presentation kept only the latest no-audio motion. An early overall direction and local verification therefore left real consumer paths open. B spent longer on broad investigation; its explicit defect set and shared target/renderer plan arrived at 16:59 UTC. It then corrected test-fixture and lint issues and completed 84 Python tests, 16 frontend tests, build and lint. The separate post-review still reproduced incomplete character-state and cancellation ingress and bye leaving active audio playing. The two reviews were independent assessments, not Reviewers in the A/B runs.

A/B and C/D are compared on investigation, plan convergence, requirement preservation, verification plans and revision after counterevidence—not on the number of bugs remaining in a frozen candidate.

The D · 10/19 independent post-review found no P0 or P1 issue, but reported three P2 classes and concluded PARTIALLY SUPPORTED / NOT_READY; this is not full product acceptance. The three classes were: a segment queued before cancellation could arrive afterward and resume playback; an in-flight producer could publish after the shutdown bye, while a separate frontend reproduction also accepted a later segment; and Web selected mouth-parameter names by model version, failing on supported alternate spellings that desktop selected from actual parameter IDs. A conflicting native Agent status during that run was handled as a Codex-native lifecycle anomaly.

**What happened in D · 10/19:**

~~~text
Controller assigns coupled design and implementation to Sol
  -> Sol independently dispatches Luna to investigate runtime support and test boundaries
  -> Sol returns a local candidate
  -> Controller starts an independent review instead of treating local completion as the end
  -> Reviewer finds two counterexamples that overturn the local conclusion:
       - an explicitly selected model can be replaced by an older desktop rule
       - an exit farewell may be sent after its event channel has closed
  -> Controller accepts the counterevidence and dispatches repairs and regression checks
~~~

This demonstrates the behavior Thaliris is designed to test: **local success is not global completion, and counterevidence changes the work that follows.**

**C · 10/19 also matters:** This was not a successful multi-agent run. Luna's request to pass the full conversation history to a child was correctly rejected by Fresh Context protection; it did not retry with an independent context, so the task returned to single-agent execution. This shows that isolation protection worked, while also showing that a critical dispatch decision needs a capable model.

**What is not yet established:** Each arm is a single run; Host and model effort differed between batches, so this is not a single-variable experiment. The mixed-model configuration cost more. Some counterevidence from D · 10/19 review and repair led to real fixes but was not recorded as formal observations, so the persistent Evidence Continuity path is still being completed. See the [ABCD benchmark implementation](https://github.com/Iris0fTheValley/Thaliris/tree/main/benchmarks/abcd) and [benchmark protocol](https://github.com/Iris0fTheValley/Thaliris/blob/main/docs/thaliris-benchmark-protocol.md).

## Quick start

Python 3.11 or newer is required. Git is optional for Core use; installing from the Git URL below also requires Git.

~~~bash
uv tool install git+https://github.com/Iris0fTheValley/Thaliris
cd your-repository
thaliris-core --root . init
TASK_ID=$(thaliris-core --root . task-start "example task" | python -c 'import json,sys; print(json.load(sys.stdin)["task_id"])')
thaliris-core --root . --task-id "$TASK_ID" task-status
~~~

Each task has its own Task ID, which is passed explicitly to later operations. Installing Core alone does not enable multi-agent work. For native integration, follow the [Codex](https://github.com/Iris0fTheValley/Thaliris-codex/blob/main/README.md), [DSH](https://github.com/Iris0fTheValley/Thaliris-dsh/blob/main/README.md) or [Claude Code](https://github.com/Iris0fTheValley/Thaliris-claude/blob/main/README.en.md) guide.

An initialized repository contains:

~~~text
.agent-memory/   # selected knowledge that can be reused across tasks
.milestones/     # long-term scope, decisions, progress and verification
.context/tasks/<task-id>/state.json   # task state and evidence; ignored by Git by default
~~~

Task state stores structured facts, observations and judgments, not conversation transcripts. Persistence and handoff are separate choices: recorded information is not automatically passed to every role.

## What it is not

Thaliris is not an Agent Runtime, workflow engine, fixed multi-agent pipeline, vector database or RAG system, automatic whole-repository summarizer, or substitute for source code, tests, compilers and runtime behavior.

Removing Thaliris should not make the underlying development process incorrect.

## Further reading

- [Core design](https://github.com/Iris0fTheValley/Thaliris/blob/main/DESIGN.md)
- [Routing protocol](https://github.com/Iris0fTheValley/Thaliris/blob/main/docs/thaliris-routing-protocol.md)
- [Task authority contract](https://github.com/Iris0fTheValley/Thaliris/blob/main/docs/thaliris-task-authority.md)
- [Prompt ownership and research motivation](https://github.com/Iris0fTheValley/Thaliris/blob/main/docs/thaliris-prompt-design.md)
- [Role descriptions](https://github.com/Iris0fTheValley/Thaliris/blob/main/docs/thaliris-role-packs.md) · [Packaging and API boundaries](https://github.com/Iris0fTheValley/Thaliris/blob/main/docs/host-neutral-packaging.md)

## Native DSH integration

@thaliris/dsh-plugin adds Thaliris task records and Controller tools to DeepSeek Harness. It uses native DSH Workspaces, persistent Sessions, Agents/subagents, Settings, the model catalog, Plugin Manager and lifecycle. A Python bridge calls the separately installed Thaliris Core (currently paired Core 0.5.2, see [Core baseline](CORE-BASELINE.md)); this repository does not include copies of Core or the Codex Adapter.

Since 0.5.0 the plugin ships as an **optional native Agent Preset mode**: after installation Thaliris only appears in DSH's native Agent Preset roster, not selected and not the default. A normal session that has not selected Thaliris gets no Controller prompt, task tools or dynamic task context. Selection and defaulting use native DSH interactions, with no second switch.

The DSH policy page configures role prompts, model routes, tools, Workspaces and Memory. Initial role templates (Investigator, Implementer, Focused Implementer, Reviewer, Curator, Reasoning Specialist) use inherit routing, do not fix a model, and grant a curated set of native DSH tools per role capability (read-only roles get read tools only; see [Native role tool permissions](#native-role-tool-permissions)); route modes are inherit, fixed and allowed. Template changes do not overwrite saved user role records; roles are adjusted by editing these user-owned records, not by the Controller. An exact Workspace binding and persistent root Session are part of task association; a repository path alone does not resume an old task.

The native root Controller gets these tools; children never see them:

| Tool | Purpose |
| --- | --- |
| `thaliris_task_start` / `thaliris_task_inspect` / `thaliris_task_close` | Establish selected intent, inspect the explicitly selected task, record mechanical DONE after the Controller's own judgment |
| `thaliris_workstream` | Dispatch one fresh child with a role, bounded handoff, optional model route and reasoning effort (the Controller picks the cheapest allowed route and lowest effort that fit the working set, after isolation and division of labor), and optional evidence association; the reservation records the route and a digest of the role as bound at dispatch |
| `thaliris_reconcile` | Check or reconcile a crash reservation from native terminal evidence; UNKNOWN never auto-releases; `dispose` (with a reason) is the Controller's explicit release, recorded as disposed/UNKNOWN, never completed |
| `thaliris_task_recover` | Explicit anchor recovery: list tasks needing recovery or attachable from another root of this Workspace; `rollback` after `TASK_AUTHORITY_STATE_CHANGED`; `attach` this root to an ACTIVE task on the user's instruction (`attach-and-rollback` for a changed ledger). Reason and authority-digest CAS; never automatic |
| `thaliris_task_status` | Compact status by default (revision, routing, counts, bounded records, non-completed dispatches, authority digest/mode, open-evidence summary); `view: "full"` returns the complete packet and `since_revision` adds a bounded change hint. Finished dispatches are append-only `dsh-dispatch` Core records, not routing state |
| `thaliris_task_context` | Record facts, decisions, progress, open items and the milestone; a bounded summary returns as DSH dynamic context after compaction or resume |
| `thaliris_task_register` / `thaliris_task_judge` | Register opaque requirements; record requirement judgments with exact observation refs, singly or as one atomic batch (`judgments`). Results carry the new revision and the open-evidence summary; a revision conflict returns Core's code, recovery and `changes_since` |
| `thaliris_task_mode` | Switch execution mode on an actual human instruction with revision and authority-digest CAS, after active work is resolved |
| `thaliris_task_identity` | Read the project identity (`action`: `status`, `get` a version, selected items, one amendment or one challenge, `trace` registered relations); absent identity is normal |
| `thaliris_task_identity_amend` / `thaliris_task_identity_challenge` / `thaliris_task_identity_relate` | Record an explicit amendment on the human owner's decision, record or dismiss a challenge, register or retract purpose relations (Controller only) |
| `thaliris_task_identity_note` / `thaliris_task_identity_suggest` | Core 0.5.2: record, retract or list verbatim basis notes of the user's explicit long-term statements; set or clear the proactive-offer preference at session, workspace, project or global scope (Controller only; no ACTIVE task needed) |

A child dispatched with an evidence association additionally receives `thaliris_observe`; the adapter binds each observation to that dispatch's handoff, candidate and requirement refs and to the bound native child, and the grant ends with the dispatch. The Controller cannot author child observations, and children cannot register, judge or switch modes. A dispatched child keeps the role (prompt, tools, memory grants) bound at dispatch even if Settings change later. Mode switches never widen a child's role or grants; delegated dispatch requires delegated mode.

### Project identity

Core 0.5.0 adds a project-level identity plane: a versioned, repository-tracked statement of what the project is for and what must not be changed silently, kept under `.project-identity/` and changed only by an explicit, recorded amendment on the human owner's decision. It is separate from Task Authority (one task's frozen intent), the Memory Provider and milestones; amending it is not a memory proposal or approval, and it never rewrites a running task's frozen contract. The bridge exposes Core's read operations (status, get, trace) and the three mutations (amend, challenge, relate) to the native root Controller only; the six `thaliris_task_identity*` tools carry the `thaliris_task_` prefix, so a role's tool grant can never include them, and they are on the deny list of every dispatched child. Mutations use the same task-revision CAS as other writes, take their actor from the adapter-bound native Controller identity and do not bump the task revision. When an identity exists, the dynamic task context gains Core's one-line summary; when none exists nothing changes and nothing is blocked. Core 0.5.2 adds natural formation: the Controller notes the user's explicit long-term statements verbatim (stored machine-locally under `THALIRIS_HOME`, never in the repository), a successful task close carries an `identity_offer` line at most once per new note, and the user can switch offers off per session, workspace, project or globally; a composed first version still needs the user's yes and an amendment. Children receive identity content only when the Controller quotes selected items into a handoff. This adapter has no path-level child write guard: a child's edit to `.project-identity/` is detected afterwards (Core reports `UNRECORDED_CHANGE` or `INVALID`, and Git shows the diff), not prevented. See Core's [Project Identity](https://github.com/Iris0fTheValley/Thaliris/blob/main/docs/thaliris-project-identity.md) document.

Memory is an independent optional capability and is disabled by default. The memory capability and local text provider can be installed separately; task routing and close work without Memory or the client UI. There are no embeddings/vector RAG or automatic retrieval. Memory reads follow grants, and writes follow user policy and Core task checks. See [capabilities](CAPABILITIES.md) and the [client contract](CLIENT-CONTRACT.md).

## Installation and first use

DSH plugin 0.5.0 declares an interface range, `>=0.2.1-rc.2 <0.2.2-0`, in `engines.dsh`; it admits the released `0.2.1-rc.2` and `0.2.1-rc.3` lines without an exact-version exemption or a pinned revision. For earlier DSH such as `dsh-v0.2.1-alpha.1` use DSH plugin 0.3.2. Installation needs no manual packing, absolute paths or profile edits; `lib/client.js` and the other artifacts ship in the package, and there is no install hook.

### Install as a normal DSH plugin

**Desktop / Web (graphical, recommended)**

1. Open DSH's **Plugins** page and install from GitHub, or create a session, switch the mode selector to **Creator mode**, and ask the model to install the same address with the native `plugin_manager`: `github:Iris0fTheValley/Thaliris-dsh`.
2. **Restart DSH** after installation, then open a session and check that Thaliris appears in Settings → Agent presets.
3. Offline or for a pinned version, install the local artifacts instead (all three packages): `dsh plugin --profile <profile> add <thaliris-dsh-plugin-0.5.0.tgz> <thaliris-dsh-memory-0.2.0.tgz> <thaliris-dsh-memory-local-0.2.0.tgz>`, then restart the Host.

**Web / headless (command line)**

```sh
dsh plugin --profile web add github:Iris0fTheValley/Thaliris-dsh
```

Restart the host afterwards as well.

> **Install address.** The canonical install address is `github:Iris0fTheValley/Thaliris-dsh` (the default branch, 0.5.0 and later). Pin a release tag when you need a fixed version, e.g. `github:Iris0fTheValley/Thaliris-dsh#v0.5.0` (enter the same address on the Desktop Plugins page).

Native limits to keep in mind:

- `plugin_manager` is available only in **Creator mode** (the `cordis` preset); a normal Standard session **has no install tool**. "Ask the model to install it" therefore requires switching to Creator mode first.
- Install, upgrade, disable and remove are host-process plugin changes: **restart DSH** to make them take effect. The native manager usually reports `restart-required`; the reason may be `unmanaged-plugin` (the change reaches a plugin running outside the plugin list — Thaliris registers its Agent Preset at runtime).
- The npm-installed `dsh` CLI **cannot** manage the Desktop profile (it reports `profile "desktop" is managed exclusively by the Electron application`). Use the Plugins page on Desktop, or the Desktop-bundled CLI after fully quitting the app.
- Installing from GitHub requires network access to GitHub plus git and pnpm (Desktop uses its bundled pnpm).

### First use: automatic Core runtime provisioning

After installation and restart the plugin is loaded. Thaliris mode does no I/O at install, bundle enablement or in unselected sessions; the **first Thaliris tool call** that needs Core provisions the runtime on demand (a human settings action can trigger it too). No global Python install is needed: DSH's bundled CPython (shipped with Desktop) is preferred, with a PATH CPython ≥ 3.11 as fallback; pip, a build backend and any third-party global tool are not required, and Node comes from DSH itself:

1. Detect Python: explicit config → `THALIRIS_PYTHON` → `%DSH_HOME%\dsh-runtimes\*\dependencies\python` (DSH Desktop ships CPython 3.12) → `python3`/`python` on PATH; CPython ≥ 3.11 is required.
2. Create an isolated `--without-pip` venv under the authority directory.
3. Download the Core source tarball pinned by `core.lock.json` with Node `fetch`, verify its SHA-256, then install it by pure source copy (no pip, no build backend, no global tools).
4. Verify Core version and state schema in the venv, then write `runtime.json` atomically.

Measured on this host: about **1.6 s cold** (DSH-shipped CPython 3.12, normal network); later calls in the same process hit memory, and after a restart it is one import probe. First tool calls complete provisioning within the bridge timeout (30 s by default). A provisioning failure never unloads the plugin: tool calls fail with a structured code, and the settings page shows recovery guidance.

- The authority directory defaults to `%USERPROFILE%\.thaliris\<profile>` (`~/.thaliris/<profile>` on Linux/macOS). It must stay outside the workspace and behind no symlink or junction.
- Thaliris settings → General → "First-run setup" shows the runtime state, whether this process verified it, the pinned Core version, the detected Python/Core versions, the authority directory, the current step and elapsed time, plus the failure code, recovery text and detail. It offers explicit "Prepare Thaliris runtime" (retry after a failure), "Re-check runtime" and "Refresh setup status" buttons. Nothing is provisioned on page load, and Standard or unselected sessions never provision.
- Manual overrides live under "Manual runtime paths (optional)": `pythonExecutable`, `corePath` and `authorityDirectory` are saved together with the policy through the native Settings revision fence; clearing a field restores the default, and non-absolute paths are refused. Click "Re-check runtime" after saving so the host validates the override.
- Offline, stage the tarball matching `core.lock.json` and point the host-process `THALIRIS_CORE_TARBALL` environment variable at it.
- Failure codes carry recovery text: `THALIRIS_PYTHON_NOT_FOUND`, `THALIRIS_PYTHON_VERSION_UNSUPPORTED`, `THALIRIS_SOURCE_FETCH_FAILED`, `THALIRIS_SOURCE_HASH_MISMATCH`, `THALIRIS_CORE_VERIFY_FAILED`, `THALIRIS_CORE_VERSION_MISMATCH`, `THALIRIS_AUTHORITY_UNSAFE`, `THALIRIS_RUNTIME_PROVISIONING`. The plugin stays loaded and the settings page stays reachable.

**Workspace auto-binding happens in exactly one case:** `policy.workspaces` is empty and the current Workspace's persistent root Session explicitly selected Thaliris mode. The plugin then appends one enabled binding with the native Workspace id and canonical root (once only, reported on the settings page and in diagnostics). A non-empty list is never appended to, and an unselected session never triggers binding. Thaliris settings → Context lists every binding and badges the host-reported auto-bound row with "Auto-bound on first Thaliris use"; otherwise bind the exact native Workspace ID and root there manually. The page has no true "current Workspace" read, so "Bind most recent Workspace" picks the native Workspace with the latest Session activity (latest `updatedAt`, then `createdAt`); it only stages the binding and Save persists it. Task authority anchors on (root Session id, Workspace id): a new session or a re-registered Workspace does not resume old tasks.

### Selecting the mode and setting the default

- After installation and restart, Thaliris appears in the native **Agent Presets** roster (Settings → Agent presets, and the new-session mode selector) under **Custom**, with preset id `thaliris`, display name `Thaliris` and order 10 after the four built-in presets. It is **not currently selected and not the default**; the default stays `standard` and normal sessions are unchanged.
- Select it per session in the new-session mode selector. DSH allows a mode switch only on a blank session; a session that has started (or completed a turn) cannot switch in place.
- Set it as the default under Settings → Agent presets → "Set as new task default", or use Thaliris settings → General → "Agent Preset and new-Session default", which shows the preset health (healthy / registered but unavailable / missing), the native default, any saved override and the effective default, plus the explicit "Set Thaliris as new-Session default" / "Restore native default" actions. Both actions make the same `agent-preset-registry.selectedDefault` write as DSH's own mode picker, fenced by the native Settings revision; page load never writes a default. The default affects **new** sessions only; existing sessions are never recomposed (their `agentPreset` stays).
- **Dangling-default risk:** if you make Thaliris the default and then disable or remove the plugin, the saved default points at a missing preset and creating an unnamed new session can fail (`agent-preset/not-found`); DSH does not self-heal. The settings page warns in that state and "Restore native default" repairs it; before disabling or removing, restore the native default (usually `standard`).
- Headless has no Agent Preset registry: no mode appears there, the plugin still loads, and normal sessions are unchanged. Thaliris mode exists only on Web/Desktop hosts that support Agent Presets.

### Native role tool permissions

Role templates no longer leave `tools` empty; they grant a curated, version-stable set of native DSH tools per role capability. At dispatch only tools that the role record allows and the host catalog actually provides are kept; unknown names are filtered with a diagnostic instead of failing child creation. Controller/management tools (`thaliris_task_*`, `thaliris_workstream`, `thaliris_reconcile`, …) can never become role grants.

| Role | Native tool grants |
| --- | --- |
| Investigator | `read`, `glob`, `grep`, `bash`, `pwsh`, `job_list`, `job_output`, `web_fetch`, `web_search`, `todo_write`, `skill` |
| Implementer / Focused Implementer | `read`, `write`, `edit`, `glob`, `grep`, `bash`, `pwsh`, `job_list`, `job_output`, `job_kill`, `terminal_list`, `terminal_open`, `terminal_read`, `terminal_send`, `terminal_signal`, `terminal_close`, `web_fetch`, `web_search`, `todo_write`, `skill`, `present` |
| Reviewer / Reasoning Specialist | `read`, `glob`, `grep`, `web_fetch`, `web_search` |
| Curator | `read`, `write`, `edit`, `glob`, `grep`, `todo_write`, `skill` |

Reviewer and Reasoning Specialist exist to challenge a candidate or framing independently, not to change code: they receive read tools only — no `write`/`edit`, no shell, no background jobs or terminals — so their read-only boundary is enforced by native tool grants, not just by prompt text. Curator can edit documents but has no shell; Investigator can run shell commands for evidence but has no file-editing tool.

`tools: []` remains legal and grants no native tools (only a dispatch with an evidence association additionally receives `thaliris_observe`). Templates and recommended permissions only affect **newly copied templates**; the plugin **never silently rewrites saved user role records**. For upgrades from older versions, Thaliris settings → General → "Recommended native permissions" lists only enabled roles whose tool grants are empty, annotates each recommended tool as present or absent in the live host catalog, and writes `policy.roles` only when you click "Apply recommended permissions" (through the same revision fence as a normal save; nothing is written on load or render). Roles with no shipped template get no guessed recommendation; users can apply, ignore or edit manually.

### Upgrade, disable and re-enable

- User configuration (roles, model routes, Workspace bindings, Memory settings) lives in the active profile's `cordis.patch.yml`; task state and authority anchors live in the authority directory (outside the workspace). The native manager only changes `package.json` and the lockfile on install/upgrade/disable/remove; it does not rewrite user patch rows or delete task state.
- Restart DSH after install, upgrade, disable and remove (the native manager reports `restart-required`, see above). After the restart, check that Settings → Agent presets still lists Thaliris and inspect the runtime status on the Thaliris settings page.
- Row ids `thaliris`/`thaliris-api` and namespace `thaliris` stay stable; preset id is fixed at `thaliris`, so old configuration keeps loading and sessions that recorded the preset still resolve. Disabling or removing the plugin makes those sessions unresumable (`agent-preset/not-found`); re-enabling and restarting restores them.
- This repository's documentation and tests do **not** mean any live Desktop profile has been changed; upgrading or removing the plugin on a live Desktop needs the user's own explicit action and restart.

### Verification status

- Checks that run in this repository: `node tests/prompt-contract.mjs` (package/preset contracts), `node tests/composition-drift.mjs` (needs `DSH_SOURCE`), `npm run test:native` (real Loader + scripted model), `npm run test:client` (shared client; 20/20 pass, including the new setup, mode/default, recommended-permission and namespace-absent cases), `npm run test:install` (packed install smoke with the 0.5.0 archive), plus the 66 bridge/Core pytest checks against a provisioned runtime. Settings-page interactions are verified with the real client module stack in jsdom.
- Verified in isolated real 0.2.1-rc.3 hosts (separate `DSH_HOME`, never the Desktop profile): 0.5.0 installs with both rows ACTIVE; the preset appears in the roster with the default still `standard`; the Web host boots with no preset-mount diagnostic; headless boots without a registry.
- Not verified: installing 0.5.0 into a running Desktop profile and observing it after a restart; clicking through the settings page in a real browser/Desktop UI (including a real cold "Prepare Thaliris runtime" click); rc.2 on a real host (the CI tag matrix covers the rc.2/rc.3 drift gate). Updated files on disk do not prove a running Host has loaded them.

## Maintainer: build and release

- Version pairing: plugin 0.5.0, Core 0.5.2 ([core.lock.json](core.lock.json)), Node.js ≥24.9, `engines.dsh >=0.2.1-rc.2 <0.2.2-0`. Current pairing and provenance are in [Core baseline](CORE-BASELINE.md).
- Build from source (maintainer flow; users do not need it):

  ```sh
  npm run build:bundle
  DSH_SOURCE="/path/to/compatible-dsh-checkout" npm run build:client
  npm pack
  ```

  `lib/client.js` is prebuilt and shipped; there are no install scripts.
- **Composition mirror maintenance (important):** a programmatic Agent Preset replaces the whole agent composition, so `composition.mjs` mirrors DSH's Standard preset (22 top-level child rows including groups/isolates/platform conditions) and appends `{ id: "thaliris-agent", name: "@thaliris/dsh-plugin/preset" }`. When DSH changes its Standard preset, the drift gate fails loudly instead of silently dropping native tools:

  ```sh
  DSH_SOURCE=/path/to/dsh-checkout node tests/composition-drift.mjs  # failure names the regeneration command
  DSH_SOURCE=/path/to/dsh-checkout node build-composition.mjs        # regenerate and commit composition.mjs
  ```

  CI runs the drift gate on both `dsh-v0.2.1-rc.2` and `dsh-v0.2.1-rc.3` and verifies on rc.3 that regenerating `composition.mjs` produces no diff.
- Initial role templates and recommended native grants live in `role-templates.mjs`; `build-bundle.mjs` derives `cordis.patch.yml` from them.

See [capabilities](CAPABILITIES.md), the [client contract](CLIENT-CONTRACT.md), [Core baseline](CORE-BASELINE.md), [prompt contract](PROMPT-CONTRACT.md).
