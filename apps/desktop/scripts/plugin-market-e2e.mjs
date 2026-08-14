// Real-world M4 verification: build the engine store, provision pnpm, install
// the web-ui family bundle through the real `dsh plugin` forwarder into an
// isolated profile home, boot the engine with that home, and confirm the
// client plugin graph carries the family — then uninstall. Run:
// node --import tsx/esm apps/desktop/scripts/plugin-market-e2e.mjs [storeRoot]
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { delimiter } from 'node:path'
import { resolveProfileDir, readProfileManifest } from '@deepseek-ai/dsh-app-boot'
import {
  engineStorePaths,
  ensurePnpmSidecar,
  readPointer,
  runStoreCommand,
  updateEngine,
  versionEngineLocation,
} from '../src/engine-store.ts'
import { startEngine } from '../src/engine-process.ts'
import { ensureProfileBuildPolicy, parseIgnoredBuilds } from '../src/plugin-market.ts'

const FAMILY = '@linxin666/dsh-web-ui-all'
const root = process.argv[2] !== undefined ? resolve(process.argv[2]) : join(tmpdir(), 'dsh-m4-e2e')
const home = join(root, 'home')
process.env.DSH_HOME = home
const paths = engineStorePaths(root)
console.log(`store root: ${root}`)
console.log(`profile home: ${home}`)

const result = await updateEngine(paths, {
  channel: 'stable',
  registry: 'https://registry.npmjs.org',
  nodeMirror: 'https://npmmirror.com/mirrors/node',
  onLine: line => console.log(`[store] ${line}`),
})
console.log(`engine update result: ${result.outcome}`)

const pnpmBinDir = await ensurePnpmSidecar(paths, 'https://registry.npmjs.org', {
  onLine: line => console.log(`[pnpm] ${line}`),
})
const pointer = await readPointer(paths.currentPointer)
if (pointer === undefined) throw new Error('store has no current engine version')
const versionDir = join(paths.versionsDir, pointer)
const engineBin = join(versionDir, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
const env = {
  ...process.env,
  PATH: `${pnpmBinDir}${delimiter}${paths.nodeDir}${delimiter}${process.env.PATH ?? ''}`,
}

async function plugin(args) {
  console.log(`[plugin] dsh plugin --profile web ${args.join(' ')}`)
  const lines = []
  const run = runArgs => runStoreCommand(paths.nodeExe, [engineBin, 'plugin', '--profile', 'web', ...runArgs], {
    env,
    cwd: versionDir,
    onLine: line => {
      lines.push(line)
      console.log(`[plugin] ${line}`)
    },
  })
  let code = await run(args)
  const blocked = parseIgnoredBuilds(lines)
  if (code !== 0 && blocked.length > 0) {
    if (await ensureProfileBuildPolicy(profileDir)) {
      console.log('[plugin] wrote the reviewed build-script policy into the profile workspace')
    }
    console.log(`[plugin] retrying with the reviewed build policy (pnpm blocked: ${blocked.join(', ')})`)
    code = await run(args)
  }
  if (code !== 0) throw new Error(`dsh plugin ${args.join(' ')} failed with exit code ${code}`)
}

const profileDir = resolveProfileDir('web', home)
console.log(`[plugin] installing ${FAMILY}…`)
await plugin(['add', FAMILY])
const afterInstall = readProfileManifest('dsh', profileDir)
console.log(`[plugin] bundles after install: ${JSON.stringify(afterInstall.dsh?.profile?.bundles ?? [])}`)
if (!(afterInstall.dsh?.profile?.bundles ?? []).includes(FAMILY)) {
  throw new Error(`${FAMILY} did not join dsh.profile.bundles`)
}

console.log('[engine] booting the store engine with the plugin profile…')
const engine = await startEngine({
  location: versionEngineLocation(paths, versionDir, env),
  env,
  timeoutMs: 120_000,
  onLine: line => console.log(`[engine] ${line}`),
})
const page = await (await fetch(engine.url)).text()
const carriesFamily = page.includes('linxin666')
console.log(`[engine] client plugin graph carries the family: ${String(carriesFamily)} (${engine.url})`)
engine.stop()
await engine.exited
if (!carriesFamily) throw new Error('the served client plugin graph does not carry the family')

console.log(`[plugin] uninstalling ${FAMILY}…`)
await plugin(['remove', FAMILY])
const afterRemove = readProfileManifest('dsh', profileDir)
console.log(`[plugin] bundles after remove: ${JSON.stringify(afterRemove.dsh?.profile?.bundles ?? [])}`)
if ((afterRemove.dsh?.profile?.bundles ?? []).includes(FAMILY)) {
  throw new Error(`${FAMILY} survived uninstall in dsh.profile.bundles`)
}
console.log(`node sidecar present: ${String(existsSync(paths.nodeExe))}`)
console.log('M4 e2e: PASS')
