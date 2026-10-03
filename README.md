# Thaliris for DeepSeek Harness

`@thaliris/dsh-plugin` adds Thaliris task records and explicit Controller tools to [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness). It uses DSH's native Workspaces, persistent Sessions, Agents, subagents, Settings, model catalog, Plugin Manager, and lifecycle. The Python Core is a separate [Thaliris distribution](https://github.com/Iris0fTheValley/Thaliris); this repository contains no copy of Core or Codex adapter code.

The runtime package has optional native Remote and shared Web/Desktop client entries. The user policy page edits native role, model, workspace, and memory settings. Memory capability and the default local provider are separate optional packages; task routing and close work without them or the client UI. See [CLIENT-CONTRACT.md](CLIENT-CONTRACT.md) and [CAPABILITIES.md](CAPABILITIES.md) for their contracts and verified limits.

## Install and configure

Use Node.js `22.19+` or `24+`, Python 3.11 or newer, and a DSH build at source revision `639ed015397290b3745d163aafe02ffee4aa3f84`. Install the separate Thaliris Core `0.4.2` distribution from source revision `751ccea498ad89c6c77c622fb4efaee9be469326`. It provides `thaliris.core` and `thaliris.authority` to the Python environment configured for the plugin. See [CORE-BASELINE.md](CORE-BASELINE.md) for package provenance and the extracted integration checks. Runtime, Remote API, and optional memory entries are disabled by default. Install the local bundles into a profile with the native Plugin Manager:

```text
dsh plugin --profile <profile> add <artifact-dir>/thaliris-dsh-plugin-0.2.0.tgz <artifact-dir>/thaliris-dsh-memory-0.1.0.tgz <artifact-dir>/thaliris-dsh-memory-local-0.1.0.tgz
```

Before enabling the runtime, configure absolute values for `pythonExecutable`, `corePath`, and `authorityDirectory`. `corePath` points to the Core installation used by that Python environment. Keep the external authority directory outside the governed Workspace and do not put credentials in plugin configuration. Register the canonical Git root as a native DSH Workspace, create or resume its persistent root Session, then bind that Workspace ID and exact root under `policy.workspaces`. Native Settings stores user policy; Core stores selected task intent.

Build the profile patch and client bundle from the pinned DSH checkout with `npm run build:bundle` and `DSH_SOURCE=<checkout> npm run build:client`. The client build uses DSH's Web client preset, shared with Desktop. Its bundled Zod license is in [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md). Then create the three local archives with `npm pack` from this repository and each optional component directory. The patch is regenerated from the visible role templates and keeps runtime/API disabled by default.

Role records, prompts, tool allowlists, model routes, memory grants, and context permissions are editable in the native policy form. Routes use the DSH model catalog: `inherit` uses the native parent configuration, `fixed` selects one configured route, and `allowed` lets the Controller select from the user's configured route set for a slice. Thaliris does not rank models or rewrite those settings.

## Behavior and limits

The native root Agent, its persisted Session ancestry, and the configured native Workspace must match the Core authority anchor. A same-path but unrelated Session cannot continue the task. Delegation uses a fresh native child and passes the selected bounded handoff, exact role prompt, and only explicitly selected memory context. The Controller makes acceptance explicit; a child result leaves the task active until the Controller closes it.

Recovery uses exact native child correlation and durable terminal Session evidence. Catalog membership or inactivity alone does not prove a child finished. When identity, persistence, or a terminal reason is missing, the outcome remains UNKNOWN and the reservation remains. The broader UNKNOWN-abandonment path is not implemented. Shared OS access and writer leases are governance facts, not universal actor authentication.

Memory is disabled by default. The optional capability accepts replaceable async providers; `@thaliris/dsh-memory-local` adds a bounded text provider over native storage. There are no embeddings, vector or RAG system, credential manager, or automatic retrieval. Manual and review writes create Core proposals; auto writes require the separate persisted `autoAuthorized: true` opt-in. Removing either optional memory package leaves task routing and close available.

The extracted repository's bridge, native composition, packed package-install, and client checks use a scripted LLM and pinned DSH source. They do not use online models or a current installed profile. Separately, the original source repository's live Web integration was verified against Core source revision `256f760`: a real Core task exercised a fifth child, denied native root tools to the child, and closed `DONE`. That observation is not evidence that the extracted repository's package smoke launched a browser. Desktop shares the Web client bundle, but a Desktop binary was not launched.

## Development and verification

Clone the pinned DSH source and the Core source or install the matching Core distribution. Set `DSH_SOURCE` to the DSH checkout, `THALIRIS_CORE_PATH` to the directory containing the source `thaliris` package, and `THALIRIS_TEST_PYTHON` to an isolated Python 3.11+ environment. The bridge and native source-composition checks use that source path. For the packed activation smoke, build a fresh Core wheel from the pinned upstream source and install it into the isolated Python environment; set `THALIRIS_TEST_CORE_PATH` to that installed package directory so the smoke checks the wheel itself. Then run:

```text
npm run build:bundle
npm run build:client
npm run test:native
npm run test:client
python -m pytest tests/test_bridge.py -q
```

The client build and client test runner use temporary package workspaces inside the DSH checkout and remove them on exit. Native tests use temporary fixture repositories. For the packed activation smoke, additionally set `THALIRIS_PACK_DIR` to the directory containing all three local archives, `THALIRIS_TEST_CORE_PATH` to the installed Core package directory in the test environment, and `THALIRIS_TEST_TMP_ROOT` to a task-owned scratch directory; then run `npm run test:install`. The smoke verifies the packed runtime imports the installed Core package, starts/inspects/closes a task through DSH, and retains those tools when optional memory bundles are removed.

The Core repo also contains the [ABCD benchmark](https://github.com/Iris0fTheValley/Thaliris/tree/main/benchmarks/abcd) and its [benchmark protocol](https://github.com/Iris0fTheValley/Thaliris/blob/main/docs/thaliris-benchmark-protocol.md). The sibling [Thaliris Codex adapter](https://github.com/Iris0fTheValley/Thaliris-codex) integrates the same Core with Codex.
