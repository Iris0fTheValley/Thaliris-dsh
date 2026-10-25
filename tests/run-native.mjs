// Source-composition runner: dependencies belong to a compatible upstream clone.
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { resolve, join } from 'node:path'
import { existsSync, mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { assertDshSource } from '../dsh-compat.mjs'

const source = process.env.DSH_SOURCE
const python = process.env.THALIRIS_TEST_PYTHON
const corePath = process.env.THALIRIS_CORE_PATH
if (!source || !python || !corePath) throw new Error('Set DSH_SOURCE (compatible clone), THALIRIS_CORE_PATH (main Core source import root), and THALIRIS_TEST_PYTHON (Python >=3.11).')
if (!existsSync(corePath) || !existsSync(python)) throw new Error('THALIRIS_CORE_PATH and THALIRIS_TEST_PYTHON must name existing paths.')
const host = assertDshSource(source, 'native composition')
console.log(`DSH native footprint: ${host.version} (${host.revision}) inside ${host.range}`)
const requireSource = createRequire(resolve(source, 'package.json'))
const temp = mkdtempSync(join(tmpdir(), 'thaliris-dsh-runner-'))
const tsconfig = join(temp, 'tsconfig.json')
const requireDomain = createRequire(resolve(source, 'packages/storage/storage-domain/package.json'))
const typescript = requireSource('typescript')
const base = typescript.parseConfigFileTextToJson('tsconfig.base.json', readFileSync(resolve(source, 'tsconfig.base.json'), 'utf8')).config
const paths = Object.fromEntries(Object.entries(base.compilerOptions.paths).map(([key, values]) => [key, values.map(value => resolve(source, value))]))
writeFileSync(tsconfig, JSON.stringify({ extends: resolve(source, 'tsconfig.base.json'), compilerOptions: { paths: { ...paths, zod: [requireDomain.resolve('zod')] } } }))
try {
for (const test of (process.argv.length > 2 ? process.argv.slice(2) : ['composition-drift.mjs', 'native-loop.ts', 'product-runtime.ts'])) {
const script = fileURLToPath(new URL(test, import.meta.url))
const child = spawnSync(process.execPath, ['--import', pathToFileURL(requireSource.resolve('tsx/esm')).href, script], {
  cwd: source, stdio: 'inherit', timeout: 180000,
  env: { ...process.env, TSX_TSCONFIG_PATH: tsconfig },
})
if (child.error) throw child.error
if (child.status !== 0) { process.exitCode = child.status ?? 1; break }
}

} finally { rmSync(temp, { recursive: true, force: true }) }
