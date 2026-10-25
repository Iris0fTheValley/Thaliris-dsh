import { createHash, randomUUID } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { basename, dirname, isAbsolute, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'
import { readPolicy, selectedRole } from './policy.mjs'
import { validDisposeReason } from './dispose-reason.mjs'
export { Config } from './policy.mjs'
export const name = 'thaliris-dsh'
export const inject = ['agents', 'systemPrompt', 'tools', 'subagents', 'subprocess', 'workspaceRegistry', 'sessionPersistence', 'llm']
export const TOOL_NAMES = Object.freeze(['thaliris_task_start', 'thaliris_task_inspect', 'thaliris_workstream', 'thaliris_task_close', 'thaliris_reconcile',
  'thaliris_task_status', 'thaliris_task_context', 'thaliris_task_register', 'thaliris_task_judge', 'thaliris_task_mode',
  'thaliris_task_identity', 'thaliris_task_identity_amend', 'thaliris_task_identity_challenge', 'thaliris_task_identity_relate',
  'thaliris_task_identity_note', 'thaliris_task_identity_suggest', 'thaliris_task_recover'])
export const MEMORY_TOOLS = Object.freeze(['thaliris_memory_read', 'thaliris_memory_search', 'thaliris_memory_propose'])
/** Granted by the adapter only to a child whose dispatch carries an evidence association. */
export const EVIDENCE_TOOLS = Object.freeze(['thaliris_observe'])
const bridgePath = fileURLToPath(new URL('./core_bridge.py', import.meta.url))
const RESTORE_RETRY_MS = 60000
const TERMINAL_REASONS = ['completed', 'aborted', 'error', 'max-tokens', 'blocked', 'interrupted']
const string = { type: 'string' }
const object = (properties, required = Object.keys(properties)) => ({ type: 'object', properties, required, additionalProperties: false })
const contractSchema = object({ human_instruction: string, boundary: string, invariants: string, acceptance: string, execution_mode: { type: 'string', enum: ['delegated', 'controller-direct', 'single-agent'] } })
const handoffSchema = object({ goal: string, scope: string, invariants: string, acceptance: string, context: string })
const identitySchema = { task_id: string, base_revision: { type: 'integer' } }
const memoryContextSchema = { type: 'array', maxItems: 4, items: object({ provider: string, operation: { type: 'string', enum: ['read', 'search'] }, key: string, query: string, limit: { type: 'integer', minimum: 1, maximum: 20 }, maxBytes: { type: 'integer', minimum: 1, maximum: 16384 } }, ['provider', 'operation', 'maxBytes']) }
const routeSchema = object({ provider: string, model: string, reasoningEffort: string }, ['provider', 'model'])
const strings = { type: 'array', items: string }
const sourceSchema = object({ id: string, kind: string, locator: string, summary: string })
const evidenceSchema = object({ candidate: string, requirement_refs: strings })
const recordSchema = object({ id: string, kind: string, text: string, source_refs: strings, status: string, supersedes: strings }, ['id', 'kind', 'text'])
const judgmentSchema = object({ id: string, candidate: string, requirement_ref: string, observation_refs: strings, outcome: { type: 'string', enum: ['satisfied', 'unknown', 'repair', 'no-current-impact'] }, reasoning: string, judgment_refs: strings }, ['id', 'candidate', 'requirement_ref', 'observation_refs', 'outcome', 'reasoning'])
const judgmentsSchema = { type: 'array', items: judgmentSchema, maxItems: 64 }
const limited = maximum => ({ type: 'array', items: string, maxItems: maximum })
const identityAmendSchema = object({ ...identitySchema, base_version: { type: 'integer', minimum: 0 }, base_sha256: string, text: string, summary: string, rationale: string,
  decision: object({ decided_by: string, human_instruction: string }), challenge_text: string, why_not_lower: string, evidence_refs: limited(64), resolves: limited(64), affected_refs: limited(64) },
[...Object.keys(identitySchema), 'base_version', 'text', 'summary', 'rationale', 'decision'])
const identityChallengeSchema = object({ ...identitySchema, targets: limited(16), summary: string, text: string, evidence_refs: limited(64), proposed_change: string, dismiss: string, reason: string }, Object.keys(identitySchema))
const identityRelateSchema = object({ ...identitySchema, add: { type: 'array', maxItems: 64, items: object({ from: string, rel: { type: 'string', enum: ['serves', 'supports', 'challenges', 'supersedes'] }, to: string, note: string }, ['from', 'rel', 'to']) },
  retract: { type: 'array', maxItems: 64, items: object({ id: string, reason: string }) } }, Object.keys(identitySchema))
const identityNoteSchema = object({ action: { type: 'string', enum: ['add', 'retract', 'list'] }, quote: string, kind: { type: 'string', enum: ['purpose', 'direction', 'constraint', 'non-goal', 'decision', 'rejection', 'material', 'other'] }, context: string, refs: limited(16),
  retract: string, reason: string, include_retracted: { type: 'boolean' } }, ['action'])
const identitySuggestSchema = object({ scope: { type: 'string', enum: ['session', 'workspace', 'project', 'global'] }, setting: { type: 'string', enum: ['on', 'off', 'clear'] } })
const identityReadSchema = object({ task_id: string, action: { type: 'string', enum: ['status', 'get', 'trace'] }, version: { type: 'integer', minimum: 1 }, items: limited(64), amendment: string, challenge: string,
  ref: string, direction: { type: 'string', enum: ['up', 'down', 'both'] }, depth: { type: 'integer', minimum: 1, maximum: 4 } }, ['task_id', 'action'])
const roleDigest = role => createHash('sha256').update(JSON.stringify(role)).digest('hex').slice(0, 16)
function validate(parameters, args) {
  const errors = validateJsonSchemaValue(parameters, args)
  if (errors.length) throw new Error(`THALIRIS_INVALID_ARGUMENTS: ${errors.join('; ')}`)
  if (JSON.stringify(args).length > 65536) throw new Error('THALIRIS_ARGUMENT_BOUND_EXCEEDED')
  if (args.base_revision !== undefined && (!Number.isSafeInteger(args.base_revision) || args.base_revision < 1)) throw new Error('THALIRIS_REVISION_REQUIRED')
  // Exactly one of a single judgment or an atomic ordered batch (one call, one revision).
  if (('judgment' in args) === ('judgments' in args) && ('judgment' in parameters.properties)) throw new Error('THALIRIS_INVALID_ARGUMENTS: give exactly one of judgment or judgments')
  if (args.judgments !== undefined && args.judgments.length < 1) throw new Error('THALIRIS_INVALID_ARGUMENTS: judgments must not be empty')
}
/** A bridge failure keeps the historical text first; Core's code, recovery hint and bounded details follow and are also exposed as properties. */
function bridgeError(response) {
  const message = response.error ?? 'THALIRIS_BRIDGE_FAILED'
  if (typeof response.code !== 'string') return new Error(message)
  const { code, recovery, details } = response
  return Object.assign(new Error(`${message} ${JSON.stringify({ code, recovery, details })}`), { code, recovery, details })
}

/** Native Settings owns mutable user policy. Core alone owns task intent. */
export function apply(ctx, config) {
  for (const key of ['pythonExecutable', 'corePath', 'authorityDirectory']) {
    if (typeof config[key] !== 'string' || !isAbsolute(config[key])) throw new Error(`THALIRIS_ABSOLUTE_CONFIG_REQUIRED: ${key}`)
  }
  readPolicy(config)
  // The interpreter is pinned at activation: its fully resolved file is the identity
  // every bridge launch must still reach. Launch it through the configured name with
  // only parent directories resolved, because a POSIX venv's bin/python is a symlink
  // and CPython locates pyvenv.cfg (and so the venv site-packages holding Core) from
  // the path it was started as; starting the resolved base interpreter loses the venv.
  const pythonIdentity = realpathSync(config.pythonExecutable), corePath = realpathSync(config.corePath)
  const python = join(realpathSync(dirname(config.pythonExecutable)), basename(config.pythonExecutable))
  function pinnedPython() {
    if (realpathSync(python) !== pythonIdentity) throw new Error('THALIRIS_PYTHON_IDENTITY_CHANGED')
    return python
  }
  let disposed = false, tail = Promise.resolve(), bridgeTail = Promise.resolve()
  const cancellations = new Set(), operations = new Set(), runs = new Set(), childGrants = new WeakMap()
  // Bounded Controller task context per native root, re-supplied as DSH dynamic
  // context; it is recorded history, never acceptance.
  const taskContexts = new Map(), restorations = new Map()
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
  async function workspaceBinding(header) {
    const workspace = await ctx.workspaceRegistry.resolveByPath(header.cwd)
    const selected = readPolicy(config).workspaces.find(row => row.enabled && row.workspaceId === workspace?.id)
    if (!selected || realpathSync(selected.root) !== realpathSync(workspace.path) || realpathSync(header.cwd) !== realpathSync(selected.root)) throw new Error('THALIRIS_WORKSPACE_NOT_CONFIGURED')
    return { root: realpathSync(selected.root), workspaceId: workspace.id }
  }
  async function persistedRootBinding(sessionId) {
    // Persistent native metadata, never a caller id or a matching object alone.
    const stored = await ctx.sessionPersistence.stat(sessionId)
    const header = stored?.header
    if (!isPersistedRoot(header, sessionId)) throw new Error('THALIRIS_PERSISTED_ROOT_REQUIRED')
    return await workspaceBinding(header)
  }
  async function binding(agent) {
    if (disposed || !isNativeRoot(agent)) throw new Error('THALIRIS_NATIVE_ROOT_REQUIRED')
    const bound = await workspaceBinding(agent.session.header)
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
      await binding(agent)
      return await operation(agent)
    } finally {
      await handle?.dispose()
    }
  }
  ctx.systemPrompt.section({ name: 'thaliris:controller-contract', order: ctx.systemPrompt.getSectionOrder('TEAM_POLICY'),
    text: ({ agent }) => {
      if (!isNativeRoot(agent)) return ''
      try {
        const cwd = realpathSync(agent.session.header.cwd), policy = readPolicy(config)
        return policy.workspaces.some(row => {
          if (!row.enabled) return false
          try {
            const workspace = ctx.workspaceRegistry.get(row.workspaceId)
            return realpathSync(row.root) === cwd && workspace?.path && realpathSync(workspace.path) === cwd
          } catch { return false }
        }) ? policy.controllerPrompt : ''
      } catch { return '' }
    },
  })
  ctx.systemPrompt.context({ name: 'thaliris:task-context', order: ctx.systemPrompt.getContextOrder('SUBAGENT_DELEGATION') + 1,
    text: ({ agent }) => {
      if (disposed || !isNativeRoot(agent)) return ''
      if (!restorations.get(agent.id)?.restored) restoreContext(agent)
      return contextText(agent)
    },
  })
  // The provider above is synchronous, so the first assembly after a restart
  // awaits restoration here and fills that same context entry: the first model
  // step already carries the recorded task context. After a failure the next
  // attempt waits for RESTORE_RETRY_MS, so a failing bridge never stalls every turn.
  ctx.on('system-prompt/assemble', async (assembly, context, next) => {
    const agent = context.agent
    if (!disposed && isNativeRoot(agent) && !restorations.get(agent.id)?.restored) {
      await restoreContext(agent)
      const entry = assembly.contexts.find(item => item.name === 'thaliris:task-context')
      if (entry && !disposed) entry.text = contextText(agent)
    }
    return next()
  })
  function contextText(agent) {
    return [restorations.get(agent.id)?.notice, ...(taskContexts.get(agent.id)?.values() ?? [])].filter(Boolean).join('\n\n')
  }
  function rememberContext(agent, taskId, text) {
    if (!agent || typeof taskId !== 'string' || text === undefined) return
    const contexts = taskContexts.get(agent.id) ?? new Map()
    if (text) contexts.set(taskId, text)
    else contexts.delete(taskId)
    taskContexts.set(agent.id, contexts)
  }
  /**
   * After a process restart, restore context for tasks anchored to this exact native root. Never rejects.
   * Success is remembered once; a failure is not: it leaves one visible notice line (code and the tool to
   * use) and is retried on a later assembly. Contexts already re-supplied by a newer result are kept.
   */
  function restoreContext(agent) {
    const restoration = restorations.get(agent.id) ?? {}
    if (restoration.pending) return restoration.pending
    if (restoration.restored || Date.now() < (restoration.retryAt ?? 0)) return Promise.resolve()
    const cancel = new AbortController()
    cancellations.add(cancel)
    restoration.pending = bridge(agent, 'resume', {}, cancel.signal).then(result => {
      const contexts = taskContexts.get(agent.id) ?? new Map()
      for (const task of result.tasks) if (task.task_context && !contexts.has(task.task_id)) contexts.set(task.task_id, task.task_context)
      taskContexts.set(agent.id, contexts)
      Object.assign(restoration, { restored: true, notice: resumeNotice(result) })
    }, error => {
      const code = typeof error?.code === 'string' ? error.code : String(error?.message ?? error).split(/[\s:]/)[0] || 'THALIRIS_BRIDGE_FAILED'
      Object.assign(restoration, { retryAt: Date.now() + RESTORE_RETRY_MS,
        notice: `Thaliris: task context was not restored (${code}); it is retried on a later turn. For a known task_id, read thaliris_task_status; thaliris_task_recover action list shows tasks needing recovery.` })
    }).finally(() => { cancellations.delete(cancel); restoration.pending = undefined })
    restorations.set(agent.id, restoration)
    return restoration.pending
  }
  /** One line per condition the restored contexts do not show; nothing when all of this root's tasks are restored. */
  function resumeNotice(result) {
    const lines = []
    if (result.recovery_required_count) lines.push(`Thaliris: ${result.recovery_required_count} task(s) of this session need Controller recovery (TASK_AUTHORITY_STATE_CHANGED): ${result.recovery_required.map(task => task.task_id).join(', ')}. Nothing was accepted; see thaliris_task_recover action list.`)
    if (result.truncated) lines.push(`Thaliris: ${result.task_count - result.tasks.length} more ACTIVE task(s) of this session are not shown here: ${result.omitted_task_ids.join(', ')}; read thaliris_task_status.`)
    if (result.unreadable_count) lines.push(`Thaliris: ${result.unreadable_count} task anchor(s) of this workspace could not be read; thaliris_task_inspect with a known task_id shows the error.`)
    // Count only: another root's task ids and context never enter this session's context.
    if (result.attachable_count && !result.task_count && !result.recovery_required_count) lines.push(`Thaliris: ${result.attachable_count} ACTIVE task(s) of this workspace are anchored to another root session. Only on the user's instruction to continue one here, see thaliris_task_recover action list.`)
    return lines.join('\n')
  }
  function bridge(agent, operation, args, signal) {
    const pending = bridgeTail.then(() => bridgeExecute(agent, operation, args, signal))
    bridgeTail = pending.catch(() => {})
    return pending.then(result => {
      if (result && Object.hasOwn(result, 'task_context') && isNativeRoot(agent)) rememberContext(agent, args.task_id, result.task_context)
      if (operation === 'close' && result?.status === 'DONE') rememberContext(agent, args.task_id, null)
      // A recovered or attached anchor changes what the restoration notice reports: rebuild it on the next assembly.
      if ((operation === 'recover' || operation === 'attach') && result?.ok) restorations.delete(agent.id)
      // The bounded summary is already re-supplied as dynamic context; the full status view keeps it for explicit reads.
      if (result && Object.hasOwn(result, 'task_context') && operation !== 'resume' && !(operation === 'status' && args.view === 'full')) { const { task_context, ...visible } = result; return visible }
      return result
    })
  }
  async function bridgeExecute(agent, operation, args, signal) {
    const bound = await binding(agent)
    signal.throwIfAborted()
    const deadline = new AbortController(), timer = setTimeout(() => deadline.abort('Thaliris bridge deadline exceeded'), config.bridgeTimeoutMs)
    timer.unref()
    const processSignal = AbortSignal.any([signal, deadline.signal])
    let command
    try {
      command = ctx.subprocess.spawn({ argv: [pinnedPython(), '-I', bridgePath], cwd: bound.root, graceMs: 1000, signal: processSignal,
        stdio: { stdin: { data: JSON.stringify({ protocol: 1, core_path: corePath, root: bound.root, authority_directory: config.authorityDirectory,
          native_controller_id: agent.id, native_workspace_id: bound.workspaceId, operation, arguments: args }) }, stdout: { maxBytes: 1048576 }, stderr: { maxBytes: 8192 } } })
      const outcome = await command.done, stdout = command.collected.stdout.readFrom(0)
      if (stdout.lossy) throw new Error('THALIRIS_BRIDGE_RESPONSE_TOO_LARGE')
      const response = JSON.parse(stdout.text)
      if (response.protocol !== 1 || response.ok !== true || outcome.exitCode !== 0) throw bridgeError(response)
      processSignal.throwIfAborted()
      return response.result
    } finally { clearTimeout(timer); if (command) { command.terminate(); await command.waitForExit() } }
  }
  function register(toolName, description, parameters, body, childAllowed = false) {
    ctx.tools.register({ name: toolName, description, parameters,
      output: { schema: { type: 'object', additionalProperties: true }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
      async execute(args, exec) {
        if (disposed || ctx.agents.get(exec.agent?.id) !== exec.agent || (!isNativeRoot(exec.agent) && !(childAllowed && childGrants.has(exec.agent)))) throw new Error('THALIRIS_NATIVE_ROOT_REQUIRED')
        validate(parameters, args)
        const cancel = new AbortController(), signal = AbortSignal.any([exec.signal, cancel.signal])
        cancellations.add(cancel)
        const work = async () => { signal.throwIfAborted(); if (isNativeRoot(exec.agent)) await binding(exec.agent); return body(args, exec.agent, signal) }
        // Child memory calls cannot wait behind the Controller's child-result wait.
        const operation = childAllowed ? work() : tail.then(work)
        if (!childAllowed) tail = operation.catch(() => {})
        operations.add(operation)
        try { return await operation } finally { operations.delete(operation); cancellations.delete(cancel) }
      } })
  }
  register(TOOL_NAMES[0], 'Controller explicitly selects human intent. Native Settings is user policy, never task consent.', object({ goal: string, contract: contractSchema }),
    (args, agent, signal) => bridge(agent, 'start', args, signal))
  register(TOOL_NAMES[1], 'Inspect the explicitly selected Core task and unresolved reservation without inferring outcomes.', object({ task_id: string }),
    (args, agent, signal) => bridge(agent, 'inspect', { task_id: args.task_id }, signal))
  register(TOOL_NAMES[2], 'Select one editable role, a bounded handoff, an optional model route/effort and an optional evidence association (candidate label and registered requirement refs) for a fresh native child.', object({ ...identitySchema, workstream: string, role: string, handoff: handoffSchema, route: routeSchema, memoryContext: memoryContextSchema, evidence: evidenceSchema }, [...Object.keys(identitySchema), 'workstream', 'role', 'handoff']), async (args, agent, signal) => {
    // The role is bound at dispatch: later Settings edits never reinterpret this child.
    const policy = readPolicy(config), role = structuredClone(selectedRole(policy, args.role))
    if (!role.context.handoff) throw new Error('THALIRIS_ROLE_HANDOFF_DENIED')
    const provider = ctx.subagents.getProvider(config.subagentProvider)
    if (!provider || provider.inheritsParentContext !== false) throw new Error('THALIRIS_FRESH_PROVIDER_REQUIRED')
    let route
    const mode = role.modelPolicy.mode
    if (mode === 'inherit') { if (args.route) throw new Error('THALIRIS_MODEL_ROUTE_NOT_ALLOWED') }
    else {
      route = args.route ?? (mode === 'fixed' ? role.modelPolicy.routes[0] : undefined)
      if (!route || !role.modelPolicy.routes.some(candidate => candidate.provider === route.provider && candidate.model === route.model && candidate.reasoningEffort === route.reasoningEffort)) throw new Error('THALIRIS_MODEL_ROUTE_NOT_ALLOWED')
      const info = await ctx.llm.resolveModelInfo(route.provider, route.model, signal)
      if (route.reasoningEffort !== undefined && !info.reasoning?.efforts.some(effort => effort.id === route.reasoningEffort)) throw new Error('THALIRIS_MODEL_CAPABILITY_NOT_ALLOWED')
    }
    const inspected = await bridge(agent, 'inspect', { task_id: args.task_id }, signal)
    if (inspected.contract.execution_mode !== 'delegated') throw new Error('THALIRIS_DELEGATED_INTENT_REQUIRED')
    const bound = await binding(agent)
    const selectedMemory = []
    for (const selection of args.memoryContext ?? []) {
      if (!role.context.memory || !role.memory.read.includes(selection.provider)) throw new Error('THALIRIS_MEMORY_PERMISSION_DENIED')
      if (selection.operation === 'read' && typeof selection.key !== 'string' || selection.operation === 'search' && (typeof selection.query !== 'string' || !Number.isSafeInteger(selection.limit))) throw new Error('THALIRIS_MEMORY_SELECTION_REQUIRED')
      selectedMemory.push({ selection, result: await memory(selection, agent, signal, selection.operation) })
    }
    if (args.evidence && (args.evidence.requirement_refs.length > 64 || args.evidence.requirement_refs.some(ref => typeof ref !== 'string'))) throw new Error('THALIRIS_INVALID_EVIDENCE_ASSOCIATION')
    const evidence = args.evidence && { handoff_id: 'H' + randomUUID().replaceAll('-', '').slice(0, 12), candidate: args.evidence.candidate, requirement_refs: [...args.evidence.requirement_refs] }
    const prompt = JSON.stringify({ task_id: args.task_id, workstream: args.workstream, role: role.id, ...args.handoff, ...(selectedMemory.length ? { memory_context: selectedMemory } : {}),
      ...(evidence ? { evidence_association: { candidate: evidence.candidate, requirement_refs: evidence.requirement_refs, observation_tool: EVIDENCE_TOOLS[0] } } : {}) })
    // The chosen model/effort and role identity are recorded with the reservation.
    const selected = { workstream: args.workstream, role: role.id, handoff_sha256: createHash('sha256').update(prompt).digest('hex'), correlation: `thaliris:${randomUUID()}`,
      // Compact: the reservation is bounded routing state until finish/reconcile
      // archives it, with its terminal observation, as a `dsh-dispatch` Core record.
      role_sha256: roleDigest(role), route: route ? `${route.provider}/${route.model}${route.reasoningEffort !== undefined ? '@' + route.reasoningEffort : ''}` : 'inherit',
      ...(evidence ? { evidence_handoff_id: evidence.handoff_id } : {}) }
    let begun = await bridge(agent, 'begin', { task_id: args.task_id, base_revision: args.base_revision, observation: JSON.stringify(selected), ...(evidence ? { evidence } : {}) }, signal)
    let run
    const reservationBound = Promise.withResolvers()
    reservationBound.promise.catch(() => {})
    try {
      run = await ctx.subagents.start(config.subagentProvider, { parent: agent, signal, label: selected.correlation, prompt: [{ type: 'text', text: prompt }], maxDepth: 1,
        toolFilter: { allow: evidence ? [...role.tools, ...EVIDENCE_TOOLS] : role.tools, deny: TOOL_NAMES }, ...(route ? { agentOptions: route } : {}), persona: role.prompt })
      runs.add(run)
      if (!run.localAgent || run.localAgent.id !== run.id || run.localAgent.session.header.parentSession !== agent.id || run.localAgent.session.header.isSeeded !== false) throw new Error('THALIRIS_NATIVE_CHILD_IDENTITY_REQUIRED')
      childGrants.set(run.localAgent, { role, roleId: role.id, parent: agent, bound, taskId: args.task_id, evidence, reservationBound: reservationBound.promise })
      // Commit observed ID immediately, before awaiting the result. Catalog label covers the preceding crash window.
      await ctx.sessionPersistence.flush()
      const beforeBind = await bridge(agent, 'inspect', { task_id: args.task_id }, signal)
      begun = await bridge(agent, 'bind', { task_id: args.task_id, base_revision: beforeBind.state.revision, observation: JSON.stringify({ ...selected, child_id: run.id }) }, signal)
      reservationBound.resolve()
      const result = await run.result
      await ctx.sessionPersistence.flush()
      // The dispatch record archives the reservation, which carries route, role digest and evidence handoff.
      const observed = { workstream: selected.workstream, role: selected.role, handoff_sha256: selected.handoff_sha256, correlation: selected.correlation, child_id: run.id, stop_reason: result.stopReason, provenance: 'native-run-result' }
      const beforeFinish = await bridge(agent, 'inspect', { task_id: args.task_id }, signal)
      // The release returns the compact open-evidence summary (totals plus bounded items) and the new revision with the child result.
      const { evidence: openEvidence, ...ack } = await bridge(agent, 'finish', { task_id: args.task_id, base_revision: beforeFinish.state.revision, observation: JSON.stringify(observed) }, signal)
      const value = { ...ack, child_id: run.id, stop_reason: result.stopReason, native_completed: result.stopReason === 'completed', route: route ? { ...route } : 'inherit', role_sha256: selected.role_sha256,
        ...(evidence ? { evidence_handoff_id: evidence.handoff_id, candidate: evidence.candidate } : {}),
        evidence_continuity: openEvidence ?? 'UNKNOWN', output: result.output }
      if (result.stopReason !== 'completed') throw new Error('THALIRIS_NATIVE_CHILD_FAILED: ' + JSON.stringify(value))
      return value
    } finally { reservationBound.reject(new Error('THALIRIS_DISPATCH_ENDED')); if (run) { if (run.localAgent) childGrants.delete(run.localAgent); await run.dispose(); runs.delete(run) } }
  })
  register(TOOL_NAMES[3], 'Controller records the mechanical DONE state after judging product completion from the task contract and available evidence.', object({ ...identitySchema, decision: string }),
    (args, agent, signal) => bridge(agent, 'close', args, signal))
  register(TOOL_NAMES[5], 'Task status. Default compact view: revision, routing mechanics, counts, bounded current records (id, kind, text clipped), non-completed dispatches, authority digest/mode and the open-evidence summary (totals plus bounded items; page with evidence_offset). view "full" returns the complete packet; since_revision adds a bounded Changes Since review hint.',
    object({ task_id: string, evidence_offset: { type: 'integer', minimum: 0 }, view: { type: 'string', enum: ['compact', 'full'] }, since_revision: { type: 'integer', minimum: 0 } }, ['task_id']), (args, agent, signal) => bridge(agent, 'status', args, signal))
  register(TOOL_NAMES[6], 'Controller records dynamic task context: append facts, decisions, progress and open items as records (supersedes replaces earlier ones), sources, and the milestone. The adapter supplies producer and revision.',
    object({ ...identitySchema, records: { type: 'array', items: recordSchema }, sources: { type: 'array', items: sourceSchema }, milestone: string }, Object.keys(identitySchema)),
    (args, agent, signal) => bridge(agent, 'context', args, signal))
  register(TOOL_NAMES[7], 'Controller registers opaque user requirements ({id, workchain_ref}) for evidence continuity. Handoffs are registered by the adapter at dispatch.',
    object({ ...identitySchema, requirements: { type: 'array', items: object({ id: string, workchain_ref: string }) } }), (args, agent, signal) => bridge(agent, 'register', args, signal))
  register(TOOL_NAMES[8], 'Controller records requirement judgments for a candidate with exact observation refs, outcome and reasoning; optional judgment_refs address an earlier repair/unknown basis. Give one judgment, or judgments (1-64, ordered, atomic: all commit in one revision or none). The result carries the new revision and the open-evidence summary.',
    object({ ...identitySchema, judgment: judgmentSchema, judgments: judgmentsSchema }, Object.keys(identitySchema)), (args, agent, signal) => bridge(agent, 'judge', args, signal))
  register(TOOL_NAMES[9], 'Switch execution mode only on an actual human instruction, with the expected authority digest from inspect/status; resolve active work first. Goal, boundary, invariants and acceptance stay frozen; child roles and grants are not widened.',
    object({ ...identitySchema, expected_authority_sha256: string, mode: { type: 'string', enum: ['delegated', 'controller-direct', 'single-agent'] }, human_instruction: string }),
    (args, agent, signal) => bridge(agent, 'mode', args, signal))
  // Project Identity (Core 0.5.0) is Controller-only: names carry the thaliris_task_ prefix, so role grants can never include them,
  // and TOOL_NAMES denies them to every dispatched child. Children see identity only when the Controller quotes selected items into a handoff.
  register(TOOL_NAMES[10], 'Read the project identity (separate from Task Authority and the Memory Provider). action status: bounded state, item ids and open challenges; get: the recorded version, selected items (version, items), one amendment or one challenge; trace: registered relations around a ref (ref, direction, depth). Reads follow the selected task; absent identity is normal.',
    identityReadSchema, (args, agent, signal) => {
      const { action, task_id, ...rest } = args
      const allowed = { status: [], get: ['version', 'items', 'amendment', 'challenge'], trace: ['ref', 'direction', 'depth'] }[action]
      const stray = Object.keys(rest).filter(key => !allowed.includes(key))
      if (stray.length || (action === 'trace' && rest.ref === undefined)) throw new Error(`THALIRIS_INVALID_ARGUMENTS: identity ${action} does not accept ${stray.join(', ') || 'a missing ref'}`)
      return bridge(agent, `identity_${action}`, { task_id, ...rest }, signal)
    })
  register(TOOL_NAMES[11], 'Controller records an explicit project identity amendment (base_version 0 establishes v1) only on the explicit decision of the human owner: quote it in decision.human_instruction with decided_by, and give the rationale. base_sha256 is the on_disk_sha256 from identity status (omit it when no IDENTITY.md exists). Not a memory proposal or approval; the frozen contract of a running task is never rewritten.',
    identityAmendSchema, (args, agent, signal) => {
      const { task_id, base_revision, base_sha256, ...rest } = args
      return bridge(agent, 'identity_amend', { task_id, base_revision, input: { ...rest, base_sha256: base_sha256 ?? null } }, signal)
    })
  register(TOOL_NAMES[12], 'Controller records evidence challenging the project identity instead of editing it (targets, summary, text, optional evidence_refs and proposed_change), or dismisses an open challenge with a reason (dismiss, reason). Amendments resolve challenges through identity_amend.resolves.',
    identityChallengeSchema, (args, agent, signal) => {
      const { task_id, base_revision, ...rest } = args
      return bridge(agent, 'identity_challenge', { task_id, base_revision, input: rest }, signal)
    })
  register(TOOL_NAMES[13], 'Controller registers (add) or retracts typed purpose relations (serves, supports, challenges, supersedes) between refs for significant decisions, designs or experiments. A challenges relation may not target identity; evidence against identity is a challenge.',
    identityRelateSchema, (args, agent, signal) => {
      const { task_id, base_revision, ...rest } = args
      return bridge(agent, 'identity_relate', { task_id, base_revision, input: rest }, signal)
    })
  register(TOOL_NAMES[14], 'Controller records, retracts or lists project identity basis notes (Core 0.5.2): action add records the user\'s verbatim words (quote, optional kind, one-line context, refs) when they explicitly state the project\'s long-term purpose, direction, constraint or non-goal, or explicitly decide or reject one; retract (retract id, reason) withdraws a wrong note; list shows notes (include_retracted optional). Needs no ACTIVE task; a note is not an identity amendment.',
    identityNoteSchema, (args, agent, signal) => {
      const { action, include_retracted, ...rest } = args
      const allowed = { add: ['quote', 'kind', 'context', 'refs'], retract: ['retract', 'reason'], list: [] }[action]
      const stray = Object.keys(rest).filter(key => !allowed.includes(key)), missing = allowed.filter(key => key === 'quote' || key === 'retract' || key === 'reason' ? rest[key] === undefined : false)
      if (stray.length || missing.length || (include_retracted !== undefined && action !== 'list')) throw new Error(`THALIRIS_INVALID_ARGUMENTS: identity note ${action} does not accept ${stray.join(', ') || 'these arguments'} or lacks ${missing.join(', ') || 'none'}`)
      return action === 'list' ? bridge(agent, 'identity_note_list', include_retracted === undefined ? {} : { include_retracted }, signal) : bridge(agent, 'identity_note', { input: rest }, signal)
    })
  register(TOOL_NAMES[15], 'Controller sets whether Thaliris may proactively offer to compose a project identity, only on the user\'s words: setting off or on (or clear to remove the setting) at scope session, workspace, project or global. Needs no ACTIVE task; it suppresses only close-time offers.',
    identitySuggestSchema, (args, agent, signal) => bridge(agent, 'identity_suggest', args, signal))
  register(EVIDENCE_TOOLS[0], 'Record one already discovered local fact that changes your conclusion, local acceptance or a critical UNKNOWN, with source refs. The adapter binds task, handoff, candidate and requirement refs; do not supply them.',
    object({ id: string, text: string, source_refs: strings, sources: { type: 'array', items: sourceSchema }, observed_state: string }, ['id', 'text', 'source_refs']), async (args, agent, signal) => {
      const grant = childGrants.get(agent)
      if (!grant) throw new Error('THALIRIS_CHILD_DISPATCH_REQUIRED')
      if (!grant.evidence) throw new Error('THALIRIS_OBSERVATION_ASSOCIATION_UNAVAILABLE: report the observation and its sources in FINAL')
      await grant.reservationBound
      return bridge(grant.parent, 'observe', { task_id: grant.taskId, handoff_id: grant.evidence.handoff_id, child_id: agent.id, observation: args }, signal)
    }, true)

  /** A short failure code for UNKNOWN reasons: never a payload, path or stack. */
  const failureCode = error => typeof error?.code === 'string' ? error.code : String(error?.message ?? error).split(/[\s:]/)[0] || 'UNKNOWN_ERROR'
  function realDirectory(path) {
    try { return realpathSync(path) } catch { return undefined }
  }
  /**
   * Native catalog correlation plus durable terminal Session evidence. Missing or unreadable native
   * state (child Session file, working directory) is UNKNOWN with a reason; an identity conflict throws.
   */
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
    const unreadable = error => { signal?.throwIfAborted(); return { child_id: id, outcome: 'UNKNOWN', reason: `native child Session unreadable (${failureCode(error)})` } }
    let handle
    try { handle = await ctx.sessionPersistence.open(id, 'read', { signal }) } catch (error) { return unreadable(error) }
    try {
      if (handle.header.parentSession !== agent.id || handle.header.isSeeded !== false || handle.header.origin !== 'subagent') throw new Error('THALIRIS_NATIVE_CHILD_IDENTITY_REQUIRED')
      const childCwd = realDirectory(handle.header.cwd), rootCwd = realDirectory(agent.session.header.cwd)
      if (!childCwd || !rootCwd) return { child_id: id, outcome: 'UNKNOWN', reason: 'native child or root working directory unavailable' }
      if (childCwd !== rootCwd) throw new Error('THALIRIS_NATIVE_CHILD_IDENTITY_REQUIRED')
      let events
      try { ({ events } = await handle.read(0, undefined, { signal })) } catch (error) { return unreadable(error) }
      const start = events.filter(event => event.type === 'turn/start').at(-1)
      const end = events.filter(event => event.type === 'turn/end').at(-1)
      if (!start || !end || end.seq < start.seq || !TERMINAL_REASONS.includes(end.data?.reason?.kind)) return { child_id: id, outcome: 'UNKNOWN', reason: 'durable native terminal reason unavailable' }
      return { child_id: id, outcome: end.data.reason.kind, terminal_seq: end.seq, terminal_reason: end.data.reason, provenance: 'native-session-turn/end' }
    } finally { try { await handle.close() } catch { /* a read-only handle; the observation above stands */ } }
  }
  /**
   * Before a Controller dispose: a child of this reservation resident in this process is cancelled first;
   * one resident under another root is refused. Liveness outside this process stays UNKNOWN.
   */
  async function disposeLiveness(agent, reservation) {
    const ids = new Set(agent.session.snapshotEvents().filter(event => event.type === 'subagent/catalog' && event.data.label === reservation.correlation).map(event => event.data.childId))
    if (reservation.child_id) ids.add(reservation.child_id)
    const child_id = reservation.child_id ?? (ids.size === 1 ? [...ids][0] : undefined)
    if (!ids.size) return { child_liveness: 'UNKNOWN', liveness_reason: 'no native child is correlated with this reservation in this session' }
    let cancelled = false
    for (const id of ids) {
      const live = ctx.agents.get(id)
      if (!live) continue
      if (live.session.header.parentSession !== agent.id) throw new Error('THALIRIS_NATIVE_CHILD_RESIDENT_ELSEWHERE: stop the child in its owning root first')
      live.cancel({ kind: 'parent' })
      await live.whenIdle()
      cancelled = true
    }
    if (cancelled) await ctx.sessionPersistence.flush()
    return { ...(child_id ? { child_id } : {}), child_liveness: cancelled ? 'cancelled' : 'not-resident',
      ...(cancelled ? {} : { liveness_reason: 'not resident in this process; liveness elsewhere is UNKNOWN' }) }
  }
  async function reconcile(agent, args, signal) {
    // A stale revision is refused by the bridge with the structured conflict (code, recovery, changes_since).
    const inspected = await bridge(agent, 'inspect', { task_id: args.task_id, base_revision: args.base_revision }, signal)
    if (inspected.state.active_work.length !== 1) throw new Error('THALIRIS_RESERVATION_REQUIRED')
    let reservation
    try { reservation = JSON.parse(inspected.state.active_work[0]) } catch { reservation = {} }
    if (!reservation || typeof reservation !== 'object') reservation = {}
    if (args.action === 'dispose') {
      // Controller decision for a reservation native evidence cannot resolve: recorded as disposed, native outcome UNKNOWN, never completed.
      const liveness = await disposeLiveness(agent, reservation)
      const released = await bridge(agent, 'dispose', { task_id: args.task_id, base_revision: args.base_revision, reason: args.reason, observation: JSON.stringify({ correlation: reservation.correlation, ...liveness }) }, signal)
      return { ...released, ...liveness, released: true, native_completed: false }
    }
    const observation = await nativeObservation(agent, reservation, signal, args.action === 'cancel-reconcile')
    if (args.action === 'check' || observation.outcome === 'UNKNOWN') return { ...observation, released: false }
    return { ...await bridge(agent, 'reconcile', { task_id: args.task_id, base_revision: args.base_revision, observation: JSON.stringify({ ...reservation, ...observation }) }, signal), ...observation, released: true, native_completed: observation.outcome === 'completed' }
  }
  register(TOOL_NAMES[4], 'Check/reconcile a crash reservation using native catalog and durable terminal Session evidence. UNKNOWN never auto releases. action dispose (with a reason) is the Controller\'s explicit release of a reservation native evidence cannot resolve: a resident child of this session is cancelled first, and the dispatch is recorded as disposed with native outcome UNKNOWN, never completed.',
    object({ ...identitySchema, action: { type: 'string', enum: ['check', 'reconcile', 'cancel-reconcile', 'dispose'] }, reason: string }, [...Object.keys(identitySchema), 'action']), async (args, agent, signal) => {
      if ((args.action === 'dispose') !== (typeof args.reason === 'string')) throw new Error('THALIRIS_INVALID_ARGUMENTS: reason is required for dispose and accepted only there')
      if (args.action === 'dispose' && !validDisposeReason(args.reason)) throw new Error('THALIRIS_INVALID_ARGUMENTS: dispose reason must be non-blank and at most 3500 characters; nothing was cancelled')
      const result = await reconcile(agent, args, signal)
      if (result.released) await bridge(agent, 'inspect', { task_id: args.task_id }, signal).catch(() => {})
      return result
    })
  register(TOOL_NAMES[16], 'Controller-only explicit anchor recovery; nothing here happens automatically. action list: tasks of this session that need recovery and ACTIVE tasks of this workspace anchored to another root (ids, digests). rollback: after TASK_AUTHORITY_STATE_CHANGED (an interrupted, unconfirmed write) archive the current ledger bytes and restore the last anchored state. attach: only on the user\'s instruction, make this root session the only Controller of an ACTIVE task of this workspace (Task ID, goal, contract, mode and evidence stay; the previous root is refused); attach-and-rollback also restores the last anchored state. Every change needs expected_authority_sha256 (from the error details or list) and a reason.',
    object({ task_id: string, action: { type: 'string', enum: ['list', 'rollback', 'attach', 'attach-and-rollback'] }, expected_authority_sha256: string, reason: string }, ['action']), async (args, agent, signal) => {
      if (args.action === 'list') {
        if (Object.keys(args).length !== 1) throw new Error('THALIRIS_INVALID_ARGUMENTS: action list takes no other arguments')
        const { tasks, ...listed } = await bridge(agent, 'resume', {}, signal)
        return { ...listed, tasks: tasks.map(({ task_context, ...task }) => task) }
      }
      const { task_id, expected_authority_sha256, reason } = args
      if (typeof task_id !== 'string' || typeof expected_authority_sha256 !== 'string' || typeof reason !== 'string') throw new Error('THALIRIS_INVALID_ARGUMENTS: task_id, expected_authority_sha256 and reason are required')
      return args.action === 'rollback' ? bridge(agent, 'recover', { task_id, expected_authority_sha256, reason }, signal)
        : bridge(agent, 'attach', { task_id, expected_authority_sha256, reason, rollback: args.action === 'attach-and-rollback' }, signal)
    })

  async function memory(args, agent, signal, operation) {
    const policy = readPolicy(config), grant = childGrants.get(agent), parent = grant?.parent ?? agent
    if (operation === 'write' && grant && args.task_id !== grant.taskId) throw new Error('THALIRIS_TASK_ID_CONFLICT')
    // A child keeps the role bound at its dispatch.
    const role = grant?.role
    if (grant && (!role.context.memory || !role.tools.includes(operation === 'read' ? MEMORY_TOOLS[0] : operation === 'search' ? MEMORY_TOOLS[1] : MEMORY_TOOLS[2]))) throw new Error('THALIRIS_MEMORY_PERMISSION_DENIED')
    const permission = operation === 'write' ? 'write' : 'read'
    const allowed = grant ? role.memory[permission] : policy.memory[permission === 'write' ? 'controllerWrite' : 'controllerRead']
    if (policy.memory.mode === 'disabled' || !policy.memory.providers.includes(args.provider) || !allowed.includes(args.provider)) throw new Error('THALIRIS_MEMORY_PERMISSION_DENIED')
    const bound = grant?.bound ?? await binding(agent)
    if (operation === 'write' && policy.memory.mode === 'auto' && policy.memory.autoAuthorized !== true) throw new Error('THALIRIS_MEMORY_AUTO_OPT_IN_REQUIRED')
    if (operation === 'write' && policy.memory.mode === 'auto') {
      const selected = await bridge(parent, 'inspect', { task_id: args.task_id }, signal)
      if (selected.state.task_id !== args.task_id) throw new Error('THALIRIS_TASK_ID_CONFLICT')
    }
    if (operation === 'write' && policy.memory.mode !== 'auto') {
      const proposal = { task_id: args.task_id, proposal_id: randomUUID(), provider: args.provider, key: args.key, text: args.text, provenance: args.provenance, role: grant?.roleId ?? 'Controller', workspaceId: bound.workspaceId, policy: policy.memory.mode }
      const acknowledgement = await bridge(parent, 'proposal', { task_id: args.task_id, observation: JSON.stringify(proposal) }, signal)
      return { proposed: true, proposal_id: proposal.proposal_id, ...acknowledgement }
    }
    const capability = ctx.get('thalirisMemory')
    if (!capability) throw new Error('THALIRIS_MEMORY_CAPABILITY_UNAVAILABLE')
    return { value: await capability.invoke(args.provider, operation, { ...args, ...bound, signal, maxBytes: args.maxBytes ?? 16384 }) }
  }
  const bounds = { maxBytes: { type: 'integer', minimum: 1, maximum: 65536 } }
  register(MEMORY_TOOLS[0], 'Explicit bounded memory read under user provider and role grants.', object({ provider: string, key: string, ...bounds }), (args, agent, signal) => memory(args, agent, signal, 'read'), true)
  register(MEMORY_TOOLS[1], 'Explicit bounded provider search; never ambient context injection.', object({ provider: string, query: string, limit: { type: 'integer', minimum: 1, maximum: 20 }, ...bounds }), (args, agent, signal) => memory(args, agent, signal, 'search'), true)
  register(MEMORY_TOOLS[2], 'Propose a memory write for the explicitly selected task. Only persisted explicitly authorized auto policy writes immediately.', object({ task_id: string, provider: string, key: string, text: string, provenance: string }), (args, agent, signal) => memory(args, agent, signal, 'write'), true)
  // Host projection/approval seam; user configuration stays on native Settings.
  ctx.provide('thaliris', {
    templates: () => import('./policy.mjs').then(module => structuredClone(module.roleTemplates)),
    providers: () => ctx.get('thalirisMemory')?.list() ?? [],
    toolCatalog: () => ctx.tools.schemas().map(({ name, description }) => ({ name, description })),
    diagnostics: async (sessionId, taskId, signal) => withNativeRoot(sessionId, signal, async agent => {
      const task = await bridge(agent, 'inspect', { task_id: taskId }, signal)
      return { task, workspace: await binding(agent), configurationRevision: ctx.get('settings')?.describe({ redactSecrets: true }).find(row => row.ns === ctx.get('configEditor')?.entries().find(entry => entry.fiber?.runtime?.name === name)?.options.id)?.revision ?? null, permissions: { memory: readPolicy(config).memory, roles: readPolicy(config).roles.map(({ id, enabled, tools, memory, context, modelPolicy }) => ({ id, enabled, tools, memory, context, modelPolicy })) },
        providers: ctx.get('thalirisMemory')?.list() ?? [], reservations: await Promise.all(task.state.active_work.map(async value => {
          // One unreadable reservation is reported as UNKNOWN; it never fails the whole diagnostics read.
          let reservation
          try { reservation = JSON.parse(value) } catch { return { reservation: value, native: { outcome: 'UNKNOWN', reason: 'reservation is not adapter JSON' } } }
          return { reservation, native: await nativeObservation(agent, reservation ?? {}, signal, false).catch(error => { signal?.throwIfAborted(); return { outcome: 'UNKNOWN', reason: `native observation failed (${failureCode(error)})` } }) }
        })) }
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
    for (const cancellation of cancellations) cancellation.abort('Thaliris plugin unloaded')
    await Promise.allSettled([...runs].map(run => run.dispose()))
    await Promise.allSettled([...operations])
    runs.clear(); cancellations.clear(); taskContexts.clear(); restorations.clear()
  })
}
