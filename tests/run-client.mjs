import { cpSync, copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const adapterRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const source = process.env.DSH_SOURCE
if (!source) throw new Error('Set DSH_SOURCE to the pinned DSH source checkout.')
const revision = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: source, encoding: 'utf8' })
if (revision.status !== 0 || revision.stdout.trim() !== '639ed015397290b3745d163aafe02ffee4aa3f84') {
  throw new Error('DSH source revision differs from the verified client baseline.')
}

// Vitest admits workspace-local tests only. Copy this product package into a
// temporary workspace slot so the actual DSH aliases, CSS handling, and jsdom
// renderer are used while leaving the user's DSH checkout unchanged.
const temporary = mkdtempSync(join(source, 'packages', 'client', 'thaliris-client-'))
const packageRoot = resolve(join(source, 'packages', 'client'))
const relativeTemp = relative(packageRoot, resolve(temporary))
if (!relativeTemp || relativeTemp.startsWith(`..${sep}`) || resolve(temporary) === packageRoot) {
  throw new Error('Refusing to remove a temporary client test package outside the DSH client workspace.')
}
const pkg = temporary
const tests = join(pkg, 'tests')
const upstreamNodeModules = join(source, 'packages', 'client', 'ui-settings-subagent', 'node_modules')
const dependencyLink = join(pkg, 'node_modules')
const requireDomain = createRequire(resolve(source, 'packages/storage/storage-domain/package.json'))
const zodDirectory = dirname(requireDomain.resolve('zod'))
mkdirSync(join(pkg, 'client'), { recursive: true })
mkdirSync(tests, { recursive: true })
try {
  cpSync(join(adapterRoot, 'client'), join(pkg, 'client'), { recursive: true })
  copyFileSync(join(adapterRoot, 'remote.mjs'), join(pkg, 'remote.mjs'))
  copyFileSync(join(adapterRoot, 'remote.d.ts'), join(pkg, 'remote.d.ts'))
  copyFileSync(join(adapterRoot, 'remote.d.mts'), join(pkg, 'remote.d.mts'))
  copyFileSync(join(adapterRoot, 'tests', 'shared-client.spec.tsx'), join(tests, 'shared-client.spec.tsx'))
  mkdirSync(dependencyLink)
  for (const entry of readdirSync(upstreamNodeModules)) {
    symlinkSync(join(upstreamNodeModules, entry), join(dependencyLink, entry), 'junction')
  }
  symlinkSync(zodDirectory, join(dependencyLink, 'zod'), 'junction')
  const testPath = `${relative(resolve(source), tests).split(sep).join('/')}/shared-client.spec.tsx`
  const run = spawnSync(process.execPath, [
    join(source, 'node_modules', 'vitest', 'vitest.mjs'), 'run', '--config', 'vitest.config.ts', testPath,
  ], { cwd: source, stdio: 'inherit', env: process.env, timeout: 180_000 })
  if (run.error) throw run.error
  if (run.status !== 0) process.exitCode = run.status ?? 1
} finally {
  rmSync(temporary, { recursive: true, force: true })
}
