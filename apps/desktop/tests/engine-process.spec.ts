/**
 * Engine discovery, announcement parsing, port selection, and the spawn
 * handshake — exercised against fake engine scripts so this suite never boots
 * the real harness.
 * @module @deepseek-ai/dsh-desktop/tests/engine-process
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'
import {
  findFreePort,
  locateEngine,
  parseWebUrl,
  resolveExecutable,
  startEngine,
  type EngineLocation,
} from '../src/engine-process.ts'

const FIXTURES = fileURLToPath(new URL('./fixtures', import.meta.url))
const FAKE_ENGINE = join(FIXTURES, 'fake-engine.mjs')
const FAKE_EXIT = join(FIXTURES, 'fake-engine-exit.mjs')
const FAKE_SILENT = join(FIXTURES, 'fake-engine-silent.mjs')
const FAKE_EADDRINUSE = join(FIXTURES, 'fake-engine-eaddrinuse.mjs')
const ENGINE_PACKAGE_BIN = join('node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')

const scratchDirs: string[] = []

/** Create a scratch directory that afterAll removes. */
function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-desktop-'))
  scratchDirs.push(dir)
  return dir
}

/** Create a file (and its parent directories) in a scratch directory. */
function touch(base: string, relative: string): string {
  const path = join(base, relative)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, '')
  return path
}

/** A launch context over one fixture script, run with this test's node. */
function fixtureLocation(script: string): EngineLocation {
  return { node: process.execPath, nodeArgs: [], script, cwd: dirname(script), kind: 'env-script' }
}

afterAll(() => {
  for (const dir of scratchDirs) rmSync(dir, { recursive: true, force: true })
})

describe('parseWebUrl', () => {
  it('reads the plain announcement', () => {
    expect(parseWebUrl('dsh web: http://127.0.0.1:4567')).toBe('http://127.0.0.1:4567')
  })

  it('drops the LAN suffix', () => {
    expect(parseWebUrl('dsh web: http://127.0.0.1:4567 (LAN: http://192.168.1.5:4567)'))
      .toBe('http://127.0.0.1:4567')
  })

  it('tolerates surrounding whitespace', () => {
    expect(parseWebUrl('  dsh web: http://127.0.0.1:4567  ')).toBe('http://127.0.0.1:4567')
  })

  it('rejects other output', () => {
    expect(parseWebUrl('server listening on 4567')).toBeUndefined()
    expect(parseWebUrl('dsh web:')).toBeUndefined()
    expect(parseWebUrl('')).toBeUndefined()
  })
})

describe('resolveExecutable', () => {
  it('finds a bare executable on a POSIX-style PATH', () => {
    const tools = scratch()
    touch(tools, 'node')
    const found = resolveExecutable('node', { PATH: tools }, 'linux')
    expect(found).toBe(join(tools, 'node'))
  })

  it('applies PATHEXT on Windows', () => {
    const tools = scratch()
    touch(tools, 'node.exe')
    const found = resolveExecutable('node', { PATH: tools, PATHEXT: '.EXE;.CMD' }, 'win32')
    expect(found).toBe(join(tools, 'node.exe'))
  })

  it('fails loudly when nothing matches', () => {
    expect(() => resolveExecutable('node', { PATH: scratch() }, 'linux')).toThrow(/cannot find node on PATH/)
  })
})

describe('locateEngine', () => {
  it('honors DSH_ENGINE_SCRIPT with DSH_ENGINE_NODE', () => {
    const dir = scratch()
    const script = touch(dir, 'bin/custom-engine.js')
    const location = locateEngine({
      env: { DSH_ENGINE_SCRIPT: script, DSH_ENGINE_NODE: process.execPath },
      fromDir: dir,
    })
    expect(location).toEqual({
      node: process.execPath,
      nodeArgs: [],
      script,
      cwd: join(dir, 'bin'),
      kind: 'env-script',
    })
  })

  it('resolves a managed engine dir and prefers its node sidecar', () => {
    const dir = scratch()
    const bin = touch(dir, ENGINE_PACKAGE_BIN)
    const sidecar = touch(dir, join('runtime', 'node', 'node.exe'))
    const location = locateEngine({ env: { DSH_ENGINE_DIR: dir }, fromDir: dir, platform: 'win32' })
    expect(location).toEqual({ node: sidecar, nodeArgs: [], script: bin, cwd: dir, kind: 'managed-dir' })
  })

  it('falls back to PATH when the managed dir has no sidecar', () => {
    const dir = scratch()
    const bin = touch(dir, ENGINE_PACKAGE_BIN)
    const tools = scratch()
    touch(tools, 'node.exe')
    const location = locateEngine({
      env: { DSH_ENGINE_DIR: dir, PATH: tools, PATHEXT: '.EXE' },
      fromDir: dir,
      platform: 'win32',
    })
    expect(location.node).toBe(join(tools, 'node.exe'))
    expect(location.script).toBe(bin)
  })

  it('fails loudly when an explicit engine dir lacks the engine bin', () => {
    const dir = scratch()
    expect(() => locateEngine({ env: { DSH_ENGINE_DIR: dir }, fromDir: dir, platform: 'win32' }))
      .toThrow(/does not contain the engine/)
  })

  it('finds the development repository engine by walking up', () => {
    const fromDir = dirname(fileURLToPath(import.meta.url))
    const location = locateEngine({
      env: { DSH_ENGINE_NODE: process.execPath, PATH: '' },
      fromDir,
    })
    expect(location.kind).toBe('dev-repo')
    expect(location.nodeArgs).toEqual(['--import', 'tsx/esm'])
    expect(location.script.replaceAll('\\', '/')).toMatch(/apps\/cli\/src\/bin\.ts$/)
    expect(existsSync(join(location.cwd, 'apps', 'cli', 'src', 'bin.ts'))).toBe(true)
  })

  it('resolves the default store through its current pointer and root sidecar', () => {
    const local = scratch()
    const root = join(local, 'DeepSeekHarness', 'engine')
    const bin = touch(root, join('versions', '0.1.0-rc.6', ENGINE_PACKAGE_BIN))
    writeFileSync(join(root, 'current'), '0.1.0-rc.6\n')
    const sidecar = touch(root, join('runtime', 'node', 'node.exe'))
    const location = locateEngine({ env: { LOCALAPPDATA: local, PATH: '' }, fromDir: local, platform: 'win32' })
    expect(location).toEqual({
      node: sidecar,
      nodeArgs: [],
      script: bin,
      cwd: join(root, 'versions', '0.1.0-rc.6'),
      kind: 'managed-dir',
    })
  })

  it('fails when nothing resolvable exists', () => {
    const fromDir = scratch()
    const local = scratch()
    expect(() => locateEngine({
      env: { PATH: '', LOCALAPPDATA: local, USERPROFILE: local, HOME: local },
      fromDir,
      platform: 'win32',
    })).toThrow(/no dsh engine found/)
  })
})

describe('findFreePort', () => {
  it('returns a port that binds', async () => {
    const port = await findFreePort()
    expect(Number.isInteger(port)).toBe(true)
    expect(port).toBeGreaterThan(0)
    await new Promise<void>((resolveBind, rejectBind) => {
      const server = createServer()
      server.once('error', rejectBind)
      server.listen(port, '127.0.0.1', () => { server.close(() => { resolveBind() }) })
    })
  })
})

describe('startEngine', () => {
  it('settles ready from the announcement line and serves HTTP', async () => {
    const engine = await startEngine({ location: fixtureLocation(FAKE_ENGINE), timeoutMs: 15_000 })
    expect(engine.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
    const response = await fetch(engine.url)
    expect(response.status).toBe(200)
    engine.stop()
    await engine.exited
  }, 20_000)

  it('rejects with diagnostics when the engine exits before ready', async () => {
    await expect(startEngine({ location: fixtureLocation(FAKE_EXIT), timeoutMs: 10_000 }))
      .rejects.toThrow(/exited before ready with code 1/)
  }, 15_000)

  it('rejects when the readiness budget expires', async () => {
    await expect(startEngine({ location: fixtureLocation(FAKE_SILENT), timeoutMs: 800 }))
      .rejects.toThrow(/did not become ready/)
  }, 10_000)

  it('retries on EADDRINUSE until the retry budget is spent', async () => {
    const marker = join(scratch(), 'attempts.log')
    await expect(startEngine({
      location: fixtureLocation(FAKE_EADDRINUSE),
      env: { FIXTURE_MARKER: marker },
      timeoutMs: 5_000,
      maxRetries: 3,
    })).rejects.toThrow(/EADDRINUSE/)
    expect(readFileSync(marker, 'utf8').trim().split('\n')).toHaveLength(3)
  }, 15_000)

  it('rejects when the engine node cannot be launched', async () => {
    const location: EngineLocation = {
      node: join(scratch(), 'missing-node.exe'),
      nodeArgs: [],
      script: FAKE_ENGINE,
      cwd: FIXTURES,
      kind: 'env-script',
    }
    await expect(startEngine({ location, timeoutMs: 5_000 })).rejects.toThrow(/cannot launch engine node/)
  }, 10_000)
})
