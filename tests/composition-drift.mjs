// Drift gate for the committed Standard-composition mirror.
//
// A programmatic Agent Preset definition replaces the whole agent composition, so
// composition.mjs mirrors DSH's shipped Standard preset child rows and appends the
// Thaliris model-visible row. When the host composition changes, the mirror must be
// regenerated; this gate fails loudly instead of silently dropping a native tool.
//
// Run through tests/run-native.mjs (needs DSH_SOURCE and the checkout's node_modules).
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  PLATFORM_EXPRESSIONS, readPresetDeclaration,
} from '../build-composition.mjs'
import {
  STANDARD_COMPOSITION, THALIRIS_AGENT_ROW, THALIRIS_PRESET_DESCRIPTION, THALIRIS_PRESET_ID,
  THALIRIS_PRESET_NAME, THALIRIS_PRESET_ORDER, thalirisPresetDefinition,
} from '../composition.mjs'

const source = process.env.DSH_SOURCE
assert.ok(source, 'Set DSH_SOURCE to a compatible DSH checkout for the composition drift gate.')
const version = JSON.parse(readFileSync(resolve(source, 'package.json'), 'utf8')).version
console.log(`Composition drift gate: DSH ${version} at ${resolve(source)}`)

/** The Loader's serialized `!!js` expression node. */
const isJsExpr = value => !!value && typeof value === 'object' && typeof value.__jsExpr === 'string'

/** Evaluate one platform condition exactly as the generated module's `WINDOWS` constants do. */
function conditionValue(expression) {
  const mapped = PLATFORM_EXPRESSIONS[expression.trim()]
  if (mapped === undefined) {
    throw new Error(`DSH ${version} standard preset uses an unsupported platform condition ${JSON.stringify(expression)}; `
      + 'classify it in build-composition.mjs PLATFORM_EXPRESSIONS, regenerate composition.mjs, and re-run this gate.')
  }
  return mapped === 'WINDOWS' ? process.platform === 'win32' : process.platform !== 'win32'
}

/** Refuse any host expression outside `disabled`, which the mirror cannot represent. */
function assertNoElsewhereExpr(value, at) {
  if (isJsExpr(value)) throw new Error(`DSH ${version} standard preset has a !!js expression outside "disabled" at ${at}; the generated mirror must be extended.`)
  if (Array.isArray(value)) value.forEach((item, index) => assertNoElsewhereExpr(item, `${at}[${index}]`))
  else if (value !== null && typeof value === 'object') for (const [key, item] of Object.entries(value)) assertNoElsewhereExpr(item, `${at}.${key}`)
}

/** Comparable projection of one declared row (the host side keeps expressions until compared). */
function projectHostRow(row, at) {
  assert.ok(row && typeof row === 'object' && !Array.isArray(row), `${at} is not a plugin row`)
  assert.equal(typeof row.name, 'string', `${at} has no module name`)
  assertNoElsewhereExpr(row.config, `${at}.config`)
  return {
    id: row.id,
    name: row.name,
    group: row.group,
    isolate: row.isolate,
    disabled: isJsExpr(row.disabled) ? conditionValue(row.disabled.__jsExpr) : row.disabled,
    config: Array.isArray(row.config) ? row.config.map((child, index) => projectHostRow(child, `${at}.config[${index}]`)) : row.config,
  }
}

function projectMirrorRow(row, at) {
  return {
    id: row.id,
    name: row.name,
    group: row.group,
    isolate: row.isolate,
    disabled: row.disabled,
    config: Array.isArray(row.config) ? row.config.map((child, index) => projectMirrorRow(child, `${at}.config[${index}]`)) : row.config,
  }
}

const declaration = readPresetDeclaration(source)
const hostComposition = declaration.config.plugins.map((row, index) => projectHostRow(row, `standard.plugins[${index}]`))
const mirror = STANDARD_COMPOSITION.map((row, index) => projectMirrorRow(row, `STANDARD_COMPOSITION[${index}]`))
const regeneration = `Regenerate with: DSH_SOURCE=<checkout> node build-composition.mjs (from ${version}) and commit composition.mjs.`
assert.equal(mirror.length, hostComposition.length, `DSH ${version} standard preset row count changed (${hostComposition.length} host rows vs ${mirror.length} mirrored); ${regeneration}`)
for (const [index, host] of hostComposition.entries()) {
  assert.deepEqual(mirror[index], host, `DSH ${version} standard preset row ${index + 1} (${host.id ?? host.name}) changed; ${regeneration}`)
}

// The appended preset child row is what carries the Thaliris model-visible surface.
assert.ok(!hostComposition.some(row => row.id === THALIRIS_AGENT_ROW.id), 'the host Standard preset must not already declare a thaliris-agent row')
assert.deepEqual({ ...THALIRIS_AGENT_ROW }, { id: 'thaliris-agent', name: '@thaliris/dsh-plugin/preset' })
const definition = thalirisPresetDefinition()
assert.equal(definition.id, THALIRIS_PRESET_ID)
assert.equal(definition.name, THALIRIS_PRESET_NAME)
assert.equal(definition.description, THALIRIS_PRESET_DESCRIPTION)
assert.equal(definition.order, THALIRIS_PRESET_ORDER, 'Thaliris order must stay after the four built-in presets (1-4)')
assert.ok(definition.order > 4)
assert.deepEqual(definition.plugins.at(-1), THALIRIS_AGENT_ROW, 'the Thaliris preset row is appended last, after the Standard mirror')
assert.equal(definition.plugins.length, STANDARD_COMPOSITION.length + 1)
console.log(`PASS ${mirror.length} mirrored Standard rows + appended thaliris-agent row match DSH ${version}; regenerate composition.mjs when the host preset changes`)
