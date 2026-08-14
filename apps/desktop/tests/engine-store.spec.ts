/**
 * Engine store: pointer round trips, sidecar provisioning, install
 * idempotence, update flow with injected installers/health checks, pruning,
 * and fallback selection.
 * @module @deepseek-ai/dsh-desktop/tests/engine-store
 */

import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gzipSync, strToU8, zipSync } from 'fflate'
import { create as tarCreate } from 'tar'
import { afterAll, describe, expect, it } from 'vitest'
import {
  defaultEngineStoreRoot,
  engineStorePaths,
  ensureNodeSidecar,
  extractNodeArchive,
  fallbackVersion,
  healthCheckEngine,
  installEngine,
  installedEngines,
  nodeArchiveUrl,
  readPointer,
  updateEngine,
  writePointer,
  type EngineInstaller,
  type EngineStorePaths,
} from '../src/engine-store.ts'
import type { EngineLocation } from '../src/engine-process.ts'

const FIXTURES = fileURLToPath(new URL('./fixtures', import.meta.url))
const FAKE_ENGINE = join(FIXTURES, 'fake-engine.mjs')
const ENGINE_BIN = join('node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')

const scratchDirs: string[] = []

/** Create a scratch directory that afterAll removes. */
function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-engine-store-'))
  scratchDirs.push(dir)
  return dir
}

afterAll(() => {
  for (const dir of scratchDirs) rmSync(dir, { recursive: true, force: true })
})

/** A fake installer that materializes the engine bin inside the version dir. */
function fakeInstaller(): { install: EngineInstaller; calls: string[] } {
  const calls: string[] = []
  return {
    calls,
    install: async (versionDir, version) => {
      calls.push(version)
      mkdirSync(join(versionDir, dirname(ENGINE_BIN)), { recursive: true })
      writeFileSync(join(versionDir, ENGINE_BIN), '')
    },
  }
}

/** A fake node archive containing node.exe and npm-cli.js. */
function fakeNodeArchive(): Buffer {
  const files: Record<string, Uint8Array> = {
    'node-v99.0.0-win-x64/node.exe': strToU8('fake node'),
    'node-v99.0.0-win-x64/node_modules/npm/bin/npm-cli.js': strToU8('fake npm'),
    'node-v99.0.0-win-x64/LICENSE': strToU8('dropped by the filter'),
  }
  return Buffer.from(zipSync(files))
}

/** A fake macOS node archive (tar.gz) containing the node bin and npm. */
async function fakeDarwinNodeArchive(): Promise<Buffer> {
  const fixture = scratch()
  const prefix = join(fixture, 'node-v99.0.0-darwin-arm64')
  mkdirSync(join(prefix, 'bin'), { recursive: true })
  mkdirSync(join(prefix, 'lib', 'node_modules', 'npm', 'bin'), { recursive: true })
  writeFileSync(join(prefix, 'bin', 'node'), 'fake node')
  writeFileSync(join(prefix, 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'), 'fake npm')
  writeFileSync(join(prefix, 'LICENSE'), 'dropped by the filter')
  const pack = tarCreate({ portable: true, gzip: false, cwd: fixture }, ['node-v99.0.0-darwin-arm64'])
  const chunks: Buffer[] = []
  pack.on('data', (chunk: Buffer) => { chunks.push(chunk) })
  const tar = await new Promise<Buffer>((resolveTar) => {
    pack.on('end', () => { resolveTar(Buffer.concat(chunks)) })
  })
  return Buffer.from(gzipSync(new Uint8Array(tar)))
}

/** A fake packument fetch naming one latest version. */
function fakePackument(version: string): (url: string) => Promise<unknown> {
  return async () => ({ 'dist-tags': { latest: version, next: version } })
}

describe('engineStorePaths', () => {
  it('derives the store layout from the root', () => {
    const paths = engineStorePaths(join('C:', 'store'), 'win32')
    expect(paths.nodeExe).toBe(join('C:', 'store', 'runtime', 'node', 'node.exe'))
    expect(paths.versionsDir).toBe(join('C:', 'store', 'versions'))
    expect(paths.currentPointer).toBe(join('C:', 'store', 'current'))
    expect(paths.lastGoodPointer).toBe(join('C:', 'store', 'last-good'))
  })
})

describe('defaultEngineStoreRoot', () => {
  it('resolves the Windows per-user location', () => {
    expect(defaultEngineStoreRoot({ LOCALAPPDATA: 'C:\\Local' }, 'win32'))
      .toBe(join('C:', 'Local', 'DeepSeekHarness', 'engine'))
  })

  it('falls back to USERPROFILE when LOCALAPPDATA is absent', () => {
    expect(defaultEngineStoreRoot({ USERPROFILE: 'C:\\Users\\me' }, 'win32'))
      .toBe(join('C:', 'Users', 'me', 'AppData', 'Local', 'DeepSeekHarness', 'engine'))
  })

  it('resolves the POSIX home location', () => {
    expect(defaultEngineStoreRoot({ HOME: '/home/me' }, 'linux'))
      .toBe(join('/home', 'me', '.dsh', 'engine'))
  })

  it('returns undefined without a base directory', () => {
    expect(defaultEngineStoreRoot({}, 'win32')).toBeUndefined()
  })
})

describe('readPointer / writePointer', () => {
  it('returns undefined for a missing pointer', async () => {
    await expect(readPointer(join(scratch(), 'current'))).resolves.toBeUndefined()
  })

  it('returns undefined for a malformed pointer', async () => {
    const dir = scratch()
    const pointer = join(dir, 'current')
    mkdirSync(dir, { recursive: true })
    writeFileSync(pointer, 'not a version\n')
    await expect(readPointer(pointer)).resolves.toBeUndefined()
  })

  it('round-trips a version', async () => {
    const pointer = join(scratch(), 'current')
    await writePointer(pointer, '0.1.0-rc.6')
    await expect(readPointer(pointer)).resolves.toBe('0.1.0-rc.6')
  })
})

describe('nodeArchiveUrl', () => {
  it('names the Windows x64 zip', () => {
    expect(nodeArchiveUrl('https://mirror.example/node', 'v24.16.0', 'win32'))
      .toBe('https://mirror.example/node/v24.16.0/node-v24.16.0-win-x64.zip')
  })

  it('strips a trailing mirror slash', () => {
    expect(nodeArchiveUrl('https://mirror.example/node/', 'v24.16.0', 'win32'))
      .toBe('https://mirror.example/node/v24.16.0/node-v24.16.0-win-x64.zip')
  })

  it('names the macOS per-architecture tar.gz', () => {
    expect(nodeArchiveUrl('https://mirror.example/node', 'v24.16.0', 'darwin', 'arm64'))
      .toBe('https://mirror.example/node/v24.16.0/node-v24.16.0-darwin-arm64.tar.gz')
    expect(nodeArchiveUrl('https://mirror.example/node', 'v24.16.0', 'darwin', 'x64'))
      .toBe('https://mirror.example/node/v24.16.0/node-v24.16.0-darwin-x64.tar.gz')
  })

  it('rejects unsupported platforms', () => {
    expect(nodeArchiveUrl('https://mirror.example/node', 'v24.16.0', 'linux')).toBeUndefined()
  })
})

describe('ensureNodeSidecar', () => {
  it('downloads and extracts the sidecar once, then reuses it', async () => {
    const paths = engineStorePaths(scratch(), 'win32')
    let downloads = 0
    const download = async (url: string): Promise<Buffer> => {
      downloads += 1
      expect(url).toContain('node-v24.16.0-win-x64.zip')
      return fakeNodeArchive()
    }
    await expect(ensureNodeSidecar(paths, 'https://mirror.example/node', { download, platform: 'win32' }))
      .resolves.toBe(paths.nodeExe)
    expect(existsSync(paths.nodeExe)).toBe(true)
    expect(existsSync(join(paths.nodeDir, 'node_modules', 'npm', 'bin', 'npm-cli.js'))).toBe(true)
    expect(existsSync(join(paths.nodeDir, 'LICENSE'))).toBe(false)
    await ensureNodeSidecar(paths, 'https://mirror.example/node', { download, platform: 'win32' })
    expect(downloads).toBe(1)
  })

  it('provisions the macOS sidecar from a tar.gz', async () => {
    const paths = engineStorePaths(scratch(), 'darwin')
    const download = async (url: string): Promise<Buffer> => {
      expect(url).toContain('node-v24.16.0-darwin-arm64.tar.gz')
      return await fakeDarwinNodeArchive()
    }
    await expect(ensureNodeSidecar(paths, 'https://mirror.example/node', { download, platform: 'darwin', arch: 'arm64' }))
      .resolves.toBe(paths.nodeExe)
    expect(existsSync(paths.nodeExe)).toBe(true)
    expect(existsSync(join(paths.nodeDir, 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'))).toBe(true)
  })

  it('rejects unsupported platform provisioning', async () => {
    const paths = engineStorePaths(scratch(), 'linux')
    await expect(ensureNodeSidecar(paths, 'https://mirror.example/node', { platform: 'linux' }))
      .rejects.toThrow(/Windows and macOS/)
  })
})

describe('extractNodeArchive', () => {
  it('rejects an archive whose members are all filtered out', async () => {
    const paths = engineStorePaths(scratch(), 'win32')
    // No member matches the node.exe/npm filter, so extraction must fail.
    const flat = Buffer.from(zipSync({ 'node-v99.0.0-win-x64/README.md': strToU8('x') }))
    await expect(extractNodeArchive(paths, flat)).rejects.toThrow(/archive is empty/)
  })

  it('extracts a macOS tar.gz, dropping filtered members', async () => {
    const paths = engineStorePaths(scratch(), 'darwin')
    await extractNodeArchive(paths, await fakeDarwinNodeArchive(), 'darwin')
    expect(existsSync(paths.nodeExe)).toBe(true)
    expect(existsSync(join(paths.nodeDir, 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'))).toBe(true)
    expect(existsSync(join(paths.nodeDir, 'LICENSE'))).toBe(false)
  })
})

describe('installEngine', () => {
  it('installs through the injected installer and verifies the bin', async () => {
    const paths = engineStorePaths(scratch(), 'win32')
    const fake = fakeInstaller()
    await expect(installEngine(paths, '0.1.0-rc.6', {
      registry: 'https://registry.example',
      install: fake.install,
      platform: 'win32',
    })).resolves.toBe(join(paths.versionsDir, '0.1.0-rc.6'))
    expect(fake.calls).toEqual(['0.1.0-rc.6'])
  })

  it('reuses an already-complete version directory', async () => {
    const paths = engineStorePaths(scratch(), 'win32')
    const fake = fakeInstaller()
    await installEngine(paths, '0.1.0-rc.6', { registry: 'https://registry.example', install: fake.install, platform: 'win32' })
    await installEngine(paths, '0.1.0-rc.6', { registry: 'https://registry.example', install: fake.install, platform: 'win32' })
    expect(fake.calls).toEqual(['0.1.0-rc.6'])
  })

  it('rejects an install that produced no bin', async () => {
    const paths = engineStorePaths(scratch(), 'win32')
    await expect(installEngine(paths, '0.1.0-rc.6', {
      registry: 'https://registry.example',
      install: async () => {},
      platform: 'win32',
    })).rejects.toThrow(/installed without its bin/)
  })
})

describe('installedEngines', () => {
  it('lists complete and incomplete versions, newest first', async () => {
    const paths = engineStorePaths(scratch(), 'win32')
    const fake = fakeInstaller()
    await installEngine(paths, '0.1.0-rc.5', { registry: 'https://registry.example', install: fake.install, platform: 'win32' })
    await installEngine(paths, '0.1.0-rc.6', { registry: 'https://registry.example', install: fake.install, platform: 'win32' })
    mkdirSync(join(paths.versionsDir, 'broken'), { recursive: true })
    const engines = await installedEngines(paths)
    expect(engines.map(engine => [engine.version, engine.complete])).toEqual([
      ['0.1.0-rc.6', true],
      ['0.1.0-rc.5', true],
    ])
  })

  it('returns an empty list for a fresh store', async () => {
    await expect(installedEngines(engineStorePaths(scratch(), 'win32'))).resolves.toEqual([])
  })
})

describe('healthCheckEngine', () => {
  it('boots the candidate against an isolated home and stops it', async () => {
    const location: EngineLocation = {
      node: process.execPath,
      nodeArgs: [],
      script: FAKE_ENGINE,
      cwd: FIXTURES,
      kind: 'env-script',
    }
    await expect(healthCheckEngine(location, { timeoutMs: 10_000 })).resolves.toBe(true)
  }, 15_000)

  it('reports an unhealthy candidate', async () => {
    const location: EngineLocation = {
      node: process.execPath,
      nodeArgs: [],
      script: join(FIXTURES, 'fake-engine-exit.mjs'),
      cwd: FIXTURES,
      kind: 'env-script',
    }
    await expect(healthCheckEngine(location, { timeoutMs: 10_000 })).resolves.toBe(false)
  }, 15_000)
})

describe('fallbackVersion', () => {
  it('returns undefined when no last-good pointer exists', async () => {
    await expect(fallbackVersion(engineStorePaths(scratch(), 'win32'), '0.1.0-rc.6')).resolves.toBeUndefined()
  })

  it('returns undefined when last-good equals current', async () => {
    const paths = engineStorePaths(scratch(), 'win32')
    await writePointer(paths.lastGoodPointer, '0.1.0-rc.6')
    await expect(fallbackVersion(paths, '0.1.0-rc.6')).resolves.toBeUndefined()
  })

  it('returns last-good when it differs and is installed', async () => {
    const paths = engineStorePaths(scratch(), 'win32')
    const fake = fakeInstaller()
    await installEngine(paths, '0.1.0-rc.5', { registry: 'https://registry.example', install: fake.install, platform: 'win32' })
    await writePointer(paths.lastGoodPointer, '0.1.0-rc.5')
    await expect(fallbackVersion(paths, '0.1.0-rc.6')).resolves.toBe('0.1.0-rc.5')
  })

  it('ignores a last-good version that is not installed', async () => {
    const paths = engineStorePaths(scratch(), 'win32')
    await writePointer(paths.lastGoodPointer, '0.1.0-rc.5')
    await expect(fallbackVersion(paths, '0.1.0-rc.6')).resolves.toBeUndefined()
  })
})

describe('updateEngine', () => {
  function harness(): {
    paths: EngineStorePaths
    fake: ReturnType<typeof fakeInstaller>
    lines: string[]
  } {
    const fake = fakeInstaller()
    const lines: string[] = []
    return { paths: engineStorePaths(scratch(), 'win32'), fake, lines }
  }

  const baseOptions = {
    channel: 'stable' as const,
    registry: 'https://registry.example',
    nodeMirror: 'https://mirror.example/node',
    timeoutMs: 10_000,
  }

  it('updates a fresh store: install, health check, pointers', async () => {
    const { paths, fake, lines } = harness()
    const result = await updateEngine(paths, {
      ...baseOptions,
      fetchPackument: fakePackument('0.1.0-rc.6'),
      install: fake.install,
      download: async () => fakeNodeArchive(),
      healthCheck: async () => true,
      onLine: (line) => { lines.push(line) },
    })
    expect(result).toEqual({ outcome: 'updated', from: undefined, to: '0.1.0-rc.6' })
    await expect(readPointer(paths.currentPointer)).resolves.toBe('0.1.0-rc.6')
    await expect(readPointer(paths.lastGoodPointer)).resolves.toBe('0.1.0-rc.6')
    expect(fake.calls).toEqual(['0.1.0-rc.6'])
  })

  it('reports already-current without reinstalling', async () => {
    const { paths, fake } = harness()
    await updateEngine(paths, {
      ...baseOptions,
      fetchPackument: fakePackument('0.1.0-rc.6'),
      install: fake.install,
      download: async () => fakeNodeArchive(),
      healthCheck: async () => true,
    })
    const second = await updateEngine(paths, {
      ...baseOptions,
      fetchPackument: fakePackument('0.1.0-rc.6'),
      install: fake.install,
      download: async () => fakeNodeArchive(),
      healthCheck: async () => true,
    })
    expect(second).toEqual({ outcome: 'already-current', version: '0.1.0-rc.6' })
    expect(fake.calls).toEqual(['0.1.0-rc.6'])
  })

  it('leaves an unhealthy candidate unactivated', async () => {
    const { paths, fake } = harness()
    const result = await updateEngine(paths, {
      ...baseOptions,
      fetchPackument: fakePackument('0.1.0-rc.6'),
      install: fake.install,
      download: async () => fakeNodeArchive(),
      healthCheck: async () => false,
    })
    expect(result.outcome).toBe('unhealthy')
    if (result.outcome === 'unhealthy') {
      expect(result.version).toBe('0.1.0-rc.6')
      expect(result.reason).toContain('health check')
    }
    await expect(readPointer(paths.currentPointer)).resolves.toBeUndefined()
    expect(fake.calls).toEqual(['0.1.0-rc.6'])
  })

  it('prunes old versions while keeping current, previous, last-good, and two extras', async () => {
    const { paths, fake } = harness()
    const install = async (version: string): Promise<void> => {
      await updateEngine(paths, {
        ...baseOptions,
        fetchPackument: fakePackument(version),
        install: fake.install,
        download: async () => fakeNodeArchive(),
        healthCheck: async () => true,
      })
    }
    await install('0.1.0-rc.2')
    await install('0.1.0-rc.3')
    await install('0.1.0-rc.4')
    await install('0.1.0-rc.5')
    await install('0.1.0-rc.6')
    const engines = await installedEngines(paths)
    expect(engines.map(engine => engine.version)).toEqual([
      '0.1.0-rc.6', '0.1.0-rc.5', '0.1.0-rc.4', '0.1.0-rc.3',
    ])
    expect(existsSync(join(paths.versionsDir, '0.1.0-rc.2'))).toBe(false)
  })

  it('rejects a packument that names no valid version', async () => {
    const { paths, fake } = harness()
    await expect(updateEngine(paths, {
      ...baseOptions,
      fetchPackument: async () => ({ 'dist-tags': { latest: 'nonsense' } }),
      install: fake.install,
      download: async () => fakeNodeArchive(),
      healthCheck: async () => true,
    })).rejects.toThrow(/no valid latest version/)
  })
})
