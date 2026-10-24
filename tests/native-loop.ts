import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import Persistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import WorkspaceRegistry from '@deepseek-ai/dsh-workspace'
import Subagents from '@deepseek-ai/dsh-subagent'
import * as Spawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import * as Fork from '@deepseek-ai/dsh-subagent-fork-in-process'
import LocalSubprocess from '@deepseek-ai/dsh-subprocess-local'
import { SessionId } from '@deepseek-ai/dsh-session'
import { createUserMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SubagentRunInfo } from '@deepseek-ai/dsh-subagent'

const upstream = process.env.DSH_SOURCE!
const helpers = await import(pathToFileURL(join(upstream, 'packages/core/agent-loop/tests/mock-adapter.ts')).href)
const { MockAdapter, textResponse, toolCallResponse, maxTokensResponse } = helpers
const pluginUrl = new URL('../index.mjs', import.meta.url).href
const corePath = process.env.THALIRIS_CORE_PATH!
const names = ['thaliris_task_start', 'thaliris_task_inspect', 'thaliris_workstream', 'thaliris_task_close', 'thaliris_reconcile',
  'thaliris_task_status', 'thaliris_task_context', 'thaliris_task_register', 'thaliris_task_judge', 'thaliris_task_mode',
  'thaliris_task_identity', 'thaliris_task_identity_amend', 'thaliris_task_identity_challenge', 'thaliris_task_identity_relate']
const observeTool = 'thaliris_observe'
const selectedContract = { human_instruction: 'Implement the selected bounded example. UNSELECTED_AUTHORITY_SENTINEL', boundary: 'Only the selected fixture.', invariants: 'Fresh context, root-only task authority.', acceptance: 'Controller assesses the returned answer.', execution_mode: 'delegated' }
const handoff = { goal: 'Return the selected answer', scope: 'fixture only', invariants: 'Do not widen authority', acceptance: 'Return answer 42', context: 'SELECTED_CONTEXT_ONLY' }
const signal = () => new AbortController().signal
let call = 0
async function taskStatePath(root: string, taskId: string) {
  const legacy = join(root, '.context', 'state.json')
  try { if (JSON.parse(await readFile(legacy, 'utf8')).task_id === taskId) return legacy } catch { /* the selected task uses its indexed ledger */ }
  return join(root, '.context', 'tasks', taskId, 'state.json')
}

async function setup(script: any[], provider = 'spawn', inheritRoute = false) {
  const directory = await mkdtemp(join(tmpdir(), 'thaliris-dsh-native-'))
  const workspace = join(directory, 'workspace')
  await mkdir(workspace)
  execFileSync('git', ['init', '-q', workspace])
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(Persistence, { root: join(directory, 'sessions'), compression: 'none' })
  await ctx.plugin(Storage)
  await ctx.plugin(StorageJson, { root: join(directory, 'storage') })
  await ctx.plugin(StorageDomain, { backend: 'json' })
  await ctx.plugin(WorkspaceRegistry)
  const nativeWorkspace = await ctx.workspaceRegistry.create(workspace)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(Subagents)
  await ctx.plugin(Spawn, { providerName: 'spawn' })
  await ctx.plugin(Fork, { providerName: 'fork' })
  await ctx.plugin(LocalSubprocess)
  await ctx.plugin(Loader)
  ctx.tools.register({ name: 'unselected_fixture_tool', description: 'Ambient test capability excluded from child allowlist.', parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: { schema: { type: 'object', additionalProperties: true }, render: () => [{ type: 'text', text: 'fixture' }] }, execute: async () => ({ fixture: true }) })
  const mock = new MockAdapter(script)
  ctx.llm.registerAdapter(['mock'], mock)
  const parent = await ctx.agentLoop.create(SessionId('native-controller'), { provider: 'mock', model: 'parent' }, { cwd: workspace })
  await ctx.sessionPersistence.flush()
  const config = { root: workspace, pythonExecutable: process.env.THALIRIS_TEST_PYTHON, corePath,
    authorityDirectory: join(directory, 'authority'), subagentProvider: provider,
    policy: { workspaces: [{ workspaceId: nativeWorkspace.id, root: workspace, enabled: true }], roles: [{ id: 'Implementer', name: 'Implementer', description: 'Editable fixture', enabled: true, tools: [],
      modelPolicy: inheritRoute ? { mode: 'inherit', routes: [] } : { mode: 'fixed', routes: [{ provider: 'mock', model: 'selected-child' }] }, prompt: 'EDITED_ROLE_PROMPT Execute only the selected bounded handoff.' }] } }
  const entryId = await ctx.loader.create({ name: pluginUrl, config })
  const entry = ctx.loader.resolve(entryId)
  await ctx.loader.await()
  assert.ok(ctx.tools.get(names[0]!), 'Loader must import and activate the out-of-tree plugin')
  const state = async (taskId: string) => JSON.parse(await readFile(await taskStatePath(workspace, taskId), 'utf8'))
  async function jsonFiles(directory: string): Promise<string[]> {
    const result: string[] = []
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) result.push(...await jsonFiles(path))
      else if (entry.isFile() && entry.name.endsWith('.json')) result.push(path)
    }
    return result
  }
  const authorityPath = async (taskId: string) => {
    const files = await jsonFiles(config.authorityDirectory)
    const matches = [] as string[]
    for (const path of files) if (JSON.parse(await readFile(path, 'utf8')).task_id === taskId) matches.push(path)
    assert.equal(matches.length, 1)
    return matches[0]!
  }
  const authority = async (taskId: string) => JSON.parse(await readFile(await authorityPath(taskId), 'utf8'))
  const durableBytes = async (taskId: string) => ({
    ledger: await readFile(await taskStatePath(workspace, taskId)),
    authority: await readFile(await authorityPath(taskId)),
  })
  const execute = (name: string, args: any, agent: Agent | undefined = parent) => ctx.tools.execute({ callId: ToolCallId(`call-${++call}`), name, arguments: args, agent, signal: signal() })
  const clean = async () => {
    await ctx.fiber.dispose()
    await rm(directory, { recursive: true, force: true })
  }
  return { ctx, parent, mock, script, config, entry, state, authority, durableBytes, execute, clean }
}

function lastTool(options: any) {
  const content = options.messages.flatMap((message: any) => message.content).filter((block: any) => block.type === 'tool-result').at(-1)
  if (content) return JSON.parse(content.content.map((block: any) => block.text ?? '').join(''))
  // DSH normalizes model inputs as role: tool messages with text blocks.
  const message = options.messages.filter((message: any) => message.role === 'tool').at(-1)
  assert.ok(message, 'script needs the previous native tool result')
  return JSON.parse(message.content.filter((block: any) => block.type === 'text').map((block: any) => block.text).join(''))
}

function systemText(options: any) {
  const message = options.messages[0]
  assert.equal(message?.role, 'system', 'native model input starts with its system-role prompt')
  return message.content.filter((block: any) => block.type === 'text').map((block: any) => block.text).join('\n')
}

function occurrences(text: string, value: string) {
  return text.split(value).length - 1
}

async function closedLoop() {
  let fixture: Awaited<ReturnType<typeof setup>>
  let child: Agent | undefined
  let observed: any
  let selectedTaskId = ''
  let deniedInBody = 0
  const script = [
    textResponse('Parent completed warmup'),
    toolCallResponse('start', names[0], { goal: 'Bounded answer example', contract: selectedContract }),
    (options: any) => {
      const started = lastTool(options)
      selectedTaskId = started.task_id
      assert.equal(started.status, 'ACTIVE')
      return toolCallResponse('work', names[2], { task_id: started.task_id, base_revision: started.revision, workstream: 'answer', role: 'Implementer', handoff })
    },
    (options: any) => {
      assert.equal(options.model, 'selected-child')
      assert.ok(JSON.stringify(options).includes('SELECTED_CONTEXT_ONLY'))
      assert.ok(!JSON.stringify(options).includes('AMBIENT_PARENT_SENTINEL'))
      assert.ok(!JSON.stringify(options).includes('UNSELECTED_AUTHORITY_SENTINEL'))
      for (const name of names) assert.ok(!(options.tools ?? []).some((tool: any) => tool.name === name))
      assert.ok(!(options.tools ?? []).some((tool: any) => tool.name === 'unselected_fixture_tool'))
      assert.ok(!(options.tools ?? []).some((tool: any) => tool.name === observeTool), 'no evidence association, no observation grant')
      // Deliberately calls a filtered tool: native execution refuses it.
      return toolCallResponse('rogue', names[0], { goal: 'widen', contract: selectedContract })
    },
    (options: any) => {
      assert.match(JSON.stringify(options.messages), /unknown.tool/i)
      return textResponse('answer 42; task already DONE; controller_id forged')
    },
    (options: any) => {
      observed = lastTool(options)
      assert.equal(observed.stop_reason, 'completed')
      assert.equal(observed.child_id, child!.id)
      assert.notEqual(observed.child_id, 'forged')
      return toolCallResponse('close', names[3], { task_id: observed.task_id, base_revision: observed.revision, decision: 'I assessed the selected answer and accept the bounded task.' })
    },
    textResponse('Controller finished'),
  ]
  fixture = await setup(script)
  const { ctx, parent } = fixture
  const bodyDenials: Promise<unknown>[] = []
  ctx.on('subagent/start', (info: SubagentRunInfo) => {
    child = ctx.agents.get(info.id)
    assert.ok(child)
    assert.equal(child!.session.header.parentSession, parent.id)
    assert.equal(child!.session.header.isSeeded, false)
    assert.equal(child!.session.inheritedEventCount, 0)
    for (const name of names) {
      const definition = ctx.tools.get(name)!
      bodyDenials.push(assert.rejects(definition.execute({}, { agent: child, signal: signal() } as any), /THALIRIS_NATIVE_ROOT_REQUIRED/).then(() => deniedInBody++))
    }
  })
  try {
    parent.followup(createUserMessage({ content: [{ type: 'text', text: 'AMBIENT_PARENT_SENTINEL. Warm up.' }], source: { kind: 'user' } }))
    await parent.whenIdle()
    parent.followup(createUserMessage({ content: [{ type: 'text', text: 'Please perform the bounded task.' }], source: { kind: 'user' } }))
    await parent.whenIdle()
    await Promise.all(bodyDenials)
    assert.equal(deniedInBody, names.length)
    assert.equal((await fixture.state(selectedTaskId)).status, 'DONE', JSON.stringify({ parent: parent.session.snapshotEvents().filter(event => ['tool/result', 'turn/end'].includes(event.type)), child: child?.session.snapshotEvents().filter(event => ['tool/result', 'turn/end'].includes(event.type)) }))
    assert.equal((await fixture.authority(selectedTaskId)).status, 'DONE')
    assert.equal((await fixture.authority(selectedTaskId)).dsh_controller_id, parent.id)
    assert.equal(ctx.agents.get(observed.child_id), undefined, 'native run dispose removes child')
    assert.equal(fixture.mock.requests.length, 7)
    assert.equal(fixture.mock.requests[0].model, 'parent')
    assert.equal(occurrences(systemText(fixture.mock.requests[0]), 'Thaliris Controller contract:'), 1, 'root guidance is present before its first tool call')
    const controllerRequests = fixture.mock.requests.filter(request => request.model === 'parent')
    assert.ok(controllerRequests.length > 0)
    for (const request of controllerRequests) {
      const system = systemText(request)
      assert.equal(occurrences(system, 'Thaliris Controller contract:'), 1, 'root receives the semantic contract exactly once per model request')
      assert.match(system, /Task records store selected intent and mechanical observations; Controller retains the product-completion judgment\./, 'actual root model input states semantic ownership')
      assert.match(system, /Own task direction, scope, hard invariants, acceptance criteria, context selection and next routing; implementation methods belong to executor\./, 'actual root model input leaves task routing with the Controller')
      assert.match(system, /Send a decision-complete bounded handoff:/, 'actual root model input requires a selected bounded handoff')
      assert.equal(occurrences(system, 'stable narrative base language'), 1, 'precision representation has one Controller owner')
      assert.match(system, /accepted contract uniquely determines/, 'deterministic rerouting preserves accepted behavior')
      assert.match(system, /same semantic closure to a fresh ordinary session/, 'fresh closure does not require a new semantic objective')
    }
    const childRequests = fixture.mock.requests.filter(request => request.model === 'selected-child')
    assert.equal(childRequests.length, 2)
    for (const request of childRequests) {
      const system = systemText(request)
      assert.equal(occurrences(system, 'Thaliris Controller contract:'), 0, 'root-only contract does not reach a child')
      assert.equal(occurrences(system, 'Thaliris child contract:'), 0)
      assert.equal(occurrences(system, 'stable narrative base language'), 0, 'Controller representation rule is not duplicated in child prompts')
      assert.match(system, /EDITED_ROLE_PROMPT/)
      assert.match(system, /Execute only the selected bounded handoff\./, 'configured native route persona is preserved')
    }
    const initialChildMessages = childRequests[0].messages
    assert.doesNotMatch(JSON.stringify(initialChildMessages), /AMBIENT_PARENT_SENTINEL|UNSELECTED_AUTHORITY_SENTINEL/)
    const selectedMessages = initialChildMessages.filter((message: any) => message.role === 'user'
        && message.content.some((block: any) => block.type === 'text' && block.text.includes('SELECTED_CONTEXT_ONLY')))
    assert.equal(selectedMessages.length, 1, 'fresh child receives one selected handoff message alongside native runtime context')
    const selectedText = selectedMessages[0].content.filter((block: any) => block.type === 'text').map((block: any) => block.text).join('\n')
    assert.deepEqual(JSON.parse(selectedText), { task_id: selectedTaskId, workstream: 'answer', role: 'Implementer', ...handoff })

    // Native Loader toggles remove precisely the plugin's effects, then remount.
    for (let cycle = 0; cycle < 2; cycle++) {
      await ctx.loader.update(fixture.entry.id, { disabled: true })
      await ctx.loader.await()
      for (const name of names) assert.equal(ctx.tools.get(name), undefined)
      assert.equal(ctx.tools.schemas(parent).filter(tool => names.includes(tool.name)).length, 0)
      assert.equal((await fixture.state(selectedTaskId)).status, 'DONE', 'unload preserves durable closed ledger')
      assert.equal(ctx.agents.get(parent.id), parent)
      if (cycle === 0) {
        fixture.script.push(textResponse('ordinary answer while plugin unloaded'))
        parent.followup(createUserMessage({ content: [{ type: 'text', text: 'Native question while plugin is unloaded.' }], source: { kind: 'user' } }))
        await parent.whenIdle()
        assert.equal(parent.session.snapshotEvents().at(-1)!.type, 'turn/end')
        assert.equal(occurrences(systemText(fixture.mock.requests.at(-1)), 'Thaliris Controller contract:'), 0, 'unload removes the root prompt contribution')
      }
      await ctx.loader.update(fixture.entry.id, { disabled: false })
      await ctx.loader.await()
      for (const name of names) assert.ok(ctx.tools.get(name))
      assert.equal(ctx.tools.schemas(parent).filter(tool => names.includes(tool.name)).length, names.length)
    }
    fixture.script.push(textResponse('native normal answer'))
    parent.followup(createUserMessage({ content: [{ type: 'text', text: 'Ordinary native question.' }], source: { kind: 'user' } }))
    await parent.whenIdle()
    assert.equal(fixture.mock.requests.length, 9)
    assert.equal(occurrences(systemText(fixture.mock.requests.at(-1)), 'Thaliris Controller contract:'), 1, 'reload restores one root prompt contribution')
    const other = await ctx.agentLoop.create(SessionId('other-native-root'), { provider: 'mock', model: 'parent' }, { cwd: fixture.config.root })
    const denied = await fixture.execute(names[1]!, { task_id: selectedTaskId }, other)
    assert.equal(denied.isError, true)
    console.log('PASS Loader -> native Controller tools -> Python Core -> fresh native child -> explicit Controller close; filtering/body denial; unload/reload and ordinary native behavior')
  } finally { await fixture.clean() }
}

async function failureAndBoundary() {
  const fixture = await setup([maxTokensResponse('partial output claims success')], 'spawn', true)
  try {
    const started = await fixture.execute(names[0]!, { goal: 'Failure fixture', contract: selectedContract })
    assert.equal(started.isError, false)
    const ack = (started as any).value
    const result = await fixture.execute(names[2]!, { task_id: ack.task_id, base_revision: ack.revision, workstream: 'failure', role: 'Implementer', handoff })
    assert.equal(result.isError, true)
    assert.match(JSON.stringify(result.content), /THALIRIS_NATIVE_CHILD_FAILED/)
    assert.match(JSON.stringify(result.content), /max-tokens/)
    assert.match(JSON.stringify(result.content), /native_completed.*false/)
    assert.equal(fixture.mock.requests[0].model, 'parent', 'omitted role route inherits native parent configuration')
    assert.equal((await fixture.state(ack.task_id)).status, 'ACTIVE')
    const statePath = await taskStatePath(fixture.config.root, ack.task_id)
    const untouched = await readFile(statePath, 'utf8')
    const unknown = await fixture.execute(names[2]!, { task_id: ack.task_id, base_revision: 4, workstream: 'unknown', role: 'Unconfigured', handoff })
    assert.equal(unknown.isError, true)
    assert.equal(await readFile(statePath, 'utf8'), untouched)
    const spoofed = await fixture.execute(names[3]!, { task_id: ack.task_id, base_revision: 4, decision: 'done', actor: 'native-controller' })
    assert.equal(spoofed.isError, true)
    const stale = await fixture.execute(names[3]!, { task_id: ack.task_id, base_revision: 1, decision: 'done' })
    assert.equal(stale.isError, true)
    const rival = await fixture.ctx.agentLoop.create(SessionId('rival'), { provider: 'mock', model: 'parent' }, { cwd: fixture.config.root })
    assert.equal((await fixture.execute(names[1]!, { task_id: ack.task_id }, rival)).isError, true)
    assert.equal((await fixture.execute(names[1]!, { task_id: ack.task_id })).isError, false, 'a rejected rival cannot bind the reloaded plugin')
    const definition = fixture.ctx.tools.get(names[0]!)!
    await assert.rejects(definition.execute({ goal: 'missing caller', contract: selectedContract }, { signal: signal() } as any), /THALIRIS_NATIVE_ROOT_REQUIRED/)
    await assert.rejects(definition.execute({ goal: 'forged object', contract: selectedContract }, { agent: { ...fixture.parent }, signal: signal() } as any), /THALIRIS_NATIVE_ROOT_REQUIRED/)
    await fixture.ctx.loader.update(fixture.entry.id, { disabled: true })
    assert.equal((await fixture.state(ack.task_id)).status, 'ACTIVE')
    await fixture.ctx.loader.update(fixture.entry.id, { disabled: false })
    await fixture.ctx.loader.await()
    // Native root binding is restored from the Core anchor, not a supplied actor.
    assert.equal((await fixture.execute(names[1]!, { task_id: ack.task_id }, rival)).isError, true)
    assert.equal((await fixture.state(ack.task_id)).status, 'ACTIVE')
    console.log('PASS native failure remains ACTIVE; role/arguments/revision/root boundaries; ACTIVE unload/reload preserves authority')
  } finally { await fixture.clean() }

  const seeded = await setup([], 'fork')
  try {
    const result: any = await seeded.execute(names[0]!, { goal: 'No seeding', contract: selectedContract })
    assert.equal((await seeded.execute(names[2]!, { task_id: result.value.task_id, base_revision: 1, workstream: 'fresh-only', role: 'Implementer', handoff })).isError, true)
    assert.equal(seeded.mock.requests.length, 0)
    assert.equal((await seeded.state(result.value.task_id)).revision, 1)
    console.log('PASS native seeding provider rejected before child start')
  } finally { await seeded.clean() }
}

async function unloadActiveChild() {
  const fixture = await setup(['hang'])
  try {
    const started: any = await fixture.execute(names[0]!, { goal: 'Unload active native run', contract: selectedContract })
    let childId: string | undefined
    let childStarts = 0
    const published = Promise.withResolvers<void>()
    fixture.ctx.on('subagent/start', (info: SubagentRunInfo) => { childId = info.id; childStarts++; published.resolve() })
    const operation = fixture.execute(names[2]!, { task_id: started.value.task_id, base_revision: 1, workstream: 'hanging', role: 'Implementer', handoff })
    await published.promise
    await fixture.ctx.loader.update(fixture.entry.id, { disabled: true })
    await fixture.ctx.loader.await()
    assert.equal((await operation).isError, true)
    assert.equal(fixture.ctx.agents.get(SessionId(childId!)), undefined)
    const taskId = started.value.task_id
    assert.equal((await fixture.state(taskId)).status, 'ACTIVE')
    assert.equal((await fixture.authority(taskId)).status, 'ACTIVE')
    assert.equal((await fixture.state(taskId)).active_work.length, 1, 'interrupted work is not invented completion')
    for (const name of names) assert.equal(fixture.ctx.tools.get(name), undefined)
    await fixture.ctx.loader.update(fixture.entry.id, { disabled: false })
    await fixture.ctx.loader.await()
    const inspected: any = await fixture.execute(names[1]!, { task_id: taskId })
    assert.equal(inspected.isError, false)
    assert.equal(inspected.value.state.status, 'ACTIVE')
    const reservation = inspected.value.state.active_work
    assert.equal(reservation.length, 1)
    const preserved = await fixture.durableBytes(taskId)
    const blockedBegin = await fixture.execute(names[2]!, {
      task_id: inspected.value.state.task_id, base_revision: inspected.value.state.revision,
      workstream: 'second Workstream', role: 'Implementer', handoff,
    })
    assert.equal(blockedBegin.isError, true)
    assert.match(JSON.stringify(blockedBegin), /UNRESOLVED_ACTIVE_WORK_CANNOT_BEGIN/)
    assert.deepEqual(await fixture.durableBytes(taskId), preserved, 'rejected replacement leaves exact ledger and authority bytes intact')
    const blockedClose = await fixture.execute(names[3]!, {
      task_id: inspected.value.state.task_id, base_revision: inspected.value.state.revision,
      decision: 'The Controller claims completion.',
    })
    assert.equal(blockedClose.isError, true)
    assert.match(JSON.stringify(blockedClose), /UNRESOLVED_ACTIVE_WORK_CANNOT_CLOSE/)
    assert.deepEqual(await fixture.durableBytes(taskId), preserved, 'rejected close leaves exact ledger and authority bytes intact')
    assert.equal(childStarts, 1, 'unresolved reservation prevents a second native child launch')
    assert.deepEqual((await fixture.state(taskId)).active_work, reservation, 'the original native reservation remains available for diagnosis')
    assert.equal((await fixture.authority(taskId)).status, 'ACTIVE')
    const check: any = await fixture.execute(names[4]!, { task_id: inspected.value.state.task_id, base_revision: inspected.value.state.revision, action: 'check' })
    assert.equal(check.isError, false, JSON.stringify(check))
    assert.equal(check.value.outcome, 'aborted')
    assert.equal(check.value.released, false)
    assert.deepEqual(await fixture.durableBytes(taskId), preserved)
    const reconciled: any = await fixture.execute(names[4]!, { task_id: inspected.value.state.task_id, base_revision: inspected.value.state.revision, action: 'reconcile' })
    assert.equal(reconciled.isError, false, JSON.stringify(reconciled))
    assert.equal(reconciled.value.native_completed, false)
    assert.equal((await fixture.state(taskId)).active_work.length, 0)
    assert.equal((await fixture.state(taskId)).status, 'ACTIVE')
    console.log('PASS unload/reload preserves unresolved work; inspect succeeds; replacement and close reject without ledger, anchor or child mutation')
  } finally { await fixture.clean() }
}

async function evidenceContextAndMode() {
  let taskId = '', handoffId = '', observationId = '', digest = '', revision = 0
  const script = [
    toolCallResponse('start', names[0], { goal: 'Evidence continuity example', contract: selectedContract }),
    (options: any) => {
      const started = lastTool(options)
      taskId = started.task_id
      return toolCallResponse('register', names[7], { task_id: taskId, base_revision: started.revision, requirements: [{ id: 'R1', workchain_ref: 'W1' }] })
    },
    (options: any) => {
      const registered = lastTool(options)
      return toolCallResponse('context', names[6], { task_id: taskId, base_revision: registered.revision, milestone: 'M1',
        records: [{ id: 'D1', kind: 'decision', text: 'CONTEXT_DECISION_SENTINEL keep the external Core.' }] })
    },
    (options: any) => {
      const recorded = lastTool(options)
      assert.match(recorded.task_context, /CONTEXT_DECISION_SENTINEL/)
      return toolCallResponse('work', names[2], { task_id: taskId, base_revision: recorded.revision, workstream: 'evidence', role: 'Implementer', handoff, evidence: { candidate: 'C1', requirement_refs: ['R1'] } })
    },
    (options: any) => {
      assert.equal(options.model, 'selected-child')
      assert.ok((options.tools ?? []).some((tool: any) => tool.name === observeTool), 'evidence association grants the observation tool')
      for (const name of names) assert.ok(!(options.tools ?? []).some((tool: any) => tool.name === name))
      assert.doesNotMatch(JSON.stringify(options.messages), /CONTEXT_DECISION_SENTINEL/, 'Controller task context does not reach the child')
      assert.match(JSON.stringify(options.messages), /evidence_association/)
      return toolCallResponse('observe', observeTool, { id: 'O1', text: 'Answer 42 verified locally.', source_refs: ['S1'], sources: [{ id: 'S1', kind: 'local', locator: 'fixture', summary: '42' }] })
    },
    (options: any) => {
      const observed = lastTool(options)
      observationId = observed.observation_id
      handoffId = observed.handoff_id
      assert.equal(observed.candidate, 'C1')
      assert.equal(observationId, `${handoffId}.O1`)
      return textResponse('answer 42')
    },
    (options: any) => {
      const result = lastTool(options)
      assert.equal(result.native_completed, true)
      assert.equal(result.evidence_handoff_id, handoffId)
      assert.deepEqual(result.route, { provider: 'mock', model: 'selected-child' })
      assert.match(result.role_sha256, /^[0-9a-f]{16}$/)
      assert.equal(result.evidence_continuity.unincorporated_total, 1, 'unresolved evidence returns with the child result')
      return toolCallResponse('status', names[5], { task_id: taskId })
    },
    (options: any) => {
      const status = lastTool(options)
      assert.equal(status.view, 'compact', 'status defaults to the compact view')
      assert.deepEqual(status.Evidence.unincorporated, [{ requirement_ref: 'R1', observation_id: observationId, candidate: 'C1', handoff_id: handoffId }])
      assert.equal(status.Authority.execution_mode, 'delegated')
      assert.ok(JSON.stringify(options.messages).includes('CONTEXT_DECISION_SENTINEL'), 'root receives its recorded task context as dynamic context')
      digest = status.Authority.sha256
      revision = status.Task.revision
      return toolCallResponse('judge', names[8], { task_id: taskId, base_revision: revision, judgment: { id: 'J1', candidate: 'C1', requirement_ref: 'R1', observation_refs: [observationId], outcome: 'satisfied', reasoning: 'Observed answer meets R1.' } })
    },
    (options: any) => {
      const judged = lastTool(options)
      assert.equal(judged.evidence.unincorporated_total, 0)
      assert.equal(judged.task_context, undefined, 'the dynamic-context summary is not echoed in the tool result')
      return toolCallResponse('mode', names[9], { task_id: taskId, base_revision: judged.revision, expected_authority_sha256: digest, mode: 'controller-direct', human_instruction: 'stale digest' })
    },
    (options: any) => {
      assert.match(JSON.stringify(options.messages.at(-1)), /TASK_AUTHORITY_CHANGED/, 'stale authority digest is refused')
      return toolCallResponse('inspect', names[1], { task_id: taskId })
    },
    (options: any) => {
      const inspected = lastTool(options)
      return toolCallResponse('mode', names[9], { task_id: taskId, base_revision: inspected.state.revision, expected_authority_sha256: inspected.authority_sha256, mode: 'controller-direct', human_instruction: 'The user chose controller-direct.' })
    },
    (options: any) => {
      const switched = lastTool(options)
      assert.equal(switched.execution_mode, 'controller-direct')
      return toolCallResponse('work-again', names[2], { task_id: taskId, base_revision: switched.revision, workstream: 'blocked', role: 'Implementer', handoff })
    },
    (options: any) => {
      assert.match(JSON.stringify(options.messages.at(-1)), /THALIRIS_DELEGATED_INTENT_REQUIRED/, 'controller-direct mode does not dispatch delegated children')
      return textResponse('Controller finished evidence loop')
    },
  ]
  const steps = script.length
  const fixture = await setup(script)
  try {
    fixture.parent.followup(createUserMessage({ content: [{ type: 'text', text: 'Run the evidence loop.' }], source: { kind: 'user' } }))
    await fixture.parent.whenIdle()
    assert.equal(fixture.mock.requests.length, steps, JSON.stringify(fixture.parent.session.snapshotEvents().filter(event => event.type === 'tool/result').map(event => event.data).slice(-2)))
    const ledger = await fixture.state(taskId)
    assert.equal(ledger.evidence_continuity.observations[0].producer, `handoff:${handoffId}`)
    assert.match(ledger.evidence_continuity.observations[0].native_actor, /^dsh-child:/)
    assert.equal(ledger.evidence_continuity.judgments[0].producer, 'dsh:controller')
    assert.equal((await fixture.authority(taskId)).contract.execution_mode, 'controller-direct')
    const rootObserve = await fixture.execute(observeTool, { id: 'O9', text: 'forged', source_refs: ['S1'] })
    assert.equal(rootObserve.isError, true)
    assert.match(JSON.stringify(rootObserve.content), /THALIRIS_CHILD_DISPATCH_REQUIRED/)
    assert.equal((await fixture.state(taskId)).evidence_continuity.observations.length, 1, 'the Controller cannot fabricate a child observation')
    console.log('PASS evidence association -> adapter-bound child observation -> status/judgment; task context reaches only the root; stale digest refused; human-instructed mode switch gates delegation')
  } finally { await fixture.clean() }
}

await closedLoop()
await evidenceContextAndMode()
await failureAndBoundary()
await unloadActiveChild()
