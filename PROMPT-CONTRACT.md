# DSH prompt template contract

`policy.mjs` owns the native Controller template. `role-templates.mjs` owns editable
initial role seeds. `build-bundle.mjs` derives `cordis.patch.yml`; explicit stored
roles (including []) remain user policy. Model routes, tool grants, memory and
context permissions are unchanged. The Controller template puts cognitive isolation and division of labor before model choice, then picks the cheapest allowed route and lowest reasoning effort that fit the working set (cheapest for deterministic closure and CI/build observation, mid for clear-causal work, strongest for coupled or unclear work and decision-critical challenge), escalates only on evidence, and respects a role policy that allows no cheap route. DSH persona receives the selected role prompt;
selected handoff is a separate payload. Core does not infer a semantic projection.

Global Codex instructions, hooks, project routers and TOML profiles are not this
adapter's installation model. The seeds are Investigator, Implementer, Focused
Implementer, Reviewer, Curator and Reasoning Specialist (non-writing challenge of a
framing or decision basis); the Codex-only Verifier is not seeded. Every seed tells
the child to record decision-changing local facts with `thaliris_observe` when its
dispatch grants it, otherwise to return them in FINAL, without reconstructing global
requirements. Focused Implementer returns remaining work without choosing a successor.
The Controller template describes evidence continuity (register, dispatch association,
status, judgment), dynamic task context, human-instructed mode switching, per-dispatch
model/effort selection and dispatch-time role binding, as concepts tied to the tools.
The template also tells the Controller (Core 0.5.1 ergonomics) to record several judgments in one `thaliris_task_judge` call (`judgments`: ordered, atomic, one revision), keep reads small (`thaliris_task_status` is compact by default; `view: "full"` or `since_revision` only when needed), reuse the revision that write results return as the next `base_revision`, and on a revision conflict (nothing written) review `details.changes_since` including its open-evidence summary (an approximate hint, `exact: false`: `recent` is only the last min(revision gap, 16) items per collection and can omit items one batch wrote in a single revision; replaced fields such as Active Work, Pending Results, milestone and status, and sources, are not tracked), retry once with `details.current_revision` if the write still applies, and read compact status when Active Work/Pending Results or anything the hint does not cover is needed.
The template also carries one Project identity paragraph (Core 0.5.0) naming `thaliris_task_identity` and its amend, challenge and relate companions: identity is separate from Task Authority, the Memory Provider, milestones and evidence; read it on demand for directional or architectural work, not ordinary local repairs; repair at the lowest sufficient layer and record a challenge instead of editing; amend only on the human owner's explicit decision; an amendment is not a memory proposal and never rewrites a running task's frozen contract; nothing propagates automatically; absent identity is normal. A user's stored `policy.controllerPrompt` is not overwritten and adopts the paragraph only through Settings editing.
Template normalization adds semantic mutation/evidence practice and the full Focused
loop/endpoint, while keeping review optional, independent and evidence based. Executors
report criterion-linked evidence and UNKNOWN; Controller judges product completion from
the original objective, criteria and available evidence, then records mechanical closure.
Test PASS, Reviewer READY and native Completed are observations, not product completion.
Review-ready source/bundle bytes do not prove installed profile activation or benchmark gains.
See [Core design](https://github.com/Iris0fTheValley/Thaliris/blob/main/docs/thaliris-prompt-design.md)
for shared rationale. Rebuild the bundle, run native/scripted tests with pinned DSH
source, then install a reviewed package into an explicitly selected profile only in
separate closure work. Existing role records require explicit user policy editing
to adopt templates; installing new defaults does not imply migration consent.
