// Emitted semantic contracts, the host/preset split and native policy preservation; no online model.
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { roleNativeTools, roleTemplates } from '../role-templates.mjs'
import { STANDARD_COMPOSITION, THALIRIS_AGENT_ROW, THALIRIS_PRESET_ID, THALIRIS_PRESET_NAME, THALIRIS_PRESET_ORDER, thalirisPresetDefinition } from '../composition.mjs'

const read = name => readFileSync(new URL(name, import.meta.url), 'utf8')
const json = name => JSON.parse(read(name))
const role = id => roleTemplates.find(value => value.id === id)
const pkg = json('../package.json')
const lock = json('../core.lock.json')
const global = read('../index.mjs')
const setup = read('../setup.mjs')
const preset = read('../preset.mjs')
const policy = read('../policy.mjs')
const api = read('../api.mjs')
const remote = read('../remote.mjs')

// --- Role templates: curated native DSH grants, no Controller/management grants -------
assert.deepEqual(roleTemplates.map(value => value.id), ['investigator', 'implementer', 'focused-implementer', 'reviewer', 'curator', 'reasoning-specialist'])
// Verifier is a Codex compatibility role and is intentionally not seeded here.
assert.ok(!roleTemplates.some(value => value.id === 'verifier'))
const designGrants = {
  investigator: ['read', 'glob', 'grep', 'bash', 'pwsh', 'job_list', 'job_output', 'web_fetch', 'web_search', 'todo_write', 'skill'],
  implementer: ['read', 'write', 'edit', 'glob', 'grep', 'bash', 'pwsh', 'job_list', 'job_output', 'job_kill',
    'terminal_list', 'terminal_open', 'terminal_read', 'terminal_send', 'terminal_signal', 'terminal_close',
    'web_fetch', 'web_search', 'todo_write', 'skill', 'present'],
  'focused-implementer': null,
  reviewer: ['read', 'glob', 'grep', 'web_fetch', 'web_search'],
  curator: ['read', 'write', 'edit', 'glob', 'grep', 'todo_write', 'skill'],
  'reasoning-specialist': ['read', 'glob', 'grep', 'web_fetch', 'web_search'],
}
designGrants['focused-implementer'] = designGrants.implementer
for (const [id, grants] of Object.entries(designGrants)) {
  assert.deepEqual(role(id).tools, grants, `${id} carries the curated native grant`)
  assert.deepEqual(roleNativeTools[id], grants)
  // A role must be able to read the repository and verify its own work; empty tools left
  // children limited to thaliris_observe, which the user explicitly rejected.
  assert.ok(grants.length > 0, `${id} has real native permissions`)
  assert.ok(grants.includes('read'), `${id} can read files`)
  for (const name of grants) assert.ok(!name.startsWith('thaliris_'), `${id} never grants a Thaliris Controller/management tool: ${name}`)
}
// Non-writing roles must be unable to mutate through the shell.
for (const id of ['reviewer', 'reasoning-specialist']) for (const name of ['bash', 'pwsh', 'write', 'edit']) assert.ok(!role(id).tools.includes(name), `${id} stays non-writing: ${name}`)
// Unknown stored names are filtered against the host catalog instead of breaking a child.
assert.ok(policy.includes('export function nativeToolGrants(tools, catalog)'))
assert.ok(preset.includes('nativeToolGrants(role.tools, ctx.tools.schemas(agent)'))
assert.ok(preset.includes("ctx.logger.warn(`thaliris: role ${role.id} grants tools this host does not provide"))
for (const value of roleTemplates) {
  assert.deepEqual(value.modelPolicy, { mode: 'inherit', routes: [] })
  assert.deepEqual(value.memory, { read: [], write: [] })
  assert.deepEqual(value.context, { handoff: true, memory: false })
}

// --- Generated bundle: shipped rows enabled with tolerant config -----------------------
const patch = json('../cordis.patch.yml')[0].insert
assert.deepEqual(patch[0].config.policy.roles, roleTemplates)
assert.equal(patch[0].id, 'thaliris')
assert.equal(patch[0].name, '@thaliris/dsh-plugin')
assert.ok(!('disabled' in patch[0]), 'the shipped global row is enabled (fresh install must be usable)')
assert.equal(patch[1].id, 'thaliris-api')
assert.equal(patch[1].name, '@thaliris/dsh-plugin/api')
assert.ok(!('disabled' in patch[1]), 'the shipped API row is enabled')
// Tolerant config: runtime paths are user-owned, optional and resolved at use time.
for (const key of ['pythonExecutable', 'corePath', 'authorityDirectory']) {
  assert.ok(!JSON.stringify(patch[0]).includes(`"${key}"`), `the shipped bundle does not pin ${key}`)
  assert.ok(policy.includes(`${key}: z.string()`), `${key} stays an optional string field`)
  assert.ok(policy.includes(`${key}: z.string().volatile()`), `${key} is a live-editable override`)
  assert.ok(!policy.includes(`${key}: z.string().required()`), `${key} must not be required for activation`)
}
assert.ok(policy.includes("subagentProvider: z.string().default('spawn')"))
assert.ok(policy.includes('}).default({}).volatile()'), 'user policy stays volatile for native Settings')
assert.ok(!indexThrowsOnActivation(global), 'activation must not require or validate runtime paths')

// --- Split invariant: the global row owns no model-visible surface --------------------
assert.ok(global.includes("export const inject = ['agents', 'subprocess', 'sessionPersistence', 'tools']"), 'global row injects host-plane services only')
assert.ok(global.includes("ctx.get('workspaceRegistry')"), 'the Workspace registry is optional so headless boot activates cleanly')
assert.ok(global.includes("ctx.provide('thaliris'"), 'the global row provides the thaliris Host service')
assert.ok(global.includes("ctx.inject(['agentPresets'], (injected) =>"), 'the preset is registered programmatically when the registry exists')
assert.ok(global.includes('thalirisPresetDefinition()'))
assert.ok(global.includes('setTimeout(start, 0)'), 'preset registration is deferred off the host row activation path')
assert.ok(global.includes("settlePreset({ status: 'registered' })"))
assert.ok(global.includes('RUNTIME_RECOVERY'))
assert.ok(global.includes('createRuntimeSetup(') && global.includes('setup.ensure('), 'the bridge waits on the single-flight setup runtime')
assert.ok(global.includes("from './setup.mjs'"), 'the failure codes and recovery text come from the host-plane setup module')
assert.ok(global.includes('workspaceAutoBind'), 'first-run workspace binding is reported through setupStatus')
for (const forbidden of ["ctx.tools.register(", 'ctx.systemPrompt.section(', 'systemPrompt.context(', "ctx.on('agent/created'", 'thaliris_workstream', 'roleTemplates']) {
  if (forbidden === 'roleTemplates') continue
  assert.ok(!global.includes(forbidden), `the global row must not own model-visible surface: ${forbidden}`)
}
assert.ok(!global.includes('ctx.subagents'))
// The preset half owns every model-visible contribution and is a subpath export.
assert.ok(preset.includes('ctx.tools.register('), 'tools live in the preset child')
assert.ok(preset.includes("ctx.systemPrompt.section({ name: 'thaliris:controller-contract'"))
assert.ok(preset.includes("ctx.systemPrompt.context({ name: 'thaliris:task-context'"))
assert.ok(preset.includes("ctx.on('system-prompt/assemble'"))
assert.ok(preset.includes("ctx.on('agent/created'"))
assert.ok(preset.includes('{ global: true }'), 'the child-composition listener is global because the dispatched child selects the ephemeral gate first')
assert.ok(!preset.includes('ctx.provide('), 'a preset child may not publish a root-realm service')
assert.ok(preset.includes("export const inject = ['thaliris', 'agents', 'llm', 'sessionPersistence', 'subagents', 'systemPrompt', 'tools']"))
assert.ok(preset.includes('const service = ctx.thaliris'))
assert.ok(!/export function apply\(ctx[^)]*\)\s*{[^}]*realpathSync\(config/.test(preset), 'preset apply performs no config I/O')

// --- Tool surface: 16 Controller tools + 3 memory tools + dispatch-granted evidence ---
assert.equal(json('../package.json').exports['./preset'], './preset.mjs')
const toolNames = preset.match(/export const TOOL_NAMES = Object\.freeze\(\[([^\]]+)\]/s)[1]
const nameCount = [...toolNames.matchAll(/'([a-z_]+)'/g)].length
assert.equal(nameCount, 16)
for (const name of ['thaliris_task_status', 'thaliris_task_context', 'thaliris_task_register', 'thaliris_task_judge', 'thaliris_task_mode',
  'thaliris_task_identity', 'thaliris_task_identity_amend', 'thaliris_task_identity_challenge', 'thaliris_task_identity_relate',
  'thaliris_task_identity_note', 'thaliris_task_identity_suggest']) assert.ok(toolNames.includes(`'${name}'`), name)
assert.ok(preset.includes("MEMORY_TOOLS = Object.freeze(['thaliris_memory_read', 'thaliris_memory_search', 'thaliris_memory_propose'])"), 'memory tools are preset-scoped')
assert.ok(preset.includes("EVIDENCE_TOOLS = Object.freeze(['thaliris_observe'])"), 'the observation tool is dispatch-granted')
// Identity tools are Controller-only: never child-allowed, never role grants, always on the dispatch deny list.
const identityBlock = preset.slice(preset.indexOf('register(TOOL_NAMES[10]'), preset.indexOf('register(EVIDENCE_TOOLS[0]'))
for (const index of [10, 11, 12, 13, 14, 15]) assert.ok(identityBlock.includes(`register(TOOL_NAMES[${index}]`), `identity tool ${index} is registered`)
assert.ok(!identityBlock.includes(', true)'), 'identity tools are never child-allowed')
for (const name of ['thaliris_task_identity', 'thaliris_task_identity_amend', 'thaliris_task_identity_challenge', 'thaliris_task_identity_relate', 'thaliris_task_identity_note', 'thaliris_task_identity_suggest']) {
  assert.ok(name.startsWith('thaliris_task_'), name)
  assert.ok(policy.includes("tool.startsWith('thaliris_task_')"), 'role grants can never include identity tools')
}
assert.ok(preset.includes("bridge(agent, `identity_${action}`"))
for (const operation of ['identity_amend', 'identity_challenge', 'identity_relate', 'identity_note', 'identity_suggest']) assert.ok(preset.includes(`bridge(agent, '${operation}'`), operation)
assert.ok(preset.includes('const role = grant?.role'), 'children keep the dispatch-time role binding')
assert.ok(policy.includes("tool === 'thaliris_observe'"), 'observation grants are per dispatch, never role policy')

// --- Dispatch composition and the non-resumable one-shot child ------------------------
assert.ok(preset.includes('persona: role.prompt'))
assert.ok(preset.includes('...args.handoff'))
assert.ok(preset.includes("toolFilter: { allow: evidence ? [...granted, ...EVIDENCE_TOOLS] : granted, deny: TOOL_NAMES }"))
assert.ok(preset.includes("created.ctx.systemPrompt.section({ name: 'deployment:persona-prefix'"))
assert.ok(preset.includes('created.ctx.tools.restrict(composition.toolFilter)'))
assert.ok(preset.includes("childId, signal, delivery: 'caller'"))
assert.ok(preset.includes("throw new Error('THALIRIS_CHILD_RESUME_DENIED')"))
assert.ok(preset.includes('maxDepth: 1'))
assert.ok(policy.includes("roles: z.array(roleSchema).default([])"))
// Gateway surface is host-plane and reads through the service.
for (const name of ['templates', 'providers', 'toolCatalog', 'diagnostics', 'approveMemory']) assert.ok(api.includes(`this.ctx.thaliris.${name}`), name)
for (const name of ['templates', 'providers', 'toolCatalog', 'diagnostics', 'approveMemory']) assert.ok(global.includes(`${name}:`), `service exposes ${name}`)

// --- Preset declaration and composition mirror ---------------------------------------
assert.equal(pkg.version, '0.5.0')
assert.ok(pkg.files.includes('preset.mjs') && pkg.files.includes('composition.mjs'), 'both halves ship in the package')
assert.ok(pkg.files.includes('lib/client.js'), 'the prebuilt client bundle still ships')
assert.equal(pkg.dsh.bundle.patch, './cordis.patch.yml')
for (const hook of ['install', 'preinstall', 'postinstall', 'prepare']) assert.ok(!(hook in pkg.scripts), `no ${hook} hook`)
assert.equal(STANDARD_COMPOSITION.length, 22, 'the committed mirror carries every Standard preset row')
assert.equal(THALIRIS_PRESET_ID, 'thaliris')
assert.equal(THALIRIS_PRESET_NAME, 'Thaliris')
assert.ok(THALIRIS_PRESET_ORDER > 4, 'the roster entry sorts after the four built-in presets')
assert.deepEqual({ ...THALIRIS_AGENT_ROW }, { id: 'thaliris-agent', name: '@thaliris/dsh-plugin/preset' })
assert.deepEqual(thalirisPresetDefinition().plugins.at(-1), THALIRIS_AGENT_ROW)
assert.ok(existsSync(new URL('../build-composition.mjs', import.meta.url)), 'the generator is committed')
assert.ok(read('../build-composition.mjs').includes("packages/bundle/web-app/presets/standard.patch.yml"), 'the mirror provenance is explicit')
assert.ok(existsSync(new URL('./composition-drift.mjs', import.meta.url)), 'the host-composition drift gate exists')

// --- First-run setup: host plane only, pinned source, human Gateway surface ------------
assert.ok(pkg.files.includes('setup.mjs'), 'the host-plane setup module ships in the package')
assert.equal(lock.version, '0.5.2')
assert.match(lock.commit, /^[0-9a-f]{40}$/)
assert.equal(lock.source.kind, 'codeload-tarball')
assert.match(lock.source.sha256, /^[0-9a-f]{64}$/)
assert.match(lock.package_tree_sha256, /^[0-9a-f]{64}$/)
// Provisioning contract: direct Python argv (no shell), no pip/build backend, no pipes.
assert.ok(setup.includes("from 'node:child_process'") && setup.includes('spawn('), 'setup runs Python directly')
assert.ok(!setup.includes('execSync') && !/execFile\(/.test(setup), 'setup never runs a shell command line')
assert.ok(!setup.includes('shell: true'), 'setup never asks for a shell')
assert.ok(!setup.includes("stdio: 'pipe'"), 'setup never pipes child stdio')
assert.ok(setup.includes("'-m', 'venv', '--without-pip'"), 'the runtime venv is created without pip')
assert.ok(!/pip install|ensurepip|hatchling/.test(setup), 'provisioning never invokes pip or a build backend')
assert.ok(setup.includes('readCoreLock(') && setup.includes('packageTreeSha256('), 'source digests come from the shipped pin')
assert.ok(setup.includes('pythonExecutable: install.python') && setup.includes('corePath: install.purelib'), 'runtime.json records both resolved paths')
assert.ok(setup.includes('renameSync(temporary, target)'), 'runtime.json is written atomically')
assert.ok(setup.includes("'provision.lock'"), 'cross-process provisioning lock')
assert.ok(setup.includes('waitFor(flight, signal)') || setup.includes('waitFor(pending, signal)'), 'caller cancellation/timeout is honored on a shared flight')
for (const code of ['THALIRIS_PYTHON_NOT_FOUND', 'THALIRIS_PYTHON_VERSION_UNSUPPORTED', 'THALIRIS_VENV_CREATE_FAILED',
  'THALIRIS_SOURCE_FETCH_FAILED', 'THALIRIS_SOURCE_HASH_MISMATCH', 'THALIRIS_CORE_INSTALL_FAILED', 'THALIRIS_CORE_VERIFY_FAILED',
  'THALIRIS_CORE_VERSION_MISMATCH', 'THALIRIS_MANIFEST_WRITE_FAILED', 'THALIRIS_AUTHORITY_UNSAFE']) assert.ok(setup.includes(`'${code}'`), code)
assert.ok(setup.includes("notConfigured: 'THALIRIS_NOT_CONFIGURED'") && setup.includes("notReady: 'THALIRIS_RUNTIME_NOT_READY'"), 'the fail-closed runtime codes live in setup.mjs')
// Workspace first-run binding: native profile editor, only for an empty list and a selected root.
assert.ok(global.includes("ctx.get('configEditor')") && global.includes('persistAutoBind('), 'first-run binding uses the native config editor')
assert.ok(global.includes('policy.workspaces.length === 0') && global.includes('isThalirisSelected('), 'auto-bind requires an empty list and a Thaliris-selected root')
assert.ok(global.includes('readDocument(presetId)'), 'Thaliris selection is proven from the preset composition')
// The setup surface is a human Gateway API, never a model tool.
for (const name of ['setupStatus', 'prepareRuntime', 'recheckRuntime']) {
  assert.ok(new RegExp(`${name}[,(:]`).test(global), `the Host service exposes ${name}`)
  assert.ok(api.includes(`this.ctx.thaliris.${name}`), `api.mjs exposes ${name}`)
  assert.ok(remote.includes(`method('${name}'`), `remote.mjs declares ${name}`)
  assert.ok(!preset.includes(name), `${name} is not reachable as a model tool`)
  assert.ok(!toolNames.includes(name), `${name} is not a registered tool name`)
}
assert.ok(!global.includes('ctx.tools.register('), 'the global row still registers no tool')
console.log('DSH prompt contracts, host/preset split, generated bundle, preset declaration and native role grants verified')

/** True when the global module validates runtime paths during activation (it must not). */
function indexThrowsOnActivation(source) {
  const body = source.slice(source.indexOf('export function apply('), source.indexOf('  let disposed = false'))
  return body.includes('throw new Error') || body.includes('realpathSync(') || body.includes('isAbsolute(')
}
