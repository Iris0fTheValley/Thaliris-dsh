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
assert.deepEqual(roleTemplates.map(value => value.id), ['investigator', 'implementer', 'focused-implementer', 'reviewer', 'curator'])
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
}
for (const id of ['implementer', 'focused-implementer']) {
  concepts(role(id).prompt, 'before first mutation', 'current surfaces', 'authoritative/derived', 'working verification', 'established inventory', 'coherent semantic mutation', 'repair from new evidence', 'coupled', 'smallest tests', 'generate/sync', 'stale region', 'reconstructing', 'methods', 'mechanically', 'no retry/tool/token/time thresholds')
}
concepts(role('implementer').prompt, 'stable accepted direction', 'deterministic convergence', 'git closure', 'original acceptance')
concepts(role('focused-implementer').prompt, 'full reasoning', 'implementation', 'runtime feedback', 'revision', 'core implementation/invariants hold', 'unknowns are resolved', 'focused evidence', 'causal model', 'architecture', 'contract', 'scope', 'acceptance', 'direction', 'pass alone is insufficient', 'fresh ordinary implementer', 'does not extend this endpoint')
assert.ok(!role('focused-implementer').prompt.includes('Stop at original acceptance'))
concepts(role('reviewer').prompt, 'when selected', 'independently', 'converged candidate', 'original acceptance', 'cross-boundary', 'non-writing', 'counterevidence', 'finding', 'unverified/insufficient', 'ready requires supported evidence for the selected review scope', 'not absence of blockers', 'reports review findings rather than product completion', 'design-preserving', 'controller')
concepts(role('investigator').prompt, 'broad facts', 'architecture decisions stay with controller', 'sufficient evidence', 'covered/uncovered')
const policy = read('../policy.mjs')
const controller = policy.match(/export const controllerTemplate = `([^`]+)`/s)?.[1]
assert.ok(controller)
concepts(controller, 'direction', 'scope', 'acceptance', 'next routing', 'methods belong to executor', 'task records store selected intent and mechanical observations', 'controller retains the product-completion judgment', 'decision-complete', 'authoritative source', 'derived relationships', 'verification entry', 'established inventory', 'fresh ordinary implementer')
concepts(controller, 'independent, non-writing challenge when it could change a decision', 'review is optional', 'executors implement and verify assigned work', 'criterion-linked evidence', 'unknown to controller', 'controller judges product completion', 'original user objective', 'acceptance criteria', 'available evidence', 'mechanical closure', 'native completed', 'task done', 'none alone establishes product completion', 'ordinary controller reads, git and diagnostics are legal')
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
assert.ok(native.includes('toolFilter: { allow: role.tools, deny: TOOL_NAMES }'))
assert.ok(native.includes('maxDepth: 1'))
assert.ok(policy.includes("roles: z.array(roleSchema).default([])"))
console.log('DSH prompt contracts, generated bundle and unchanged native grants verified')
