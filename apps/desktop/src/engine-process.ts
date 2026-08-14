/**
 * Engine discovery, spawn, and readiness handshake for the desktop shell.
 * The desktop shell hosts the `dsh --profile web` engine as a child process:
 * locate it (an explicit override, the managed engine directory, or the
 * development repository), spawn it on a loopback port, and resolve the
 * served URL from the engine's `dsh web:` announcement line — falling back
 * to an HTTP probe of the chosen port. Everything in this module is plain
 * Node so the handshake is testable without Electron.
 * @module @deepseek-ai/dsh-desktop/engine-process
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { readFileSync, statSync } from 'node:fs'
import { createServer } from 'node:net'
import { delimiter, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** The engine entry script inside an installed `@deepseek-ai/dsh` package. */
const ENGINE_PACKAGE_BIN = join('node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')

/** How the engine was found, for startup diagnostics. */
export type EngineKind = 'env-script' | 'managed-dir' | 'dev-repo'

/** A resolved engine: the exact node binary, entry script, and launch context. */
export interface EngineLocation {
  /** Absolute path to the node executable that runs the engine. */
  readonly node: string
  /** Node CLI arguments placed before the script (`--import tsx/esm` in dev). */
  readonly nodeArgs: readonly string[]
  /** Absolute path to the engine entry script. */
  readonly script: string
  /** Spawn working directory. */
  readonly cwd: string
  /** How the location was resolved. */
  readonly kind: EngineKind
}

/** Inputs to engine discovery; defaults read the live process. */
export interface LocateEngineOptions {
  /** Environment to resolve overrides and PATH against (defaults to the process env). */
  readonly env?: NodeJS.ProcessEnv
  /** Directory the dev-repo walk starts from (defaults to this module's directory). */
  readonly fromDir?: string
  /** Platform that decides sidecar and PATH-extension names (defaults to the live platform). */
  readonly platform?: NodeJS.Platform
}

/** Whether a path exists and is a regular file. */
function isFile(path: string): boolean {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

/**
 * Resolve an executable name against PATH (and PATHEXT on Windows).
 * @param name - the executable name, without a path.
 * @param env - environment carrying PATH (and PATHEXT on Windows).
 * @param platform - the platform whose extension rules apply.
 * @returns the absolute path of the first existing candidate.
 */
export function resolveExecutable(
  name: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string {
  const pathValue = env.PATH ?? env.Path ?? ''
  const extensions = platform === 'win32'
    ? (env.PATHEXT ?? '.EXE;.CMD;.BAT;.COM').split(';').filter(extension => extension !== '')
    : []
  const entries = pathValue.split(delimiter).filter(entry => entry !== '')
  const candidates = [name, ...extensions.map(extension => `${name}${extension.toLowerCase()}`)]
  for (const entry of entries) {
    for (const candidate of candidates) {
      const candidatePath = resolve(entry, candidate)
      if (isFile(candidatePath)) return candidatePath
    }
  }
  throw new Error(`cannot find ${name} on PATH (searched ${entries.length} directories)`)
}

/**
 * The managed engine store root the desktop shell resolves by default.
 * @param env - environment carrying the home/base directory variables.
 * @param platform - the platform whose layout applies.
 * @returns the store root, or undefined when its base is unavailable.
 */
function defaultEngineRoot(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string | undefined {
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
 * The bundled node sidecar path inside a managed engine directory.
 * @param dir - the managed engine directory.
 * @param platform - the platform whose layout applies.
 * @returns the candidate sidecar path.
 */
function sidecarNode(dir: string, platform: NodeJS.Platform): string {
  return platform === 'win32'
    ? join(dir, 'runtime', 'node', 'node.exe')
    : join(dir, 'runtime', 'node', 'bin', 'node')
}

/**
 * A managed engine directory's location: its bundled sidecar node wins, then
 * an explicit `DSH_ENGINE_NODE`, then PATH. The fallback is lazy so a present
 * sidecar never pays the PATH walk.
 * @param dir - the managed engine directory (its bin already verified present).
 * @param fallbackNode - resolves the node binary to use when no sidecar exists.
 * @param platform - the platform whose sidecar layout applies.
 * @returns the resolved location.
 */
function managedLocation(dir: string, fallbackNode: () => string, platform: NodeJS.Platform): EngineLocation {
  const sidecar = sidecarNode(dir, platform)
  return {
    node: isFile(sidecar) ? sidecar : fallbackNode(),
    nodeArgs: [],
    script: join(dir, ENGINE_PACKAGE_BIN),
    cwd: dir,
    kind: 'managed-dir',
  }
}

/**
 * Walk up from a directory looking for the development repository marker
 * (`apps/cli/src/bin.ts`) and resolve the source-launch engine.
 * @param fromDir - the directory the walk starts from.
 * @param env - environment for the node override and PATH.
 * @param platform - the platform whose PATH rules apply.
 * @returns the dev-repo location, or undefined when no marker is found.
 */
function devRepoLocation(fromDir: string, env: NodeJS.ProcessEnv, platform: NodeJS.Platform): EngineLocation | undefined {
  const node = (): string => {
    const override = env.DSH_ENGINE_NODE
    return override !== undefined && override !== '' ? resolve(override) : resolveExecutable('node', env, platform)
  }
  let current = resolve(fromDir)
  for (let depth = 0; depth < 8; depth += 1) {
    const script = join(current, 'apps', 'cli', 'src', 'bin.ts')
    if (isFile(script)) {
      return { node: node(), nodeArgs: ['--import', 'tsx/esm'], script, cwd: current, kind: 'dev-repo' }
    }
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }
  return undefined
}

/**
 * Locate the engine, in order: `DSH_ENGINE_SCRIPT` (explicit entry),
 * `DSH_ENGINE_DIR` (explicit managed directory, which fails loudly when its
 * bin is missing), the default managed engine directory, then the
 * development repository the shell is running inside.
 * @param options - environment, walk origin, and platform overrides.
 * @returns the resolved engine location.
 */
export function locateEngine(options: LocateEngineOptions = {}): EngineLocation {
  const env = options.env ?? process.env
  const platform = options.platform ?? process.platform
  const fallbackNode = (): string => {
    const override = env.DSH_ENGINE_NODE
    return override !== undefined && override !== '' ? resolve(override) : resolveExecutable('node', env, platform)
  }
  const scriptOverride = env.DSH_ENGINE_SCRIPT
  if (scriptOverride !== undefined && scriptOverride !== '') {
    const script = resolve(scriptOverride)
    return { node: fallbackNode(), nodeArgs: [], script, cwd: dirname(script), kind: 'env-script' }
  }
  const explicitDir = env.DSH_ENGINE_DIR
  if (explicitDir !== undefined && explicitDir !== '') {
    const dir = resolve(explicitDir)
    const script = join(dir, ENGINE_PACKAGE_BIN)
    if (!isFile(script)) {
      throw new Error(`DSH_ENGINE_DIR ${dir} does not contain the engine at ${ENGINE_PACKAGE_BIN}`)
    }
    return managedLocation(dir, fallbackNode, platform)
  }
  const defaultRoot = defaultEngineRoot(env, platform)
  if (defaultRoot !== undefined) {
    // The store's `current` pointer names the version directory to boot; the
    // portable node sidecar lives at the store root, not inside the version.
    let pointerVersion: string | undefined
    try {
      const content = readFileSync(join(defaultRoot, 'current'), 'utf8').trim()
      if (content !== '') pointerVersion = content
    } catch {
      // No pointer yet — the store is fresh.
    }
    if (pointerVersion !== undefined) {
      const versionDir = join(defaultRoot, 'versions', pointerVersion)
      if (isFile(join(versionDir, ENGINE_PACKAGE_BIN))) {
        const sidecar = sidecarNode(defaultRoot, platform)
        return {
          node: isFile(sidecar) ? sidecar : fallbackNode(),
          nodeArgs: [],
          script: join(versionDir, ENGINE_PACKAGE_BIN),
          cwd: versionDir,
          kind: 'managed-dir',
        }
      }
    }
    // Legacy single-dir layout: before the version store, the default pointed
    // straight at `<root>/current` and kept the sidecar inside it.
    if (isFile(join(defaultRoot, 'current', ENGINE_PACKAGE_BIN))) {
      return managedLocation(join(defaultRoot, 'current'), fallbackNode, platform)
    }
  }
  const dev = devRepoLocation(options.fromDir ?? dirname(fileURLToPath(import.meta.url)), env, platform)
  if (dev !== undefined) return dev
  throw new Error(
    'no dsh engine found: set DSH_ENGINE_DIR to an engine install (a directory containing '
    + `${ENGINE_PACKAGE_BIN}), or run from inside the deepseek-harness repository so its `
    + 'development engine (apps/cli/src/bin.ts) is used',
  )
}

/**
 * Pick a port the OS currently leaves free on the loopback interface.
 * @param host - the bind host, always a loopback address in the desktop shell.
 * @returns a promise of the free port.
 */
export function findFreePort(host = '127.0.0.1'): Promise<number> {
  return new Promise((resolvePort, rejectPort) => {
    const probe = createServer()
    probe.once('error', rejectPort)
    probe.listen(0, host, () => {
      const address = probe.address()
      probe.close((error) => {
        if (error !== undefined) {
          rejectPort(error)
        } else if (address === null || typeof address === 'string') {
          rejectPort(new Error('port probe did not report a TCP address'))
        } else {
          resolvePort(address.port)
        }
      })
    })
  })
}

/**
 * Parse the engine's `dsh web:` announcement line.
 * @param line - one engine stdout line.
 * @returns the served URL, or undefined when the line is not an announcement.
 */
export function parseWebUrl(line: string): string | undefined {
  const trimmed = line.trim()
  const prefix = 'dsh web: '
  if (!trimmed.startsWith(prefix)) return undefined
  const rest = trimmed.slice(prefix.length)
  const match = /^(https?:\/\/\S+?)(?:\s*\(LAN:.*\))?$/.exec(rest)
  return match?.[1]
}

/** How the engine process settled, for shell-side diagnostics. */
export interface EngineExit {
  /** Exit code, or null when the process was terminated by the shell. */
  readonly code: number | null
}

/** A running engine: the served URL plus process control. */
export interface RunningEngine {
  /** The loopback URL the engine serves. */
  readonly url: string
  /** The loopback port the engine listens on. */
  readonly port: number
  /** Terminate the engine process. */
  stop(): void
  /** Settles when the engine process exits. */
  readonly exited: Promise<EngineExit>
}

/** Inputs to one engine launch. */
export interface StartEngineOptions {
  /** Resolved engine launch context. */
  readonly location: EngineLocation
  /** Environment for the engine process (defaults to the shell's). */
  readonly env?: NodeJS.ProcessEnv
  /** Loopback port to bind; defaults to a fresh free port. */
  readonly port?: number
  /** Readiness budget per attempt; defaults to 120 seconds. */
  readonly timeoutMs?: number
  /** How many fresh-port attempts an EADDRINUSE exit allows; defaults to 3. */
  readonly maxRetries?: number
  /** Sink for engine output lines (both streams). */
  readonly onLine?: (line: string) => void
}

/** A spawn attempt's settlement before readiness. */
type AttemptResult =
  | { readonly outcome: 'ready'; readonly engine: RunningEngine }
  | { readonly outcome: 'spawn-error' | 'exit' | 'timeout'; readonly error: Error; readonly portInUse: boolean }

const DEFAULT_READY_TIMEOUT_MS = 120_000
const DEFAULT_PORT_RETRIES = 3
const PROBE_INTERVAL_MS = 250
const OUTPUT_TAIL_CHARS = 2000

/**
 * The output tail that accompanies a startup failure, so diagnostics survive
 * the shell's own logs.
 * @param stdoutText - accumulated engine stdout.
 * @param stderrText - accumulated engine stderr.
 * @returns the combined tail, prefixed for the error message.
 */
function outputTail(stdoutText: string, stderrText: string): string {
  const combined = `${stdoutText}${stderrText}`.trim()
  const tail = combined.length > OUTPUT_TAIL_CHARS ? combined.slice(-OUTPUT_TAIL_CHARS) : combined
  return tail === '' ? '' : ` Output tail:\n${tail}`
}

/**
 * Feed a chunked stream through a line splitter.
 * @param onLine - consumer of complete lines.
 * @returns a chunk sink that buffers partial lines.
 */
function makeLineFeed(onLine: (line: string) => void): (chunk: Buffer) => void {
  let buffer = ''
  return (chunk: Buffer): void => {
    buffer += chunk.toString('utf8')
    let newline = buffer.indexOf('\n')
    while (newline >= 0) {
      onLine(buffer.slice(0, newline).replace(/\r$/, ''))
      buffer = buffer.slice(newline + 1)
      newline = buffer.indexOf('\n')
    }
  }
}

/**
 * Spawn one engine attempt and settle it when it announces its URL, answers
 * an HTTP probe, exits early, or exceeds the readiness budget.
 * @param input - the attempt's launch context, port, budget, and line sink.
 * @returns the settlement.
 */
function runAttempt(input: {
  readonly location: EngineLocation
  readonly env: NodeJS.ProcessEnv
  readonly port: number
  readonly timeoutMs: number
  readonly onLine: (line: string) => void
}): Promise<AttemptResult> {
  return new Promise((resolveAttempt) => {
    const args = [
      ...input.location.nodeArgs,
      input.location.script,
      '--profile', 'web',
      '--host', '127.0.0.1',
      '--port', String(input.port),
    ]
    let child: ChildProcess
    try {
      child = spawn(input.location.node, args, {
        cwd: input.location.cwd,
        env: input.env,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      })
    } catch (error) {
      resolveAttempt({
        outcome: 'spawn-error',
        error: new Error(`cannot launch engine node ${input.location.node}: ${error instanceof Error ? error.message : String(error)}`),
        portInUse: false,
      })
      return
    }
    let settled = false
    let stdoutText = ''
    let stderrText = ''
    const feedStdout = makeLineFeed((line) => {
      stdoutText += `${line}\n`
      input.onLine(line)
      const url = parseWebUrl(line)
      if (url !== undefined && !settled) settleReady(url)
    })
    const feedStderr = makeLineFeed((line) => {
      stderrText += `${line}\n`
      input.onLine(`[stderr] ${line}`)
    })
    const probeUrl = `http://127.0.0.1:${input.port}/`
    const probeTimer = setInterval(() => {
      if (settled) return
      fetch(probeUrl, { signal: AbortSignal.timeout(PROBE_INTERVAL_MS * 8) })
        .then(() => { if (!settled) settleReady(probeUrl) })
        .catch(() => {}) // not listening yet; the interval keeps probing
    }, PROBE_INTERVAL_MS)
    const deadline = setTimeout(() => {
      if (settled) return
      settled = true
      clearInterval(probeTimer)
      child.kill()
      resolveAttempt({
        outcome: 'timeout',
        error: new Error(`engine did not become ready within ${input.timeoutMs}ms on ${probeUrl}.${outputTail(stdoutText, stderrText)}`),
        portInUse: false,
      })
    }, input.timeoutMs)
    const exited = new Promise<EngineExit>((resolveExit) => {
      child.once('exit', (code) => { resolveExit({ code }) })
    })
    child.stdout?.on('data', (chunk: Buffer) => { feedStdout(chunk) })
    child.stderr?.on('data', (chunk: Buffer) => { feedStderr(chunk) })
    child.once('error', (error) => {
      if (settled) return
      settled = true
      clearInterval(probeTimer)
      clearTimeout(deadline)
      resolveAttempt({
        outcome: 'spawn-error',
        error: new Error(`cannot launch engine node ${input.location.node}: ${error.message}`),
        portInUse: false,
      })
    })
    child.once('exit', (code) => {
      if (settled) return
      settled = true
      clearInterval(probeTimer)
      clearTimeout(deadline)
      resolveAttempt({
        outcome: 'exit',
        error: new Error(`engine exited before ready with code ${String(code)}.${outputTail(stdoutText, stderrText)}`),
        portInUse: stdoutText.includes('EADDRINUSE') || stderrText.includes('EADDRINUSE'),
      })
    })
    function settleReady(url: string): void {
      settled = true
      clearInterval(probeTimer)
      clearTimeout(deadline)
      resolveAttempt({
        outcome: 'ready',
        engine: {
          url,
          port: input.port,
          stop() { child.kill() },
          exited,
        },
      })
    }
  })
}

/**
 * Launch the engine, retrying once on a port that was taken between the
 * shell's probe and the engine's bind.
 * @param options - launch context, port, budgets, and line sink.
 * @returns a promise of the running engine.
 */
export async function startEngine(options: StartEngineOptions): Promise<RunningEngine> {
  const env = options.env ?? process.env
  const timeoutMs = options.timeoutMs ?? DEFAULT_READY_TIMEOUT_MS
  const maxRetries = options.maxRetries ?? DEFAULT_PORT_RETRIES
  const onLine = options.onLine ?? (() => {})
  let port = options.port ?? await findFreePort()
  for (let attempt = 1; ; attempt += 1) {
    const result = await runAttempt({ location: options.location, env, port, timeoutMs, onLine })
    if (result.outcome === 'ready') return result.engine
    if (result.outcome === 'exit' && result.portInUse && attempt < maxRetries) {
      onLine(`[desktop] port ${port} was taken by another process; retrying with a fresh port`)
      port = await findFreePort()
      continue
    }
    throw result.error
  }
}
