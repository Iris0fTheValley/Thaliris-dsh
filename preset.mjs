// Preset-scoped (model-visible) half of Thaliris.
//
// This module is mounted ONLY as a child row of the `thaliris` Agent Preset:
//   { id: 'thaliris-agent', name: '@thaliris/dsh-plugin/preset' }
// A preset mount is eager, so `apply` must be side-effect free: every contribution below
// is registered on this preset scope (tools, prompt sections, dynamic contexts, scoped
// event listeners) and therefore exists only for Agents bound to the preset. An
// unselected/Standard session sees no Thaliris tool, no Controller prompt section and no
// task context — that scope layering is the R-NO-INJECT mechanism, not a runtime check.
//
// The host side (./index.mjs) is always active and supplies the `thaliris` service this
// module injects: tolerant config, Core bridge execution, Workspace/root binding, memory
// capability and the programmatic preset registration itself.
import { createHash, randomUUID } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'
import { nativeToolGrants, readPolicy, selectedRole } from './policy.mjs'

export const name = 'thaliris-preset'
/** Host services the preset child consumes; `thaliris` is provided by the always-active global row. */
export const inject = ['thaliris', 'agents', 'llm', 'sessionPersistence', 'subagents', 'systemPrompt', 'tools']

export const TOOL_NAMES = Object.freeze(['thaliris_task_start', 'thaliris_task_inspect', 'thaliris_workstream', 'thaliris_task_close', 'thaliris_reconcile',
  'thaliris_task_status', 'thaliris_task_context', 'thaliris_task_register', 'thaliris_task_judge', 'thaliris_task_mode',
  'thaliris_task_identity', 'thaliris_task_identity_amend', 'thaliris_task_identity_challenge', 'thaliris_task_identity_relate',
  'thaliris_task_identity_note', 'thaliris_task_identity_suggest'])
export const MEMORY_TOOLS = Object.freeze(['thaliris_memory_read', 'thaliris_memory_search', 'thaliris_memory_propose'])
/** Granted by the adapter only to a child whose dispatch carries an evidence association. */
export const EVIDENCE_TOOLS = Object.freeze(['thaliris_observe'])
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

/** Side-effect-free apply: all contributions are owned by this preset scope and disposed with it. */
export function apply(ctx) {
  const service = ctx.thaliris
  let disposed = false, tail = Promise.resolve()
  // The native role-grant picker needs the model-visible catalog, which now lives in this
  // preset scope rather than the host plane. The host service merges it and filters the
  // Controller/management tools that are never role grants.
  if (typeof service.attachToolCatalog === 'function') ctx.effect(() => service.attachToolCatalog(() => ctx.tools.schemas()))
  const cancellations = new Set(), operations = new Set(), runs = new Set(), childGrants = new WeakMap()
  // Dispatch-time child composition keyed by the reserved native child id: the role
  // persona and the exact tool grant, installed on the child's own scope exactly as
  // DSH formerly applied a per-request persona and toolFilter.
  const compositions = new Map(), gates = new Set()
  // `global: true` is deliberate. A dispatched child selects the per-dispatch gate preset
  // during creation, so its scope chain still points at that gate when `agent/created`
  // fires; a scope-filtered listener would never see it. The handler therefore gates on
  // its own dispatch map and on the Thaliris subagent descriptor, never on ambient state.
  ctx.on('agent/created', async ({ agent: created, source }) => {
    const composition = compositions.get(created.id)
    if (composition) {
      const { presets } = composition
      if (created.session.header.parentSession !== composition.parent.id) throw new Error('THALIRIS_NATIVE_CHILD_IDENTITY_REQUIRED')
      // DSH recorded the per-dispatch gate as this child's independent preset selection,
      // so its own cold resume mounts only that gate and refuses once it is unregistered.
      // Read the recorded event rather than a versioned reader method: the same session-log
      // record is the interface DSH cold resume restores in every compatible 0.2.1 release.
      if (!created.session.snapshotEvents().some(event => event.type === 'agent-preset/selected' && event.data?.agentPreset === composition.gate)) throw new Error('THALIRIS_CHILD_RESUME_GATE_REQUIRED')
      // The gate composes nothing: the dispatched child joins the parent's preset as before.
      if (composition.parentPreset !== undefined) await presets.recompose(created.ctx, composition.parentPreset)
      if (presets.composedPreset(created.ctx) !== (composition.parentPreset ?? composition.gate)) throw new Error('THALIRIS_NATIVE_CHILD_IDENTITY_REQUIRED')
      created.ctx.systemPrompt.section({ name: 'deployment:persona-prefix', order: created.ctx.systemPrompt.getSectionOrder('DEPLOYMENT_PERSONA_PREFIX'), text: composition.persona })
      created.ctx.tools.restrict(composition.toolFilter)
      composition.applied++
      return
    }
    // A dispatched child is one-shot: its grants exist only for its dispatch, so it is
    // never re-created (resumed or continued) without them.
    if (source !== 'startup' && created.session.header.origin === 'subagent' && created.session.snapshotEvents().some(event => event.type === 'subagent/descriptor' && String(event.data?.label).startsWith('thaliris:'))) {
      throw new Error('THALIRIS_CHILD_RESUME_DENIED')
    }
  }, { global: true })
  // Bounded Controller task context per native root, re-supplied as DSH dynamic
  // context; it is recorded history, never acceptance.
  const taskContexts = new Map(), restorations = new Map()
  function isNativeRoot(agent) {
    const header = agent?.session.header
    return !!agent && ctx.agents.get(agent.id) === agent && ctx.agents.roots().includes(agent)
      && header.id === agent.id && header.parentSession === undefined && header.isSeeded === false
      && (header.delegationDepth ?? 0) === 0 && header.origin !== 'subagent' && !!header.cwd
  }
  ctx.systemPrompt.section({ name: 'thaliris:controller-contract', order: ctx.systemPrompt.getSectionOrder('TEAM_POLICY'),
    text: ({ agent }) => {
      if (!isNativeRoot(agent)) return ''
      try {
        const cwd = realpathSync(agent.session.header.cwd), policy = service.policy()
        return policy.workspaces.some(row => {
          if (!row.enabled) return false
          try {
            const workspacePath = service.workspacePath(row.workspaceId)
            return realpathSync(row.root) === cwd && workspacePath && realpathSync(workspacePath) === cwd
          } catch { return false }
        }) ? policy.controllerPrompt : ''
      } catch { return '' }
    },
  })
  ctx.systemPrompt.context({ name: 'thaliris:task-context', order: ctx.systemPrompt.getContextOrder('SUBAGENT_DELEGATION') + 1,
    text: ({ agent }) => {
      if (disposed || !isNativeRoot(agent)) return ''
      if (!taskContexts.has(agent.id)) { restoreContext(agent); return '' }
      return contextText(agent)
    },
  })
  // The provider above is synchronous, so the first assembly after a restart
  // awaits restoration here and fills that same context entry: the first model
  // step already carries the recorded task context. The waterfall itself is not
  // scope-filtered, so the gate is this preset's own context entry: an unselected
  // session has no `thaliris:task-context` entry and is never touched.
  ctx.on('system-prompt/assemble', async (assembly, context, next) => {
    const agent = context.agent
    const entry = assembly.contexts.find(item => item.name === 'thaliris:task-context')
    if (!disposed && entry && isNativeRoot(agent) && !taskContexts.has(agent.id)) {
      await restoreContext(agent)
      if (entry && !entry.text && !disposed && taskContexts.has(agent.id)) entry.text = contextText(agent)
    }
    return next()
  })
  function contextText(agent) {
    return [...(taskContexts.get(agent.id)?.values() ?? [])].filter(Boolean).join('\n\n')
  }
  function rememberContext(agent, taskId, text) {
    if (!agent || typeof taskId !== 'string' || text === undefined) return
    const contexts = taskContexts.get(agent.id) ?? new Map()
    if (text) contexts.set(taskId, text)
    else contexts.delete(taskId)
    taskContexts.set(agent.id, contexts)
  }
  /** After a process restart, restore context for tasks anchored to this exact native root (once; never rejects). */
  function restoreContext(agent) {
    if (restorations.has(agent.id)) return restorations.get(agent.id)
    const cancel = new AbortController()
    cancellations.add(cancel)
    const restoration = bridge(agent, 'resume', {}, cancel.signal).then(result => {
      if (taskContexts.has(agent.id)) return
      taskContexts.set(agent.id, new Map(result.tasks.filter(task => task.task_context).map(task => [task.task_id, task.task_context])))
    }, () => {}).finally(() => cancellations.delete(cancel))
    restorations.set(agent.id, restoration)
    return restoration
  }
  function bridge(agent, operation, args, signal) {
    return service.bridge(agent, operation, args, signal).then(result => {
      if (result && Object.hasOwn(result, 'task_context') && isNativeRoot(agent)) rememberContext(agent, args.task_id, result.task_context)
      if (operation === 'close' && result?.status === 'DONE') rememberContext(agent, args.task_id, null)
      // The bounded summary is already re-supplied as dynamic context; the full status view keeps it for explicit reads.
      if (result && Object.hasOwn(result, 'task_context') && operation !== 'resume' && !(operation === 'status' && args.view === 'full')) { const { task_context, ...visible } = result; return visible }
      return result
    })
  }
  function register(toolName, description, parameters, body, childAllowed = false) {
    ctx.tools.register({ name: toolName, description, parameters,
      output: { schema: { type: 'object', additionalProperties: true }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
      async execute(args, exec) {
        if (disposed || ctx.agents.get(exec.agent?.id) !== exec.agent || (!isNativeRoot(exec.agent) && !(childAllowed && childGrants.has(exec.agent)))) throw new Error('THALIRIS_NATIVE_ROOT_REQUIRED')
        validate(parameters, args)
        const cancel = new AbortController(), signal = AbortSignal.any([exec.signal, cancel.signal])
        cancellations.add(cancel)
        const work = async () => { signal.throwIfAborted(); if (isNativeRoot(exec.agent)) await service.binding(exec.agent); return body(args, exec.agent, signal) }
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
    const policy = service.policy(), role = structuredClone(selectedRole(policy, args.role))
    if (!role.context.handoff) throw new Error('THALIRIS_ROLE_HANDOFF_DENIED')
    // Stored roles may name tools a narrower host does not provide. Apply what the host
    // resolves and report the rest; a stale grant must never break child creation and the
    // user's stored row is never rewritten here.
    const { granted, unknown } = nativeToolGrants(role.tools, ctx.tools.schemas(agent).map(tool => tool.name))
    if (unknown.length) ctx.logger.warn(`thaliris: role ${role.id} grants tools this host does not provide: ${unknown.join(', ')}`)
    const provider = ctx.subagents.getProvider(service.config().subagentProvider)
    if (!provider || provider.inheritsParentContext !== false) throw new Error('THALIRIS_FRESH_PROVIDER_REQUIRED')
    // The resume gate needs independent preset selection; without it a finished child
    // could later be continued with the parent's composition and none of its grants.
    // Probe the service's interface, not a package version: every compatible 0.2.1
    // release supplies these three methods even when internal method sets differ.
    const presets = ctx.get('agentPresets')
    const resumeGatePort = !!presets && typeof presets.register === 'function' && typeof presets.composedPreset === 'function' && typeof presets.recompose === 'function'
    if (!resumeGatePort || provider.capabilities?.agentPreset !== true) throw new Error('THALIRIS_CHILD_RESUME_GATE_UNAVAILABLE')
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
    const bound = await service.binding(agent)
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
    let run, child
    const reservationBound = Promise.withResolvers()
    reservationBound.promise.catch(() => {})
    // DSH composes new children through Agent Presets and no longer accepts a
    // per-request persona or tool filter. The child identity is reserved here and
    // its exact dispatch-time composition is installed on the child's own scope by
    // the `agent/created` listener, before the child's first prompt assembly.
    // DSH records local children as continuable and cold-resumes them without this
    // plugin. The child therefore selects a per-dispatch gate preset that exists only
    // while its dispatch runs: DSH refuses to restore a child whose selected preset is
    // missing and never falls back to the parent's composition, so once the dispatch
    // ends (or the plugin unloads) DSH itself rejects continuing the child.
    const childId = randomUUID(), gate = `thaliris-dispatch-${childId}`
    const composition = { parent: agent, presets, gate, parentPreset: presets.composedPreset(agent.ctx), persona: role.prompt, toolFilter: { allow: evidence ? [...granted, ...EVIDENCE_TOOLS] : granted, deny: TOOL_NAMES }, applied: 0 }
    let releaseGate
    compositions.set(childId, composition)
    try {
      releaseGate = await presets.register({ id: gate, name: 'Thaliris dispatch', description: 'Internal: exists only while one Thaliris child dispatch runs, so the child cannot be continued afterwards. Not for session selection.', plugins: [] })
      gates.add(releaseGate)
      run = await ctx.subagents.startActivation({ provider: service.config().subagentProvider, label: selected.correlation, childId, signal, delivery: 'caller',
        request: { parent: agent, prompt: [{ type: 'text', text: prompt }], agentPreset: gate, maxDepth: 1, ...(route ? { agentOptions: route } : {}) } })
      runs.add(run)
      child = ctx.agents.get(run.childId)
      if (run.childId !== childId || composition.applied !== 1 || !child || child.session.header.parentSession !== agent.id || child.session.header.isSeeded !== false) throw new Error('THALIRIS_NATIVE_CHILD_IDENTITY_REQUIRED')
      childGrants.set(child, { role, roleId: role.id, parent: agent, bound, taskId: args.task_id, evidence, reservationBound: reservationBound.promise })
      // Commit observed ID immediately, before awaiting the result. Catalog label covers the preceding crash window.
      await ctx.sessionPersistence.flush()
      const beforeBind = await bridge(agent, 'inspect', { task_id: args.task_id }, signal)
      begun = await bridge(agent, 'bind', { task_id: args.task_id, base_revision: beforeBind.state.revision, observation: JSON.stringify({ ...selected, child_id: run.childId }) }, signal)
      reservationBound.resolve()
      const result = await run.result
      await ctx.sessionPersistence.flush()
      // The dispatch record archives the reservation, which carries route, role digest and evidence handoff.
      const observed = { workstream: selected.workstream, role: selected.role, handoff_sha256: selected.handoff_sha256, correlation: selected.correlation, child_id: run.childId, stop_reason: result.stopReason, provenance: 'native-run-result' }
      const beforeFinish = await bridge(agent, 'inspect', { task_id: args.task_id }, signal)
      // The release returns the compact open-evidence summary (totals plus bounded items) and the new revision with the child result.
      const { evidence: openEvidence, ...ack } = await bridge(agent, 'finish', { task_id: args.task_id, base_revision: beforeFinish.state.revision, observation: JSON.stringify(observed) }, signal)
      const value = { ...ack, child_id: run.childId, stop_reason: result.stopReason, native_completed: result.stopReason === 'completed', route: route ? { ...route } : 'inherit', role_sha256: selected.role_sha256,
        ...(evidence ? { evidence_handoff_id: evidence.handoff_id, candidate: evidence.candidate } : {}),
        evidence_continuity: openEvidence ?? 'UNKNOWN', output: result.output }
      if (result.stopReason !== 'completed') throw new Error('THALIRIS_NATIVE_CHILD_FAILED: ' + JSON.stringify(value))
      return value
    } finally {
      reservationBound.reject(new Error('THALIRIS_DISPATCH_ENDED')); if (child) childGrants.delete(child)
      try { if (run) { await run.dispose(); runs.delete(run) } } finally {
        compositions.delete(childId)
        // Unregistering the gate is what makes DSH refuse any later continuation of this child.
        if (releaseGate && gates.delete(releaseGate)) await releaseGate()
      }
    }
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

  async function reconcile(agent, args, signal) {
    // A stale revision is refused by the bridge with the structured conflict (code, recovery, changes_since).
    const inspected = await bridge(agent, 'inspect', { task_id: args.task_id, base_revision: args.base_revision }, signal)
    if (inspected.state.active_work.length !== 1) throw new Error('THALIRIS_RESERVATION_REQUIRED')
    const reservation = JSON.parse(inspected.state.active_work[0])
    const observation = await service.nativeObservation(agent, reservation, signal, args.action === 'cancel-reconcile')
    if (args.action === 'check' || observation.outcome === 'UNKNOWN') return { ...observation, released: false }
    return { ...await bridge(agent, 'reconcile', { task_id: args.task_id, base_revision: args.base_revision, observation: JSON.stringify({ ...reservation, ...observation }) }, signal), ...observation, released: true, native_completed: observation.outcome === 'completed' }
  }
  register(TOOL_NAMES[4], 'Check/reconcile a crash reservation using native catalog and durable terminal Session evidence. UNKNOWN never auto releases.',
    object({ ...identitySchema, action: { type: 'string', enum: ['check', 'reconcile', 'cancel-reconcile'] } }), async (args, agent, signal) => {
      const result = await reconcile(agent, args, signal)
      if (result.released) await bridge(agent, 'inspect', { task_id: args.task_id }, signal).catch(() => {})
      return result
    })

  async function memory(args, agent, signal, operation) {
    const policy = service.policy(), grant = childGrants.get(agent), parent = grant?.parent ?? agent
    if (operation === 'write' && grant && args.task_id !== grant.taskId) throw new Error('THALIRIS_TASK_ID_CONFLICT')
    // A child keeps the role bound at its dispatch.
    const role = grant?.role
    if (grant && (!role.context.memory || !role.tools.includes(operation === 'read' ? MEMORY_TOOLS[0] : operation === 'search' ? MEMORY_TOOLS[1] : MEMORY_TOOLS[2]))) throw new Error('THALIRIS_MEMORY_PERMISSION_DENIED')
    const permission = operation === 'write' ? 'write' : 'read'
    const allowed = grant ? role.memory[permission] : policy.memory[permission === 'write' ? 'controllerWrite' : 'controllerRead']
    if (policy.memory.mode === 'disabled' || !policy.memory.providers.includes(args.provider) || !allowed.includes(args.provider)) throw new Error('THALIRIS_MEMORY_PERMISSION_DENIED')
    const bound = grant?.bound ?? await service.binding(agent)
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
    const capability = service.memoryCapability()
    if (!capability) throw new Error('THALIRIS_MEMORY_CAPABILITY_UNAVAILABLE')
    return { value: await capability.invoke(args.provider, operation, { ...args, ...bound, signal, maxBytes: args.maxBytes ?? 16384 }) }
  }
  const bounds = { maxBytes: { type: 'integer', minimum: 1, maximum: 65536 } }
  register(MEMORY_TOOLS[0], 'Explicit bounded memory read under user provider and role grants.', object({ provider: string, key: string, ...bounds }), (args, agent, signal) => memory(args, agent, signal, 'read'), true)
  register(MEMORY_TOOLS[1], 'Explicit bounded provider search; never ambient context injection.', object({ provider: string, query: string, limit: { type: 'integer', minimum: 1, maximum: 20 }, ...bounds }), (args, agent, signal) => memory(args, agent, signal, 'search'), true)
  register(MEMORY_TOOLS[2], 'Propose a memory write for the explicitly selected task. Only persisted explicitly authorized auto policy writes immediately.', object({ task_id: string, provider: string, key: string, text: string, provenance: string }), (args, agent, signal) => memory(args, agent, signal, 'write'), true)
  ctx.effect(() => async () => {
    disposed = true
    for (const cancellation of cancellations) cancellation.abort('Thaliris preset unloaded')
    await Promise.allSettled([...runs].map(run => run.dispose()))
    await Promise.allSettled([...operations])
    // Dispatches interrupted by unload release their gates here: their children stay non-resumable.
    await Promise.allSettled([...gates].map(release => release()))
    gates.clear(); runs.clear(); cancellations.clear(); taskContexts.clear(); restorations.clear(); compositions.clear()
  })
}
