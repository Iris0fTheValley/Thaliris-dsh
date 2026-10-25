// Maintainer generator for composition.mjs: commits DSH's Standard preset child
// rows as a plain JavaScript module, because a programmatic `agentPresets.register`
// definition cannot carry the Loader's `!!js` YAML expressions. Run with
//   DSH_SOURCE=<compatible DSH checkout> node build-composition.mjs
// The drift gate in tests/composition-drift.mjs fails when the host composition
// changes without this file being regenerated.
import { readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Platform expression aliases emitted into the generated module. */
export const PLATFORM_EXPRESSIONS = Object.freeze({
  "process.platform === 'win32'": 'WINDOWS',
  "process.platform !== 'win32'": '!WINDOWS',
})
/** Placeholder that survives `JSON.stringify` so the generated module can hold a live boolean expression. */
const TOKEN = { WINDOWS: '__THALIRIS_PLATFORM_WINDOWS__', NOT_WINDOWS: '__THALIRIS_PLATFORM_NOT_WINDOWS__' }
const presetPath = source => resolve(source, 'packages/bundle/web-app/presets/standard.patch.yml')

/** Resolve the checkout's own js-yaml, the parser the Loader uses for this file. */
export function loadYamlModule(source) {
  const requireSource = createRequire(resolve(source, 'package.json'))
  try {
    return requireSource('js-yaml')
  } catch (error) {
    throw new Error(`The DSH checkout at ${source} does not expose js-yaml (${error.message}); install its workspace dependencies.`)
  }
}

/** Parse one preset patch file into the inserted preset declaration. */
export function readPresetDeclaration(source) {
  const yaml = loadYamlModule(source)
  // Same node representation the Loader produces for `!!js` before evaluation.
  const jsType = new yaml.Type('tag:yaml.org,2002:js', {
    kind: 'scalar',
    resolve: value => typeof value === 'string' && value.length > 0,
    construct: value => ({ __jsExpr: String(value) }),
  })
  const schema = yaml.DEFAULT_SCHEMA.extend([jsType])
  const document = yaml.load(readFileSync(presetPath(source), 'utf8'), { schema })
  const rows = Array.isArray(document) ? document : []
  const declaration = rows.flatMap(entry => Array.isArray(entry?.insert) ? entry.insert : [])
    .find(row => row?.name === '@deepseek-ai/dsh-agent-preset' && row?.config?.id === 'standard')
  if (!declaration) throw new Error(`No "standard" @deepseek-ai/dsh-agent-preset declaration in ${presetPath(source)}.`)
  return declaration
}

/** Read the Standard preset child rows with platform expressions preserved as {@link PLATFORM_EXPRESSIONS} values. */
export function standardComposition(source) {
  return normalizeRows(readPresetDeclaration(source).config.plugins)
}

/** True when a value is the Loader's serialized `!!js` expression node. */
function isJsExpr(value) {
  return !!value && typeof value === 'object' && typeof value.__jsExpr === 'string'
}

/** Map one `!!js` expression to the boolean expression the generated module stores. */
function disabledExpression(value) {
  if (typeof value === 'boolean') return value
  if (!isJsExpr(value)) throw new Error(`Unsupported disabled value: ${JSON.stringify(value)}`)
  const mapped = PLATFORM_EXPRESSIONS[value.__jsExpr.trim()]
  if (mapped === undefined) {
    throw new Error(`Unsupported preset platform condition ${JSON.stringify(value.__jsExpr)}; add it to PLATFORM_EXPRESSIONS and the generated module.`)
  }
  return mapped === 'WINDOWS' ? TOKEN.WINDOWS : TOKEN.NOT_WINDOWS
}

function normalizeValue(value) {
  if (isJsExpr(value)) {
    const mapped = PLATFORM_EXPRESSIONS[value.__jsExpr.trim()]
    if (mapped === undefined) throw new Error(`Unsupported preset expression ${JSON.stringify(value.__jsExpr)} in a config value.`)
    return mapped === 'WINDOWS' ? TOKEN.WINDOWS : TOKEN.NOT_WINDOWS
  }
  if (Array.isArray(value)) return value.map(normalizeValue)
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, normalizeValue(item)]))
  return value
}

function normalizeRows(rows) {
  if (!Array.isArray(rows)) throw new Error('Preset rows must be a list.')
  return rows.map(row => {
    if (!row || typeof row !== 'object' || typeof row.name !== 'string') throw new Error(`Invalid preset row: ${JSON.stringify(row)}`)
    const normalized = {}
    if (row.id !== undefined) normalized.id = row.id
    normalized.name = row.name
    if (row.group === true) normalized.group = true
    if (row.isolate !== undefined) normalized.isolate = normalizeValue(row.isolate)
    if (row.disabled !== undefined) normalized.disabled = disabledExpression(row.disabled)
    if (row.config !== undefined) normalized.config = Array.isArray(row.config) ? normalizeRows(row.config) : normalizeValue(row.config)
    return normalized
  })
}

/** Host version for the generated provenance line. */
function hostVersion(source) {
  return JSON.parse(readFileSync(resolve(source, 'package.json'), 'utf8')).version
}

/** Render composition.mjs for one definition. */
export function renderComposition(source, rows) {
  const body = JSON.stringify(rows, null, 2)
    .replaceAll(`"${TOKEN.WINDOWS}"`, 'WINDOWS')
    .replaceAll(`"${TOKEN.NOT_WINDOWS}"`, '!WINDOWS')
  return `// GENERATED FILE - do not edit by hand. Regenerate with:
//   DSH_SOURCE=<compatible DSH checkout> node build-composition.mjs
// Source: DSH ${hostVersion(source)} packages/bundle/web-app/presets/standard.patch.yml
// A programmatic Agent Preset definition receives evaluated entry options, so the
// Loader's YAML platform conditions appear here as live booleans. The drift gate in
// tests/composition-drift.mjs compares these rows with the host declaration for the
// running DSH checkout (CI covers every verified release tag).
const WINDOWS = process.platform === 'win32'

function deepFreeze(value) {
  if (value !== null && typeof value === 'object') {
    for (const item of Object.values(value)) deepFreeze(item)
    Object.freeze(value)
  }
  return value
}

/** DSH Standard preset child rows; a preset replaces the agent composition, so Thaliris must carry them. */
export const STANDARD_COMPOSITION = deepFreeze(${body})

/** Appended row: the Thaliris preset-scoped module that owns the model-visible surface. */
export const THALIRIS_AGENT_ROW = deepFreeze({ id: 'thaliris-agent', name: '@thaliris/dsh-plugin/preset' })

/** Stable preset id; session logs and the native default-mode setting record it. */
export const THALIRIS_PRESET_ID = 'thaliris'
/** Roster display name; custom names are not localized by the host. */
export const THALIRIS_PRESET_NAME = 'Thaliris'
/** Roster description shown in the native mode picker. */
export const THALIRIS_PRESET_DESCRIPTION = 'Opt-in Thaliris Controller mode: Core task authority, bounded Workstreams, evidence continuity. Carries the standard DSH tools plus the Thaliris Controller surface.'
/** Display order after the four built-in presets (standard 1, ptc 2, minimal 3, cordis 4). */
export const THALIRIS_PRESET_ORDER = 10

/** Detached definition for \`agentPresets.register\`; the registry clones it on mount. */
export function thalirisPresetDefinition() {
  return { id: THALIRIS_PRESET_ID, name: THALIRIS_PRESET_NAME, description: THALIRIS_PRESET_DESCRIPTION, order: THALIRIS_PRESET_ORDER, plugins: [...STANDARD_COMPOSITION, THALIRIS_AGENT_ROW] }
}
`
}

/** Generate composition.mjs from a DSH checkout. `destination` defaults to the committed module. */
export function generateComposition(source, destination = fileURLToPath(new URL('./composition.mjs', import.meta.url))) {
  const rows = standardComposition(source)
  writeFileSync(destination, renderComposition(source, rows))
  return rows
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const source = process.env.DSH_SOURCE
  if (!source) throw new Error('Set DSH_SOURCE to a compatible DSH checkout to regenerate composition.mjs.')
  // An explicit destination keeps the generator usable where a shell sandbox cannot
  // write the package directory; the committed module is still the default.
  const destination = process.env.THALIRIS_COMPOSITION_OUT
  const rows = generateComposition(source, destination === undefined ? undefined : resolve(destination))
  console.log(`composition.mjs: ${rows.length} mirrored Standard rows from DSH ${hostVersion(source)}${destination ? ` -> ${resolve(destination)}` : ''}`)
}
