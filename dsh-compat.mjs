// DSH host compatibility is an interface range, not a pinned revision. The
// plugin's runtime surface (Agent Presets, subagent activation, session log) is
// the same across the 0.2.1 prerelease line from rc.2 through rc.3, so every
// build and test gate accepts any checkout whose host version satisfies the
// range and then exercises the real interface. Pinning one revision here would
// reject the identical interface and force an exact-version exemption.
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

/** Declared against `engines.dsh` in package.json; keep the two in agreement. */
export const DSH_COMPATIBILITY_RANGE = '>=0.2.1-rc.2 <0.2.2-0'
/** Versions this repository's evidence covers; a subset of the range, not a gate. */
export const DSH_VERIFIED_VERSIONS = Object.freeze(['0.2.1-rc.2', '0.2.1-rc.3'])
/** Upstream tags for the verified versions, used by CI without committing hashes. */
export const DSH_VERIFIED_TAGS = Object.freeze(['dsh-v0.2.1-rc.2', 'dsh-v0.2.1-rc.3'])

/** Read the DSH host version from a source checkout's root manifest. */
export function dshSourceVersion(source) {
  const manifest = JSON.parse(readFileSync(join(source, 'package.json'), 'utf8'))
  if (typeof manifest.version !== 'string') throw new Error(`DSH source ${source} has no root package version.`)
  return manifest.version
}

/**
 * Resolve the checkout's own semver implementation and confirm that its host
 * version lies inside the interface range. Returns the version and revision for
 * logs; revision is evidence, never an admission condition.
 */
export function assertDshSource(source, purpose = 'DSH source checkout') {
  if (!source) throw new Error(`Set DSH_SOURCE to a compatible DSH source checkout for the ${purpose}.`)
  const version = dshSourceVersion(source)
  const requireSource = createRequire(resolve(source, 'package.json'))
  let semver
  try { semver = requireSource('semver') } catch { semver = undefined }
  // CI installs the checkout's dependencies before running the adapter gates; a
  // missing semver in a hand-made checkout is reported instead of silently pinned.
  if (!semver || typeof semver.satisfies !== 'function') throw new Error(`DSH source ${source} does not expose its semver dependency; install its workspace dependencies first.`)
  if (!semver.satisfies(version, DSH_COMPATIBILITY_RANGE, { includePrerelease: true })) {
    throw new Error(`DSH source ${source} is ${version}; this plugin supports DSH ${DSH_COMPATIBILITY_RANGE}. Pinning one revision is not required: use any checkout of a compatible interface version.`)
  }
  const revision = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: source, encoding: 'utf8' })
  return { source: resolve(source), version, range: DSH_COMPATIBILITY_RANGE, revision: revision.status === 0 ? revision.stdout.trim() : 'UNKNOWN' }
}
