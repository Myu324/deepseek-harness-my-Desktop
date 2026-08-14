/**
 * The plugin marketplace: a locally shipped curated feed of installable
 * profile plugins over the existing `dsh plugin --profile web` pnpm
 * forwarder. The market window embeds the community page in a webview and
 * drives installs through a terminal-style command surface; this module owns
 * the feed parsing, the profile state merge, the command grammar, the
 * install / uninstall / update operations, the manifest-snapshot rollback,
 * and the reviewed build-script policy. Plain Node and Electron-free; the
 * shell injects the command runner.
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
  /** The install spec (npm name, npm name@version, or a git URL). */
  readonly package: string
  /** Display title. */
  readonly title: string
  /** Display title in Chinese; the page prefers it when the shell runs in zh. */
  readonly titleZh?: string
  /** Display description. */
  readonly description: string
  /** Display description in Chinese; the page prefers it when the shell runs in zh. */
  readonly descriptionZh?: string
  /** The entry's author, when the feed names one. */
  readonly author?: string
  /** The source repository URL (https). */
  readonly source: string
  /** Whether the entry ships in the official feed (false = community-maintained). */
  readonly official: boolean
  /** Whether this entry aggregates a whole plugin family (one-click family install). */
  readonly bundles: boolean
  /** The engine semver range the plugin was built against; absent means unknown. */
  readonly compatibility?: string
}

/** The feed document the marketplace reads from disk. */
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
  /** Whether the engine version satisfies the entry's compatibility range (true when unknown). */
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
 * Packages outside the reviewed set resolve to `true`: the user already
 * approved the install in the trust-displaying marketplace, so their build
 * scripts run — the same consent pnpm's interactive approve-builds asks for.
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
          const decision = REVIEWED_BUILDS[name] ?? true
          return `${match[1]}${name}: ${decision ? 'true' : 'false'}`
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
 * Parse and validate a feed document at the file boundary. Unknown fields
 * are ignored; a malformed entry or an unsupported feed version fails loud.
 * @param value - the parsed JSON value.
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
    if (plugin.titleZh !== undefined && !isText(plugin.titleZh)) throw new Error(`${where} must declare titleZh as text`)
    if (plugin.descriptionZh !== undefined && !isText(plugin.descriptionZh)) throw new Error(`${where} must declare descriptionZh as text`)
    if (plugin.author !== undefined && !isText(plugin.author)) throw new Error(`${where} must declare author as text`)
    if (!isHttpsUrl(plugin.source)) throw new Error(`${where} must declare an https source URL`)
    if (typeof plugin.official !== 'boolean') throw new Error(`${where} must declare an official flag`)
    if (typeof plugin.bundles !== 'boolean') throw new Error(`${where} must declare a bundles flag`)
    if (plugin.compatibility !== undefined
      && (!isText(plugin.compatibility) || semver.validRange(plugin.compatibility) === null)) {
      throw new Error(`${where} must declare a valid compatibility range when present`)
    }
    return {
      package: plugin.package,
      title: plugin.title,
      ...plugin.titleZh !== undefined && { titleZh: plugin.titleZh },
      description: plugin.description,
      ...plugin.descriptionZh !== undefined && { descriptionZh: plugin.descriptionZh },
      ...plugin.author !== undefined && { author: plugin.author },
      source: plugin.source,
      official: plugin.official,
      bundles: plugin.bundles,
      ...plugin.compatibility !== undefined && { compatibility: plugin.compatibility },
    }
  })
  return { version: 1, plugins }
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

/**
 * Parse one terminal command into `dsh plugin` arguments. The grammar is the
 * four verbs a user needs: `add <spec>`, `remove <name>`, `update <name>`,
 * and `install` (reconcile), plus `rollback`.
 * @param command - the raw command line.
 * @returns the `dsh plugin` argument list.
 */
export function parsePluginCommand(command: string): string[] {
  const parts = command.trim().split(/\s+/).filter(part => part !== '')
  const verb = parts[0] ?? ''
  const rest = parts.slice(1)
  switch (verb) {
    case 'add': {
      const spec = rest[0]
      if (rest.length !== 1 || spec === undefined) throw new Error('usage: add <package-or-git-url>')
      return ['add', spec]
    }
    case 'remove':
    case 'update': {
      const name = rest[0]
      if (rest.length !== 1 || name === undefined) throw new Error(`usage: ${verb} <package-name>`)
      return [verb, name]
    }
    case 'install':
      if (rest.length !== 0) throw new Error('usage: install')
      return ['install']
    case 'rollback':
      if (rest.length !== 0) throw new Error('usage: rollback')
      return []
    default:
      throw new Error(`unknown command "${verb}" — use add / remove / update / install / rollback`)
  }
}

/** The marketplace's read and mutating operations. */
export interface MarketOperations {
  /** The shipped feed merged with the live profile and engine facts. */
  list(): Promise<{ readonly engineVersion: string | undefined; readonly plugins: PluginState[] }>
  /** Run one terminal command; throws on a parse or execution failure. */
  runCommand(command: string): Promise<string>
}

/** The market's injected world: profile, engine version, shipped feed file, command runner. */
export interface MarketContext {
  /** The profile directory the plugin forwarder manages. */
  readonly profileDir: string
  /** The running engine version, or undefined when unknown (compatibility unknown). */
  readonly engineVersion: string | undefined
  /** The locally shipped feed file path. */
  readonly feedPath: string
  /** The `dsh plugin` command runner; returns the exit code (injected by the shell). */
  readonly runPlugin: (args: readonly string[]) => Promise<number>
}

/**
 * Build the marketplace operations over one profile.
 * @param context - the injected world.
 * @returns the operations.
 */
export function createMarket(context: MarketContext): MarketOperations {
  const runChecked = async (args: readonly string[], purpose: string): Promise<void> => {
    const code = await context.runPlugin(args)
    if (code !== 0) throw new Error(`plugin ${purpose} failed with exit code ${code}`)
  }
  return {
    async list() {
      if (!existsSync(context.feedPath)) {
        throw new Error(`plugin feed file is missing at ${context.feedPath}`)
      }
      const raw = await readFile(context.feedPath, 'utf8')
      const feed = parseMarketFeed(JSON.parse(raw) as unknown)
      const profile = readProfileState(context.profileDir)
      const plugins = feed.plugins.map((entry): PluginState => {
        const name = packageName(entry.package)
        return {
          ...entry,
          installed: profile.bundles.includes(name) || profile.dependencies.includes(name),
          compatible: context.engineVersion === undefined || entry.compatibility === undefined
            ? true
            : semver.satisfies(context.engineVersion, entry.compatibility, { includePrerelease: true }),
          rollbackAvailable: hasProfileSnapshot(context.profileDir),
        }
      })
      return { engineVersion: context.engineVersion, plugins }
    },
    async runCommand(command) {
      const parsed = parsePluginCommand(command)
      if (parsed.length === 0) {
        // rollback: restore the snapshot and reconcile.
        await rollbackProfile(context.profileDir, async args => await context.runPlugin(args))
        return 'rollback done'
      }
      if (parsed[0] === 'add') {
        await snapshotProfile(context.profileDir)
        await runChecked(parsed, 'install')
        return `installed ${parsed[1] ?? ''}`
      }
      if (parsed[0] === 'remove' || parsed[0] === 'update') {
        await snapshotProfile(context.profileDir)
        await runChecked(parsed, parsed[0])
        return `${parsed[0]} ${parsed[1] ?? ''} done`
      }
      await runChecked(parsed, 'install')
      return 'install done'
    },
  }
}
