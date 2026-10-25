// First-run provisioning of the pinned Thaliris Core (host plane, no model surface).
//
// Design §5 and .context/recon/provision-spike.md: detect a CPython >= 3.11, create an
// isolated `--without-pip` venv under the authority directory, fetch the pinned Core
// source tarball with Node's fetch (no git/curl), verify its SHA-256 before use, copy
// the `thaliris` package into the venv's purelib with a dist-info and console shim
// (no pip, no build backend, no temporary files), verify imports/version/state schema
// inside that interpreter by reading a result JSON file, then atomically write
// `<authority>/runtime.json`.
//
// The module performs no I/O at import time and `createRuntimeSetup()` does no I/O
// either: plugin activation must never fail or block on setup. Every filesystem or
// network step runs from `ensure()` (first bridge use) or the explicit human Gateway
// action (`prepareRuntime` / `recheckRuntime`). A failure leaves the plugin loaded with
// a structured code and recovery text; a partial runtime directory is removed while the
// verified tarball cache is kept.
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gunzipSync } from 'node:zlib'

const MIN_PYTHON = [3, 11]
const PROBE_TIMEOUT_MS = 20000
const VENV_TIMEOUT_MS = 120000
const FETCH_TIMEOUT_MS = 60000
const PROVISION_LOCK_STALE_MS = 5 * 60 * 1000
const MANIFEST_VERSION = 1
const MODULES = Object.freeze(['thaliris.core', 'thaliris.authority', 'thaliris.errors', 'thaliris.identity', 'thaliris.identity_basis'])
const DEFAULT_LOCK_PATH = fileURLToPath(new URL('./core.lock.json', import.meta.url))

/** Setup state machine values reported by `status()` and the Gateway setup methods. */
export const SETUP_STATES = Object.freeze({
  unconfigured: 'unconfigured', detecting: 'detecting', provisioning: 'provisioning',
  verifying: 'verifying', ready: 'ready', failed: 'failed',
})
/** Ordered user-visible provisioning steps; `status().progress.step` names the active one. */
export const SETUP_STEPS = Object.freeze(['detect-python', 'fetch-source', 'create-runtime', 'install-core', 'verify-core', 'write-manifest'])
/** Structured provisioning failure codes (spike §5) plus the setup-only additions. */
export const SETUP_CODES = Object.freeze({
  pythonNotFound: 'THALIRIS_PYTHON_NOT_FOUND',
  pythonUnsupported: 'THALIRIS_PYTHON_VERSION_UNSUPPORTED',
  venvFailed: 'THALIRIS_VENV_CREATE_FAILED',
  sourceFetchFailed: 'THALIRIS_SOURCE_FETCH_FAILED',
  sourceHashMismatch: 'THALIRIS_SOURCE_HASH_MISMATCH',
  coreInstallFailed: 'THALIRIS_CORE_INSTALL_FAILED',
  coreVerifyFailed: 'THALIRIS_CORE_VERIFY_FAILED',
  coreVersionMismatch: 'THALIRIS_CORE_VERSION_MISMATCH',
  manifestWriteFailed: 'THALIRIS_MANIFEST_WRITE_FAILED',
  authorityUnsafe: 'THALIRIS_AUTHORITY_UNSAFE',
  lockInvalid: 'THALIRIS_CORE_LOCK_INVALID',
  runtimeProvisioning: 'THALIRIS_RUNTIME_PROVISIONING',
  setupAborted: 'THALIRIS_SETUP_ABORTED',
})
/** Codes a bridge caller can branch on when no provisioning was attempted. */
export const RUNTIME_CODES = Object.freeze({ notConfigured: 'THALIRIS_NOT_CONFIGURED', notReady: 'THALIRIS_RUNTIME_NOT_READY' })
/** User-facing recovery text shared by every fail-closed runtime error. */
export const RUNTIME_RECOVERY = 'Open Settings -> Thaliris -> General and run "Prepare Thaliris runtime", or set the runtime paths explicitly.'

const RECOVERY = Object.freeze({
  THALIRIS_PYTHON_NOT_FOUND: 'Install CPython 3.11 or newer (DSH Desktop ships one under %DSH_HOME%\\dsh-runtimes), or set pythonExecutable / THALIRIS_PYTHON, then retry "Prepare Thaliris runtime".',
  THALIRIS_PYTHON_VERSION_UNSUPPORTED: 'Point pythonExecutable / THALIRIS_PYTHON at CPython 3.11 or newer, then retry "Prepare Thaliris runtime".',
  THALIRIS_VENV_CREATE_FAILED: 'Check that the authority directory is writable and that the selected Python can create virtual environments, then retry.',
  THALIRIS_SOURCE_FETCH_FAILED: 'Check network access to codeload.github.com and retry, or stage the pinned tarball and set THALIRIS_CORE_TARBALL.',
  THALIRIS_SOURCE_HASH_MISMATCH: 'Do not trust this archive: restore network integrity and retry, or review the pin in core.lock.json in a reviewed change.',
  THALIRIS_CORE_INSTALL_FAILED: 'Delete the runtime directory and retry; check free disk space and authority directory permissions.',
  THALIRIS_CORE_VERIFY_FAILED: 'Retry "Prepare Thaliris runtime"; it recreates an incomplete runtime. If it persists, set the paths manually.',
  THALIRIS_CORE_VERSION_MISMATCH: 'The installed Core does not match core.lock.json: review the pin or delete the runtime, then retry.',
  THALIRIS_MANIFEST_WRITE_FAILED: 'Make the authority directory writable and retry; it must stay outside the workspace.',
  THALIRIS_AUTHORITY_UNSAFE: 'Set authorityDirectory to a writable directory outside the workspace and not behind a symlink or junction, then retry.',
  THALIRIS_CORE_LOCK_INVALID: 'The shipped core.lock.json is damaged; reinstall the plugin package and retry.',
  THALIRIS_RUNTIME_PROVISIONING: 'Another Thaliris session is already preparing the runtime; retry in a few seconds.',
  THALIRIS_SETUP_ABORTED: 'The operation was cancelled; retry "Prepare Thaliris runtime".',
})
/** Recovery text for a setup failure code; the general runtime recovery is the fallback. */
export function recoveryFor(code) { return RECOVERY[code] ?? RUNTIME_RECOVERY }

class ProvisionError extends Error {
  constructor(code, detail, details) {
    super(`${code}: ${detail}`)
    this.name = 'ProvisionError'
    this.code = code
    this.recovery = recoveryFor(code)
    this.details = details
  }
}

const provisionError = (code, detail, details) => new ProvisionError(code, detail, details)
const isString = value => typeof value === 'string' && value.trim() !== ''
const sha256 = buffer => createHash('sha256').update(buffer).digest('hex')
const now = () => Date.now()
const isoNow = () => new Date().toISOString()

/**
 * Read one plugin Config field. Cordis config nodes are reactive values whose `.get()`
 * returns the current parsed field (including live volatile edits); plain objects are
 * accepted too so tests can pass a literal config.
 * @param config - parsed plugin Config proxy (or a plain object).
 * @param key - field name.
 * @returns the current field value, or undefined when the field is absent.
 */
export function configValue(config, key) {
  const field = config?.[key]
  return typeof field?.get === 'function' ? field.get() : field
}

/** Hash a package tree independently of tar packing: sorted `<relpath>:<sha256hex>` lines, joined with `\n`, hashed as UTF-8. */
export function packageTreeSha256(files) {
  const lines = files.map(file => `${String(file.path).replaceAll('\\', '/')}:${sha256(file.body)}`).sort()
  return sha256(Buffer.from(lines.join('\n'), 'utf8'))
}

/** Read every regular file below `root` (excluding `__pycache__` and `*.pyc`) as a package tree. */
function readTreeFiles(root) {
  const files = []
  const walk = directory => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) {
        if (entry.name !== '__pycache__') walk(path)
      } else if (entry.isFile() && !entry.name.endsWith('.pyc')) {
        files.push({ path: relative(root, path), body: readFileSync(path) })
      }
    }
  }
  walk(root)
  return files
}

/** Depth-first tar reader for plain ustar entries (GitHub codeload tarballs). */
function readTar(buffer) {
  const entries = []
  let offset = 0
  while (offset + 512 <= buffer.length) {
    const header = buffer.subarray(offset, offset + 512)
    if (header.every(byte => byte === 0)) break
    const field = (start, length) => header.subarray(start, start + length).toString('utf8').replace(/\0.*$/s, '').trim()
    const name = field(0, 100)
    const size = parseInt(field(124, 12) || '0', 8)
    const typeflag = String.fromCharCode(header[156] || 48)
    const prefix = field(345, 155)
    const path = prefix ? `${prefix}/${name}` : name
    offset += 512
    const body = buffer.subarray(offset, offset + size)
    if (typeflag === '0' || typeflag === '7') entries.push({ path, body, type: 'file' })
    else if (typeflag === '5') entries.push({ path, type: 'dir' })
    offset += Math.ceil(size / 512) * 512
  }
  return entries
}

/**
 * Read the shipped Core pin. The pin is a reviewed source of truth: repository, commit,
 * version, task state schema, and the integrity digests of the pinned source archive and
 * of the `src/thaliris` package tree inside it.
 * @param lockPath - `core.lock.json` location (defaults to the package copy).
 * @returns Normalized pin used by provisioning.
 */
export function readCoreLock(lockPath = DEFAULT_LOCK_PATH) {
  let raw
  try { raw = JSON.parse(readFileSync(lockPath, 'utf8')) } catch (error) {
    throw new Error(`cannot read ${basename(lockPath)}: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (typeof raw.repository !== 'string' || !/^[^/\s]+\/[^/\s]+$/.test(raw.repository)) throw new Error('core.lock.json repository is invalid')
  if (typeof raw.commit !== 'string' || !/^[0-9a-f]{40}$/.test(raw.commit)) throw new Error('core.lock.json commit is invalid')
  if (typeof raw.version !== 'string' || !/^\d+\.\d+\.\d+$/.test(raw.version)) throw new Error('core.lock.json version is invalid')
  if (!Number.isInteger(raw.state_schema_version)) throw new Error('core.lock.json state_schema_version is invalid')
  const tarballSha256 = raw.source?.sha256
  const packageTreeDigest = raw.package_tree_sha256
  if (typeof tarballSha256 !== 'string' || !/^[0-9a-f]{64}$/.test(tarballSha256)) throw new Error('core.lock.json source.sha256 is invalid')
  if (typeof packageTreeDigest !== 'string' || !/^[0-9a-f]{64}$/.test(packageTreeDigest)) throw new Error('core.lock.json package_tree_sha256 is invalid')
  const template = isString(raw.source?.url_template) ? raw.source.url_template : 'https://codeload.github.com/{repository}/tar.gz/{commit}'
  return {
    repository: raw.repository,
    commit: raw.commit,
    version: raw.version,
    stateSchemaVersion: raw.state_schema_version,
    tarballSha256,
    packageTreeSha256: packageTreeDigest,
    tarballUrl: template.replace('{repository}', raw.repository).replace('{commit}', raw.commit),
    lockPath,
  }
}

/** Portable profile directory name for the authority default; keeps the path segment safe. */
function authorityProfileName(profileName, env = process.env) {
  const requested = isString(profileName) ? profileName : isString(env.DSH_PROFILE) ? env.DSH_PROFILE : 'dsh'
  const cleaned = requested.trim().replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[.-]+/, '')
  return cleaned || 'dsh'
}

/**
 * Default authority directory: `<home>/.thaliris/<DSH_PROFILE or 'dsh'>`, outside the
 * workspace by construction. The existing `authorityDirectory` config field overrides it.
 * @param profileName - active profile name, when the host exposes one.
 * @param env - environment source for the DSH_PROFILE fallback.
 * @returns Absolute authority directory path.
 */
export function defaultAuthorityDirectory(profileName, env = process.env) {
  return join(homedir(), '.thaliris', authorityProfileName(profileName, env))
}

/**
 * Resolve the authority directory with the documented precedence (explicit config wins).
 * @param config - parsed plugin Config proxy.
 * @param profileName - active profile name, when the host exposes one.
 * @param env - environment source for the DSH_PROFILE fallback.
 * @returns Absolute authority directory path.
 */
export function resolveAuthorityDirectory(config, profileName, env = process.env) {
  const explicit = configValue(config, 'authorityDirectory')
  if (isString(explicit)) return resolve(explicit)
  return defaultAuthorityDirectory(profileName, env)
}

function isInside(parent, child) {
  const relation = relative(resolve(parent), resolve(child))
  return relation === '' || (!relation.startsWith('..') && !isAbsolute(relation))
}

function isLinkOrJunction(path) {
  try { return lstatSync(path).isSymbolicLink() } catch { return false }
}

/** Reject an authority path that the bridge would refuse anyway (inside a workspace or behind a link/junction). */
function assertAuthoritySafe(path, workspaceRoots) {
  if (workspaceRoots.some(root => isInside(root, path))) {
    throw provisionError(SETUP_CODES.authorityUnsafe, 'authority directory is inside a configured workspace', { reason: 'inside-workspace' })
  }
  const existing = []
  let cursor = resolve(path)
  for (;;) {
    if (existsSync(cursor)) existing.push(cursor)
    const parent = dirname(cursor)
    if (parent === cursor) break
    cursor = parent
  }
  if (existing.some(isLinkOrJunction)) {
    throw provisionError(SETUP_CODES.authorityUnsafe, 'authority path passes through a symlink or junction', { reason: 'linked' })
  }
}

function commandName(executable) { return basename(String(executable)) }

/**
 * Spawn one process without a shell and without piped stdio. Pipes are avoided because a
 * confined DSH host may deny them, and the result is always transferred through a file.
 * @returns Exit status, or an error/timeout marker; never rejects.
 */
function runProcess(executable, args, options = {}) {
  const { timeoutMs = 0, cwd, env } = options
  return new Promise(resolvePromise => {
    let settled = false
    const finish = value => { if (settled) return; settled = true; clearTimeout(timer); resolvePromise(value) }
    let child
    try { child = spawn(executable, args, { cwd, env, windowsHide: true, stdio: 'ignore' }) } catch (error) { resolvePromise({ error, timedOut: false }); return }
    const timer = timeoutMs > 0 ? setTimeout(() => { try { child.kill() } catch { /* already exited */ } finish({ timedOut: true }) }, timeoutMs) : undefined
    timer?.unref?.()
    child.on('error', error => finish({ error, timedOut: false }))
    child.on('exit', (code, signal) => finish({ code, signal, timedOut: false }))
  })
}

/** Run a Python snippet with `-I` and read its JSON result file (never its stdout). */
async function runPythonJson({ python, script, resultPath, timeoutMs, cwd, env }) {
  rmSync(resultPath, { force: true })
  const outcome = await runProcess(python, ['-I', '-c', script], { timeoutMs, cwd, env })
  let result
  try { result = JSON.parse(readFileSync(resultPath, 'utf8')) } catch { result = undefined }
  rmSync(resultPath, { force: true })
  return { outcome, result }
}

const interpreterProbeScript = resultPath => `import json, pathlib, sys, sysconfig
pathlib.Path(${JSON.stringify(resultPath)}).write_text(json.dumps({
    "executable": sys.executable, "version": list(sys.version_info[:3]),
    "implementation": sys.implementation.name, "purelib": sysconfig.get_path("purelib"),
    "scripts": sysconfig.get_path("scripts"), "prefix": sys.prefix}), encoding="utf-8")
`

const importProbeScript = (corePath, resultPath) => `import json, pathlib, sys
try:
    sys.path.insert(0, ${JSON.stringify(corePath)})
    import thaliris
    from thaliris import core, authority
    import thaliris.errors, thaliris.identity, thaliris.identity_basis
    result = {"ok": True, "version": getattr(thaliris, "__version__", None), "path": thaliris.__file__,
              "schema_version": core._STATE_SCHEMA_VERSION, "python": ".".join(map(str, sys.version_info[:3])),
              "executable": sys.executable, "modules": ["thaliris.core", "thaliris.authority", "thaliris.errors", "thaliris.identity", "thaliris.identity_basis"]}
except Exception as error:
    result = {"ok": False, "error": type(error).__name__ + ": " + str(error)}
pathlib.Path(${JSON.stringify(resultPath)}).write_text(json.dumps(result), encoding="utf-8")
`

let probeCounter = 0
function probePath(directory, tag) {
  probeCounter += 1
  return join(directory, `.thaliris-${tag}-${process.pid}-${probeCounter}.json`)
}

/** Candidate interpreters in the documented order: explicit config, THALIRIS_PYTHON, host runtimes, PATH. */
function pythonCandidates(explicitPath, env) {
  const candidates = []
  if (isString(explicitPath)) candidates.push(explicitPath)
  if (isString(env.THALIRIS_PYTHON)) candidates.push(env.THALIRIS_PYTHON)
  const dshHome = isString(env.DSH_HOME) && isAbsolute(env.DSH_HOME) ? env.DSH_HOME : join(homedir(), '.dsh')
  const runtimes = join(dshHome, 'dsh-runtimes')
  try {
    for (const entry of readdirSync(runtimes, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const base = join(runtimes, entry.name, 'dependencies', 'python')
      const names = process.platform === 'win32' ? ['python.exe'] : ['bin/python3', 'bin/python']
      for (const name of names) if (existsSync(join(base, name))) candidates.push(join(base, name))
    }
  } catch { /* the host may not ship a bundled runtime */ }
  candidates.push(...(process.platform === 'win32' ? ['python.exe', 'python3', 'python'] : ['python3', 'python']))
  return [...new Set(candidates)]
}

async function detectPython({ explicitPath, authority, env }) {
  const failures = []
  let sawInterpreter = false
  for (const candidate of pythonCandidates(explicitPath, env)) {
    const resultPath = probePath(authority, 'python')
    const { outcome, result } = await runPythonJson({ python: candidate, script: interpreterProbeScript(resultPath), resultPath, timeoutMs: PROBE_TIMEOUT_MS, cwd: authority, env })
    if (result === undefined) {
      failures.push(`${commandName(candidate)}: ${outcome.timedOut ? 'probe timed out' : outcome.error ? 'cannot spawn' : `probe exited ${outcome.code}`}`)
      continue
    }
    sawInterpreter = true
    const version = Array.isArray(result.version) ? result.version.map(Number) : []
    if (result.implementation !== 'cpython' || version[0] !== MIN_PYTHON[0] || version[1] < MIN_PYTHON[1]) {
      failures.push(`${commandName(candidate)}: ${version.join('.')} ${result.implementation} (need CPython ${MIN_PYTHON.join('.')}+)`)
      continue
    }
    return { executable: candidate, version, implementation: result.implementation, purelib: result.purelib, chosenFrom: isString(explicitPath) && candidate === explicitPath ? 'explicit' : isString(env.THALIRIS_PYTHON) && candidate === env.THALIRIS_PYTHON ? 'THALIRIS_PYTHON' : 'host detection' }
  }
  const code = sawInterpreter ? SETUP_CODES.pythonUnsupported : SETUP_CODES.pythonNotFound
  throw provisionError(code, `no usable Python found (${failures.join('; ') || 'no candidates'})`, { candidates: failures.length })
}

async function fetchCore({ lock, cacheDir, env, fetchImpl, log }) {
  if (isString(env.THALIRIS_CORE_TARBALL)) {
    const staged = resolve(env.THALIRIS_CORE_TARBALL)
    let bytes
    try { bytes = readFileSync(staged) } catch (error) { throw provisionError(SETUP_CODES.sourceFetchFailed, `cannot read THALIRIS_CORE_TARBALL (${error?.code ?? 'read failed'})`, {}) }
    assertTarballHash(bytes, lock)
    return { bytes, url: 'THALIRIS_CORE_TARBALL', cached: true, fetchMs: 0 }
  }
  const cacheFile = join(cacheDir, `core-${lock.commit}.tar.gz`)
  if (existsSync(cacheFile)) {
    const bytes = readFileSync(cacheFile)
    if (sha256(bytes) === lock.tarballSha256) return { bytes, url: cacheFile, cached: true, fetchMs: 0 }
    rmSync(cacheFile, { force: true })
  }
  const started = now()
  let response
  try {
    response = await fetchImpl(lock.tarballUrl, { redirect: 'follow', signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
  } catch (error) {
    const detail = error?.name === 'TimeoutError' || error?.name === 'AbortError' ? `request timed out after ${FETCH_TIMEOUT_MS} ms` : `request failed (${error?.code ?? error?.name ?? 'network error'})`
    throw provisionError(SETUP_CODES.sourceFetchFailed, detail, { timeout_ms: FETCH_TIMEOUT_MS })
  }
  if (!response.ok) throw provisionError(SETUP_CODES.sourceFetchFailed, `pinned Core source returned HTTP ${response.status}`, { status: response.status })
  let bytes
  try { bytes = Buffer.from(await response.arrayBuffer()) } catch (error) {
    throw provisionError(SETUP_CODES.sourceFetchFailed, `response body failed (${error?.name ?? 'read error'})`)
  }
  assertTarballHash(bytes, lock)
  try {
    mkdirSync(cacheDir, { recursive: true })
    const temporary = `${cacheFile}.${process.pid}.tmp`
    writeFileSync(temporary, bytes)
    renameSync(temporary, cacheFile)
  } catch (error) {
    // The verified bytes are usable without a cache; a later run simply fetches again.
    rmSync(`${cacheFile}.${process.pid}.tmp`, { force: true })
    log(`thaliris: could not cache the Core tarball (${error?.code ?? 'write failed'}); continuing with the verified download`)
  }
  return { bytes, url: lock.tarballUrl, cached: false, fetchMs: now() - started }
}

function assertTarballHash(bytes, lock) {
  const actual = sha256(bytes)
  if (actual !== lock.tarballSha256) {
    throw provisionError(SETUP_CODES.sourceHashMismatch, `tarball sha256 does not match core.lock.json (got ${actual.slice(0, 12)}...)`, { expected: lock.tarballSha256, actual })
  }
}

function extractPackage(tarball, lock) {
  let entries
  try { entries = readTar(gunzipSync(tarball)) } catch (error) {
    throw provisionError(SETUP_CODES.sourceFetchFailed, `source archive is not a readable gzip tar (${error?.code ?? 'invalid archive'})`)
  }
  const roots = new Set(entries.filter(entry => entry.path.includes('/')).map(entry => entry.path.split('/')[0]))
  if (roots.size !== 1) throw provisionError(SETUP_CODES.sourceFetchFailed, 'source archive is not a single-root GitHub tarball')
  const root = [...roots][0]
  const pyproject = entries.find(entry => entry.path === `${root}/pyproject.toml`)
  if (!pyproject) throw provisionError(SETUP_CODES.sourceFetchFailed, 'pyproject.toml is missing from the pinned source archive')
  const projectVersion = (pyproject.body.toString('utf8').match(/^version\s*=\s*"([^"]+)"/m) || [])[1]
  if (!projectVersion) throw provisionError(SETUP_CODES.sourceFetchFailed, 'cannot read [project].version from pyproject.toml')
  if (projectVersion !== lock.version) {
    throw provisionError(SETUP_CODES.coreVersionMismatch, `source archive version does not match core.lock.json`, { archive: projectVersion, lock: lock.version })
  }
  const prefix = `${root}/src/thaliris/`
  const files = entries.filter(entry => entry.type === 'file' && entry.path.startsWith(prefix)).map(entry => ({ path: entry.path.slice(prefix.length), body: entry.body }))
  if (!files.some(file => file.path === '__init__.py')) throw provisionError(SETUP_CODES.sourceFetchFailed, 'src/thaliris/__init__.py is missing from the pinned source archive')
  const treeSha256 = packageTreeSha256(files)
  if (treeSha256 !== lock.packageTreeSha256) {
    throw provisionError(SETUP_CODES.sourceHashMismatch, 'package tree digest does not match core.lock.json (the pinned source differs)', { expected: lock.packageTreeSha256, actual: treeSha256 })
  }
  return { files, projectVersion, treeSha256 }
}

async function installPure({ venvPython, runtimePrefix, files, version, lock, env }) {
  const resultPath = join(runtimePrefix, '.paths-result.json')
  const { outcome, result: paths } = await runPythonJson({ python: venvPython, script: interpreterProbeScript(resultPath), resultPath, timeoutMs: PROBE_TIMEOUT_MS, cwd: runtimePrefix, env })
  if (!paths?.purelib) throw provisionError(SETUP_CODES.coreInstallFailed, `cannot resolve the runtime site-packages (${outcome.timedOut ? 'probe timed out' : `probe exited ${outcome.code ?? 'with an error'}`})`)
  const packageDirectory = join(paths.purelib, 'thaliris')
  for (const file of files) {
    const target = join(packageDirectory, file.path)
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, file.body)
  }
  const distInfo = join(paths.purelib, `thaliris-${version}.dist-info`)
  mkdirSync(distInfo, { recursive: true })
  writeFileSync(join(distInfo, 'METADATA'), `Metadata-Version: 2.1\nName: thaliris\nVersion: ${version}\nSummary: Host-neutral mechanical task ledger, evidence, retrieval, memory and authority\nLicense: MIT\nRequires-Python: >=3.11\n`)
  writeFileSync(join(distInfo, 'WHEEL'), 'Wheel-Version: 1.0\nGenerator: thaliris-dsh setup (pure-source install)\nRoot-Is-Purelib: true\nTag: py3-none-any\n')
  writeFileSync(join(distInfo, 'entry_points.txt'), '[console_scripts]\nthaliris-core = thaliris.cli:main\n')
  writeFileSync(join(distInfo, 'INSTALLER'), 'thaliris-dsh-setup\n')
  mkdirSync(paths.scripts, { recursive: true })
  if (process.platform === 'win32') {
    writeFileSync(join(paths.scripts, 'thaliris-core.cmd'), '@echo off\r\n"%~dp0python.exe" -c "from thaliris.cli import main; import sys; sys.exit(main())" %*\r\n')
  } else {
    const shim = join(paths.scripts, 'thaliris-core')
    writeFileSync(shim, '#!/bin/sh\nexec "$(dirname "$0")/python" -c "from thaliris.cli import main; import sys; sys.exit(main())" "$@"\n')
    chmodSync(shim, 0o755)
  }
  // Verify the copy itself: the package tree on disk must still hash to the reviewed pin.
  const copiedTree = packageTreeSha256(readTreeFiles(packageDirectory))
  if (copiedTree !== lock.packageTreeSha256) {
    throw provisionError(SETUP_CODES.coreInstallFailed, 'copied Core package tree does not match core.lock.json', { expected: lock.packageTreeSha256, actual: copiedTree })
  }
  return { purelib: paths.purelib, scripts: paths.scripts, python: paths.executable, files: files.length, bytes: files.reduce((total, file) => total + file.body.length, 0), projectVersion: version }
}

async function verifyImports({ pythonExecutable, corePath, probeDirectory, requirePinVersion, requirePathInsideCore, lock, env }) {
  const resultPath = probePath(probeDirectory, 'verify')
  const { outcome, result } = await runPythonJson({ python: pythonExecutable, script: importProbeScript(corePath, resultPath), resultPath, timeoutMs: PROBE_TIMEOUT_MS, cwd: probeDirectory, env })
  if (outcome.error || outcome.timedOut) throw provisionError(SETUP_CODES.coreVerifyFailed, `verification interpreter ${outcome.timedOut ? 'timed out' : 'could not start'}`, {})
  if (!result) throw provisionError(SETUP_CODES.coreVerifyFailed, `verification probe produced no result (exit ${outcome.code ?? 'unknown'})`, {})
  if (!result.ok) throw provisionError(SETUP_CODES.coreVerifyFailed, `Core import failed inside the configured interpreter (${result.error ?? 'unknown import error'})`, {})
  if (requirePathInsideCore && !isInside(corePath, String(result.path ?? ''))) {
    throw provisionError(SETUP_CODES.coreVerifyFailed, 'the configured interpreter did not import Core from the configured corePath', {})
  }
  if (requirePinVersion && result.version !== lock.version) {
    throw provisionError(SETUP_CODES.coreVersionMismatch, `Core ${result.version} does not match the pinned ${lock.version}`, { version: result.version })
  }
  if (result.schema_version !== lock.stateSchemaVersion) {
    throw provisionError(SETUP_CODES.coreVersionMismatch, `Core state schema ${result.schema_version} does not match the pinned ${lock.stateSchemaVersion}`, { schema_version: result.schema_version })
  }
  return {
    version: result.version, schemaVersion: result.schema_version, pythonVersion: result.python,
    path: result.path, modules: Array.isArray(result.modules) ? result.modules : [...MODULES],
  }
}

function readManifest(authority) {
  try {
    const value = JSON.parse(readFileSync(join(authority, 'runtime.json'), 'utf8'))
    return value && typeof value === 'object' ? value : undefined
  } catch (error) {
    // Missing is the normal first-run state; a damaged manifest is reported by status but
    // never blocks load or the next provisioning attempt.
    return error?.code === 'ENOENT' ? undefined : { damaged: true }
  }
}

/** Recorded runtime fields from `runtime.json`, tolerant of older/partial manifests. */
function runtimeFromManifest(manifest, authority) {
  if (!manifest || manifest.damaged) return undefined
  const pythonExecutable = isString(manifest.pythonExecutable) ? manifest.pythonExecutable : manifest.runtime?.python_path
  const corePath = isString(manifest.corePath) ? manifest.corePath : manifest.runtime?.core_path
  if (!isString(pythonExecutable) || !isAbsolute(pythonExecutable) || !isString(corePath) || !isAbsolute(corePath)) return undefined
  return {
    pythonExecutable, corePath, authorityDirectory: authority,
    version: manifest.core?.version, commit: manifest.core?.commit, stateSchemaVersion: manifest.core?.state_schema_version,
    sourceSha256: manifest.core?.source?.sha256, packageTreeSha256: manifest.core?.source?.package_tree_sha256,
    pythonVersion: manifest.python?.version, verifiedAt: manifest.verify?.checked_at ?? manifest.updated_at ?? manifest.created_at,
  }
}

function acquireProvisionLock(authority) {
  const lockPath = join(authority, 'provision.lock')
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = openSync(lockPath, 'wx')
      try { writeFileSync(handle, JSON.stringify({ pid: process.pid, started_at: isoNow(), host: process.platform })) } finally { closeSync(handle) }
      return () => { try { rmSync(lockPath, { force: true }) } catch { /* another provisioning attempt already removed it */ } }
    } catch (error) {
      if (error?.code !== 'EEXIST') throw provisionError(SETUP_CODES.manifestWriteFailed, `cannot create the provisioning lock (${error?.code ?? 'write failed'})`, {})
      let stale = true
      try { stale = now() - statSync(lockPath).mtimeMs > PROVISION_LOCK_STALE_MS } catch { stale = true }
      if (!stale) throw provisionError(SETUP_CODES.runtimeProvisioning, 'another process is preparing the runtime', {})
      rmSync(lockPath, { force: true })
    }
  }
  throw provisionError(SETUP_CODES.runtimeProvisioning, 'could not acquire the provisioning lock', {})
}

function cleanupOtherRuntimes(authority, keep) {
  try {
    for (const entry of readdirSync(authority, { withFileTypes: true })) {
      if (!entry.isDirectory() || !entry.name.startsWith('runtime-')) continue
      const path = join(authority, entry.name)
      if (path !== keep) rmSync(path, { recursive: true, force: true })
    }
  } catch { /* best effort: stale runtime directories are harmless and never block provisioning */ }
}

function writeManifest({ authority, runtimePrefix, lock, python, install, verification, source, elapsedMs }) {
  const target = join(authority, 'runtime.json')
  let previous
  try { previous = JSON.parse(readFileSync(target, 'utf8')) } catch { previous = undefined }
  const stamp = isoNow()
  const manifest = {
    manifest_version: MANIFEST_VERSION,
    created_at: isString(previous?.created_at) ? previous.created_at : stamp,
    updated_at: stamp,
    host_platform: process.platform,
    installer: { name: '@thaliris/dsh-plugin setup', node: process.version, method: 'pure-source-copy' },
    pythonExecutable: install.python,
    corePath: install.purelib,
    authorityDirectory: authority,
    core: {
      repository: lock.repository, commit: lock.commit, version: verification.version,
      state_schema_version: verification.schemaVersion,
      source: { kind: 'codeload-tarball', url: source.url, sha256: source.sha256, package_tree_sha256: lock.packageTreeSha256, cached: source.cached, fetch_ms: source.fetchMs },
      install: { method: 'pure-source-copy', files: install.files, bytes: install.bytes },
    },
    python: { executable: python.executable, version: python.version.join('.'), implementation: python.implementation, chosen_from: python.chosenFrom },
    runtime: { prefix: runtimePrefix, python_path: install.python, core_path: install.purelib, scripts_path: install.scripts },
    verify: { ok: true, version: verification.version, schema_version: verification.schemaVersion, python: verification.pythonVersion, checked_at: stamp, bridge_protocol: 1, modules: verification.modules, core_path: verification.path },
    provisioning: { elapsed_ms: elapsedMs, tarball_cached: source.cached, fetch_ms: source.fetchMs },
  }
  mkdirSync(authority, { recursive: true })
  const temporary = `${target}.${process.pid}.tmp`
  try {
    writeFileSync(temporary, `${JSON.stringify(manifest, null, 2)}\n`)
    renameSync(temporary, target)
  } catch (error) {
    rmSync(temporary, { force: true })
    throw provisionError(SETUP_CODES.manifestWriteFailed, `cannot write runtime.json (${error?.code ?? 'write failed'})`, {})
  }
  return target
}

/** Strip absolute host paths from detail text that may reach a model-visible error or the Gateway. */
function redactPaths(text) {
  return String(text ?? '')
    .replace(/[A-Za-z]:[\\/][^\s"']+/g, '<path>')
    .replace(/\\\\[^\s"']+/g, '<path>')
    .replace(/\/(?:home|Users|tmp|var|opt|mnt|root|private)\/[^\s"']*/g, '<path>')
    .slice(0, 400)
}

/**
 * Create the lazy setup state machine for one plugin row.
 *
 * @param options.config - parsed plugin Config proxy; the three path fields are read on use.
 * @param options.profileName - returns the active profile name (authority default).
 * @param options.workspaceRoots - returns configured workspace roots (authority safety check).
 * @param options.env - environment (defaults to `process.env`).
 * @param options.log - diagnostic sink for non-fatal notices.
 * @param options.fetch - fetch implementation (tests may substitute one).
 * @param options.lockPath - Core pin location (tests may substitute one).
 * @returns status/ensure/prepare/recheck/recordedRuntime/generation/authority accessors.
 */
export function createRuntimeSetup(options = {}) {
  const config = options.config ?? {}
  const env = options.env ?? process.env
  const profileName = options.profileName ?? (() => undefined)
  const workspaceRoots = options.workspaceRoots ?? (() => [])
  const log = options.log ?? (() => {})
  const fetchImpl = options.fetch ?? globalThis.fetch
  const lockPath = options.lockPath ?? DEFAULT_LOCK_PATH
  const stringConfig = key => isString(configValue(config, key))
  const current = {
    status: SETUP_STATES.unconfigured, step: undefined, code: undefined, detail: undefined,
    attempt: 0, startedAt: undefined, elapsedMs: undefined, runtime: undefined,
    signature: undefined, provisioned: false,
  }
  let generation = 0
  let flight
  let lockCache

  const authorityDirectory = () => resolveAuthorityDirectory(config, profileName(), env)
  const roots = () => { try { return (workspaceRoots() ?? []).filter(isString) } catch { return [] } }

  function coreLock() {
    if (lockCache) return lockCache
    try { lockCache = readCoreLock(lockPath) } catch (error) {
      throw provisionError(SETUP_CODES.lockInvalid, error instanceof Error ? error.message : String(error))
    }
    return lockCache
  }

  function recordedRuntime() {
    try { return runtimeFromManifest(readManifest(authorityDirectory()), authorityDirectory()) } catch { return undefined }
  }

  function signature() {
    return JSON.stringify([
      stringConfig('pythonExecutable') ? resolve(configValue(config, 'pythonExecutable')) : '',
      stringConfig('corePath') ? resolve(configValue(config, 'corePath')) : '',
      authorityDirectory(),
    ])
  }

  function setState(status, step) {
    current.status = status
    current.step = step
  }

  function markFailed(error) {
    const wrapped = error instanceof ProvisionError ? error : provisionError('THALIRIS_PROVISION_FAILED', error instanceof Error ? error.message : String(error))
    current.status = SETUP_STATES.failed
    current.code = wrapped.code
    current.detail = redactPaths(wrapped.message)
    current.elapsedMs = current.startedAt === undefined ? undefined : now() - current.startedAt
    current.provisioned = false
    return wrapped
  }

  function markReady(runtime, provisioned) {
    current.status = SETUP_STATES.ready
    current.step = 'ready'
    current.code = undefined
    current.detail = undefined
    current.runtime = runtime
    current.signature = signature()
    current.provisioned = provisioned
    current.elapsedMs = current.startedAt === undefined ? undefined : now() - current.startedAt
    generation += 1
  }

  async function runEnsure() {
    current.attempt += 1
    current.startedAt = now()
    current.elapsedMs = undefined
    current.code = undefined
    current.detail = undefined
    current.provisioned = false
    const authority = authorityDirectory()
    try { mkdirSync(authority, { recursive: true }) } catch (error) {
      throw markFailed(provisionError(SETUP_CODES.manifestWriteFailed, `cannot create the authority directory (${error?.code ?? 'write failed'})`))
    }
    try {
      const lock = coreLock()
      const explicitPython = stringConfig('pythonExecutable') ? resolve(configValue(config, 'pythonExecutable')) : undefined
      const explicitCore = stringConfig('corePath') ? resolve(configValue(config, 'corePath')) : undefined
      const recorded = recordedRuntime()
      // A recorded runtime is only trusted for the pinned version; any other version is
      // replaced by provisioning instead of being silently used.
      const manifestUsable = recorded !== undefined && recorded.version === lock.version
      const pythonCandidate = explicitPython ?? (manifestUsable ? recorded.pythonExecutable : undefined)
      const coreCandidate = explicitCore ?? (manifestUsable ? recorded.corePath : undefined)

      if (pythonCandidate && coreCandidate) {
        const fromManifest = !(explicitPython && explicitCore)
        setState(SETUP_STATES.verifying, fromManifest ? 'verify-recorded' : 'verify-configured')
        try {
          const verification = await verifyImports({ pythonExecutable: pythonCandidate, corePath: coreCandidate, probeDirectory: authority, requirePinVersion: fromManifest, requirePathInsideCore: fromManifest, lock, env })
          const runtime = {
            pythonExecutable: pythonCandidate, corePath: coreCandidate, authorityDirectory: authority,
            version: verification.version, commit: lock.commit, stateSchemaVersion: verification.schemaVersion,
            pythonVersion: verification.pythonVersion, verifiedAt: isoNow(), modules: verification.modules,
            versionMatchesPin: verification.version === lock.version,
            source: fromManifest ? 'recorded' : 'configuration',
          }
          markReady(runtime, false)
          return { runtime, provisioned: false }
        } catch (error) {
          // Explicit overrides are authoritative: a wrong manual path fails closed with the
          // actionable code instead of provisioning somewhere the resolver will not use.
          if (explicitPython && explicitCore) throw error
          log(`thaliris: recorded runtime is not usable (${error?.code ?? 'verification failed'}); provisioning again`, 'warn')
        }
      }
      return await provisionCore({ authority, lock })
    } catch (error) {
      throw markFailed(error)
    }
  }

  async function provisionCore({ authority, lock }) {
    assertAuthoritySafe(authority, roots())
    setState(SETUP_STATES.detecting, 'detect-python')
    const python = await detectPython({ explicitPath: stringConfig('pythonExecutable') ? resolve(configValue(config, 'pythonExecutable')) : undefined, authority, env })
    const pythonTag = `${python.version[0]}.${python.version[1]}`
    const runtimePrefix = join(authority, `runtime-${lock.version}-py${pythonTag}`)
    assertAuthoritySafe(runtimePrefix, roots())
    const release = acquireProvisionLock(authority)
    const cacheDir = join(authority, 'cache')
    try {
      setState(SETUP_STATES.provisioning, 'fetch-source')
      const source = await fetchCore({ lock, cacheDir, env, fetchImpl, log })
      const extracted = extractPackage(source.bytes, lock)
      setState(SETUP_STATES.provisioning, 'create-runtime')
      rmSync(runtimePrefix, { recursive: true, force: true })
      mkdirSync(runtimePrefix, { recursive: true })
      const venv = await runProcess(python.executable, ['-m', 'venv', '--without-pip', runtimePrefix], { timeoutMs: VENV_TIMEOUT_MS, cwd: authority, env })
      if (venv.timedOut) throw provisionError(SETUP_CODES.venvFailed, `runtime creation timed out after ${VENV_TIMEOUT_MS} ms`)
      if (venv.error) throw provisionError(SETUP_CODES.venvFailed, 'cannot start the selected Python to create the runtime')
      if (venv.code !== 0) throw provisionError(SETUP_CODES.venvFailed, `runtime creation exited with ${venv.code}`)
      const venvPython = join(runtimePrefix, process.platform === 'win32' ? 'Scripts' : 'bin', process.platform === 'win32' ? 'python.exe' : 'python')
      if (!existsSync(venvPython)) throw provisionError(SETUP_CODES.venvFailed, 'runtime interpreter was not created')
      setState(SETUP_STATES.provisioning, 'install-core')
      const install = await installPure({ venvPython, runtimePrefix, files: extracted.files, version: extracted.projectVersion, lock, env })
      setState(SETUP_STATES.verifying, 'verify-core')
      const verification = await verifyImports({ pythonExecutable: venvPython, corePath: install.purelib, probeDirectory: runtimePrefix, requirePinVersion: true, requirePathInsideCore: true, lock, env })
      setState(SETUP_STATES.provisioning, 'write-manifest')
      writeManifest({ authority, runtimePrefix, lock, python, install, verification, source: { ...source, sha256: sha256(source.bytes) }, elapsedMs: now() - current.startedAt })
      const runtime = {
        pythonExecutable: venvPython, corePath: install.purelib, authorityDirectory: authority,
        version: verification.version, commit: lock.commit, stateSchemaVersion: verification.schemaVersion,
        pythonVersion: verification.pythonVersion, verifiedAt: isoNow(), modules: verification.modules,
        versionMatchesPin: true, source: 'provisioned',
      }
      cleanupOtherRuntimes(authority, runtimePrefix)
      markReady(runtime, true)
      return { runtime, provisioned: true }
    } catch (error) {
      // Failure invariant: remove the partial runtime, keep the verified tarball cache.
      rmSync(runtimePrefix, { recursive: true, force: true })
      throw error
    } finally {
      release()
    }
  }

  /**
   * Unverified display runtime derived from config/recorded paths without running Python:
   * lets the settings page show a usable runtime on a fresh process; `ensure()` still runs
   * the import probe before the bridge or a Gateway action reports `verified: true`.
   */
  function displayRuntime(authority, lock) {
    if (current.runtime) return { runtime: current.runtime, provisional: false }
    if (current.status === SETUP_STATES.failed) return undefined
    const explicitPython = stringConfig('pythonExecutable') ? resolve(configValue(config, 'pythonExecutable')) : undefined
    const explicitCore = stringConfig('corePath') ? resolve(configValue(config, 'corePath')) : undefined
    const recorded = recordedRuntime()
    if (recorded !== undefined && lock !== undefined && recorded.version !== lock.version) return undefined
    const pythonExecutable = explicitPython ?? recorded?.pythonExecutable
    const corePath = explicitCore ?? recorded?.corePath
    if (!pythonExecutable || !corePath) return undefined
    if (!existsSync(pythonExecutable) || !existsSync(join(corePath, 'thaliris', '__init__.py'))) return { incomplete: true }
    return {
      provisional: true,
      runtime: {
        pythonExecutable, corePath, authorityDirectory: authority,
        version: recorded?.version ?? null, commit: recorded?.commit ?? lock?.commit ?? null,
        stateSchemaVersion: recorded?.stateSchemaVersion ?? lock?.stateSchemaVersion ?? null,
        pythonVersion: recorded?.pythonVersion ?? null, verifiedAt: recorded?.verifiedAt ?? null,
        versionMatchesPin: recorded?.version === lock?.version,
        source: explicitPython && explicitCore ? 'configuration' : 'recorded',
      },
    }
  }

  function status() {
    try {
      const authority = authorityDirectory()
      const explicitPython = stringConfig('pythonExecutable')
      const explicitCore = stringConfig('corePath')
      let lock, pin
      try { lock = coreLock(); pin = { version: lock.version, commit: lock.commit, stateSchemaVersion: lock.stateSchemaVersion } } catch (error) { pin = { error: redactPaths(error instanceof Error ? error.message : String(error)) } }
      const display = displayRuntime(authority, lock)
      const runtime = display?.runtime
      // Derived states keep the Gateway informative before the first bridge call: a
      // usable path pair is `ready` but unverified; recorded-but-incomplete is actionable.
      let state = current.status
      let code = current.code ?? null
      if (state === SETUP_STATES.unconfigured) {
        if (display?.incomplete) { state = SETUP_STATES.unconfigured; code = RUNTIME_CODES.notReady }
        else if (runtime) { state = SETUP_STATES.ready; code = null }
        else if (!pin.error) code = RUNTIME_CODES.notConfigured
      }
      const progress = current.status === SETUP_STATES.detecting || current.status === SETUP_STATES.provisioning || current.status === SETUP_STATES.verifying
        ? { step: current.step ?? null, started_at: current.startedAt === undefined ? null : new Date(current.startedAt).toISOString(), elapsed_ms: current.startedAt === undefined ? null : now() - current.startedAt }
        : null
      return {
        state,
        verified: current.status === SETUP_STATES.ready,
        code,
        recovery: code ? recoveryFor(code) : null,
        detail: current.detail ?? null,
        step: current.step ?? (state === SETUP_STATES.ready ? 'ready' : null),
        attempt: current.attempt,
        elapsed_ms: current.elapsedMs ?? null,
        progress,
        configured: Boolean(explicitPython && explicitCore),
        manual_override: Boolean(explicitPython || explicitCore),
        authorityDirectory: authority,
        runtime: runtime
          ? {
            pythonExecutable: runtime.pythonExecutable, corePath: runtime.corePath, version: runtime.version ?? null,
            commit: runtime.commit ?? null, state_schema_version: runtime.stateSchemaVersion ?? null,
            python: runtime.pythonVersion ?? null, verified_at: runtime.verifiedAt ?? null,
            source: runtime.source ?? null, version_matches_pin: runtime.versionMatchesPin ?? null,
          }
          : null,
        pin,
      }
    } catch (error) {
      return {
        state: SETUP_STATES.failed, code: 'THALIRIS_SETUP_STATUS_FAILED', recovery: RUNTIME_RECOVERY,
        detail: redactPaths(error instanceof Error ? error.message : String(error)), configured: false, manual_override: false,
        authorityDirectory: null, runtime: null, pin: {},
      }
    }
  }

  /** Abort-aware await: the shared provisioning flight continues in the background on cancel. */
  function waitFor(pending, signal) {
    if (!signal) return pending
    if (signal.aborted) return Promise.reject(provisionError(SETUP_CODES.setupAborted, 'the operation was cancelled'))
    return new Promise((resolvePromise, rejectPromise) => {
      const onAbort = () => rejectPromise(provisionError(SETUP_CODES.setupAborted, 'the operation was cancelled'))
      signal.addEventListener('abort', onAbort, { once: true })
      pending.then(value => { signal.removeEventListener('abort', onAbort); resolvePromise(value) }, error => { signal.removeEventListener('abort', onAbort); rejectPromise(error) })
    })
  }

  /**
   * Ensure a verified runtime is available, provisioning on first use. Single-flight per
   * setup instance; a caller that cancels stops waiting but does not kill the shared work.
   * @param options.signal - caller cancellation/timeout signal.
   * @param options.force - re-verify even when this process already settled on a runtime.
   * @returns the usable runtime and whether this call provisioned it.
   */
  async function ensure({ signal, force = false } = {}) {
    if (!force && current.status === SETUP_STATES.ready && current.runtime && signature() === current.signature) return { runtime: current.runtime, provisioned: false }
    if (!flight) {
      flight = runEnsure().finally(() => { flight = undefined })
    }
    return await waitFor(flight, signal)
  }

  /**
   * Human Gateway action: ensure the runtime and report the setup state. Never throws.
   * @param options.signal - optional cancellation from the human client.
   * @returns setup status plus `ok`, `already` and call `elapsed_ms`.
   */
  async function prepare({ signal } = {}) {
    const started = now()
    try {
      const result = await ensure({ signal })
      return { ...status(), ok: true, already: result.provisioned === false, provisioned: result.provisioned, elapsed_ms: now() - started }
    } catch (error) {
      const failed = error instanceof ProvisionError ? error : provisionError('THALIRIS_PROVISION_FAILED', error instanceof Error ? error.message : String(error))
      if (current.status !== SETUP_STATES.failed) markFailed(failed)
      return { ...status(), ok: false, already: false, provisioned: false, code: failed.code, recovery: failed.recovery, elapsed_ms: now() - started }
    }
  }

  /**
   * Human Gateway action: re-read the configured/recorded runtime and re-verify it without
   * provisioning. A missing runtime becomes `unconfigured`; a broken one becomes `failed`.
   * @param options.signal - optional cancellation from the human client.
   * @returns the resulting setup status (never throws).
   */
  async function recheck({ signal } = {}) {
    if (signal?.aborted) return status()
    if (flight) return status()
    current.attempt += 1
    current.startedAt = now()
    current.elapsedMs = undefined
    current.code = undefined
    current.detail = undefined
    try {
      const authority = authorityDirectory()
      const lock = coreLock()
      const explicitPython = stringConfig('pythonExecutable') ? resolve(configValue(config, 'pythonExecutable')) : undefined
      const explicitCore = stringConfig('corePath') ? resolve(configValue(config, 'corePath')) : undefined
      const recorded = recordedRuntime()
      const manifestUsable = recorded !== undefined && recorded.version === lock.version
      const pythonCandidate = explicitPython ?? (manifestUsable ? recorded.pythonExecutable : undefined)
      const coreCandidate = explicitCore ?? (manifestUsable ? recorded.corePath : undefined)
      if (!pythonCandidate || !coreCandidate) {
        current.status = SETUP_STATES.unconfigured
        current.step = undefined
        current.runtime = undefined
        current.code = RUNTIME_CODES.notConfigured
        current.detail = 'no configured or recorded runtime'
        current.elapsedMs = now() - current.startedAt
        return status()
      }
      const fromManifest = !(explicitPython && explicitCore)
      setState(SETUP_STATES.verifying, fromManifest ? 'verify-recorded' : 'verify-configured')
      const verification = await verifyImports({ pythonExecutable: pythonCandidate, corePath: coreCandidate, probeDirectory: authority, requirePinVersion: fromManifest, requirePathInsideCore: fromManifest, lock, env })
      markReady({
        pythonExecutable: pythonCandidate, corePath: coreCandidate, authorityDirectory: authority,
        version: verification.version, commit: lock.commit, stateSchemaVersion: verification.schemaVersion,
        pythonVersion: verification.pythonVersion, verifiedAt: isoNow(), modules: verification.modules,
        versionMatchesPin: verification.version === lock.version, source: fromManifest ? 'recorded' : 'configuration',
      }, false)
    } catch (error) {
      markFailed(error)
    }
    return status()
  }

  function generationNumber() { return generation }
  function busy() { return flight !== undefined }

  return { status, ensure, prepare, recheck, recordedRuntime, authority: authorityDirectory, generation: generationNumber, busy }
}
