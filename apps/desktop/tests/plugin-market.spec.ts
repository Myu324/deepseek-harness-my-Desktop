/**
 * Plugin marketplace: feed validation, state merge, snapshot/rollback
 * semantics, and the operation → command mapping.
 * @module @deepseek-ai/dsh-desktop/tests/plugin-market
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'
import {
  createMarket,
  ensureProfileBuildPolicy,
  fetchMarketFeed,
  hasProfileSnapshot,
  parseIgnoredBuilds,
  parseMarketFeed,
  readProfileState,
  rollbackProfile,
  snapshotProfile,
  type MarketContext,
} from '../src/plugin-market.ts'

const scratchDirs: string[] = []

/** Create a scratch directory that afterAll removes. */
function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-market-'))
  scratchDirs.push(dir)
  return dir
}

afterAll(() => {
  for (const dir of scratchDirs) rmSync(dir, { recursive: true, force: true })
})

/** A valid feed document with one entry. */
function validFeed(): unknown {
  return {
    version: 1,
    plugins: [{
      package: '@linxin666/dsh-web-ui-all',
      title: 'Web UI 全家桶',
      description: 'The whole family.',
      source: 'https://github.com/zhu1090093659/dsh-web-ui',
      official: false,
      bundles: true,
      compatibility: '>=0.1.0-rc.6',
    }],
  }
}

/** A profile fixture manifest with the given bundles and dependencies. */
function writeProfile(dir: string, bundles: string[] = [], dependencies: Record<string, string> = {}): void {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify({
    name: 'web',
    dependencies,
    dsh: { profile: { bundles } },
  }, null, 2))
}

/** A market context over one profile with a recording command runner. */
function harness(): {
  profileDir: string
  calls: string[][]
  context: MarketContext
} {
  const profileDir = scratch()
  const calls: string[][] = []
  const context: MarketContext = {
    profileDir,
    engineVersion: '0.1.0-rc.6',
    feedUrl: 'https://feeds.example/plugins.json',
    fetchFeed: async () => validFeed(),
    runPlugin: async (args) => {
      calls.push([...args])
      return 0
    },
  }
  return { profileDir, calls, context }
}

describe('parseMarketFeed', () => {
  it('accepts a valid feed', () => {
    const feed = parseMarketFeed(validFeed())
    expect(feed.version).toBe(1)
    expect(feed.plugins[0]?.package).toBe('@linxin666/dsh-web-ui-all')
  })

  it('rejects a non-object feed', () => {
    expect(() => parseMarketFeed([1])).toThrow(/must be a JSON object/)
  })

  it('rejects an unsupported feed version', () => {
    expect(() => parseMarketFeed({ version: 2, plugins: [] })).toThrow(/version must be 1/)
  })

  it('rejects an entry with a bad compatibility range', () => {
    const feed = validFeed() as { plugins: Array<Record<string, unknown>> }
    feed.plugins[0] = { ...feed.plugins[0]!, compatibility: 'not a range' }
    expect(() => parseMarketFeed(feed)).toThrow(/valid compatibility range/)
  })

  it('rejects an entry with a non-https source', () => {
    const feed = validFeed() as { plugins: Array<Record<string, unknown>> }
    feed.plugins[0] = { ...feed.plugins[0]!, source: 'file:///etc/passwd' }
    expect(() => parseMarketFeed(feed)).toThrow(/https source URL/)
  })

  it('accepts and validates the optional Chinese fields', () => {
    const feed = validFeed() as { plugins: Array<Record<string, unknown>> }
    feed.plugins[0] = { ...feed.plugins[0]!, titleZh: 'Web UI 全家桶', descriptionZh: '一键装齐。' }
    const parsed = parseMarketFeed(feed)
    expect(parsed.plugins[0]?.titleZh).toBe('Web UI 全家桶')
    expect(parsed.plugins[0]?.descriptionZh).toBe('一键装齐。')
    const first = feed.plugins[0]
    if (first === undefined) throw new Error('fixture has no entries')
    feed.plugins[0] = { ...first, titleZh: 42 }
    expect(() => parseMarketFeed(feed)).toThrow(/titleZh as text/)
  })
})

describe('fetchMarketFeed', () => {
  it('fetches and validates through the injected fetcher', async () => {
    const feed = await fetchMarketFeed('https://feeds.example/plugins.json', async () => validFeed())
    expect(feed.plugins).toHaveLength(1)
  })

  it('propagates fetcher failures', async () => {
    await expect(fetchMarketFeed('https://feeds.example/x', async () => {
      throw new Error('network down')
    })).rejects.toThrow('network down')
  })

  it('retries transient network failures before giving up', async () => {
    let calls = 0
    vi.stubGlobal('fetch', vi.fn(async () => {
      calls += 1
      if (calls < 3) throw new TypeError('fetch failed')
      return { ok: true, json: async () => validFeed() }
    }))
    const feed = await fetchMarketFeed('https://feeds.example/plugins.json')
    expect(feed.plugins).toHaveLength(1)
    expect(calls).toBe(3)
    vi.unstubAllGlobals()
  })

  it('does not retry deterministic HTTP errors', async () => {
    let calls = 0
    vi.stubGlobal('fetch', vi.fn(async () => {
      calls += 1
      return { ok: false, status: 404, json: async () => ({}) }
    }))
    await expect(fetchMarketFeed('https://feeds.example/plugins.json')).rejects.toThrow(/HTTP 404/)
    expect(calls).toBe(1)
    vi.unstubAllGlobals()
  })
})

describe('readProfileState', () => {
  it('tolerates an absent profile', () => {
    const state = readProfileState(scratch())
    expect(state).toEqual({ exists: false, manifest: {}, bundles: [], dependencies: [] })
  })

  it('reads bundles and dependencies', () => {
    const dir = scratch()
    writeProfile(dir, ['@deepseek-ai/dsh-base'], { '@linxin666/dsh-ssh': '0.1.12' })
    const state = readProfileState(dir)
    expect(state.exists).toBe(true)
    expect(state.bundles).toEqual(['@deepseek-ai/dsh-base'])
    expect(state.dependencies).toEqual(['@linxin666/dsh-ssh'])
  })
})

describe('snapshotProfile / rollbackProfile', () => {
  it('rolls a manifest change back and reconciles', async () => {
    const dir = scratch()
    writeProfile(dir, ['@deepseek-ai/dsh-base'])
    await snapshotProfile(dir)
    writeProfile(dir, ['@deepseek-ai/dsh-base', '@linxin666/dsh-web-ui-all'])
    const calls: string[][] = []
    await rollbackProfile(dir, async (args) => {
      calls.push([...args])
      return 0
    })
    expect(readProfileState(dir).bundles).toEqual(['@deepseek-ai/dsh-base'])
    expect(calls).toEqual([['install']])
    expect(hasProfileSnapshot(dir)).toBe(false)
  })

  it('restores an absent manifest', async () => {
    const dir = scratch()
    await snapshotProfile(dir)
    writeProfile(dir, ['@linxin666/dsh-web-ui-all'])
    await rollbackProfile(dir, async () => 0)
    expect(existsSync(join(dir, 'package.json'))).toBe(false)
  })

  it('refuses to roll back without a snapshot', async () => {
    await expect(rollbackProfile(scratch(), async () => 0)).rejects.toThrow(/no plugin snapshot/)
  })
})

describe('parseIgnoredBuilds', () => {
  it('extracts the blocked package list from pnpm output', () => {
    const lines = [
      'Progress: resolved 29, done',
      '[ERR_PNPM_IGNORED_BUILDS] Ignored build scripts: cloudflared@0.7.3, cpu-features@0.0.10, ssh2@1.17.0',
      'Run "pnpm approve-builds" to pick which dependencies should be allowed to run scripts.',
    ]
    expect(parseIgnoredBuilds(lines)).toEqual(['cloudflared@0.7.3', 'cpu-features@0.0.10', 'ssh2@1.17.0'])
  })

  it('returns an empty list when nothing was ignored', () => {
    expect(parseIgnoredBuilds(['all good'])).toEqual([])
  })
})

describe('ensureProfileBuildPolicy', () => {
  it('appends the reviewed policy when the workspace file lacks one', async () => {
    const dir = scratch()
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'pnpm-workspace.yaml'), 'packages:\n  - .\n')
    await expect(ensureProfileBuildPolicy(dir)).resolves.toBe(true)
    const content = readFileSync(join(dir, 'pnpm-workspace.yaml'), 'utf8')
    expect(content).toContain('allowBuilds:')
    expect(content).toContain('cloudflared: true')
    expect(content).toContain('ssh2: false')
    expect(content).toContain('cpu-features: false')
  })

  it('is idempotent and respects an already-resolved allowBuilds section', async () => {
    const dir = scratch()
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'pnpm-workspace.yaml'), 'allowBuilds:\n  cloudflared: true\n')
    await expect(ensureProfileBuildPolicy(dir)).resolves.toBe(false)
    expect(readFileSync(join(dir, 'pnpm-workspace.yaml'), 'utf8')).not.toContain('ssh2')
  })

  it('resolves the pnpm placeholder entries to the reviewed decisions', async () => {
    const dir = scratch()
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'pnpm-workspace.yaml'), [
      'packages:',
      '  - .',
      'allowBuilds:',
      '  cloudflared: set this to true or false',
      '  cpu-features: set this to true or false',
      '  ssh2: set this to true or false',
      '  someone-else: set this to true or false',
      '',
    ].join('\n'))
    await expect(ensureProfileBuildPolicy(dir)).resolves.toBe(true)
    const content = readFileSync(join(dir, 'pnpm-workspace.yaml'), 'utf8')
    expect(content).toContain('cloudflared: true')
    expect(content).toContain('ssh2: false')
    expect(content).toContain('cpu-features: false')
    expect(content).toContain('someone-else: set this to true or false')
  })

  it('creates the file when the profile has none', async () => {
    const dir = scratch()
    mkdirSync(dir, { recursive: true })
    await expect(ensureProfileBuildPolicy(dir)).resolves.toBe(true)
    expect(readFileSync(join(dir, 'pnpm-workspace.yaml'), 'utf8')).toContain('cloudflared: true')
  })
})

describe('createMarket', () => {
  it('merges feed entries with the live profile state', async () => {
    const { profileDir, context } = harness()
    writeProfile(profileDir, ['@linxin666/dsh-web-ui-all'])
    const state = await createMarket(context).list()
    expect(state.engineVersion).toBe('0.1.0-rc.6')
    expect(state.plugins).toEqual([{
      package: '@linxin666/dsh-web-ui-all',
      title: 'Web UI 全家桶',
      description: 'The whole family.',
      source: 'https://github.com/zhu1090093659/dsh-web-ui',
      official: false,
      bundles: true,
      compatibility: '>=0.1.0-rc.6',
      installed: true,
      compatible: true,
      rollbackAvailable: false,
    }])
  })

  it('flags incompatible entries against the engine version', async () => {
    const { profileDir, context } = harness()
    const market = createMarket({ ...context, engineVersion: '0.1.0-rc.5' })
    const state = await market.list()
    expect(state.plugins[0]?.compatible).toBe(false)
    void profileDir
  })

  it('treats an unknown engine version as compatible', async () => {
    const { context } = harness()
    const state = await createMarket({ ...context, engineVersion: undefined }).list()
    expect(state.plugins[0]?.compatible).toBe(true)
  })

  it('installs through add, snapshotting first', async () => {
    const { profileDir, calls, context } = harness()
    writeProfile(profileDir)
    await createMarket(context).install('@linxin666/dsh-web-ui-all')
    expect(calls).toEqual([['add', '@linxin666/dsh-web-ui-all']])
    expect(hasProfileSnapshot(profileDir)).toBe(true)
  })

  it('uninstalls and updates through remove and update', async () => {
    const { calls, context } = harness()
    const market = createMarket(context)
    await market.uninstall('@linxin666/dsh-web-ui-all')
    await market.update('@linxin666/dsh-web-ui-all')
    expect(calls).toEqual([
      ['remove', '@linxin666/dsh-web-ui-all'],
      ['update', '@linxin666/dsh-web-ui-all'],
    ])
  })

  it('surfaces command failures and keeps the snapshot', async () => {
    const { profileDir, context } = harness()
    writeProfile(profileDir)
    const market = createMarket({
      ...context,
      runPlugin: async () => 1,
    })
    await expect(market.install('@linxin666/dsh-web-ui-all')).rejects.toThrow(/install failed with exit code 1/)
    expect(hasProfileSnapshot(profileDir)).toBe(true)
  })

  it('rolls back through the injected runner', async () => {
    const { profileDir, calls, context } = harness()
    writeProfile(profileDir, ['@deepseek-ai/dsh-base'])
    await snapshotProfile(profileDir)
    writeProfile(profileDir, ['@deepseek-ai/dsh-base', '@linxin666/dsh-web-ui-all'])
    await createMarket(context).rollback()
    expect(readProfileState(profileDir).bundles).toEqual(['@deepseek-ai/dsh-base'])
    expect(calls).toEqual([['install']])
  })

  it('reports the rollback snapshot on every entry', async () => {
    const { profileDir, context } = harness()
    writeProfile(profileDir)
    await snapshotProfile(profileDir)
    const state = await createMarket(context).list()
    expect(state.plugins[0]?.rollbackAvailable).toBe(true)
  })
})
