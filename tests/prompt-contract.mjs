// Emitted semantic contracts and native policy preservation; no online model.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { roleTemplates } from '../role-templates.mjs'

const read = name => readFileSync(new URL(name, import.meta.url), 'utf8')
const role = id => roleTemplates.find(value => value.id === id)
const concepts = (prompt, ...anchors) => {
  const value = prompt.toLowerCase()
  for (const anchor of anchors) assert.ok(value.includes(anchor), anchor)
}
assert.deepEqual(roleTemplates.map(value => value.id), ['investigator', 'implementer', 'focused-implementer', 'reviewer', 'curator', 'reasoning-specialist'])
// Verifier is a Codex compatibility role and is intentionally not seeded here.
assert.ok(!roleTemplates.some(value => value.id === 'verifier'))
const patch = JSON.parse(read('../cordis.patch.yml'))[0].insert
assert.deepEqual(patch[0].config.policy.roles, roleTemplates)
assert.equal(patch[0].disabled, true)
assert.equal(patch[1].disabled, true)
for (const value of roleTemplates) {
  assert.deepEqual(value.tools, [])
  assert.deepEqual(value.modelPolicy, { mode: 'inherit', routes: [] })
  assert.deepEqual(value.memory, { read: [], write: [] })
  assert.deepEqual(value.context, { handoff: true, memory: false })
  concepts(value.prompt, 'selected handoff', 'hard invariants', 'decided boundaries', 'decision-changing unknown', 'final', 'private', 'distilled')
  concepts(value.prompt, 'thaliris_observe', 'source refs', 'adapter binds task, handoff, candidate and requirement refs', 'do not supply or reconstruct', 'return the observation and its sources in final', 'no search obligation', 'do not reconstruct global requirements or judge their satisfaction', 'not current truth')
}
for (const id of ['implementer', 'focused-implementer']) {
  concepts(role(id).prompt, 'before first mutation', 'current surfaces', 'authoritative/derived', 'working verification', 'established inventory', 'coherent semantic mutation', 'repair from new evidence', 'coupled', 'smallest tests', 'generate/sync', 'stale region', 'reconstructing', 'methods', 'mechanically', 'no retry/tool/token/time thresholds')
}
concepts(role('implementer').prompt, 'stable accepted direction', 'deterministic convergence', 'git closure', 'selected local acceptance', 'pass alone does not end an unfinished assignment')
concepts(role('focused-implementer').prompt, 'full reasoning', 'implementation', 'runtime feedback', 'revision', 'core implementation/invariants hold', 'unknowns are resolved', 'focused evidence', 'causal model', 'architecture', 'contract', 'scope', 'acceptance', 'direction', 'pass alone is insufficient', 'explicit remaining work', 'without choosing a successor role or session', 'controller decides what follows', 'does not extend this endpoint')
assert.ok(!role('focused-implementer').prompt.includes('Stop at original acceptance'))
concepts(role('reviewer').prompt, 'when selected', 'independently', 'converged candidate', 'original acceptance', 'cross-boundary', 'non-writing', 'counterevidence', 'finding', 'unverified/insufficient', 'ready requires supported evidence for the selected review scope', 'not absence of blockers', 'reports review findings rather than product completion', 'design-preserving', 'controller')
concepts(role('reasoning-specialist').prompt, 'when selected', 'independently challenge', 'framing and decision basis', 'could change direction', 'hidden assumptions', 'causal model', 'premature convergence', 'material alternatives', 'evidence from inference', 'strongest material challenge', 'missing facts', 'non-writing', 'do not delegate, gather broad facts, implement', 'routine review', 'final task decision')
assert.deepEqual(role('reasoning-specialist').tools, [], 'non-writing seed has no tool grants')
concepts(role('investigator').prompt, 'broad facts', 'architecture decisions stay with controller', 'sufficient evidence', 'covered/uncovered')
const policy = read('../policy.mjs')
const controller = policy.match(/export const controllerTemplate = `([^`]+)`/s)?.[1]
assert.ok(controller)
concepts(controller, 'direction', 'scope', 'acceptance', 'next routing', 'methods belong to executor', 'task records store selected intent and mechanical observations', 'controller retains the product-completion judgment', 'decision-complete', 'authoritative source', 'derived relationships', 'verification entry', 'established inventory', 'fresh ordinary implementer')
concepts(controller, 'independent, non-writing challenge when it could change a decision', 'review is optional', 'executors implement and verify assigned work', 'criterion-linked evidence', 'unknown to controller', 'controller judges product completion', 'original user objective', 'acceptance criteria', 'available evidence', 'mechanical closure', 'native completed', 'task done', 'none alone establishes product completion', 'ordinary controller reads, git and diagnostics are legal')
concepts(controller, 'reasoning specialist', 'without choosing a successor', 'controller decides what follows', 'model route and reasoning effort per dispatch', 'allowed routes', 'recorded with the reservation', 'changes neither role responsibility nor permissions', 'role bound at dispatch', 'cognitive isolation and division of labor come first', 'cheapest allowed route and lowest reasoning effort', 'long-running observation', 'escalate only on evidence', 'allows no cheap route', 'user policy')
concepts(controller, 'thaliris_task_register', 'evidence association', 'thaliris_observe', 'adapter binds', 'children never judge requirements', 'controller never authors child observations', 'thaliris_task_status', 'thaliris_task_judge', 'satisfied, unknown, repair or no-current-impact', 'exact observation refs', 'judgment_refs', 'not disposition', 'candidate label is not an observed repository state', 'not automatically current truth')
concepts(controller, 'thaliris_task_context', 'facts, decisions, progress, open items, milestone', 'after compaction or resume', 'not fresh verification', 'thaliris_task_mode', 'actual human instruction', 'expected authority digest', 'active work is resolved', 'stay frozen', "no mode widens a child's role, tool grants or readonly limits")
concepts(controller, 'project identity is separate from task authority, the memory provider, milestones and evidence', 'thaliris_task_identity', 'status, get, trace', 'legacy memory labels', 'confer nothing', 'absent identity is normal and blocks nothing', "only on the user's decision", 'one summary line', 'directional or architectural work', 'replanning', 'cross-layer conflicts', 'before turning an implementation limit into a principle', 'not for ordinary local repairs', 'locate the layer', 'trace up', 'lowest sufficient layer', 'thaliris_task_identity_challenge', 'instead of editing it', 'thaliris_task_identity_amend', "human owner's explicit decision", 'quote it', 'give the rationale', 'why it is insufficient', 'not a memory provider proposal or approval', "never rewrites a running task's frozen contract", 'nothing propagates automatically', 'which registered dependents to revalidate', 'thaliris_task_identity_relate', 'significant decisions, designs or experiments', 'trace covers registered relations only', 'absence of a relation is not evidence of independence', 'quote selected items into a handoff')
concepts(controller, 'preserve delegated, controller-direct and single-agent modes', 'further verification may be delegated when it could change the decision', 'suitable existing role or the current execution mode', 'no fixed closing stage or automatic spawn is required')
assert.ok(!controller.toLowerCase().includes('closing handoff'))
for (const id of ['implementer', 'focused-implementer']) concepts(role(id).prompt, 'criterion-linked verification', 'evidence limits', 'unknown to controller', 'controller judges product completion', 'original objective', 'acceptance criteria', 'mechanical closure', 'test pass', 'reviewer ready', 'native completed', 'not product completion')
concepts(controller, 'stable narrative base language', 'precision-bearing original terms', 'quotations, distinctions and user formulations', 'materially blur, broaden, narrow or expand', 'forced monolingual translation', 'random language switching', 'bilingual repetition', 'output language requirements', 'compression and handoff')
assert.equal(controller.split('stable narrative base language').length - 1, 1)
for (const value of roleTemplates) assert.ok(!value.prompt.includes('stable narrative base language'))
concepts(controller, 'authoritative artifact, source, revision and provenance', 'before delegation', 'later workstream', 'operational acceptance', 'project/package', 'fixtures', 'isolated smoke', 'packed artifacts', 'project-local', 'effective live host', 'global instructions', 'profiles', 'hooks', 'trust', 'separate host maintenance authority')
concepts(controller, 'accepted contract uniquely determines', 'compatibility authority ambiguity remains semantic', 'production behavior and historical fixtures', 'representative evidence', 'does not mandate full regression', 'same semantic closure', 'fresh ordinary session', 'explicit inputs and available evidence', 'accumulated debugging state adds no benefit', 'green evidence, provenance, remaining acceptance and blockers, not raw history')
for (const id of ['implementer', 'focused-implementer']) concepts(role(id).prompt, 'authority ambiguity', 'compatibility, ownership, security, lifecycle or contract', 'many failures, many files or long regression alone do not require escalation', 'project/package install-smoke closure excludes effective live host', 'separate authority')
concepts(role('focused-implementer').prompt, 'production behavior and historical fixtures', 'representative evidence', 'dependency to controller', 'do not classify that ambiguity as mechanical compatibility', 'full regression by default')
assert.ok(!controller.includes('codex-install'))
// Known native call chain: role persona is passed separately from selected
// handoff. User grants/routes/schema are not replaced by prompt normalization.
const native = read('../index.mjs')
assert.ok(native.includes('Controller records the mechanical DONE state after judging product completion from the task contract and available evidence.'))
assert.ok(native.includes('persona: role.prompt'))
assert.ok(native.includes('...args.handoff'))
assert.ok(native.includes('toolFilter: { allow: evidence ? [...role.tools, ...EVIDENCE_TOOLS] : role.tools, deny: TOOL_NAMES }'))
assert.ok(native.includes("EVIDENCE_TOOLS = Object.freeze(['thaliris_observe'])"))
const identityTools = ['thaliris_task_identity', 'thaliris_task_identity_amend', 'thaliris_task_identity_challenge', 'thaliris_task_identity_relate']
for (const name of ['thaliris_task_status', 'thaliris_task_context', 'thaliris_task_register', 'thaliris_task_judge', 'thaliris_task_mode', ...identityTools]) assert.ok(native.match(/export const TOOL_NAMES = Object\.freeze\(\[([^\]]+)\]/s)[1].includes(`'${name}'`), name)
// Identity tools are Controller-only: never child-allowed, never role grants, always on the dispatch deny list.
for (const name of identityTools) {
  assert.ok(name.startsWith('thaliris_task_'), name)
  assert.ok(policy.includes("tool.startsWith('thaliris_task_')"), 'role grants can never include identity tools')
}
const identityBlock = native.slice(native.indexOf('register(TOOL_NAMES[10]'), native.indexOf('register(EVIDENCE_TOOLS[0]'))
for (const index of [10, 11, 12, 13]) assert.ok(identityBlock.includes(`register(TOOL_NAMES[${index}]`), `identity tool ${index} is registered`)
assert.ok(!identityBlock.includes(', true)'), 'identity tools are never child-allowed')
assert.ok(native.includes("bridge(agent, `identity_${action}`"))
for (const operation of ['identity_amend', 'identity_challenge', 'identity_relate']) assert.ok(native.includes(`bridge(agent, '${operation}'`), operation)
assert.ok(native.includes('const role = grant?.role'), 'children keep the dispatch-time role binding')
assert.ok(policy.includes("tool === 'thaliris_observe'"), 'observation grants are per dispatch, never role policy')
assert.ok(native.includes('maxDepth: 1'))
assert.ok(policy.includes("roles: z.array(roleSchema).default([])"))
console.log('DSH prompt contracts, generated bundle and unchanged native grants verified')
