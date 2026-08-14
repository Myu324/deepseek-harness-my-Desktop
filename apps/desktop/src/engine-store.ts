/**
 * The managed engine version store. The shell installs `@deepseek-ai/dsh`
 * engine versions side-by-side under `<root>/versions/<version>/`, provisions
 * one portable node runtime under `<root>/runtime/node/` (the engine requires
 * Node `^22.19 || >=24`, which Electron's bundled node does not satisfy), and
 * switches the running engine by rewriting two pointer files: `current` (what
 * the next engine start uses) and `last-good` (the newest version that passed
 * a health check). Activation health-checks the candidate by really booting
 * it through {@link startEngine} — against an isolated Harness home, never
 * the user's profile — before the pointers move, and a failed boot falls back
 * to `last-good`. Everything is plain Node so the store logic is unit-testable
 * with injected downloaders and installers.
 * @module @deepseek-ai/dsh-desktop/engine-store
 */

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { Readable } from 'node:stream'
import { unzipSync, type UnzipFileFilter } from 'fflate'
import { x as tarX } from 'tar'
import semver from 'semver'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { resolveExecutable, startEngine, type EngineLocation } from './engine-process.ts'

/** The portable node version the store provisions for the engine sidecar. */
const NODE_SIDECAR_VERSION = 'v24.16.0'

/** The engine package the store installs, as an npm spec base. */
const ENGINE_PACKAGE_NAME = '@deepseek-ai/dsh'

/** Release channels the store maps to npm dist-tags. */
export type EngineChannel = 'stable' | 'beta'

/** The dist-tag each channel reads. */
const CHANNEL_TAG: Readonly<Record<EngineChannel, string>> = {
  stable: 'latest',
  beta: 'next',
}

/** Engine store paths inside one store root. */
export interface EngineStorePaths {
  /** The store root. */
  readonly root: string
  /** The side-by-side version installs directory. */
  readonly versionsDir: string
  /** The portable node runtime directory. */
  readonly nodeDir: string
  /** The portable node executable. */
  readonly nodeExe: string
  /** The pointer file naming the version the next engine start uses. */
  readonly currentPointer: string
  /** The pointer file naming the newest version that passed a health check. */
  readonly lastGoodPointer: string
}

/**
 * Resolve the engine store paths.
 * @param root - the store root directory.
 * @param platform - the platform whose node layout applies.
 * @returns the resolved paths.
 */
export function engineStorePaths(root: string, platform: NodeJS.Platform = process.platform): EngineStorePaths {
  const nodeDir = join(root, 'runtime', 'node')
  return {
    root,
    versionsDir: join(root, 'versions'),
    nodeDir,
    nodeExe: platform === 'win32' ? join(nodeDir, 'node.exe') : join(nodeDir, 'bin', 'node'),
    currentPointer: join(root, 'current'),
    lastGoodPointer: join(root, 'last-good'),
  }
}

/**
 * The default engine store root: `%LOCALAPPDATA%\DeepSeekHarness\engine` on
 * Windows, `~/.dsh/engine` elsewhere.
 * @param env - environment carrying the base directory variables.
 * @param platform - the platform whose layout applies.
 * @returns the store root, or undefined when its base is unavailable.
 */
export function defaultEngineStoreRoot(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  if (platform === 'win32') {
    const local = env.LOCALAPPDATA
    const base = local !== undefined && local !== ''
      ? local
      : env.USERPROFILE !== undefined && env.USERPROFILE !== ''
        ? join(env.USERPROFILE, 'AppData', 'Local')
        : undefined
    return base === undefined ? undefined : join(base, 'DeepSeekHarness', 'engine')
  }
  const home = env.HOME
  return home === undefined || home === '' ? undefined : join(home, '.dsh', 'engine')
}

/**
 * Read one pointer file.
 * @param pointerPath - the pointer file path.
 * @returns the recorded version, or undefined when the pointer is absent or malformed.
 */
export async function readPointer(pointerPath: string): Promise<string | undefined> {
  let content: string
  try {
    content = await readFile(pointerPath, 'utf8')
  } catch {
    return undefined // no pointer yet — the store is fresh
  }
  const version = content.trim()
  return semver.valid(version) === null ? undefined : version
}

/**
 * Write one pointer file atomically.
 * @param pointerPath - the pointer file path.
 * @param version - the version to record.
 */
export async function writePointer(pointerPath: string, version: string): Promise<void> {
  await writeFileAtomic(pointerPath, `${version}\n`, { mode: 0o600, dirMode: 0o700 })
}

/** One installed engine version's directory and location facts. */
export interface InstalledEngine {
  /** The version string (the directory name). */
  readonly version: string
  /** The version directory. */
  readonly dir: string
  /** Whether the engine bin exists inside the directory. */
  readonly complete: boolean
}

/**
 * List the installed engine versions, newest first by semver.
 * @param paths - the store paths.
 * @returns the installed versions.
 */
export async function installedEngines(paths: EngineStorePaths): Promise<InstalledEngine[]> {
  let entries: string[]
  try {
    entries = await readdir(paths.versionsDir)
  } catch {
    return [] // no versions directory yet
  }
  const engines = entries
    .map((name): InstalledEngine => {
      const dir = join(paths.versionsDir, name)
      return {
        version: name,
        dir,
        complete: existsSync(join(dir, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')),
      }
    })
    .filter(engine => semver.valid(engine.version) !== null)
  return engines.sort((left, right) => semver.rcompare(left.version, right.version))
}

/**
 * The engine location one installed version directory provides. The portable
 * node sidecar wins over an explicit `DSH_ENGINE_NODE` and PATH.
 * @param paths - the store paths.
 * @param versionDir - the installed version directory.
 * @param env - environment for the node override and PATH.
 * @param platform - the platform whose layout applies.
 * @returns the resolved engine location.
 */
export function versionEngineLocation(
  paths: EngineStorePaths,
  versionDir: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): EngineLocation {
  return {
    node: existsSync(paths.nodeExe) ? paths.nodeExe : resolveExecutable('node', env, platform),
    nodeArgs: [],
    script: join(versionDir, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'),
    cwd: versionDir,
    kind: 'managed-dir',
  }
}

/** A downloader: URL in, bytes out. Injectable for tests. */
export type Downloader = (url: string) => Promise<Buffer>

/**
 * The portable node download URL for one mirror, version, platform, and
 * architecture. Windows ships a zip; macOS ships a per-architecture tar.gz.
 * Other platforms are unsupported.
 * @param mirror - the mirror base, without trailing slash.
 * @param version - the node version tag.
 * @param platform - the platform whose archive layout applies.
 * @param arch - the CPU architecture for macOS archives.
 * @returns the archive URL, or undefined for unsupported platforms.
 */
export function nodeArchiveUrl(
  mirror: string,
  version: string,
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): string | undefined {
  const base = mirror.replace(/\/+$/, '')
  if (platform === 'win32') return `${base}/${version}/node-${version}-win-x64.zip`
  if (platform === 'darwin') {
    const archName = arch === 'arm64' ? 'arm64' : 'x64'
    return `${base}/${version}/node-${version}-darwin-${archName}.tar.gz`
  }
  return undefined
}

/** Which zip members enter the store's node directory (Windows dist). */
const NODE_ARCHIVE_FILTER: UnzipFileFilter = file =>
  !file.name.endsWith('/')
  && (file.name.endsWith('/node.exe') || file.name.includes('/node_modules/npm/'))

/** Which tar members enter the store's node directory (macOS dist). */
function nodeTarFilter(path: string): boolean {
  return path.endsWith('/bin/node') || path.includes('/lib/node_modules/npm/')
}

/**
 * Extract a macOS node tar.gz into the store's node directory, creating it.
 * @param paths - the store paths.
 * @param archive - the downloaded archive bytes.
 */
async function extractTarGzNodeArchive(paths: EngineStorePaths, archive: Buffer): Promise<void> {
  await mkdir(paths.nodeDir, { recursive: true })
  const unpack = tarX({
    cwd: paths.nodeDir,
    strip: 1,
    filter: path => nodeTarFilter(path),
  })
  await new Promise<void>((resolveUnpack, rejectUnpack) => {
    unpack.once('end', () => { resolveUnpack() })
    unpack.once('error', (error: Error) => { rejectUnpack(error) })
    Readable.from([archive]).pipe(unpack)
  })
}

/**
 * Extract a node archive into the store's node directory, creating it: a
 * Windows zip or a macOS tar.gz, by platform.
 * @param paths - the store paths.
 * @param archive - the downloaded archive bytes.
 * @param platform - the platform whose archive layout applies.
 */
export async function extractNodeArchive(
  paths: EngineStorePaths,
  archive: Buffer,
  platform: NodeJS.Platform = process.platform,
): Promise<void> {
  if (platform === 'darwin') {
    await extractTarGzNodeArchive(paths, archive)
    return
  }
  const entries = Object.entries(unzipSync(new Uint8Array(archive), { filter: NODE_ARCHIVE_FILTER }))
  const first = entries[0]
  if (first === undefined) throw new Error('node sidecar archive is empty')
  const prefixLength = first[0].indexOf('/')
  if (prefixLength < 0) throw new Error(`node sidecar archive member has no directory prefix: ${first[0]}`)
  const prefix = first[0].slice(0, prefixLength + 1)
  for (const [name, data] of entries) {
    const relative = name.startsWith(prefix) ? name.slice(prefix.length) : name
    const target = join(paths.nodeDir, ...relative.split('/'))
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, data)
  }
}

/**
 * Provision the portable node sidecar into the store: download and extract
 * the pinned node version unless a complete sidecar already exists.
 * @param paths - the store paths.
 * @param mirror - the node mirror base URL.
 * @param options - downloader, platform, and line-sink overrides.
 * @returns the sidecar node executable path.
 */
export async function ensureNodeSidecar(
  paths: EngineStorePaths,
  mirror: string,
  options: {
    readonly download?: Downloader
    readonly platform?: NodeJS.Platform
    readonly arch?: string
    readonly onLine?: (line: string) => void
  } = {},
): Promise<string> {
  const platform = options.platform ?? process.platform
  const arch = options.arch ?? process.arch
  const onLine = options.onLine ?? (() => {})
  if (existsSync(paths.nodeExe)) {
    onLine(`node sidecar present at ${paths.nodeExe}`)
    return paths.nodeExe
  }
  const url = nodeArchiveUrl(mirror, NODE_SIDECAR_VERSION, platform, arch)
  if (url === undefined) {
    throw new Error(`portable node sidecar provisioning supports Windows and macOS, not ${platform}`)
  }
  onLine(`downloading node sidecar ${url}`)
  const download = options.download ?? (async (target: string): Promise<Buffer> => {
    const response = await fetch(target)
    if (!response.ok) throw new Error(`node sidecar download failed: HTTP ${response.status} from ${target}`)
    return Buffer.from(await response.arrayBuffer())
  })
  const archive = await download(url)
  await extractNodeArchive(paths, archive, platform)
  if (!existsSync(paths.nodeExe)) throw new Error(`node sidecar archive did not contain ${paths.nodeExe}`)
  onLine(`node sidecar ready at ${paths.nodeExe}`)
  return paths.nodeExe
}

/** An engine installer: materializes one version directory. Injectable for tests. */
export type EngineInstaller = (
  versionDir: string,
  version: string,
  options: { readonly registry: string; readonly onLine: (line: string) => void },
) => Promise<void>

/** The npm CLI path inside the portable node dist, per platform. */
function npmCliPath(platform: NodeJS.Platform): string {
  return platform === 'win32'
    ? join('node_modules', 'npm', 'bin', 'npm-cli.js')
    : join('lib', 'node_modules', 'npm', 'bin', 'npm-cli.js')
}

/** Default installer: run the portable node's bundled npm against the registry. */
async function npmInstallEngine(
  versionDir: string,
  version: string,
  options: { readonly registry: string; readonly onLine: (line: string) => void },
  paths: EngineStorePaths,
  platform: NodeJS.Platform,
): Promise<void> {
  const manifest = {
    name: `dsh-engine-${version.replaceAll('.', '-')}`,
    private: true,
    dependencies: { [ENGINE_PACKAGE_NAME]: version },
  }
  await mkdir(versionDir, { recursive: true })
  await writeFileAtomic(join(versionDir, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 })
  const code = await runStoreCommand(paths.nodeExe, [
    join(paths.nodeDir, npmCliPath(platform)), 'install',
    '--prefix', versionDir,
    '--registry', options.registry,
    '--no-audit', '--no-fund', '--ignore-scripts', '--omit=dev',
    '--loglevel', 'warn',
  ], { onLine: options.onLine, cwd: versionDir })
  if (code !== 0) throw new Error(`engine install failed with exit code ${code}`)
}

/**
 * Provision the pnpm launcher into the store's runtime directory by
 * installing the `pnpm` package through the bundled npm (idempotent). The
 * profile plugin forwarder (`dsh plugin`) spawns `pnpm` from PATH, so the
 * returned `.bin` directory is prepended to the plugin command's PATH.
 * @param paths - the store paths.
 * @param registry - the registry to install pnpm from.
 * @param options - platform and line-sink overrides.
 * @returns the directory holding the pnpm launcher shims.
 */
export async function ensurePnpmSidecar(
  paths: EngineStorePaths,
  registry: string,
  options: { readonly platform?: NodeJS.Platform; readonly onLine?: (line: string) => void } = {},
): Promise<string> {
  const platform = options.platform ?? process.platform
  const onLine = options.onLine ?? (() => {})
  const pnpmDir = join(paths.root, 'runtime', 'pnpm')
  const binDir = join(pnpmDir, 'node_modules', '.bin')
  const launcher = platform === 'win32'
    ? join(binDir, 'pnpm.cmd')
    : join(binDir, 'pnpm')
  if (existsSync(launcher)) {
    onLine(`pnpm sidecar present at ${binDir}`)
    return binDir
  }
  onLine(`installing pnpm sidecar into ${pnpmDir}`)
  await mkdir(pnpmDir, { recursive: true })
  const code = await runStoreCommand(paths.nodeExe, [
    join(paths.nodeDir, npmCliPath(platform)), 'install',
    '--prefix', pnpmDir,
    '--registry', registry,
    '--no-audit', '--no-fund', '--ignore-scripts', '--omit=dev',
    '--loglevel', 'warn',
    'pnpm',
  ], { onLine, cwd: pnpmDir })
  if (code !== 0) throw new Error(`pnpm sidecar install failed with exit code ${code}`)
  if (!existsSync(launcher)) throw new Error(`pnpm sidecar install produced no launcher at ${launcher}`)
  onLine(`pnpm sidecar ready at ${binDir}`)
  return binDir
}

/**
 * Run one command to completion, feeding its output lines to the sink.
 * @param bin - the executable.
 * @param args - the arguments.
 * @param options - working directory, environment, and line sink.
 * @returns the exit code.
 */
export async function runStoreCommand(
  bin: string,
  args: readonly string[],
  options: { readonly cwd: string; readonly env?: NodeJS.ProcessEnv; readonly onLine: (line: string) => void },
): Promise<number> {
  return await new Promise<number>((resolveExit, rejectSpawn) => {
    const child = spawn(bin, [...args], {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    const feed = (chunk: Buffer): void => {
      for (const line of chunk.toString('utf8').split('\n')) {
        const trimmed = line.replace(/\r$/, '')
        if (trimmed !== '') options.onLine(trimmed)
      }
    }
    child.stdout.on('data', (chunk: Buffer) => { feed(chunk) })
    child.stderr.on('data', (chunk: Buffer) => { feed(chunk) })
    child.once('error', (error) => { rejectSpawn(error) })
    child.once('exit', (code) => { resolveExit(code ?? 1) })
  })
}

/**
 * Install one engine version into the store (idempotent: an already-complete
 * version directory is reused).
 * @param paths - the store paths.
 * @param version - the exact version to install.
 * @param options - registry, installer, platform, and line-sink overrides.
 * @returns the version directory.
 */
export async function installEngine(
  paths: EngineStorePaths,
  version: string,
  options: {
    readonly registry: string
    readonly install?: EngineInstaller
    readonly platform?: NodeJS.Platform
    readonly onLine?: (line: string) => void
  },
): Promise<string> {
  const onLine = options.onLine ?? (() => {})
  const platform = options.platform ?? process.platform
  const versionDir = join(paths.versionsDir, version)
  if (existsSync(join(versionDir, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'))) {
    onLine(`engine ${version} already installed`)
    return versionDir
  }
  onLine(`installing engine ${version} from ${options.registry}`)
  const install = options.install
    ?? ((dir, target, installOptions) => npmInstallEngine(dir, target, installOptions, paths, platform))
  await install(versionDir, version, { registry: options.registry, onLine })
  if (!existsSync(join(versionDir, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'))) {
    throw new Error(`engine ${version} installed without its bin at ${versionDir}`)
  }
  return versionDir
}

/**
 * Health-check one installed version by really booting it through the
 * readiness handshake against an isolated Harness home, then stopping it.
 * The candidate never touches the user's profile or a running engine's data.
 * @param location - the candidate engine location.
 * @param options - readiness budget and line sink.
 * @returns true when the engine became ready.
 */
export async function healthCheckEngine(
  location: EngineLocation,
  options: { readonly timeoutMs?: number; readonly onLine?: (line: string) => void } = {},
): Promise<boolean> {
  const onLine = options.onLine ?? (() => {})
  const isolatedHome = await mkdtemp(join(tmpdir(), 'dsh-engine-health-'))
  try {
    const engine = await startEngine({
      location,
      ...options.timeoutMs !== undefined && { timeoutMs: options.timeoutMs },
      onLine,
      env: { ...process.env, DSH_HOME: isolatedHome },
    })
    engine.stop()
    await engine.exited
    return true
  } catch (error) {
    onLine(`health check failed: ${error instanceof Error ? error.message : String(error)}`)
    return false
  } finally {
    await rm(isolatedHome, { recursive: true, force: true })
  }
}

/**
 * The fallback version when the current pointer's engine fails: the
 * last-good version, when it differs from current and is installed.
 * @param paths - the store paths.
 * @param current - the current pointer's version.
 * @returns the fallback version, or undefined.
 */
export async function fallbackVersion(paths: EngineStorePaths, current: string | undefined): Promise<string | undefined> {
  const lastGood = await readPointer(paths.lastGoodPointer)
  if (lastGood === undefined || lastGood === current) return undefined
  const installed = await installedEngines(paths)
  return installed.some(engine => engine.version === lastGood && engine.complete) ? lastGood : undefined
}

/** The result of one update flow. */
export type EngineUpdateResult =
  | { readonly outcome: 'already-current'; readonly version: string }
  | { readonly outcome: 'updated'; readonly from: string | undefined; readonly to: string }
  | { readonly outcome: 'unhealthy'; readonly version: string; readonly reason: string }

/**
 * Update the store to the newest engine version on a channel: query the
 * registry dist-tag, install, health-check, then move the pointers. A
 * candidate that fails its health check is left installed but never
 * activated.
 * @param paths - the store paths.
 * @param options - channel, registry, node mirror, and injection overrides.
 * @returns the update result.
 */
export async function updateEngine(
  paths: EngineStorePaths,
  options: {
    readonly channel: EngineChannel
    readonly registry: string
    readonly nodeMirror: string
    readonly fetchPackument?: (url: string) => Promise<unknown>
    readonly install?: EngineInstaller
    readonly download?: Downloader
    readonly healthCheck?: (location: EngineLocation) => Promise<boolean>
    readonly onLine?: (line: string) => void
    readonly timeoutMs?: number
  },
): Promise<EngineUpdateResult> {
  const onLine = options.onLine ?? (() => {})
  const latest = await queryLatestVersion(options.registry, options.channel, options.fetchPackument, onLine)
  const current = await readPointer(paths.currentPointer)
  if (latest === current) {
    const installed = await installedEngines(paths)
    if (installed.some(engine => engine.version === current && engine.complete)) {
      onLine(`engine ${latest} is already current`)
      return { outcome: 'already-current', version: latest }
    }
  }
  await ensureNodeSidecar(paths, options.nodeMirror, {
    ...options.download !== undefined && { download: options.download },
    onLine,
  })
  await installEngine(paths, latest, {
    registry: options.registry,
    ...options.install !== undefined && { install: options.install },
    onLine,
  })
  const versionDir = join(paths.versionsDir, latest)
  const candidate = versionEngineLocation(paths, versionDir)
  const healthy = options.healthCheck !== undefined
    ? await options.healthCheck(candidate)
    : await healthCheckEngine(candidate, {
      ...options.timeoutMs !== undefined && { timeoutMs: options.timeoutMs },
      onLine,
    })
  if (!healthy) {
    return { outcome: 'unhealthy', version: latest, reason: `engine ${latest} failed its health check; it stays installed but not activated` }
  }
  await writePointer(paths.currentPointer, latest)
  await writePointer(paths.lastGoodPointer, latest)
  await pruneEngines(paths, latest, current, onLine)
  return { outcome: 'updated', from: current, to: latest }
}

/**
 * Remove installed versions the pointers no longer reference, keeping at
 * most two extra complete versions.
 * @param paths - the store paths.
 * @param current - the now-current version.
 * @param previous - the previously current version.
 * @param onLine - line sink.
 */
async function pruneEngines(
  paths: EngineStorePaths,
  current: string,
  previous: string | undefined,
  onLine: (line: string) => void,
): Promise<void> {
  const lastGood = await readPointer(paths.lastGoodPointer)
  const keep = new Set([current, previous, lastGood].filter((value): value is string => value !== undefined))
  const engines = await installedEngines(paths)
  let kept = 0
  for (const engine of engines) {
    if (keep.has(engine.version)) continue
    if (kept < 2) {
      kept += 1
      continue
    }
    onLine(`removing old engine version ${engine.version}`)
    await rm(engine.dir, { recursive: true, force: true })
  }
}

/**
 * Query the newest engine version on a channel from the registry packument.
 * @param registry - the registry base URL.
 * @param channel - the release channel.
 * @param fetchPackument - packument fetcher override (tests).
 * @param onLine - line sink.
 * @returns the version the channel's dist-tag names.
 */
async function queryLatestVersion(
  registry: string,
  channel: EngineChannel,
  fetchPackument: ((url: string) => Promise<unknown>) | undefined,
  onLine: (line: string) => void,
): Promise<string> {
  const tag = CHANNEL_TAG[channel]
  const url = `${registry.replace(/\/+$/, '')}/${ENGINE_PACKAGE_NAME.replace('/', '%2f')}`
  onLine(`querying engine channel ${tag} at ${url}`)
  const fetchFn = fetchPackument ?? (async (target: string): Promise<unknown> => {
    const response = await fetch(target)
    if (!response.ok) throw new Error(`engine registry query failed: HTTP ${response.status} from ${target}`)
    return await response.json()
  })
  const packument = await fetchFn(url)
  if (packument === null || typeof packument !== 'object' || Array.isArray(packument)) {
    throw new Error(`engine registry query returned a non-object packument from ${url}`)
  }
  const distTags = (packument as Record<string, unknown>)['dist-tags']
  if (distTags === null || typeof distTags !== 'object' || Array.isArray(distTags)) {
    throw new Error(`engine packument carries no dist-tags from ${url}`)
  }
  const version = (distTags as Record<string, unknown>)[tag]
  if (typeof version !== 'string' || semver.valid(version) === null) {
    throw new Error(`engine packument names no valid ${tag} version from ${url}`)
  }
  return version
}
