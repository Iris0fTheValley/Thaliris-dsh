// Emitted semantic contracts and native policy preservation; no online model.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { roleTemplates } from '../role-templates.mjs'

const read = name => readFileSync(new URL(name, import.meta.url), 'utf8')
const role = id => roleTemplates.find(value => value.id === id)
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
}
assert.deepEqual(role('reasoning-specialist').tools, [], 'non-writing seed has no tool grants')
const policy = read('../policy.mjs')
// Known native call chain: role persona is passed separately from selected
// handoff. User grants/routes/schema are not replaced by prompt normalization.
const native = read('../index.mjs')
assert.ok(native.includes('persona: role.prompt'))
assert.ok(native.includes('...args.handoff'))
assert.ok(native.includes('toolFilter: { allow: evidence ? [...role.tools, ...EVIDENCE_TOOLS] : role.tools, deny: TOOL_NAMES }'))
assert.ok(native.includes("EVIDENCE_TOOLS = Object.freeze(['thaliris_observe'])"))
// DSH no longer accepts a per-request persona/toolFilter: the dispatch-time composition is
// installed on the reserved child's own scope before its first prompt assembly, and a
// Thaliris child is never re-created (resumed) without it.
assert.ok(native.includes("created.ctx.systemPrompt.section({ name: 'deployment:persona-prefix'"))
assert.ok(native.includes('created.ctx.tools.restrict(composition.toolFilter)'))
assert.ok(native.includes("childId, signal, delivery: 'caller'"))
assert.ok(native.includes("throw new Error('THALIRIS_CHILD_RESUME_DENIED')"))
const identityTools = ['thaliris_task_identity', 'thaliris_task_identity_amend', 'thaliris_task_identity_challenge', 'thaliris_task_identity_relate', 'thaliris_task_identity_note', 'thaliris_task_identity_suggest']
for (const name of ['thaliris_task_status', 'thaliris_task_context', 'thaliris_task_register', 'thaliris_task_judge', 'thaliris_task_mode', ...identityTools]) assert.ok(native.match(/export const TOOL_NAMES = Object\.freeze\(\[([^\]]+)\]/s)[1].includes(`'${name}'`), name)
// Identity tools are Controller-only: never child-allowed, never role grants, always on the dispatch deny list.
for (const name of identityTools) {
  assert.ok(name.startsWith('thaliris_task_'), name)
  assert.ok(policy.includes("tool.startsWith('thaliris_task_')"), 'role grants can never include identity tools')
}
const identityBlock = native.slice(native.indexOf('register(TOOL_NAMES[10]'), native.indexOf('register(EVIDENCE_TOOLS[0]'))
for (const index of [10, 11, 12, 13, 14, 15]) assert.ok(identityBlock.includes(`register(TOOL_NAMES[${index}]`), `identity tool ${index} is registered`)
assert.ok(!identityBlock.includes(', true)'), 'identity tools are never child-allowed')
assert.ok(native.includes("bridge(agent, `identity_${action}`"))
for (const operation of ['identity_amend', 'identity_challenge', 'identity_relate', 'identity_note', 'identity_suggest']) assert.ok(native.includes(`bridge(agent, '${operation}'`), operation)
assert.ok(native.includes('const role = grant?.role'), 'children keep the dispatch-time role binding')
assert.ok(policy.includes("tool === 'thaliris_observe'"), 'observation grants are per dispatch, never role policy')
assert.ok(native.includes('maxDepth: 1'))
assert.ok(policy.includes("roles: z.array(roleSchema).default([])"))
console.log('DSH prompt contracts, generated bundle and unchanged native grants verified')
