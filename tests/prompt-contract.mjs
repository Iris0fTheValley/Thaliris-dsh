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
concepts(role('reviewer').prompt, 'independently', 'converged candidate', 'original acceptance', 'cross-boundary', 'non-writing', 'counterevidence', 'finding', 'unverified/insufficient', 'ready requires supported critical closure', 'not absence of blockers', 'design-preserving', 'controller')
concepts(role('investigator').prompt, 'broad facts', 'architecture decisions stay with controller', 'sufficient evidence', 'covered/uncovered')
const policy = read('../policy.mjs')
const controller = policy.match(/export const controllerTemplate = `([^`]+)`/s)?.[1]
assert.ok(controller)
concepts(controller, 'direction', 'scope', 'acceptance', 'next routing', 'methods belong to executor', 'decision-complete', 'authoritative source', 'derived relationships', 'verification entry', 'established inventory', 'fresh ordinary implementer', 'native completion is an observation')
// Known native call chain: role persona is passed separately from selected
// handoff. User grants/routes/schema are not replaced by prompt normalization.
const native = read('../index.mjs')
assert.ok(native.includes('persona: role.prompt'))
assert.ok(native.includes('...args.handoff'))
assert.ok(native.includes('toolFilter: { allow: role.tools, deny: TOOL_NAMES }'))
assert.ok(native.includes('maxDepth: 1'))
assert.ok(policy.includes("roles: z.array(roleSchema).default([])"))
console.log('DSH prompt contracts, generated bundle and unchanged native grants verified')
