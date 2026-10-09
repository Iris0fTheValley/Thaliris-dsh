# Thaliris for DeepSeek Harness

Language: English | [简体中文](README.md)

## DSH Host adapter

@thaliris/dsh-plugin adds task records and explicit Controller tools to [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness), using its native Workspaces, persistent Sessions, Agents, subagents, Settings, model catalog, Plugin Manager, and lifecycle. The Python Core is a separate [Thaliris distribution](https://github.com/Iris0fTheValley/Thaliris); this repository contains no Core or Codex adapter copy.

The runtime package has optional Remote API and shared Web/Desktop client entries. Its policy page edits native role, model, workspace, and memory settings. Memory capability and the default local provider are separate optional packages, while task routing and close work without them or the client UI. Contracts and limits are in [CLIENT-CONTRACT.md](CLIENT-CONTRACT.md), [CAPABILITIES.md](CAPABILITIES.md), and [CORE-BASELINE.md](CORE-BASELINE.md).

## Shared work principles

Thaliris is a Git-native context and agent orchestration controller, not a general identity system or standalone agent runtime. Its default is `delegated`: the long-lived Controller owns direction, scope, acceptance and next routing; short-lived Investigators handle open-ended, cross-file, multi-step or repeated investigation, and Implementers handle work with a stable direction. The Controller may directly read a small number of precisely located facts needed for the current decision; successive small queries remain one investigation to delegate. An explicit user choice of `controller-direct` or `single-agent` takes precedence over the efficiency default while preserving task scope, readonly role boundaries and user-content protection.

These are shared work semantics, not proof of Host actor identity or an unbypassable tool guarantee. DSH uses user-editable native Controller/role policy. This README describes DSH capabilities only within the adapter contracts and verification limits below; it does not attribute Codex Hooks, Codex native lifecycle or Codex task-disposition features to DSH.

### Install and configure

The package targets DSH source revision 639ed015397290b3745d163aafe02ffee4aa3f84 and Thaliris Core 0.4.4 source revision [`56e48ac299dd2c5c4b16c992db732a55b7790893`](https://github.com/Iris0fTheValley/Thaliris/tree/56e48ac299dd2c5c4b16c992db732a55b7790893). For this pin, the packed smoke builds and installs a local wheel from source; no published PyPI wheel is claimed. See [Core dependency provenance](CORE-BASELINE.md). It requires Node.js 22.19+ in the 22.x line or 24+, plus Python 3.11+. Core supplies thaliris.core and thaliris.authority to the plugin's configured Python environment. Runtime, Remote API, and optional memory entries are disabled by default. Install the local archives through the native Plugin Manager:

This guide and its links to shared semantics do not automatically port updated Codex-specific admission, Hook, wait, profile, or semantic-acceptance contracts to this DSH pin. This repository claims compatibility only for the listed revisions and the checks documented here.

    dsh plugin --profile <profile> add <artifact-dir>/thaliris-dsh-plugin-0.2.0.tgz <artifact-dir>/thaliris-dsh-memory-0.1.0.tgz <artifact-dir>/thaliris-dsh-memory-local-0.1.0.tgz

Before enabling runtime, configure absolute pythonExecutable, corePath, and authorityDirectory values. corePath identifies the Core installation for that Python environment. Keep authorityDirectory outside the governed Workspace and do not store credentials in plugin configuration. Register the canonical Git root as a native Workspace, create or resume its persistent root Session, then bind the native Workspace ID and exact root in policy.workspaces.

Build the profile patch with npm run build:bundle and the client with DSH_SOURCE=<checkout> npm run build:client from the pinned DSH checkout. The Web client preset is shared with Desktop. Run npm pack in this repository and each optional component directory to create the three archives. The patch is regenerated from visible role templates and leaves runtime/API disabled by default; bundled Zod licensing is listed in [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md). The native policy form edits role records, prompts, tool grants, model routes, memory grants, and context permissions. Route modes are inherit, fixed, and allowed; Thaliris does not rank models or rewrite user settings.

### Behavior and limits

The native root Agent, persisted Session ancestry, and configured native Workspace must match the Core Authority anchor for the selected Task ID. One native root Session may be associated with multiple independent Core tasks; task-specific workstream, close, reconcile, inspect and diagnostic reads select an explicit Task ID. A matching repository path or Workspace alone does not resume an older task. Delegation creates a fresh native child and passes only the selected bounded handoff, exact role prompt, and explicitly selected memory context. Controller acceptance is explicit; a child result leaves that task active until Controller close.

Recovery uses exact native child correlation and durable terminal Session evidence. Catalog membership or inactivity alone does not prove completion. If identity, persistence, or terminal reason is missing, the result remains UNKNOWN and its reservation stays attached to that Task ID, blocking replacement work or close for that same task until sufficient terminal evidence is available. That reservation does not make another Task ID's state conflicting. DSH does not yet provide the broader native UNKNOWN-abandonment flow. Shared OS access and writer leases are governance facts, not universal actor authentication.

Memory is disabled by default. The optional capability accepts replaceable async providers; @thaliris/dsh-memory-local adds a bounded text provider over native storage. There are no embeddings, vector/RAG system, credential manager, or automatic retrieval. Memory search/read are read-only and task-independent. Task inspection, diagnostics, approval and memory writes select an explicit Task ID. Manual and review writes pass through the bridge as Core proposals and use that task's Authority and CAS checks; automatic provider writes first verify the parent task association and require a separate persisted `autoAuthorized: true` opt-in. Removing either optional package leaves task routing and close available.

The extracted repository checks use a scripted LLM and pinned DSH source; they do not use online models or a current installed profile. The original source repository separately verified live Web integration against Core source revision 256f760, including a real task, fifth child, denial of native root tools to that child, and explicit DONE close. This does not mean the extracted package smoke launched a browser. Desktop shares the Web client bundle, but no Desktop binary was launched. Detailed commands and scopes are in the original Chinese README and linked contract docs.

The Core repository contains the [ABCD benchmark protocol](https://github.com/Iris0fTheValley/Thaliris/blob/main/docs/thaliris-benchmark-protocol.md) and canonical results. The sibling [Thaliris Codex adapter](https://github.com/Iris0fTheValley/Thaliris-codex) uses the same Core.

### Development and verification

Use the pinned DSH source and Core source revision. Set DSH_SOURCE to the DSH checkout, THALIRIS_CORE_PATH to the directory containing the thaliris source package, and THALIRIS_TEST_PYTHON to an isolated Python 3.11+ environment. The source bridge and native composition checks use that checkout. For packed activation smoke, build a fresh local Core wheel from the pinned source, install it into the isolated environment, and set THALIRIS_TEST_CORE_PATH to the installed package directory. Then run:

    npm run build:bundle
    npm run build:client
    npm run test:native
    npm run test:client
    python -m pytest tests/test_bridge.py -q

The client build and tests use temporary package workspaces under DSH and remove them on exit; native tests use temporary fixture repositories. The packed smoke also needs THALIRIS_PACK_DIR (all three local archives), THALIRIS_TEST_CORE_PATH (the installed Core package), and THALIRIS_TEST_TMP_ROOT (task-owned scratch space), then runs npm run test:install. It verifies the packed runtime imports Core, starts, inspects, and closes a task through DSH, and retains those tools after optional memory bundles are removed.

## Native policy and prompt boundaries

DSH uses native persistent Workspace/Session/Agent and subagent correlation, an explicit
Python Core bridge, and user-editable Controller/role policy. `policy.mjs` owns the
Controller template; `role-templates.mjs` owns initial role prompts. Model routes, tool
allowlists, memory/context grants and enabled records remain user policy. Existing stored
roles are not silently overwritten by template changes; explicit empty arrays stay empty.
`build-bundle.mjs` generates the disabled bundle patch from those templates. Client output
comes from `client/*`. This adapter does not install Codex hooks, TOML profiles or the Codex
lifecycle contract. The untracked local Codex instruction copies are not DSH authority.

Controller owns direction, scope, acceptance and next routing; executor owns implementation
methods. Ordinary Implementer converges the stable accepted direction. Focused Implementer
owns reasoning, implementation, runtime feedback and revision until core semantics converge;
remaining deterministic closure goes to a fresh ordinary Implementer. Reviewer is independent
and non-writing: supported critical evidence is needed for READY, not absence of blockers.
See [shared semantics](https://github.com/Iris0fTheValley/Thaliris/blob/main/docs/thaliris-routing-protocol.md)
and [context design](https://github.com/Iris0fTheValley/Thaliris/blob/main/docs/thaliris-prompt-design.md).
Native completion is evidence, not semantic acceptance. Core authority and DSH recovery retain
their existing exact identity/evidence checks. See [CLIENT-CONTRACT.md](CLIENT-CONTRACT.md).
No compression benchmark or live-profile activation is claimed for template normalization.

## Historical benchmark evidence

Historical ABCD evidence belongs to [Core](https://github.com/Iris0fTheValley/Thaliris#readme); it does not validate this DSH template normalization.
