/**
 * Shell settings store: merge tolerance, round trip, and atomic replace.
 * @module @deepseek-ai/dsh-desktop/tests/shell-settings
 */

import { mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { DEFAULT_SHELL_SETTINGS, isOwnerOnly, readShellSettings, writeShellSettings } from '../src/shell-settings.ts'

const scratchDirs: string[] = []

/** Create a scratch directory that afterAll removes. */
function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-desktop-settings-'))
  scratchDirs.push(dir)
  return dir
}

afterAll(() => {
  for (const dir of scratchDirs) rmSync(dir, { recursive: true, force: true })
})

describe('readShellSettings', () => {
  it('returns defaults when the file is missing', async () => {
    const path = join(scratch(), 'settings.json')
    await expect(readShellSettings(path)).resolves.toEqual(DEFAULT_SHELL_SETTINGS)
  })

  it('returns defaults when the file is not valid JSON', async () => {
    const dir = scratch()
    const path = join(dir, 'settings.json')
    mkdirSync(dir, { recursive: true })
    writeFileSync(path, 'not json {')
    await expect(readShellSettings(path)).resolves.toEqual(DEFAULT_SHELL_SETTINGS)
  })

  it('returns defaults when the document is not an object', async () => {
    const dir = scratch()
    const path = join(dir, 'settings.json')
    mkdirSync(dir, { recursive: true })
    writeFileSync(path, '[1, 2]')
    await expect(readShellSettings(path)).resolves.toEqual(DEFAULT_SHELL_SETTINGS)
  })

  it('merges each present well-typed field over the defaults', async () => {
    const dir = scratch()
    const path = join(dir, 'settings.json')
    mkdirSync(dir, { recursive: true })
    writeFileSync(path, JSON.stringify({
      minimizeToTray: false,
      updateChannel: 'beta',
      openAtLogin: 'yes',
      registry: 'https://registry.npmmirror.com',
      nodeMirror: 'not a url',
      locale: 'en',
    }))
    await expect(readShellSettings(path)).resolves.toEqual({
      minimizeToTray: false,
      openAtLogin: DEFAULT_SHELL_SETTINGS.openAtLogin,
      updateChannel: 'beta',
      registry: 'https://registry.npmmirror.com',
      nodeMirror: DEFAULT_SHELL_SETTINGS.nodeMirror,
      pluginFeedUrl: DEFAULT_SHELL_SETTINGS.pluginFeedUrl,
      locale: 'en',
    })
  })

  it('round-trips a full settings document', async () => {
    const path = join(scratch(), 'settings.json')
    const settings = {
      minimizeToTray: false,
      openAtLogin: true,
      updateChannel: 'beta' as const,
      registry: 'https://registry.npmmirror.com',
      nodeMirror: 'https://npmmirror.com/mirrors/node',
      pluginFeedUrl: 'https://raw.githubusercontent.com/example/feed.json',
      locale: 'zh' as const,
    }
    await writeShellSettings(path, settings)
    await expect(readShellSettings(path)).resolves.toEqual(settings)
  })
})

describe('writeShellSettings', () => {
  it('creates the parent directory tree', async () => {
    const path = join(scratch(), 'nested', 'dir', 'settings.json')
    await writeShellSettings(path, DEFAULT_SHELL_SETTINGS)
    await expect(readShellSettings(path)).resolves.toEqual(DEFAULT_SHELL_SETTINGS)
  })

  it('replaces an existing file completely', async () => {
    const dir = scratch()
    const path = join(dir, 'settings.json')
    mkdirSync(dir, { recursive: true })
    writeFileSync(path, `${JSON.stringify({ openAtLogin: true })}\n`)
    await writeShellSettings(path, { ...DEFAULT_SHELL_SETTINGS, updateChannel: 'beta' })
    await expect(readShellSettings(path)).resolves.toEqual({ ...DEFAULT_SHELL_SETTINGS, updateChannel: 'beta' })
  })
})

describe('isOwnerOnly', () => {
  it('reports the stored file mode without judging it', async () => {
    const path = join(scratch(), 'settings.json')
    await writeShellSettings(path, DEFAULT_SHELL_SETTINGS)
    const mode = statSync(path).mode & 0o777
    expect(await isOwnerOnly(path)).toBe(mode === 0o600)
  })
})
