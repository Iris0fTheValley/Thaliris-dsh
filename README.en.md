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
