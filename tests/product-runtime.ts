import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { boot, initProfile, readProfilePatches } from '@deepseek-ai/dsh-app-boot'
import ConfigEditor from '@deepseek-ai/dsh-config-editor'
import Settings from '@deepseek-ai/dsh-settings'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import AgentPresets from '@deepseek-ai/dsh-agent-preset-registry'
import Subagents from '@deepseek-ai/dsh-subagent'
import * as Spawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import LocalSubprocess from '@deepseek-ai/dsh-subprocess-local'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import * as Persistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import WorkspaceRegistry from '@deepseek-ai/dsh-workspace'
import { SessionId } from '@deepseek-ai/dsh-session'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { assembleContextFor } from '@deepseek-ai/dsh-agent'
import * as Plugin from '../index.mjs'
import Api from '../api.mjs'
import { remoteContribution } from '../remote.mjs'
import * as ClientGateway from '@deepseek-ai/dsh-api-gateway/client'
import Registry from '@deepseek-ai/dsh-typert-registry'
import Gateway from '@deepseek-ai/dsh-api-gateway'
import RemoteAccess from '@deepseek-ai/dsh-api-remote-access'
import { Peer } from '@deepseek-ai/dsh-client-connection'
import Memory from '../components/memory/index.mjs'
import * as LocalMemory from '../components/memory-local/index.mjs'
import { executeCalls } from './scripted-execute.ts'
const upstream = process.env.DSH_SOURCE!
const { MockAdapter, textResponse, toolCallResponse } = await import(pathToFileURL(join(upstream, 'packages/core/agent-loop/tests/mock-adapter.ts')).href)
const corePath = process.env.THALIRIS_CORE_PATH!
const bridgePath = fileURLToPath(new URL('../core_bridge.py', import.meta.url))
/** Shipped Core pin, asserted against the provisioned runtime.json in the cold-provision stage. */
const coreLock = JSON.parse(await readFile(fileURLToPath(new URL('../core.lock.json', import.meta.url)), 'utf8'))
/** The real preset-scoped child, mounted through a test-only preset declaration. */
const presetUrl = new URL('../preset.mjs', import.meta.url).href
const FIXTURE_PRESET = 'thaliris-product-fixture'
const script: any[] = []
const signal = () => new AbortController().signal
const contract = { human_instruction: 'Product runtime fixture', boundary: 'Temporary fixtures only', invariants: 'Native durable identity, optional memory, editable policy', acceptance: 'Controller decides', execution_mode: 'delegated' }
const role = { id: 'editable', name: 'My role', description: 'Fully editable', enabled: true, prompt: 'EXACT_EDITED_PROMPT', tools: [], modelPolicy: { mode: 'allowed', routes: [{ provider: 'mock', model: 'child' }] }, memory: { read: [], write: [] }, context: { handoff: true, memory: false } }
const handoff = { goal: 'Fixture', scope: 'Text only', invariants: 'No ambient input', acceptance: 'Controller assesses', context: 'BOUNDED_SELECTION' }
/** Parameterization for the first-run setup stages; the phase-1 init/restart stages use defaults. */
interface HarnessOptions {
  /** `configured` (default) ships the fixture Workspace bindings; `empty` leaves the list empty. */
  workspaces?: 'configured' | 'empty'
  /** `configured` (default) uses the test runtime paths; `missing` points at absent paths; `auto` omits them (cold provisioning). */
  runtime?: 'configured' | 'missing' | 'auto'
  /** Set false for stages that exercise the host setup service without a model session. */
  createParent?: boolean
}
async function taskStatePath(root: string, taskId: string) {
  const legacy = join(root, '.context', 'state.json')
  try { if (JSON.parse(await readFile(legacy, 'utf8')).task_id === taskId) return legacy } catch { /* the selected task uses its indexed ledger */ }
  return join(root, '.context', 'tasks', taskId, 'state.json')
}
async function harness(home: string, initialize: boolean, resumeRoot = true, options: HarnessOptions = {}) {
  const dir = join(home, 'profiles', 'product'), workspace = join(home, 'repo'), secondRoot = join(home, 'second')
  if (initialize) {
    await mkdir(workspace); await mkdir(secondRoot)
    execFileSync('git', ['init', '-q', workspace]); execFileSync('git', ['init', '-q', secondRoot])
    initProfile(dir, ['fixture-bundle'])
    await mkdir(join(dir, 'node_modules', 'fixture-bundle'), { recursive: true })
    await writeFile(join(home, 'package.json'), JSON.stringify({ name: 'test-installation' }))
    await writeFile(join(dir, 'cordis.yml'), '[]\n')
    await writeFile(join(dir, 'node_modules', 'fixture-bundle', 'package.json'), JSON.stringify({ name: 'fixture-bundle', version: '1.0.0', dsh: { bundle: { patch: 'cordis.patch.yml' } } }))
  }
  const profile = { name: 'product', startedBundles: ['fixture-bundle'], dir, patchPath: join(dir, 'cordis.patch.yml'), installAnchor: join(home, 'package.json'), cwd: home, home, overlays: [], telemetryDisabledEnv: undefined }
  const mock = new MockAdapter(script)
  const patches = initialize ? [] : readProfilePatches('product', profile as any)
  const ctx = await boot('product', join(dir, 'cordis.yml'), patches, async ctx => {
    ctx.provide('profileContext', profile as any)
    await mountAgentLoopTestDependencies(ctx, { workingDirectory: true })
    await ctx.plugin(Persistence, { root: join(home, 'sessions'), compression: 'none' })
    await ctx.plugin(Storage); await ctx.plugin(StorageJson, { root: join(home, 'storage') }); await ctx.plugin(StorageDomain, { backend: 'json' })
    await ctx.plugin(WorkspaceRegistry)
    const first = await ctx.workspaceRegistry.create(workspace), second = await ctx.workspaceRegistry.create(secondRoot)
    await ctx.plugin(AgentLoop, { agents: [] }); await ctx.plugin(Subagents); await ctx.plugin(Spawn, { providerName: 'spawn' }); await ctx.plugin(LocalSubprocess)
    // Thaliris dispatch requires native Agent presets for its per-dispatch resume gate.
    await ctx.plugin(AgentPresets, { default: 'standard' })
    ctx.llm.registerAdapter(['mock'], mock)
    Object.assign(ctx.loader.builtins, { editor: ConfigEditor, settings: Settings, thaliris: Plugin })
    if (initialize) {
      // First-run stages vary only the two host-service inputs: the Workspace binding list and
      // the runtime paths. Everything else (real Loader/Settings/Gateway/preset child) is the
      // same host shape the phase-1 suite uses.
      const runtime = options.runtime ?? 'configured'
      const runtimeConfig: Record<string, unknown> = { authorityDirectory: join(home, 'authority') }
      if (runtime === 'configured') { runtimeConfig.pythonExecutable = process.env.THALIRIS_TEST_PYTHON; runtimeConfig.corePath = corePath }
      else if (runtime === 'missing') { runtimeConfig.pythonExecutable = join(home, 'missing-python.exe'); runtimeConfig.corePath = join(home, 'missing-core') }
      runtimeConfig.policy = {
        workspaces: options.workspaces === 'empty' ? [] : [{ workspaceId: first.id, root: workspace, enabled: true }, { workspaceId: second.id, root: secondRoot, enabled: true }],
        roles: [role],
      }
      await writeFile(join(dir, 'node_modules', 'fixture-bundle', 'cordis.patch.yml'), JSON.stringify([{ insert: [
        { id: 'editor', name: 'cordis:editor' }, { id: 'settings', name: 'cordis:settings' },
        { id: 'thaliris', name: 'cordis:thaliris', config: runtimeConfig },
      ] }]))
      patches.push(...readProfilePatches('product', profile as any))
    }
  })
  await ctx.plugin(Registry); await ctx.plugin(RemoteAccess); await ctx.plugin(Gateway); await ctx.plugin(Api)
  // Every in-process Gateway call names its Peer; this fixture acts as the local owner.
  const owner = new Peer(ctx.root, { principal: { kind: 'owner' } })
  const invoke = (request: { namespace: string, method: string, args: Record<string, unknown> }) => ctx.typertGateway.invoke({ peer: owner, ...request })
  // Split invariants in the real Loader/Registry host: the global row is active, the product
  // preset is declared through the native roster with its real composition, the native
  // default stays `standard`, and only the selected fixture preset carries the model-visible
  // Thaliris surface. This reduced host cannot mount the whole mirrored Standard composition,
  // so the selected session uses a fixture declaration that mounts the real preset child.
  assert.ok(ctx.get('thaliris'), 'the global row must provide the thaliris Host service')
  const registration: any = await (ctx as any).thaliris.preset()
  assert.equal(registration.status, 'registered', JSON.stringify(registration))
  const roster = await ctx.agentPresets.list()
  assert.ok(roster.some((preset: any) => preset.id === 'thaliris' && preset.name === 'Thaliris'), 'the native roster exposes the Thaliris preset')
  assert.equal(ctx.agentPresets.defaultId, 'standard', 'the plugin never changes the native new-session default')
  const document = await ctx.agentPresets.readDocument('thaliris')
  assert.match(document.content, /thaliris-agent/)
  assert.match(document.content, /@deepseek-ai\/dsh-tool-fs/, 'the declared composition mirrors the Standard native tools')
  await ctx.agentPresets.register({ id: FIXTURE_PRESET, name: 'Thaliris product fixture', plugins: [{ id: 'thaliris-agent', name: presetUrl }] })
  const parent = !initialize
    ? resumeRoot ? (await ctx.agents.resume({ resumeSessionId: SessionId('persistent-controller'), agentOptions: { provider: 'mock', model: 'parent' },
      setup: async agentCtx => { await ctx.agentPresets.mount(agentCtx, FIXTURE_PRESET) } })).agent : undefined
    : options.createParent === false ? undefined
      : (await ctx.agents.create({ sessionId: SessionId('persistent-controller'), meta: { cwd: workspace, agentPreset: FIXTURE_PRESET },
        agentOptions: { provider: 'mock', model: 'parent' }, setup: async agentCtx => { await ctx.agentPresets.mount(agentCtx, FIXTURE_PRESET) } })).agent
  assert.equal(ctx.tools.get('thaliris_task_start'), undefined, 'the global tool view carries no preset-scoped tool')
  if (parent) {
    assert.ok(ctx.tools.get('thaliris_task_start', parent), 'the preset-selected session resolves the Controller tools')
    assert.equal(ctx.tools.schemas(parent).filter(tool => tool.name.startsWith('thaliris_')).length, 21, '17 Controller + 3 memory + dispatch-granted evidence tools are preset-scoped')
  }
  await ctx.sessionPersistence.flush()
  let call = 0
  // One standalone call through the native batch executor; the single settled result is returned.
  const execute = async (name: string, args: any, agent = parent) => (await executeCalls(ctx, { calls: [{ type: 'tool-call', id: ToolCallId(`product-${++call}`), name, arguments: JSON.stringify(args) }], agent, signal: signal() })).results[0]!.result as any
  const view = () => ctx.settings.describe().find(row => row.ns === 'thaliris')!
  const edit = async (ops: any[], expected = view().revision) => ctx.settings.mutate('thaliris', ops, expected)
  const inspect = async (taskId: string) => { const value: any = await execute('thaliris_task_inspect', { task_id: taskId }); assert.equal(value.isError, false); return value.value }
  return { ctx, parent, execute, invoke, edit, view, inspect, mock, workspace, secondRoot }
}
function bridge(home: string, operation: string, arguments_: any) {
  return JSON.parse(execFileSync(process.env.THALIRIS_TEST_PYTHON!, ['-I', bridgePath], { input: JSON.stringify({ protocol: 1, core_path: corePath, root: join(home, 'repo'), authority_directory: join(home, 'authority'), native_controller_id: 'persistent-controller', native_workspace_id: arguments_.workspaceId, operation, arguments: arguments_.args }), encoding: 'utf8' }))
}
async function initialize(home: string) {
  const h = await harness(home, true)
  try {
    const start: any = await h.execute('thaliris_task_start', { goal: 'Product fixture', contract }); assert.equal(start.isError, false, JSON.stringify(start))
    const taskId = start.value.task_id
    await writeFile(join(home, 'task-id'), taskId)
    const orphanTask: any = await h.execute('thaliris_task_start', { goal: 'Old task with unresolved native reservation', contract })
    assert.equal(orphanTask.isError, false, JSON.stringify(orphanTask))
    const orphanTaskId = orphanTask.value.task_id
    assert.notEqual(orphanTaskId, taskId)
    const orphanReservation = JSON.stringify({ correlation: 'orphaned', workstream: 'old', role: 'editable', handoff_sha256: 'old-digest' })
    const orphanBridge: any = bridge(home, 'begin', { workspaceId: (await h.ctx.workspaceRegistry.resolveByPath(h.workspace))!.id,
      args: { task_id: orphanTaskId, base_revision: 1, observation: orphanReservation } })
    assert.equal(orphanBridge.ok, true)
    const independent: any = await h.execute('thaliris_task_start', { goal: 'Independent task beside old ACTIVE task', contract })
    assert.equal(independent.isError, false, JSON.stringify(independent))
    const independentId = independent.value.task_id
    assert.notEqual(independentId, orphanTaskId)
    assert.equal((await h.inspect(independentId)).state.active_work.length, 0)
    assert.equal((await h.execute('thaliris_task_close', { task_id: independentId, base_revision: 1, decision: 'Independent task accepted.' })).isError, false)
    assert.deepEqual((await h.inspect(orphanTaskId)).state.active_work, [orphanReservation])
    const unbound = await h.ctx.agentLoop.create(SessionId('unbound-controller'), { provider: 'mock', model: 'parent' }, { cwd: h.secondRoot })
    await h.ctx.sessionPersistence.flush()
    assert.equal(h.ctx.tools.schemas(unbound).filter((tool: any) => tool.name.startsWith('thaliris_')).length, 0, 'an unselected session sees no Thaliris tool')
    const originalWorkspaces = structuredClone(h.view().value.policy.workspaces)
    const staleRoot = join(h.workspace, 'removed-unrelated-workspace')
    await h.edit([{ op: 'set', path: ['policy', 'workspaces'], value: [
      originalWorkspaces[0],
      { workspaceId: 'removed-native-workspace', root: staleRoot, enabled: true },
    ] }])
    const promptSection = async (agent: any) => (await h.ctx.systemPrompt.assemble(assembleContextFor(agent, signal()))).sections.find((section: any) => section.name === 'thaliris:controller-contract')?.text ?? ''
    assert.match(await promptSection(h.parent), /Thaliris Controller contract:/, 'a stale unrelated binding does not break the configured root prompt')
    assert.equal(await promptSection(unbound), '', 'an unbound native root receives no Thaliris prompt even with an unrelated stale binding')
    await h.edit([{ op: 'set', path: ['policy', 'workspaces'], value: originalWorkspaces }])
    const client = new Context()
    await client.plugin(Registry)
    client.provide('connection', { registerGenerationSource: () => () => {}, start: () => ({ stop() {} }), rpc: {
      open: () => (async function* () {})(),
      call: async (_channel: string, endpoint: string, payload: any) => {
        const [namespace, method] = endpoint.split('/')
        try { return { ok: true, value: await h.invoke({ namespace: namespace!, method: method!, args: payload.args }) } }
        catch (error: any) { return { ok: false, error: { code: 'gateway/internal', message: error.message, details: {} } } }
      },
    } } as any)
    await client.plugin(ClientGateway)
    const unmount = await client.remote.$mount(remoteContribution)
    const clientTemplates: any = await (client.remote as any).thaliris.templates(); assert.equal(clientTemplates.ok, true, JSON.stringify(clientTemplates)); assert.ok(clientTemplates.value.length)
    const clientTools: any = await (client.remote as any).thaliris.toolCatalog(); assert.equal(clientTools.ok, true)
    // R-NO-INJECT: preset-scoped Thaliris tools never appear in the global Gateway catalog.
    assert.ok(!clientTools.value.some((tool: any) => tool.name.startsWith('thaliris_')), 'the global tool catalog stays free of preset-scoped tools')
    for (const tool of clientTools.value) assert.deepEqual(Object.keys(tool).sort(), ['description', 'name'])
    const clientDiagnostics: any = await (client.remote as any).thaliris.diagnostics(h.parent.id, taskId); assert.equal(clientDiagnostics.ok, true, JSON.stringify(clientDiagnostics)); assert.equal(clientDiagnostics.value.task.state.status, 'ACTIVE')
    await unmount(); await client.fiber.dispose()
    const templates: any = await h.invoke({ namespace: 'thaliris', method: 'templates', args: {} }); assert.ok(templates.some((value: any) => value.id === 'curator'))
    const diagnostics: any = await h.invoke({ namespace: 'thaliris', method: 'diagnostics', args: { sessionId: h.parent.id, taskId } }); assert.equal(diagnostics.task.state.status, 'ACTIVE'); assert.equal(typeof diagnostics.configurationRevision, 'number')
    const taskPath = await taskStatePath(h.workspace, taskId)
    const bytes = await readFile(taskPath)
    const rev = h.view().revision
    await h.edit([{ op: 'set', path: ['policy', 'controllerPrompt'], value: 'VISIBLE_EDITED_CONTROLLER' }], rev)
    await assert.rejects(h.edit([{ op: 'set', path: ['policy', 'roles'], value: [] }], rev), /changed since/)
    assert.deepEqual(await readFile(taskPath), bytes, 'Settings edits never rewrite task intent')
    await h.edit([{ op: 'set', path: ['policy', 'roles'], value: [] }])
    assert.deepEqual((h.view().value as any).policy.roles, [])
    let task = await h.inspect(taskId)
    assert.equal((await h.execute('thaliris_workstream', { task_id: task.state.task_id, base_revision: task.state.revision, role: role.id, workstream: 'removed', handoff })).isError, true)
    const unrelatedInvalid = { ...role, id: 'disabled-fixed-role', enabled: false, modelPolicy: { mode: 'fixed', routes: [] } }
    const selectedInvalid = { ...role, id: 'invalid-fixed-role', modelPolicy: { mode: 'fixed', routes: [] } }
    await h.edit([{ op: 'set', path: ['policy', 'roles'], value: [role, unrelatedInvalid, selectedInvalid] }])
    const denied: any = await h.execute('thaliris_workstream', { task_id: task.state.task_id, base_revision: task.state.revision, role: role.id, workstream: 'denied', handoff, route: { provider: 'mock', model: 'other' } })
    assert.equal(denied.isError, true); assert.match(JSON.stringify(denied), /MODEL_ROUTE_NOT_ALLOWED/)
    const invalidRoute: any = await h.execute('thaliris_workstream', { task_id: task.state.task_id, base_revision: task.state.revision, role: selectedInvalid.id, workstream: 'invalid-selected-role', handoff })
    assert.equal(invalidRoute.isError, true); assert.match(JSON.stringify(invalidRoute), /FIXED_ROUTE_REQUIRED/)
    script.push((request: any) => { assert.ok(JSON.stringify(request).includes('EXACT_EDITED_PROMPT')); assert.ok(!JSON.stringify(request).includes('Thaliris child contract:')); return textResponse('editable role complete') })
    const routed: any = await h.execute('thaliris_workstream', { task_id: task.state.task_id, base_revision: task.state.revision, role: role.id, workstream: 'editable', handoff, route: { provider: 'mock', model: 'child' } }); assert.equal(routed.isError, false, JSON.stringify(routed))
    await h.edit([{ op: 'set', path: ['policy', 'roles'], value: [] }])
    // Empty set persists; no hidden regeneration.
    const second = (await h.ctx.agents.create({ sessionId: SessionId('second-controller'), meta: { cwd: h.secondRoot, agentPreset: FIXTURE_PRESET },
      agentOptions: { provider: 'mock', model: 'parent' }, setup: async agentCtx => { await h.ctx.agentPresets.mount(agentCtx, FIXTURE_PRESET) } })).agent
    await h.ctx.sessionPersistence.flush()
    const secondStart: any = await h.execute('thaliris_task_start', { goal: 'Isolated second workspace', contract }, second)
    assert.equal(secondStart.isError, false)
    const secondTaskId = secondStart.value.task_id
    assert.notEqual((await h.execute('thaliris_task_inspect', { task_id: secondTaskId }, second) as any).value.state.task_id, task.state.task_id)
    assert.equal((await h.execute('thaliris_task_close', { task_id: task.state.task_id, base_revision: 1, decision: 'Cross-workspace attack' }, second)).isError, true)
    // Native, independently disposable provider plugins; remote-style fixture is injected at the same seam.
    const memoryFiber = await h.ctx.plugin(Memory)
    const localFiber = await h.ctx.plugin(LocalMemory)
    let writes = 0
    const externalFiber = await h.ctx.plugin({ inject: ['thalirisMemory'], apply(ctx: Context) { (ctx as any).thalirisMemory.register(ctx, { id: 'external', name: 'External async fixture', async read(request: any) { return { text: request.key === 'unicode' ? '😀'.repeat(10) : 'external' } }, async search() { return [{ key: 'remote', text: 'external' }] }, async write() { writes++; return { stored: true } } }) } })
    await assert.rejects((h.ctx as any).thalirisMemory.invoke('external', 'read', { key: 'unicode', signal: signal(), maxBytes: 31 }), /THALIRIS_MEMORY_RESULT_BOUND_EXCEEDED/)
    await h.edit([{ op: 'set', path: ['policy', 'memory'], value: { mode: 'manual', autoAuthorized: false, providers: ['thaliris-local', 'external'], controllerRead: ['thaliris-local', 'external'], controllerWrite: ['thaliris-local', 'external'] } }])
    const manualBefore = (await h.inspect(taskId)).state.pending_results
    const manualForeign: any = await h.execute('thaliris_memory_propose', { task_id: secondTaskId, provider: 'external', key: 'foreign', text: 'must not be proposed', provenance: 'foreign workspace fixture' })
    const manualUnknown: any = await h.execute('thaliris_memory_propose', { task_id: '00000000-0000-4000-8000-000000000001', provider: 'external', key: 'unknown', text: 'must not be proposed', provenance: 'unknown task fixture' })
    assert.equal(manualForeign.isError, true)
    assert.equal(manualUnknown.isError, true)
    assert.deepEqual((await h.inspect(taskId)).state.pending_results, manualBefore)
    assert.equal(writes, 0, 'invalid manual task selections cannot trigger provider writes')
    assert.equal((await h.execute('thaliris_memory_read', { provider: 'external', key: 'x', maxBytes: 64 })).isError, false)
    assert.equal((await h.execute('thaliris_memory_read', { provider: 'forbidden', key: 'x', maxBytes: 64 })).isError, true)
    assert.equal((await h.execute('thaliris_memory_search', { provider: 'external', query: 'x', limit: 1, maxBytes: 1 })).isError, true)
    const proposed: any = await h.execute('thaliris_memory_propose', { task_id: taskId, provider: 'external', key: 'x', text: 'selected', provenance: 'user-selected fixture' }); assert.equal(proposed.isError, false); assert.equal(writes, 0)
    await assert.rejects(h.invoke({ namespace: 'thaliris', method: 'approveMemory', args: { sessionId: h.parent.id, taskId: orphanTaskId, proposalId: proposed.value.proposal_id } }), /MEMORY_PERMISSION_DENIED/)
    assert.equal(writes, 0, 'a proposal from one task cannot be approved through another task ID')
    await h.invoke({ namespace: 'thaliris', method: 'approveMemory', args: { sessionId: h.parent.id, taskId, proposalId: proposed.value.proposal_id } }); assert.equal(writes, 1)
    const approvedState = (await h.inspect(taskId)).state
    assert.ok(!approvedState.pending_results.some((value: string) => value.includes(proposed.value.proposal_id)), 'approval consumes the pending proposal')
    assert.ok(approvedState.records.some((item: any) => item.kind === 'dsh-memory-approval' && item.producer === 'dsh:adapter' && JSON.parse(item.text).receipt.proposal_id === proposed.value.proposal_id), 'approval receipt is an adapter record')
    await assert.rejects(h.invoke({ namespace: 'thaliris', method: 'approveMemory', args: { sessionId: h.parent.id, taskId, proposalId: proposed.value.proposal_id } }), /MEMORY_PERMISSION_DENIED/)
    assert.equal(writes, 1, 'a consumed proposal cannot be approved twice')
    await h.edit([{ op: 'set', path: ['policy', 'memory', 'mode'], value: 'suggest-review' }])
    const suggestion: any = await h.execute('thaliris_memory_propose', { task_id: taskId, provider: 'thaliris-local', key: 'local', text: 'stored after review', provenance: 'fixture' }); assert.equal(suggestion.isError, false)
    await (h.ctx as any).thaliris.approveMemory(h.parent.id, taskId, suggestion.value.proposal_id, signal())
    assert.equal((await h.execute('thaliris_memory_read', { provider: 'thaliris-local', key: 'local', maxBytes: 512 }) as any).value.value.text, 'stored after review')
    // Auto remains refused at execution until both persisted user policy fields opt in.
    await h.edit([{ op: 'set', path: ['policy', 'memory', 'mode'], value: 'auto' }])
    assert.equal((await h.execute('thaliris_memory_propose', { task_id: taskId, provider: 'external', key: 'x', text: 'no consent', provenance: 'fixture' })).isError, true)
    await h.edit([{ op: 'set', path: ['policy', 'memory', 'autoAuthorized'], value: true }])
    const autoBefore = (await h.inspect(taskId)).state.pending_results
    const autoForeign: any = await h.execute('thaliris_memory_propose', { task_id: secondTaskId, provider: 'external', key: 'foreign', text: 'must not be written', provenance: 'foreign workspace fixture' })
    const autoUnknown: any = await h.execute('thaliris_memory_propose', { task_id: '00000000-0000-4000-8000-000000000001', provider: 'external', key: 'unknown', text: 'must not be written', provenance: 'unknown task fixture' })
    assert.equal(autoForeign.isError, true)
    assert.equal(autoUnknown.isError, true)
    assert.deepEqual((await h.inspect(taskId)).state.pending_results, autoBefore)
    assert.equal(writes, 1, 'invalid auto task selections cannot trigger provider writes')
    assert.equal((await h.execute('thaliris_memory_propose', { task_id: taskId, provider: 'external', key: 'x', text: 'consented', provenance: 'fixture' })).isError, false); assert.equal(writes, 2)
    await h.edit([{ op: 'set', path: ['policy', 'memory', 'mode'], value: 'suggest-review' },
      { op: 'set', path: ['policy', 'roles'], value: [{ ...role, tools: [...Plugin.MEMORY_TOOLS], memory: { read: ['external'], write: [] }, context: { handoff: true, memory: true } }] }])
    script.push((options: any) => { assert.match(JSON.stringify(options.messages), /memory_context/); return toolCallResponse('read', 'thaliris_memory_read', { provider: 'external', key: 'x', maxBytes: 64 }) },
      toolCallResponse('denied-write', 'thaliris_memory_propose', { task_id: taskId, provider: 'external', key: 'x', text: 'denied', provenance: 'fixture' }),
      (options: any) => { assert.match(JSON.stringify(options.messages), /MEMORY_PERMISSION_DENIED/); return textResponse('child permission fixture') })
    task = await h.inspect(taskId)
    const childMemory: any = await h.execute('thaliris_workstream', { task_id: task.state.task_id, base_revision: task.state.revision, role: role.id, workstream: 'memory-grants', handoff, memoryContext: [{ provider: 'external', operation: 'read', key: 'x', maxBytes: 64 }], route: { provider: 'mock', model: 'child' } })
    assert.equal(childMemory.isError, false, JSON.stringify(childMemory))
    await h.edit([{ op: 'set', path: ['policy', 'roles', '0', 'memory', 'write'], value: ['external'] }])
    await h.edit([{ op: 'set', path: ['policy', 'memory', 'mode'], value: 'auto' },
      { op: 'set', path: ['policy', 'memory', 'autoAuthorized'], value: true }])
    script.push(toolCallResponse('foreign-task-write', 'thaliris_memory_propose', { task_id: secondTaskId, provider: 'external', key: 'foreign', text: 'child cannot write another task', provenance: 'foreign child task fixture' }),
      (options: any) => { assert.match(JSON.stringify(options.messages), /THALIRIS_TASK_ID_CONFLICT/); return textResponse('foreign Task ID rejected') })
    task = await h.inspect(taskId)
    const foreignGrant: any = await h.execute('thaliris_workstream', { task_id: task.state.task_id, base_revision: task.state.revision, role: role.id, workstream: 'foreign-memory-task', handoff, route: { provider: 'mock', model: 'child' } })
    assert.equal(foreignGrant.isError, false, JSON.stringify(foreignGrant))
    assert.equal(writes, 2, 'a child grant cannot write to another task, even with auto mode authorized')
    await h.edit([{ op: 'set', path: ['policy', 'memory', 'mode'], value: 'suggest-review' }])
    script.push(toolCallResponse('suggest', 'thaliris_memory_propose', { task_id: taskId, provider: 'external', key: 'x', text: 'child suggestion', provenance: 'selected child' }),
      (options: any) => { assert.match(JSON.stringify(options.messages), /proposal_id/); return textResponse('suggestion proposed') })
    task = await h.inspect(taskId)
    const childProposal: any = await h.execute('thaliris_workstream', { task_id: task.state.task_id, base_revision: task.state.revision, role: role.id, workstream: 'memory-proposal', handoff, route: { provider: 'mock', model: 'child' } })
    assert.equal(childProposal.isError, false, JSON.stringify(childProposal))
    assert.equal(writes, 2, 'Curator/child proposal cannot enable automatic writes')
    await h.edit([{ op: 'set', path: ['policy', 'roles'], value: [] }])
    await localFiber.dispose(); assert.equal((h.ctx as any).thaliris.providers().length, 1)
    await externalFiber.dispose(); await memoryFiber.dispose()
    assert.equal((h.ctx as any).thaliris.providers().length, 0)
    await h.edit([{ op: 'set', path: ['policy', 'roles'], value: [role] }])
    task = await h.inspect(taskId); script.push(textResponse('routing after memory uninstall'))
    assert.equal((await h.execute('thaliris_workstream', { task_id: task.state.task_id, base_revision: task.state.revision, role: role.id, workstream: 'no-memory', handoff, route: { provider: 'mock', model: 'child' } })).isError, false)
    await h.edit([{ op: 'set', path: ['policy', 'roles'], value: [] }])
    await h.edit([{ op: 'set', path: ['policy', 'memory', 'mode'], value: 'disabled' }])
    assert.equal((await h.execute('thaliris_memory_read', { provider: 'external', key: 'x', maxBytes: 64 })).isError, true)
    assert.equal((await h.execute('thaliris_task_close', { task_id: secondTaskId, base_revision: 1, decision: 'Native task closes with memory absent' }, second)).isError, false)
    // Crash window: Core has reservation, native catalog has exact child, bind/finish never ran.
    task = await h.inspect(taskId)
    const reservation = { workstream: 'crash-window', role: 'fixture', handoff_sha256: 'fixture-digest', correlation: 'thaliris:unique-crash-window' }
    const workspaceId = (await h.ctx.workspaceRegistry.resolveByPath(h.workspace))!.id
    const begun = bridge(home, 'begin', { workspaceId, args: { task_id: task.state.task_id, base_revision: task.state.revision, observation: JSON.stringify(reservation) } }); assert.equal(begun.ok, true)
    script.push(textResponse('native completed before bridge acknowledgement'))
    const run = await h.ctx.subagents.startActivation({ provider: 'spawn', label: reservation.correlation, signal: signal(), delivery: 'caller', request: { parent: h.parent, prompt: [{ type: 'text', text: 'Selected crash fixture' }], maxDepth: 1 } })
    assert.equal((await run.result).stopReason, 'completed')
    await h.ctx.sessionPersistence.flush(); await run.dispose()
    const check: any = await h.execute('thaliris_reconcile', { task_id: task.state.task_id, base_revision: begun.result.revision, action: 'check' }); assert.equal(check.value.outcome, 'completed'); assert.equal(check.value.released, false)
    console.log('PASS native Settings revision/prompt/deletion/model grants; multiple workspaces; optional local/external providers manual/review/auto opt-in/removal; catalog crash fixture')
  } finally { await h.ctx.fiber.dispose() }
}
async function restart(home: string) {
  const taskId = (await readFile(join(home, 'task-id'), 'utf8')).trim()
  const unloaded = await harness(home, false, false)
  try {
    assert.equal(unloaded.ctx.agents.get(SessionId('persistent-controller')), undefined, 'fixture begins with no live Agent for the persisted root Session')
    const diagnostics: any = await unloaded.invoke({ namespace: 'thaliris', method: 'diagnostics', args: { sessionId: 'persistent-controller', taskId } })
    assert.equal(diagnostics.task.state.status, 'ACTIVE', 'native diagnostics resumes the exact persisted root Agent and reads the explicitly selected Core task')
    assert.equal(diagnostics.workspace.workspaceId, (await unloaded.ctx.workspaceRegistry.resolveByPath(unloaded.workspace))!.id)
    assert.equal(unloaded.ctx.agents.get(SessionId('persistent-controller')), undefined, 'one-shot diagnostics disposes only the Agent handle it resumed')
    console.log('PASS Gateway diagnostics resumes and validates a persisted configured root Session, then disposes its owned Agent handle')
  } finally { await unloaded.ctx.fiber.dispose() }
  const h = await harness(home, false)
  try {
    // Before any Thaliris tool call, the resumed root's dynamic context is
    // restored from the Core task anchored to this exact native root, and the
    // very first assembly (the first model step) already carries it.
    const restored = (await h.ctx.systemPrompt.assemble(assembleContextFor(h.parent!, signal()))).contexts.find(item => item.name === 'thaliris:task-context')?.text ?? ''
    assert.match(restored, new RegExp(`Thaliris task ${taskId} context`), 'the first assembly after restart carries the bounded Controller task context')
    assert.match(restored, /Dispatch history: \d+ finished dispatch\(es\) archived as dsh-dispatch records/, 'dispatch history is summarized from records')
    const rivalContext = await h.ctx.agentLoop.create(SessionId('context-rival'), { provider: 'mock', model: 'parent' }, { cwd: h.workspace })
    await h.ctx.systemPrompt.assemble(assembleContextFor(rivalContext, signal()))
    await new Promise(resolve => setTimeout(resolve, 1500))
    assert.doesNotMatch((await h.ctx.systemPrompt.assemble(assembleContextFor(rivalContext, signal()))).contexts.map(item => item.text).join('\n'), new RegExp(taskId), 'another root does not receive this task context')
    assert.deepEqual((h.view().value as any).policy.roles, [], 'deleted roles stay deleted after fresh process')
    assert.equal((h.view().value as any).policy.controllerPrompt, 'VISIBLE_EDITED_CONTROLLER')
    const task = await h.inspect(taskId)
    assert.equal(task.state.active_work.length, 1)
    const rival = await h.ctx.agentLoop.create(SessionId('unrelated-root'), { provider: 'mock', model: 'parent' }, { cwd: h.workspace }); await h.ctx.sessionPersistence.flush()
    assert.equal((await h.execute('thaliris_task_inspect', { task_id: taskId }, rival)).isError, true)
    await h.edit([{ op: 'set', path: ['policy', 'roles'], value: [
      { ...role, id: 'disabled-fixed-role', enabled: false, modelPolicy: { mode: 'fixed', routes: [] } },
    ] }])
    const lifecycle = await h.inspect(taskId)
    assert.equal(lifecycle.state.active_work.length, 1, 'disabled invalid role does not block lifecycle inspection')
    const reconciled: any = await h.execute('thaliris_reconcile', { task_id: lifecycle.state.task_id, base_revision: lifecycle.state.revision, action: 'reconcile' })
    assert.equal(reconciled.isError, false, JSON.stringify(reconciled)); assert.equal(reconciled.value.native_completed, true)
    const state = (await h.inspect(taskId)).state
    assert.equal(state.active_work.length, 0)
    assert.ok(!state.pending_results.some((value: string) => value.includes('Archived reservation:')), 'no dispatch history in routing state')
    const archived = state.records.filter((item: any) => item.kind === 'dsh-dispatch' && item.producer === 'dsh:adapter').map((item: any) => JSON.parse(item.text))
    assert.ok(archived.some((item: any) => item.operation === 'reconcile' && item.reservation.correlation === 'thaliris:unique-crash-window' && item.result.outcome === 'completed'), 'reconciled reservation is archived as a dispatch record')
    assert.equal((await h.execute('thaliris_task_close', { task_id: state.task_id, base_revision: state.revision, decision: 'Controller accepted native evidence after restart with memory removed' })).isError, false)
    console.log('PASS fresh process/runtime persisted native Workspace + same Session/new Agent Core continuation; rival denial; durable completed reconciliation; close without memory')
  } finally { await h.ctx.fiber.dispose() }
}
async function setupReady(home: string) {
  const h = await harness(home, true, true, { createParent: false })
  try {
    const service: any = (h.ctx as any).thaliris
    // Status is available before any bridge call: derived from the configured paths, then
    // verified by the explicit human action.
    const initial: any = service.setupStatus()
    assert.equal(initial.state, 'ready', JSON.stringify(initial))
    assert.equal(initial.verified, false, 'a fresh process derives readiness without a probe')
    assert.equal(initial.manual_override, true)
    assert.ok(initial.runtime && typeof initial.runtime.pythonExecutable === 'string')
    // The three path fields are live-editable (volatile) manual overrides in native Settings.
    const descriptor: any = h.view()
    assert.equal(descriptor.applies, 'live')
    const schemaText = JSON.stringify(descriptor.schema)
    for (const key of ['pythonExecutable', 'corePath', 'authorityDirectory']) assert.ok(schemaText.includes(key), `${key} is an editable volatile settings field`)
    const first: any = await service.prepareRuntime(signal())
    assert.equal(first.ok, true, JSON.stringify(first))
    assert.equal(first.state, 'ready'); assert.equal(first.provisioned, false); assert.equal(first.verified, true)
    const started = Date.now()
    const second: any = await service.prepareRuntime(signal())
    const elapsed = Date.now() - started
    assert.equal(second.ok, true, JSON.stringify(second))
    assert.equal(second.already, true); assert.equal(second.provisioned, false)
    assert.ok(elapsed < 2000, `idempotent setup re-run must be fast (${elapsed}ms)`)
    const rechecked: any = await service.recheckRuntime(signal())
    assert.equal(rechecked.state, 'ready'); assert.equal(rechecked.verified, true); assert.equal(rechecked.code, null)
    // Human Gateway methods return tolerant JSON; the model tool surface never gains them.
    const gateway: any = await h.invoke({ namespace: 'thaliris', method: 'setupStatus', args: {} })
    assert.equal(gateway.state, 'ready')
    const gatewayPrepared: any = await h.invoke({ namespace: 'thaliris', method: 'prepareRuntime', args: {} })
    assert.equal(gatewayPrepared.ok, true)
    const gatewayRechecked: any = await h.invoke({ namespace: 'thaliris', method: 'recheckRuntime', args: {} })
    assert.equal(gatewayRechecked.state, 'ready')
    for (const name of ['setupStatus', 'prepareRuntime', 'recheckRuntime']) assert.equal(h.ctx.tools.get(name), undefined, `${name} is not a model tool`)
    console.log('PASS setupStatus/prepareRuntime/recheckRuntime report and verify an already-configured runtime; idle re-run is idempotent; setup stays off the model tool surface')
  } finally { await h.ctx.fiber.dispose() }
}
async function setupAutoBind(home: string) {
  const h = await harness(home, true, true, { workspaces: 'empty' })
  try {
    const service: any = (h.ctx as any).thaliris
    const workspace = (await h.ctx.workspaceRegistry.resolveByPath(h.workspace))!
    assert.deepEqual((h.view().value as any).policy.workspaces, [], 'the fixture starts with no Workspace binding')
    // An unselected native root is never bound, even when the list is empty.
    const unselected = await h.ctx.agentLoop.create(SessionId('unselected-root'), { provider: 'mock', model: 'parent' }, { cwd: h.secondRoot })
    await h.ctx.sessionPersistence.flush()
    await assert.rejects(service.binding(unselected, { autoBind: true }), /THALIRIS_WORKSPACE_NOT_CONFIGURED/)
    assert.deepEqual((h.view().value as any).policy.workspaces, [], 'no binding is written for an unselected session')
    // A Thaliris-selected root: the first tool call persists one enabled binding through
    // the native profile editor and reports it in setupStatus.
    const started: any = await h.execute('thaliris_task_start', { goal: 'First-run auto-bound workspace', contract })
    assert.equal(started.isError, false, JSON.stringify(started))
    const workspaces = (h.view().value as any).policy.workspaces
    assert.equal(workspaces.length, 1, JSON.stringify(workspaces))
    assert.equal(workspaces[0].workspaceId, workspace.id)
    assert.equal(workspaces[0].enabled, true)
    assert.equal(workspaces[0].root, h.workspace)
    const reported: any = service.setupStatus().workspaceAutoBind
    assert.ok(reported && reported.workspaceId === workspace.id, JSON.stringify(reported))
    // A non-empty list keeps requiring an explicit binding for a second Workspace.
    const second = (await h.ctx.agents.create({ sessionId: SessionId('second-controller'), meta: { cwd: h.secondRoot, agentPreset: FIXTURE_PRESET },
      agentOptions: { provider: 'mock', model: 'parent' }, setup: async agentCtx => { await h.ctx.agentPresets.mount(agentCtx, FIXTURE_PRESET) } })).agent
    await h.ctx.sessionPersistence.flush()
    const blocked: any = await h.execute('thaliris_task_start', { goal: 'Unbound second workspace', contract }, second)
    assert.equal(blocked.isError, true)
    assert.match(JSON.stringify(blocked), /THALIRIS_WORKSPACE_NOT_CONFIGURED/)
    assert.equal((h.view().value as any).policy.workspaces.length, 1, 'a non-empty list is never appended to')
    console.log('PASS first-run Workspace auto-binding persists once for a Thaliris-selected root, reports it, and never binds unselected sessions or a non-empty list')
  } finally { await h.ctx.fiber.dispose() }
}
async function setupFailure(home: string) {
  const h = await harness(home, true, true, { runtime: 'missing' })
  try {
    const service: any = (h.ctx as any).thaliris
    // The plugin loaded with unusable explicit paths; nothing failed at activation.
    assert.ok(h.ctx.get('thaliris'), 'the plugin loads with unusable runtime paths')
    const status: any = service.setupStatus()
    assert.equal(status.state, 'unconfigured')
    assert.equal(status.code, 'THALIRIS_RUNTIME_NOT_READY')
    assert.equal(status.verified, false)
    const prepared: any = await service.prepareRuntime(signal())
    assert.equal(prepared.ok, false)
    assert.ok(['THALIRIS_CORE_VERIFY_FAILED', 'THALIRIS_PYTHON_NOT_FOUND', 'THALIRIS_RUNTIME_NOT_READY'].includes(prepared.code), prepared.code)
    assert.ok(typeof prepared.recovery === 'string' && prepared.recovery.length > 0)
    assert.ok(!String(prepared.detail ?? '').includes('missing-python'), 'failure detail is redacted')
    // A Thaliris tool call fails closed with the actionable code; the plugin stays loaded.
    const called: any = await h.execute('thaliris_task_start', { goal: 'Unusable runtime fixture', contract })
    assert.equal(called.isError, true)
    assert.match(JSON.stringify(called), /THALIRIS_CORE_VERIFY_FAILED|THALIRIS_RUNTIME_NOT_READY|THALIRIS_NOT_CONFIGURED/)
    assert.ok(h.ctx.get('thaliris'), 'the plugin remains loaded after a failed setup')
    console.log('PASS unusable runtime paths produce an actionable setup code and recovery text, and tool calls fail closed without unloading the plugin')
  } finally { await h.ctx.fiber.dispose() }
}
async function setupCold(home: string) {
  const h = await harness(home, true, true, { runtime: 'auto' })
  try {
    const service: any = (h.ctx as any).thaliris
    const before: any = service.setupStatus()
    assert.equal(before.state, 'unconfigured', JSON.stringify(before))
    assert.equal(before.code, 'THALIRIS_NOT_CONFIGURED')
    assert.equal(before.manual_override, false)
    const started = Date.now()
    const cold: any = await service.prepareRuntime(signal())
    const coldMs = Date.now() - started
    assert.equal(cold.ok, true, JSON.stringify(cold))
    assert.equal(cold.provisioned, true)
    assert.equal(cold.state, 'ready'); assert.equal(cold.verified, true)
    assert.equal(cold.runtime.version, '0.5.2')
    assert.match(String(cold.runtime.pythonExecutable), /runtime-0\.5\.2-py3\.\d+[\\/](?:Scripts[\\/]python\.exe|bin[\\/]python)$/i)
    assert.match(String(cold.runtime.corePath), /site-packages$/)
    const manifest = JSON.parse(await readFile(join(home, 'authority', 'runtime.json'), 'utf8'))
    assert.equal(manifest.core.version, '0.5.2')
    assert.equal(manifest.core.state_schema_version, 7)
    assert.equal(manifest.core.source.sha256, coreLock.source.sha256)
    assert.equal(manifest.core.source.package_tree_sha256, coreLock.package_tree_sha256)
    // No pip or global build tooling was installed into the runtime.
    const scripts = dirname(cold.runtime.pythonExecutable)
    assert.equal(existsSync(join(scripts, 'pip.exe')), false, 'the venv has no pip')
    assert.equal(existsSync(join(cold.runtime.corePath, 'pip')), false, 'the runtime has no pip package')
    // The bridge now runs through the provisioned interpreter and Core path.
    const task: any = await h.execute('thaliris_task_start', { goal: 'Cold-provisioned runtime fixture', contract })
    assert.equal(task.isError, false, JSON.stringify(task))
    const warmStarted = Date.now()
    const again: any = await service.prepareRuntime(signal())
    const warmMs = Date.now() - warmStarted
    assert.equal(again.ok, true); assert.equal(again.already, true); assert.equal(again.provisioned, false)
    assert.ok(warmMs < 2000, `idempotent re-run after cold provisioning must be fast (${warmMs}ms)`)
    const status: any = service.setupStatus()
    assert.equal(status.state, 'ready'); assert.equal(status.verified, true)
    console.log(`PASS cold provisioning from the shipped Python (${coldMs} ms; no pip/global tools), runtime.json correct, bridge usable, re-run idempotent (${warmMs} ms)`)
  } finally { await h.ctx.fiber.dispose() }
}
const phase = process.argv[2], home = process.argv[3]
if (phase === 'init') await initialize(home!)
else if (phase === 'restart') await restart(home!)
else if (phase === 'setup') await setupReady(home!)
else if (phase === 'autobind') await setupAutoBind(home!)
else if (phase === 'failure') await setupFailure(home!)
else if (phase === 'cold') await setupCold(home!)
else {
  const directory = await mkdtemp(join(tmpdir(), 'thaliris-product-'))
  try {
    const stages = ['init', 'restart', 'setup', 'autobind', 'failure']
    if (process.env.THALIRIS_TEST_COLD_PROVISION === '1') stages.push('cold')
    for (const stage of stages) {
      const stageHome = stage === 'init' || stage === 'restart' ? directory : join(directory, stage)
      if (stageHome !== directory) await mkdir(stageHome, { recursive: true })
      const env = stage === 'cold' ? { ...process.env, THALIRIS_PYTHON: process.env.THALIRIS_TEST_PYTHON } : process.env
      const child = spawnSync(process.execPath, [...process.execArgv, fileURLToPath(import.meta.url), stage, stageHome], { stdio: 'inherit', env, timeout: 240000 })
      assert.equal(child.status, 0, `${stage}: ${child.error ?? ''}`)
    }
  } finally { await rm(directory, { recursive: true, force: true }) }
}
