/**
 * The desktop shell's own settings: window/tray behavior and the engine
 * update channel. Plain JSON in the shell's userData directory, written with
 * the repository's atomic-write utility; this module is Electron-free so the
 * merge, tolerance, and write behavior are unit-testable. The engine's
 * product settings live elsewhere (the engine's Harness home) — this store
 * owns only what the shell itself decides.
 * @module @deepseek-ai/dsh-desktop/shell-settings
 */

import { readFile, stat } from 'node:fs/promises'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { isShellLocale, type ShellLocale } from './shell-i18n.ts'

/** Shell-owned settings. */
export interface ShellSettings {
  /** Whether closing the window hides to the tray instead of quitting. */
  readonly minimizeToTray: boolean
  /** Whether the shell launches at Windows login. */
  readonly openAtLogin: boolean
  /** The engine update channel tag (`stable` or `beta`). */
  readonly updateChannel: 'stable' | 'beta'
  /** The npm registry the engine store installs from. */
  readonly registry: string
  /** The mirror the portable node sidecar downloads from. */
  readonly nodeMirror: string
  /** The community page the marketplace embeds in its webview. */
  readonly communityPageUrl: string
  /** The shell UI language. */
  readonly locale: ShellLocale
}

/** Defaults for every field; a missing or malformed file falls back to these. */
export const DEFAULT_SHELL_SETTINGS: ShellSettings = {
  minimizeToTray: true,
  openAtLogin: false,
  updateChannel: 'stable',
  registry: 'https://registry.npmjs.org',
  nodeMirror: 'https://npmmirror.com/mirrors/node',
  communityPageUrl: 'https://github.com/zhu1090093659/dsh-web-ui',
  locale: 'zh',
}

/** A parsed settings document: each field is its own fallback decision. */
interface ParsedSettings {
  readonly minimizeToTray: boolean | undefined
  readonly openAtLogin: boolean | undefined
  readonly updateChannel: 'stable' | 'beta' | undefined
  readonly registry: string | undefined
  readonly nodeMirror: string | undefined
  readonly communityPageUrl: string | undefined
  readonly locale: ShellLocale | undefined
}

/** Whether a value is an http(s) URL. */
function isHttpUrl(value: unknown): value is string {
  return typeof value === 'string' && /^https?:\/\/\S+$/.test(value)
}

/** Tolerate one settings document: absent fields keep their defaults. */
function parseSettings(content: string): ParsedSettings {
  const empty: ParsedSettings = {
    minimizeToTray: undefined,
    openAtLogin: undefined,
    updateChannel: undefined,
    registry: undefined,
    nodeMirror: undefined,
    communityPageUrl: undefined,
    locale: undefined,
  }
  let document: unknown
  try {
    document = JSON.parse(content)
  } catch {
    return empty
  }
  if (document === null || typeof document !== 'object' || Array.isArray(document)) {
    return empty
  }
  const record = document as Record<string, unknown>
  return {
    minimizeToTray: typeof record.minimizeToTray === 'boolean' ? record.minimizeToTray : undefined,
    openAtLogin: typeof record.openAtLogin === 'boolean' ? record.openAtLogin : undefined,
    updateChannel: record.updateChannel === 'stable' || record.updateChannel === 'beta' ? record.updateChannel : undefined,
    registry: isHttpUrl(record.registry) ? record.registry : undefined,
    nodeMirror: isHttpUrl(record.nodeMirror) ? record.nodeMirror : undefined,
    communityPageUrl: isHttpUrl(record.communityPageUrl) ? record.communityPageUrl : undefined,
    locale: isShellLocale(record.locale) ? record.locale : undefined,
  }
}

/**
 * Read the shell settings, merging each present, well-typed field over the
 * defaults. A missing file or an unreadable document yields the defaults
 * instead of blocking the shell on a user-editable file.
 * @param filePath - the settings JSON path.
 * @returns the merged settings.
 */
export async function readShellSettings(filePath: string): Promise<ShellSettings> {
  let content: string
  try {
    content = await readFile(filePath, 'utf8')
  } catch {
    return { ...DEFAULT_SHELL_SETTINGS }
  }
  const parsed = parseSettings(content)
  return {
    minimizeToTray: parsed.minimizeToTray ?? DEFAULT_SHELL_SETTINGS.minimizeToTray,
    openAtLogin: parsed.openAtLogin ?? DEFAULT_SHELL_SETTINGS.openAtLogin,
    updateChannel: parsed.updateChannel ?? DEFAULT_SHELL_SETTINGS.updateChannel,
    registry: parsed.registry ?? DEFAULT_SHELL_SETTINGS.registry,
    nodeMirror: parsed.nodeMirror ?? DEFAULT_SHELL_SETTINGS.nodeMirror,
    communityPageUrl: parsed.communityPageUrl ?? DEFAULT_SHELL_SETTINGS.communityPageUrl,
    locale: parsed.locale ?? DEFAULT_SHELL_SETTINGS.locale,
  }
}

/**
 * Persist the shell settings atomically, creating the directory tree with
 * owner-only permissions.
 * @param filePath - the settings JSON path.
 * @param settings - the complete settings to store.
 */
export async function writeShellSettings(filePath: string, settings: ShellSettings): Promise<void> {
  const content = `${JSON.stringify(settings, null, 2)}\n`
  await writeFileAtomic(filePath, content, { mode: 0o600, dirMode: 0o700 })
}

/**
 * Whether a stored settings file is owner-only readable.
 * @param filePath - the settings JSON path.
 * @returns true when the file mode is exactly 0600; on platforms without mode
 *   semantics this reports false and callers must not treat it as a failure.
 */
export async function isOwnerOnly(filePath: string): Promise<boolean> {
  const mode = (await stat(filePath)).mode & 0o777
  return mode === 0o600
}
