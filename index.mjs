// Global (host-plane) half of Thaliris.
//
// This row is active whenever the installed bundle is enabled, whether or not any session
// selects the Thaliris Agent Preset. It therefore owns ONLY host-plane material:
//   * tolerant configuration (no required runtime path, no I/O in `apply`),
//   * the `thaliris` Host service consumed by the API row and the preset child,
//   * the Python Core bridge and Workspace/root binding used by both halves,
//   * Gateway-facing data for the shared Web/Desktop settings page,
//   * registration of the persistent `thaliris` Agent Preset when the host registry exists.
// All model-visible surface (the 19 Controller/evidence/memory tools, the Controller prompt
// section, dynamic task context, `agent/created` child composition and dispatch) lives in
// ./preset.mjs, which the preset mounts only for sessions bound to the preset. That split is
// what keeps an unselected/standard session free of Thaliris tools and prompt contributions.
import { randomUUID } from 'node:crypto'
import { existsSync, readdirSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readPolicy } from './policy.mjs'
import { configValue, createRuntimeSetup, RUNTIME_CODES, RUNTIME_RECOVERY } from './setup.mjs'
import { THALIRIS_PRESET_ID, thalirisPresetDefinition } from './composition.mjs'
export { Config } from './policy.mjs'
export { EVIDENCE_TOOLS, MEMORY_TOOLS, TOOL_NAMES } from './preset.mjs'
export { RUNTIME_CODES, RUNTIME_RECOVERY } from './setup.mjs'

export const name = 'thaliris-dsh'
/** Host-plane dependencies only; the preset half declares its own model-facing injections. */
export const inject = ['agents', 'subprocess', 'sessionPersistence', 'tools']

const bridgePath = fileURLToPath(new URL('./core_bridge.py', import.meta.url))

/** Fail-closed runtime error carrying the machine code, recovery text and offending field. */
function runtimeError(code, field, detail) {
  const recovery = RUNTIME_RECOVERY
  return Object.assign(new Error(`${code}: ${field} ${detail}. ${recovery}`), { code, recovery, details: { field } })
}

/** Host-bundled Python executable candidates under the DSH runtimes directory. */
function detectBundledPython(home) {
  const runtimes = join(home, 'dsh-runtimes')
  let entries
  try { entries = readdirSync(runtimes, { withFileTypes: true }) } catch { return undefined }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const python = process.platform === 'win32'
      ? join(runtimes, entry.name, 'dependencies', 'python', 'python.exe')
      : join(runtimes, entry.name, 'dependencies', 'python', 'bin', 'python3')
    if (existsSync(python)) return python
  }
  return undefined
}

/**
 * Lazy runtime resolver (design §2): explicit configuration first, then the recorded
 * runtime manifest written by first-run provisioning, then a host-detected bundled
 * Python. Nothing here runs during activation: a fresh install, a headless host or a
 * damaged profile must still load, and only an operation that needs the bridge fails
 * closed with an actionable code. `setup.ensure()` runs before every bridge launch, so a
 * recorded runtime the resolver trusts has already been probed in this process.
 */
function createRuntimeResolver(config, setup) {
  let settled
  // Cordis config nodes are reactive values with `.get()`; read through the shared helper so
  // explicit paths (and live volatile Settings edits) resolve as real strings.
  const configured = key => typeof configValue(config, key) === 'string' && configValue(config, key).trim() !== ''
  const dshHome = () => process.env.DSH_HOME && isAbsolute(process.env.DSH_HOME) ? process.env.DSH_HOME : join(homedir(), '.dsh')
  // A manual Settings override invalidates the settle even before any provisioning runs.
  const signature = () => JSON.stringify([
    configured('pythonExecutable') ? resolve(configValue(config, 'pythonExecutable')) : '',
    configured('corePath') ? resolve(configValue(config, 'corePath')) : '',
    setup.authority(),
  ])
  function resolveRuntime() {
    if (settled !== undefined && settled.generation === setup.generation() && settled.signature === signature()) return settled
    const authority = setup.authority()
    const recorded = setup.recordedRuntime()
    const python = configured('pythonExecutable') ? resolve(configValue(config, 'pythonExecutable'))
      : recorded?.pythonExecutable ?? detectBundledPython(dshHome())
    const core = configured('corePath') ? resolve(configValue(config, 'corePath')) : recorded?.corePath
    const source = configured('pythonExecutable') || configured('corePath') ? 'explicit' : recorded ? 'manifest' : 'detected'
    if (!python) throw runtimeError(RUNTIME_CODES.notConfigured, 'pythonExecutable', 'has no configured, recorded or host-detected value')
    if (!core) throw runtimeError(RUNTIME_CODES.notConfigured, 'corePath', 'has no configured or recorded value')
    let identity
    try { identity = realpathSync(python) } catch {
      throw runtimeError(RUNTIME_CODES.notReady, 'pythonExecutable', 'does not exist')
    }
    let corePath
    try { corePath = realpathSync(core) } catch {
      throw runtimeError(RUNTIME_CODES.notReady, 'corePath', 'does not exist')
    }
    // The interpreter is pinned at first use: its fully resolved file is the identity
    // every bridge launch must still reach. Launch it through the configured name with
    // only parent directories resolved, because a POSIX venv's bin/python is a symlink
    // and CPython locates pyvenv.cfg (and so the venv site-packages holding Core) from
    // the path it was started as; starting the resolved base interpreter loses the venv.
    const launch = join(realpathSync(dirname(python)), basename(python))
    settled = { python: launch, identity, corePath, authorityDirectory: authority, manifestPath: join(authority, 'runtime.json'), source, generation: setup.generation(), signature: signature() }
    return settled
  }
  /** Pinned interpreter path, re-verified on every bridge so a swapped binary cannot be used. */
  function pinnedPython(runtime) {
    if (realpathSync(runtime.python) !== runtime.identity) throw new Error('THALIRIS_PYTHON_IDENTITY_CHANGED')
    return runtime.python
  }
  /** Tolerant status for the settings page; never throws. */
  function status() {
    try {
      const runtime = resolveRuntime()
      return { configured: true, source: runtime.source, pythonExecutable: runtime.python, corePath: runtime.corePath, authorityDirectory: runtime.authorityDirectory, manifestPath: runtime.manifestPath }
    } catch (error) {
      let authority
      try { authority = setup.authority() } catch { authority = undefined }
      return { configured: false, code: error.code, recovery: error.recovery, details: error.details ?? null, authorityDirectory: authority }
    }
  }
  return { resolve: resolveRuntime, pinnedPython, status }
}

/** Native Settings owns mutable user policy. Core alone owns task intent. */
export function apply(ctx, config) {
  // Tolerant activation: no required field and no filesystem access here. This row must
  // load on a fresh install, on a headless host without Agent Presets, and with an
  // incomplete runtime; every operation that needs the bridge fails closed instead.
  let disposed = false, bridgeTail = Promise.resolve()
  const setup = createRuntimeSetup({
    config,
    profileName: () => ctx.get('profileContext')?.name,
    workspaceRoots: () => { try { return readPolicy(config).workspaces.filter(row => row.enabled).map(row => row.root) } catch { return [] } },
    log: message => ctx.logger?.warn?.(message),
  })
  const runtime = createRuntimeResolver(config, setup)
  const bridgeTimeoutMs = (() => { const value = configValue(config, 'bridgeTimeoutMs'); return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 30000 })()
  // Last first-run workspace binding reported by setupStatus (human diagnostics).
  let lastAutoBind

  function isNativeRoot(agent) {
    const header = agent?.session.header
    return !!agent && ctx.agents.get(agent.id) === agent && ctx.agents.roots().includes(agent)
      && header.id === agent.id && header.parentSession === undefined && header.isSeeded === false
      && (header.delegationDepth ?? 0) === 0 && header.origin !== 'subagent' && !!header.cwd
  }
  function isPersistedRoot(header, sessionId) {
    return !!header && header.id === sessionId && header.parentSession === undefined && header.isSeeded === false
      && (header.delegationDepth ?? 0) === 0 && header.origin !== 'subagent' && !!header.cwd
  }
  // Whether a persisted/live root selected a preset whose composition mounts the Thaliris
  // half. This is the "Thaliris-selected session" gate for first-run workspace binding: a
  // plain or Standard native root never gets a binding written for it.
  const presetSelection = new Map()
  async function isThalirisSelected(header) {
    const presetId = header?.agentPreset
    if (typeof presetId !== 'string' || !presetId) return false
    if (presetSelection.has(presetId)) return presetSelection.get(presetId)
    const registry = ctx.get('agentPresets')
    if (!registry?.readDocument) return false
    try {
      const document = await registry.readDocument(presetId)
      const content = typeof document === 'string' ? document : document?.content
      const selected = typeof content === 'string' && /thaliris-agent|@thaliris\/dsh-plugin\/preset/.test(content)
      presetSelection.set(presetId, selected)
      return selected
    } catch { return false }
  }
  let autoBindFlight
  async function autoBindWorkspace(workspace) {
    // Persist exactly once per process through the native profile editor; a concurrent
    // first call shares the same write instead of appending a duplicate binding.
    if (!autoBindFlight) autoBindFlight = persistAutoBind(workspace).finally(() => { autoBindFlight = undefined })
    return autoBindFlight
  }
  async function persistAutoBind(workspace) {
    const editor = ctx.get('configEditor')
    const entry = editor?.entries().find(candidate => candidate.fiber?.runtime?.name === name)
      ?? editor?.entries().find(candidate => candidate.options.id === 'thaliris')
    if (!editor || !entry || !workspace?.id || typeof workspace.path !== 'string') throw new Error('THALIRIS_WORKSPACE_NOT_CONFIGURED')
    await editor.edit(entry, (current, inherited) => {
      // configEditor persists a complete raw config, so keep the composed values and only
      // append the one enabled binding the first-run rule is allowed to add.
      const base = { ...inherited, ...current }
      const policy = { ...(inherited.policy ?? {}), ...(current.policy ?? {}) }
      const workspaces = Array.isArray(policy.workspaces) ? [...policy.workspaces] : []
      if (!workspaces.some(row => row?.workspaceId === workspace.id)) workspaces.push({ workspaceId: workspace.id, root: workspace.path, enabled: true })
      return { ...base, policy: { ...policy, workspaces } }
    })
    lastAutoBind = { workspaceId: workspace.id, root: workspace.path, enabled: true, at: new Date().toISOString() }
    ctx.logger?.info?.(`thaliris: bound native Workspace ${workspace.id} at ${workspace.path} on first Thaliris use (policy.workspaces was empty)`)
    return lastAutoBind
  }
  async function workspaceBinding(header, { autoBind = false } = {}) {
    // The Workspace registry is optional at activation (the headless profile does not compose
    // it) and required for a bound Workspace; reading it lazily keeps headless boot clean.
    const registry = ctx.get('workspaceRegistry')
    if (!registry) throw new Error('THALIRIS_WORKSPACE_NOT_CONFIGURED')
    const workspace = await registry.resolveByPath(header.cwd)
    let policy = readPolicy(config)
    let selected = policy.workspaces.find(row => row.enabled && row.workspaceId === workspace?.id)
    let autoBound
    // First-run rule (design §5): bind only when the whole list is empty, the root really is
    // a Thaliris-selected session, and the cwd resolves to a native Workspace. A non-empty
    // list always requires an explicit binding, and unselected roots never get one.
    if (!selected && autoBind && workspace && policy.workspaces.length === 0 && await isThalirisSelected(header)) {
      autoBound = await autoBindWorkspace(workspace)
      policy = readPolicy(config)
      selected = policy.workspaces.find(row => row.enabled && row.workspaceId === workspace.id)
    }
    if (!selected || realpathSync(selected.root) !== realpathSync(workspace.path) || realpathSync(header.cwd) !== realpathSync(selected.root)) throw new Error('THALIRIS_WORKSPACE_NOT_CONFIGURED')
    // Omit the marker when nothing was bound: Gateway results are strict JSON values.
    return autoBound ? { root: realpathSync(selected.root), workspaceId: workspace.id, autoBound } : { root: realpathSync(selected.root), workspaceId: workspace.id }
  }
  async function persistedRootBinding(sessionId) {
    // Persistent native metadata, never a caller id or a matching object alone.
    const stored = await ctx.sessionPersistence.stat(sessionId)
    const header = stored?.header
    if (!isPersistedRoot(header, sessionId)) throw new Error('THALIRIS_PERSISTED_ROOT_REQUIRED')
    return await workspaceBinding(header)
  }
  async function binding(agent, options = {}) {
    if (disposed || !isNativeRoot(agent)) throw new Error('THALIRIS_NATIVE_ROOT_REQUIRED')
    const bound = await workspaceBinding(agent.session.header, options)
    const stored = await ctx.sessionPersistence.stat(agent.id)
    if (!isPersistedRoot(stored?.header, agent.id) || realpathSync(stored.header.cwd) !== bound.root) throw new Error('THALIRIS_PERSISTED_ROOT_REQUIRED')
    return bound
  }
  async function withNativeRoot(sessionId, signal, operation) {
    let agent = ctx.agents.get(sessionId)
    let handle
    if (!agent) {
      // Prove durable root ancestry and exact configured Workspace before asking
      // the native Agent service to resume caller-selected persisted history.
      await persistedRootBinding(sessionId)
      signal?.throwIfAborted()
      try {
        handle = await ctx.agents.resume({ resumeSessionId: sessionId, signal })
        agent = handle.agent
      } catch (error) {
        // Another native request may have resumed this exact identity after our
        // initial lookup. Reuse it only after the ordinary live binding checks.
        agent = ctx.agents.get(sessionId)
        if (!agent) throw error
      }
    }
    try {
      // Human Gateway reads never write a first-run binding; only a Thaliris tool call and
      // the explicit setup action may do that (design §5 trigger).
      await binding(agent, { autoBind: false })
      return await operation(agent)
    } finally {
      await handle?.dispose()
    }
  }
  function bridge(agent, operation, args, signal) {
    const pending = bridgeTail.then(() => bridgeExecute(agent, operation, args, signal))
    bridgeTail = pending.catch(() => {})
    return pending
  }
  async function bridgeExecute(agent, operation, args, signal) {
    const bound = await binding(agent, { autoBind: true })
    signal.throwIfAborted()
    // One deadline and one single-flight provisioning pass per call: the first Thaliris
    // tool call may cold-provision (measured ~1.7 s here, ~2.2 s in the spike) inside the
    // ordinary bridge timeout, while a ready/configured runtime short-circuits to a probe
    // (~0.1 s) or an in-process cache hit. A cancelled wait never kills the shared work.
    const deadline = new AbortController(), timer = setTimeout(() => deadline.abort('Thaliris bridge deadline exceeded'), bridgeTimeoutMs)
    timer.unref()
    const processSignal = AbortSignal.any([signal, deadline.signal])
    let command
    try {
      await setup.ensure({ signal: processSignal })
      // Resolution is lazy: an unconfigured runtime fails here with an actionable code
      // instead of failing plugin activation.
      const runtimeConfig = runtime.resolve()
      const python = runtime.pinnedPython(runtimeConfig)
      command = ctx.subprocess.spawn({ argv: [python, '-I', bridgePath], cwd: bound.root, graceMs: 1000, signal: processSignal,
        stdio: { stdin: { data: JSON.stringify({ protocol: 1, core_path: runtimeConfig.corePath, root: bound.root, authority_directory: runtimeConfig.authorityDirectory,
          native_controller_id: agent.id, native_workspace_id: bound.workspaceId, operation, arguments: args }) }, stdout: { maxBytes: 1048576 }, stderr: { maxBytes: 8192 } } })
      const outcome = await command.done, stdout = command.collected.stdout.readFrom(0)
      if (stdout.lossy) throw new Error('THALIRIS_BRIDGE_RESPONSE_TOO_LARGE')
      const response = JSON.parse(stdout.text)
      if (response.protocol !== 1 || response.ok !== true || outcome.exitCode !== 0) throw bridgeError(response)
      processSignal.throwIfAborted()
      return response.result
    } finally { clearTimeout(timer); if (command) { command.terminate(); await command.waitForExit() } }
  }
  async function nativeObservation(agent, reservation, signal, cancel) {
    const own = agent.session.snapshotEvents().filter(event => event.type === 'subagent/catalog' && event.data.label === reservation.correlation)
    const ids = [...new Set(own.map(event => event.data.childId))]
    const id = reservation.child_id ?? (ids.length === 1 ? ids[0] : undefined)
    if (!id || ids.length !== 1 || ids[0] !== id) return { outcome: 'UNKNOWN', reason: 'native catalog correlation unresolved' }
    const live = ctx.agents.get(id)
    if (live) {
      if (live.session.header.parentSession !== agent.id) throw new Error('THALIRIS_NATIVE_CHILD_IDENTITY_REQUIRED')
      if (!cancel) return { child_id: id, outcome: 'UNKNOWN', reason: 'native child resident; cancel and observe or await its owner' }
      live.cancel({ kind: 'parent' })
      await live.whenIdle()
      await ctx.sessionPersistence.flush()
    }
    const handle = await ctx.sessionPersistence.open(id, 'read', { signal })
    try {
      if (handle.header.parentSession !== agent.id || handle.header.isSeeded !== false || handle.header.origin !== 'subagent'
        || realpathSync(handle.header.cwd) !== realpathSync(agent.session.header.cwd)) throw new Error('THALIRIS_NATIVE_CHILD_IDENTITY_REQUIRED')
      const { events } = await handle.read(0, undefined, { signal })
      const start = events.filter(event => event.type === 'turn/start').at(-1)
      const end = events.filter(event => event.type === 'turn/end').at(-1)
      if (!start || !end || end.seq < start.seq || !['completed', 'aborted', 'error', 'max-tokens', 'blocked', 'interrupted'].includes(end.data.reason.kind)) return { child_id: id, outcome: 'UNKNOWN', reason: 'durable native terminal reason unavailable' }
      return { child_id: id, outcome: end.data.reason.kind, terminal_seq: end.seq, terminal_reason: end.data.reason, provenance: 'native-session-turn/end' }
    } finally { await handle.close() }
  }

  // Persistent Agent Preset registration. The definition activates eagerly in the host
  // registry, so it is deliberately started from a zero-delay task owned by this row's
  // effect: the global row must never await a mount that waits for the `thaliris` service
  // this same `apply` provides (deadlock), and a missing/broken registry must not fail load.
  const presetState = { status: 'pending' }
  let registerRetries = 0
  const presetReady = Promise.withResolvers()
  function settlePreset(update) {
    Object.assign(presetState, update)
    presetReady.resolve({ ...presetState })
  }
  ctx.inject(['agentPresets'], (injected) => {
    injected.effect(() => {
      let cancelled = false, timer, release
      const definition = thalirisPresetDefinition()
      presetState.definition = { id: definition.id, name: definition.name, description: definition.description, order: definition.order, rows: definition.plugins.length }
      const start = () => {
        timer = undefined
        if (cancelled) return
        injected.agentPresets.register(definition).then(async disposer => {
          if (cancelled) { await disposer(); return }
          release = disposer
          settlePreset({ status: 'registered' })
        }, error => {
          // A duplicate id can trail a not-yet-disposed previous row during hot reload; every
          // other rejection is final. Either way the Host row stays active and reports it.
          if (!cancelled && /Duplicate agent preset/.test(String(error?.message)) && registerRetries < 3) {
            registerRetries++
            timer = setTimeout(start, 200)
            return
          }
          if (!cancelled) injected.logger.warn(`thaliris: agent preset ${THALIRIS_PRESET_ID} could not be registered: ${error?.message ?? error}`)
          settlePreset({ status: 'failed', error: String(error?.message ?? error) })
        })
      }
      // The zero delay is what keeps the mount off this row's activation path.
      timer = setTimeout(start, 0)
      return async () => {
        cancelled = true
        if (timer !== undefined) clearTimeout(timer)
        if (release) await release()
        release = undefined
      }
    })
  })

  // Host projection/approval seam; user configuration stays on native Settings.
  // The preset-scoped half reports its model-visible catalog here, because native DSH
  // tools live in the preset composition while the settings page reads the Gateway on
  // the host plane. Management tools are never role grants, so they stay out of it.
  let presetToolCatalog
  /** Setup status plus the reported first-run workspace binding (human diagnostics). */
  const setupStatus = () => ({ ...setup.status(), workspaceAutoBind: lastAutoBind ?? null })
  ctx.provide('thaliris', {
    config: () => config,
    policy: () => readPolicy(config),
    status: () => ({ runtime: runtime.status(), preset: { status: presetState.status, id: THALIRIS_PRESET_ID, error: presetState.error ?? null }, setup: setupStatus() }),
    /** Resolves when the programmatic preset registration settles; tests and the settings page use it. */
    preset: () => presetReady.promise,
    bridge: (agent, operation, args, signal) => bridge(agent, operation, args, signal),
    binding: (agent, options) => binding(agent, { autoBind: options?.autoBind !== false }),
    /** Human Gateway setup surface: tolerant, never a model tool (it is not registered in preset.mjs). */
    setupStatus,
    prepareRuntime: signal => setup.prepare({ signal }).then(result => ({ ...result, workspaceAutoBind: lastAutoBind ?? null })),
    recheckRuntime: signal => setup.recheck({ signal }).then(result => ({ ...result, workspaceAutoBind: lastAutoBind ?? null })),
    /** Registry path of a configured native Workspace, or undefined while it is not registered. */
    workspacePath: workspaceId => ctx.get('workspaceRegistry')?.get(workspaceId)?.path,
    nativeObservation: (agent, reservation, signal, cancel) => nativeObservation(agent, reservation, signal, cancel),
    memoryCapability: () => ctx.get('thalirisMemory'),
    templates: () => import('./policy.mjs').then(module => structuredClone(module.roleTemplates)),
    providers: () => ctx.get('thalirisMemory')?.list() ?? [],
    /** Registers the preset-scope catalog reader and returns its disposer. */
    attachToolCatalog: provider => {
      presetToolCatalog = provider
      return () => { if (presetToolCatalog === provider) presetToolCatalog = undefined }
    },
    toolCatalog: () => {
      const merged = new Map()
      for (const tool of ctx.tools.schemas()) merged.set(tool.name, { name: tool.name, description: tool.description })
      for (const tool of presetToolCatalog?.() ?? []) merged.set(tool.name, { name: tool.name, description: tool.description })
      return [...merged.values()].filter(tool => !tool.name.startsWith('thaliris_'))
    },
    diagnostics: async (sessionId, taskId, signal) => withNativeRoot(sessionId, signal, async agent => {
      const task = await bridge(agent, 'inspect', { task_id: taskId }, signal)
      return { task, workspace: await binding(agent), configurationRevision: ctx.get('settings')?.describe({ redactSecrets: true }).find(row => row.ns === ctx.get('configEditor')?.entries().find(entry => entry.fiber?.runtime?.name === name)?.options.id)?.revision ?? null, permissions: { memory: readPolicy(config).memory, roles: readPolicy(config).roles.map(({ id, enabled, tools, memory, context, modelPolicy }) => ({ id, enabled, tools, memory, context, modelPolicy })) },
        providers: ctx.get('thalirisMemory')?.list() ?? [], reservations: await Promise.all(task.state.active_work.map(async value => ({ reservation: JSON.parse(value), native: await nativeObservation(agent, JSON.parse(value), signal, false) }))) }
    }),
    approveMemory: async (sessionId, taskId, proposalId, signal) => withNativeRoot(sessionId, signal, async agent => {
      const bound = await binding(agent), policy = readPolicy(config)
      const task = await bridge(agent, 'inspect', { task_id: taskId }, signal)
      const proposal = task.state.pending_results.map(value => { try { return JSON.parse(value) } catch { return null } }).find(value => value?.proposal_id === proposalId)
      if (!proposal || (proposal.task_id !== undefined && proposal.task_id !== taskId) || proposal.workspaceId !== bound.workspaceId || policy.memory.mode === 'disabled' || !policy.memory.providers.includes(proposal.provider) || !policy.memory.controllerWrite.includes(proposal.provider)) throw new Error('THALIRIS_MEMORY_PERMISSION_DENIED')
      const capability = ctx.get('thalirisMemory')
      if (!capability) throw new Error('THALIRIS_MEMORY_CAPABILITY_UNAVAILABLE')
      const value = await capability.invoke(proposal.provider, 'write', { ...proposal, ...bound, signal, maxBytes: 16384 })
      // Consumes the pending proposal and records the receipt as a `dsh-memory-approval` Core record.
      const recorded = await bridge(agent, 'approval', { task_id: taskId, observation: JSON.stringify({ approval_id: randomUUID(), proposal_id: proposal.proposal_id, provider: proposal.provider, workspaceId: bound.workspaceId, outcome: 'provider-write-observed', provenance: 'native-client-approval' }) }, signal)
      return { value, recorded: true, ...recorded }
    }),
  })
  ctx.effect(() => async () => {
    disposed = true
    // The preset half owns its own operations; this row only stops accepting new bridge work.
    await bridgeTail
  })
}

/** A bridge failure keeps the historical text first; Core's code, recovery hint and bounded details follow and are also exposed as properties. */
function bridgeError(response) {
  const message = response.error ?? 'THALIRIS_BRIDGE_FAILED'
  if (typeof response.code !== 'string') return new Error(message)
  const { code, recovery, details } = response
  return Object.assign(new Error(`${message} ${JSON.stringify({ code, recovery, details })}`), { code, recovery, details })
}
