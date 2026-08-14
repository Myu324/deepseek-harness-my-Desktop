/**
 * The plugin marketplace: a curated feed of installable profile plugins over
 * the existing `dsh plugin --profile web` pnpm forwarder. Each feed entry
 * states its npm spec, source repository, official/community trust, and the
 * engine semver range it was built against; the market merges that with the
 * live profile manifest and offers install / uninstall / update, plus a
 * manifest-snapshot rollback for a broken install. This module is plain Node
 * and Electron-free; the shell injects the command runner and feed fetcher.
 * @module @deepseek-ai/dsh-desktop/plugin-market
 */

import { existsSync } from 'node:fs'
import { mkdir, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import semver from 'semver'
import { readProfileManifest, type ProfileManifest } from '@deepseek-ai/dsh-app-boot'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'

/** One curated feed entry. */
interface MarketPluginEntry {
  /** The npm spec to install (bare name or name@version). */
  readonly package: string
  /** Display title. */
  readonly title: string
  /** Display description. */
  readonly description: string
  /** The source repository URL (https). */
  readonly source: string
  /** Whether the entry ships in the official feed (false = community-maintained). */
  readonly official: boolean
  /** Whether this entry aggregates a whole plugin family (one-click family install). */
  readonly bundles: boolean
  /** The engine semver range the plugin was built against. */
  readonly compatibility: string
}

/** The feed document the marketplace fetches. */
export interface MarketFeed {
  /** The feed format version; only 1 exists. */
  readonly version: 1
  /** The curated entries. */
  readonly plugins: MarketPluginEntry[]
}

/** One feed entry merged with the live profile state; also the list wire payload element. */
export interface PluginState extends MarketPluginEntry {
  /** Whether the plugin is installed in the profile. */
  readonly installed: boolean
  /** Whether the engine version satisfies the entry's compatibility range. */
  readonly compatible: boolean
  /** Whether a rollback snapshot exists for the profile. */
  readonly rollbackAvailable: boolean
}

/** The snapshot a mutating operation records before it runs. */
interface ProfileSnapshot {
  /** ISO timestamp of the snapshot. */
  readonly savedAt: string
  /** The raw manifest content, or null when no manifest existed yet. */
  readonly packageJson: string | null
}

/** The profile facts the market reads. */
export interface ProfileState {
  /** Whether a manifest exists. */
  readonly exists: boolean
  /** The parsed manifest (empty when absent). */
  readonly manifest: ProfileManifest
  /** The registered bundle layers. */
  readonly bundles: string[]
  /** The installed dependency names. */
  readonly dependencies: string[]
}

/** The snapshot file name inside the profile directory. */
const SNAPSHOT_FILENAME = '.dsh-desktop-snapshot.json'

/**
 * Extract the package list pnpm reports when it ignored build scripts; a
 * failed install then has {@link ensureProfileBuildPolicy} write the reviewed
 * policy and retries with the same arguments.
 * @param lines - the captured command output lines.
 * @returns the package names, empty when nothing was ignored.
 */
export function parseIgnoredBuilds(lines: readonly string[]): string[] {
  const line = lines.find(candidate => candidate.includes('Ignored build scripts:')) ?? ''
  const match = /Ignored build scripts:\s*([^\n]+)/.exec(line)
  if (match === null) return []
  const packages = match[1]
  if (packages === undefined) return []
  return packages.split(',').map(packageSpec => packageSpec.trim()).filter(packageSpec => packageSpec !== '')
}

/** The profile's pnpm settings file, written by the profile initializer. */
const PROFILE_WORKSPACE_FILE = 'pnpm-workspace.yaml'

/**
 * The reviewed build-script decisions the marketplace writes into the
 * profile workspace: cloudflared downloads a prebuilt binary the SSH tunnel
 * needs, while ssh2's optional native binding (and its cpu-features helper)
 * needs a C++ toolchain user machines lack — ssh2 falls back to pure
 * JavaScript crypto, so both are reviewed-and-denied and the install
 * succeeds.
 */
const REVIEWED_BUILDS: Readonly<Record<string, boolean>> = {
  cloudflared: true,
  ssh2: false,
  'cpu-features': false,
}

/** The fresh-policy text for a profile whose workspace declares no allowBuilds. */
const REVIEWED_BUILD_POLICY = `allowBuilds:
  # dsh-ssh needs the prebuilt cloudflared binary for its tunnel support.
  cloudflared: true
  # ssh2's optional native binding needs a C++ toolchain user machines lack;
  # ssh2 falls back to pure JavaScript crypto without it.
  ssh2: false
  cpu-features: false
`

/**
 * Ensure the profile's pnpm settings carry the reviewed build-script
 * decisions. pnpm appends `allowBuilds` entries with a `set this to true or
 * false` placeholder when it ignores build scripts; those placeholders are
 * resolved to the reviewed decisions, an absent allowBuilds section gets the
 * reviewed policy appended, and an already-resolved file is left untouched.
 * Packages outside the reviewed set stay blocked and fail loud.
 * @param profileDir - the profile directory.
 * @returns true when the policy file changed.
 */
export async function ensureProfileBuildPolicy(profileDir: string): Promise<boolean> {
  const path = join(profileDir, PROFILE_WORKSPACE_FILE)
  let content: string
  try {
    content = await readFile(path, 'utf8')
  } catch {
    content = ''
  }
  const lines = content.split('\n')
  let inAllowBuilds = false
  const resolved = lines.map((line) => {
    if (/^allowBuilds:$/.test(line)) {
      inAllowBuilds = true
      return line
    }
    if (inAllowBuilds && /^\S/.test(line)) inAllowBuilds = false
    if (inAllowBuilds) {
      const match = /^(\s*)([^\s:]+):\s*set this to true or false$/.exec(line)
      if (match !== null) {
        const name = match[2]
        if (name !== undefined) {
          const decision = REVIEWED_BUILDS[name]
          if (decision !== undefined) {
            return `${match[1]}${name}: ${decision ? 'true' : 'false'}`
          }
        }
      }
    }
    return line
  })
  const changed = resolved.some((line, index) => line !== lines[index])
  if (changed) {
    await writeFileAtomic(path, resolved.join('\n'), { mode: 0o600, dirMode: 0o700 })
    return true
  }
  if (!content.includes('allowBuilds:')) {
    const separator = content === '' || content.endsWith('\n') ? '' : '\n'
    await writeFileAtomic(path, `${content}${separator}${REVIEWED_BUILD_POLICY}`, { mode: 0o600, dirMode: 0o700 })
    return true
  }
  return false
}

/** Strip a version suffix from an npm spec, keeping the scoped name. */
function packageName(spec: string): string {
  const trimmed = spec.trim()
  if (trimmed.startsWith('@')) {
    const secondAt = trimmed.indexOf('@', 1)
    return secondAt < 0 ? trimmed : trimmed.slice(0, secondAt)
  }
  const at = trimmed.indexOf('@')
  return at < 0 ? trimmed : trimmed.slice(0, at)
}

/** Whether a value is an https URL. */
function isHttpsUrl(value: unknown): value is string {
  return typeof value === 'string' && value.startsWith('https://')
}

/** Whether a value is a non-empty string. */
function isText(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== ''
}

/**
 * Parse and validate a feed document at the wire boundary. Unknown fields
 * are ignored; a malformed entry or an unsupported feed version fails loud.
 * @param value - the fetched JSON value.
 * @returns the validated feed.
 */
export function parseMarketFeed(value: unknown): MarketFeed {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('plugin feed must be a JSON object')
  }
  const record = value as Record<string, unknown>
  if (record.version !== 1) {
    throw new Error(`plugin feed version must be 1, got ${JSON.stringify(record.version)}`)
  }
  if (!Array.isArray(record.plugins)) throw new Error('plugin feed must carry a plugins array')
  const plugins = record.plugins.map((entry, index): MarketPluginEntry => {
    const where = `plugin feed entry ${index}`
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error(`${where} must be an object`)
    }
    const plugin = entry as Record<string, unknown>
    if (!isText(plugin.package)) throw new Error(`${where} must declare a package spec`)
    if (!isText(plugin.title)) throw new Error(`${where} must declare a title`)
    if (!isText(plugin.description)) throw new Error(`${where} must declare a description`)
    if (!isHttpsUrl(plugin.source)) throw new Error(`${where} must declare an https source URL`)
    if (typeof plugin.official !== 'boolean') throw new Error(`${where} must declare an official flag`)
    if (typeof plugin.bundles !== 'boolean') throw new Error(`${where} must declare a bundles flag`)
    if (!isText(plugin.compatibility) || semver.validRange(plugin.compatibility) === null) {
      throw new Error(`${where} must declare a valid compatibility range`)
    }
    return {
      package: plugin.package,
      title: plugin.title,
      description: plugin.description,
      source: plugin.source,
      official: plugin.official,
      bundles: plugin.bundles,
      compatibility: plugin.compatibility,
    }
  })
  return { version: 1, plugins }
}

/**
 * Fetch and parse the feed at one URL.
 * @param url - the feed URL.
 * @param fetchFn - fetcher override (tests).
 * @returns the validated feed.
 */
export async function fetchMarketFeed(url: string, fetchFn?: (target: string) => Promise<unknown>): Promise<MarketFeed> {
  const fetchImpl = fetchFn ?? (async (target: string): Promise<unknown> => {
    const response = await fetch(target)
    if (!response.ok) throw new Error(`plugin feed fetch failed: HTTP ${response.status} from ${target}`)
    return await response.json()
  })
  return parseMarketFeed(await fetchImpl(url))
}

/**
 * Read the live profile state, tolerating an absent profile.
 * @param profileDir - the profile directory.
 * @returns the profile facts.
 */
export function readProfileState(profileDir: string): ProfileState {
  const manifestPath = join(profileDir, 'package.json')
  if (!existsSync(manifestPath)) {
    return { exists: false, manifest: {}, bundles: [], dependencies: [] }
  }
  const manifest = readProfileManifest('dsh', profileDir)
  const bundles = manifest.dsh?.profile?.bundles ?? []
  const dependencies = Object.keys(manifest.dependencies ?? {})
  return { exists: true, manifest, bundles, dependencies }
}

/** The snapshot file path inside the profile directory. */
function snapshotPath(profileDir: string): string {
  return join(profileDir, SNAPSHOT_FILENAME)
}

/**
 * Record the manifest as it is before a mutating operation.
 * @param profileDir - the profile directory.
 */
export async function snapshotProfile(profileDir: string): Promise<void> {
  const manifestPath = join(profileDir, 'package.json')
  const snapshot: ProfileSnapshot = {
    savedAt: new Date().toISOString(),
    packageJson: existsSync(manifestPath) ? await readFile(manifestPath, 'utf8') : null,
  }
  await writeFileAtomic(snapshotPath(profileDir), `${JSON.stringify(snapshot, null, 2)}\n`, { mode: 0o600, dirMode: 0o700 })
}

/** Whether a rollback snapshot exists. */
export function hasProfileSnapshot(profileDir: string): boolean {
  return existsSync(snapshotPath(profileDir))
}

/**
 * Restore the recorded manifest snapshot and reconcile the profile install,
 * then drop the snapshot.
 * @param profileDir - the profile directory.
 * @param runPlugin - the plugin command runner (for the reconcile install).
 */
export async function rollbackProfile(
  profileDir: string,
  runPlugin: (args: readonly string[]) => Promise<number>,
): Promise<void> {
  const path = snapshotPath(profileDir)
  let raw: string
  try {
    raw = await readFile(path, 'utf8')
  } catch {
    throw new Error('no plugin snapshot to roll back to')
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error('plugin snapshot is not valid JSON; refusing to roll back')
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('plugin snapshot is not a JSON object; refusing to roll back')
  }
  const snapshot = parsed as { readonly savedAt?: unknown; readonly packageJson?: unknown }
  if (typeof snapshot.packageJson !== 'string' && snapshot.packageJson !== null) {
    throw new Error('plugin snapshot is malformed; refusing to roll back')
  }
  if (snapshot.packageJson === null) {
    await rm(join(profileDir, 'package.json'), { force: true })
  } else {
    await mkdir(profileDir, { recursive: true })
    await writeFileAtomic(join(profileDir, 'package.json'), snapshot.packageJson, { mode: 0o600, dirMode: 0o700 })
  }
  const code = await runPlugin(['install'])
  if (code !== 0) throw new Error(`plugin rollback reconcile failed with exit code ${code}`)
  await rm(path, { force: true })
}

/** The marketplace's read and mutating operations. */
export interface MarketOperations {
  /** The feed merged with the live profile and engine facts. */
  list(): Promise<{ readonly engineVersion: string | undefined; readonly plugins: PluginState[] }>
  /** Install one feed entry's spec (records a rollback snapshot first). */
  install(spec: string): Promise<void>
  /** Uninstall one installed plugin by name. */
  uninstall(name: string): Promise<void>
  /** Update one installed plugin by name. */
  update(name: string): Promise<void>
  /** Restore the profile to its pre-operation snapshot. */
  rollback(): Promise<void>
}

/** The market's injected world: profile, engine version, feed, command runner. */
export interface MarketContext {
  /** The profile directory the plugin forwarder manages. */
  readonly profileDir: string
  /** The running engine version, or undefined when unknown (compatibility unknown). */
  readonly engineVersion: string | undefined
  /** The feed URL. */
  readonly feedUrl: string
  /** Feed fetcher override (tests). */
  readonly fetchFeed?: (url: string) => Promise<unknown>
  /** The `dsh plugin` command runner; returns the exit code (injected by the shell). */
  readonly runPlugin: (args: readonly string[]) => Promise<number>
}

/**
 * Build the marketplace operations over one profile.
 * @param context - the injected world.
 * @returns the operations.
 */
export function createMarket(context: MarketContext): MarketOperations {
  const fetchFeedImpl = context.fetchFeed ?? undefined
  const runChecked = async (args: readonly string[], purpose: string): Promise<void> => {
    const code = await context.runPlugin(args)
    if (code !== 0) throw new Error(`plugin ${purpose} failed with exit code ${code}`)
  }
  return {
    async list() {
      const feed = await fetchMarketFeed(context.feedUrl, fetchFeedImpl)
      const profile = readProfileState(context.profileDir)
      const plugins = feed.plugins.map((entry): PluginState => {
        const name = packageName(entry.package)
        return {
          ...entry,
          installed: profile.bundles.includes(name) || profile.dependencies.includes(name),
          compatible: context.engineVersion === undefined
            ? true
            : semver.satisfies(context.engineVersion, entry.compatibility, { includePrerelease: true }),
          rollbackAvailable: hasProfileSnapshot(context.profileDir),
        }
      })
      return { engineVersion: context.engineVersion, plugins }
    },
    async install(spec) {
      await snapshotProfile(context.profileDir)
      await runChecked(['add', spec], 'install')
    },
    async uninstall(name) {
      await snapshotProfile(context.profileDir)
      await runChecked(['remove', name], 'uninstall')
    },
    async update(name) {
      await snapshotProfile(context.profileDir)
      await runChecked(['update', name], 'update')
    },
    async rollback() {
      await rollbackProfile(context.profileDir, async args => await context.runPlugin(args))
    },
  }
}
