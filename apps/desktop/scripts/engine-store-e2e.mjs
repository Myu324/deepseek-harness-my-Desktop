// Real-world M3 verification: the complete engine-store update flow against
// the real npm registry, the real node mirror, a real npm install, and a real
// engine health check. Run: node --import tsx/esm apps/desktop/scripts/engine-store-e2e.mjs [storeRoot]
import { existsSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { engineStorePaths, installedEngines, readPointer, updateEngine } from '../src/engine-store.ts'

const root = process.argv[2] !== undefined ? resolve(process.argv[2]) : join(tmpdir(), 'dsh-m3-e2e')
const paths = engineStorePaths(root)
console.log(`store root: ${root}`)
if (process.env.DSH_M3_E2E_CLEAN === '1') {
  rmSync(root, { recursive: true, force: true })
  console.log('cleaned the store first (DSH_M3_E2E_CLEAN=1)')
}

const started = Date.now()
const result = await updateEngine(paths, {
  channel: 'stable',
  registry: 'https://registry.npmjs.org',
  nodeMirror: 'https://npmmirror.com/mirrors/node',
  onLine: line => console.log(`[store] ${line}`),
})
console.log(`result: ${JSON.stringify(result)}`)
console.log(`current pointer: ${await readPointer(paths.currentPointer)}`)
console.log(`last-good pointer: ${await readPointer(paths.lastGoodPointer)}`)
for (const engine of await installedEngines(paths)) {
  console.log(`installed: ${engine.version} (complete=${String(engine.complete)}) at ${engine.dir}`)
}
console.log(`elapsed: ${Math.round((Date.now() - started) / 1000)}s`)
if (result.outcome !== 'updated' && result.outcome !== 'already-current') {
  process.exitCode = 1
}
console.log(`node sidecar present: ${String(existsSync(paths.nodeExe))}`)
