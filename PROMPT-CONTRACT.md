# DSH prompt template contract

`policy.mjs` owns the native Controller template. `role-templates.mjs` owns editable
initial role seeds. `build-bundle.mjs` derives `cordis.patch.yml`; explicit stored
roles (including []) remain user policy. Model routes, tool grants, memory and
context permissions are unchanged. DSH persona receives the selected role prompt;
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
