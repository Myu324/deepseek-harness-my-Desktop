/**
 * Electron entry: a single-instance desktop shell that boots the
 * `dsh --profile web` engine on a loopback port and hosts the Web GUI in a
 * native window. Everything durable (sessions, settings, installed plugins)
 * stays in the engine's Harness home; this process owns the window, the tray,
 * the engine child lifecycle, shell settings, notifications, and the
 * shell-level auto update.
 * @module @deepseek-ai/dsh-desktop/main
 */

import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, Notification, shell, Tray } from 'electron'
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import electronUpdater from 'electron-updater'
import { resolveProfileDir } from '@deepseek-ai/dsh-app-boot'
import {
  locateEngine,
  startEngine,
  type EngineExit,
  type EngineKind,
  type EngineLocation,
  type RunningEngine,
} from './engine-process.ts'
import {
  defaultEngineStoreRoot,
  engineStorePaths,
  ensurePnpmSidecar,
  fallbackVersion,
  readPointer,
  runStoreCommand,
  updateEngine,
  versionEngineLocation,
  type EngineUpdateResult,
} from './engine-store.ts'
import {
  createMarket,
  ensureProfileBuildPolicy,
  parseIgnoredBuilds,
  type MarketOperations,
  type PluginState,
} from './plugin-market.ts'
import { readShellSettings, writeShellSettings, type ShellSettings } from './shell-settings.ts'
import { wireUpdater } from './shell-updater.ts'

// electron-updater is CommonJS; its module.exports is the default export.
const { autoUpdater } = electronUpdater

app.setName('DeepSeek Harness')
app.setAppUserModelId('com.deepseek-ai.harness.desktop')

const userDataDir = app.getPath('userData')
const logDir = join(userDataDir, 'logs')
const settingsPath = join(userDataDir, 'settings.json')

/**
 * Contain one process-level failure (uncaught exception or unhandled promise
 * rejection): write it to the shell log and keep running, instead of showing
 * Electron's generic "A JavaScript error occurred in the main process" dialog.
 * The shell owns a separate engine process, so an error here must never kill
 * the engine; the fatal paths that should end the app raise their own dialogs.
 * @param kind - the failure class, for the log line.
 * @param error - the thrown value.
 */
function reportProcessError(kind: string, error: unknown): void {
  const message = error instanceof Error
    ? `${error.message}\n${error.stack ?? ''}`
    : String(error)
  console.error(`[main] ${kind}:`, error)
  try {
    appendFileSync(join(logDir, 'engine.log'), `${new Date().toISOString()} [main] ${kind}: ${message}\n`)
  } catch {
    // The log sink is broken too; console already carries the failure.
  }
}

process.on('uncaughtException', (error) => { reportProcessError('uncaught exception', error) })
process.on('unhandledRejection', (reason) => { reportProcessError('unhandled rejection', reason) })

/** One-line rendering of a thrown value for log lines. */
function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

let engine: RunningEngine | undefined
let engineLocation: EngineLocation | undefined
let window: BrowserWindow | undefined
let tray: Tray | undefined
let wiredUpdater: ReturnType<typeof wireUpdater> | undefined
let settings: ShellSettings | undefined
let marketWindow: BrowserWindow | undefined
let marketOperations: MarketOperations | undefined
let quitting = false
let restarting = false

/** Human wording for an engine location kind, used in startup diagnostics. */
function describeKind(kind: EngineKind): string {
  switch (kind) {
    case 'env-script': return 'explicit DSH_ENGINE_SCRIPT'
    case 'managed-dir': return 'managed engine directory'
    case 'dev-repo': return 'development repository'
  }
}

/** Append one engine output line to the shell log, keeping console echo for dev. */
function logLine(line: string): void {
  try {
    appendFileSync(join(logDir, 'engine.log'), `${new Date().toISOString()} ${line}\n`)
  } catch {
    // Best-effort logging; a broken log sink must not take the shell down.
  }
  console.log(`[engine] ${line}`)
}

/** A dialog that ends the app after an unrecoverable startup or engine failure. */
function fatal(title: string, message: string): void {
  dialog.showErrorBox(title, message)
  app.exit(1)
}

/** A system notification when supported; silent otherwise. */
function notify(title: string, body: string): void {
  if (!Notification.isSupported()) return
  new Notification({ title, body }).show()
}

/** The shell tray icon, or undefined when the asset is missing. */
function trayImage(): Electron.NativeImage | undefined {
  const image = nativeImage.createFromPath(join(app.getAppPath(), 'build', 'icon.png'))
  return image.isEmpty() ? undefined : image
}

/** Persist shell settings and apply the OS-visible parts. */
async function saveSettings(next: ShellSettings): Promise<void> {
  settings = next
  await writeShellSettings(settingsPath, next)
  if (app.isPackaged) {
    app.setLoginItemSettings({ openAtLogin: next.openAtLogin })
  } else {
    logLine('openAtLogin is stored but only applies to the OS in a packaged install')
  }
}

/** Show the window over the current engine URL, creating it if needed. */
function showWindow(): void {
  if (window === undefined) {
    if (engine === undefined) return
    showEngineWindow(engine.url)
    return
  }
  if (window.isMinimized()) window.restore()
  window.show()
  window.focus()
}

/** Rebuild the tray menu from the current shell state. */
function refreshTrayMenu(): void {
  if (tray === undefined || settings === undefined) return
  const current = settings
  tray.setToolTip(`DeepSeek Harness — ${engine === undefined ? 'engine stopped' : `engine on ${engine.port}`}`)
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Open DeepSeek Harness', click: showWindow },
    {
      label: 'Restart Engine',
      enabled: engine !== undefined && !restarting,
      click: () => { void restartEngine() },
    },
    { type: 'separator' },
    {
      label: 'Launch at login',
      type: 'checkbox',
      checked: current.openAtLogin,
      click: (item) => {
        void saveSettings({ ...current, openAtLogin: item.checked }).catch((error: unknown) => {
          logLine(`saving settings failed: ${describeError(error)}`)
        })
      },
    },
    {
      label: 'Check for Shell Updates',
      click: () => { void wiredUpdater?.check() },
    },
    {
      label: 'Check for Engine Updates',
      click: () => { void checkEngineUpdates() },
    },
    {
      label: 'Plugin Marketplace',
      click: openMarketWindow,
    },
    { type: 'separator' },
    {
      label: 'Quit',
      click: () => {
        quitting = true
        app.quit()
      },
    },
  ]))
}

/** Create the tray with the current state and menu. */
function createTray(): void {
  const image = trayImage()
  if (image === undefined) {
    logLine('tray icon asset missing; running without a tray')
    return
  }
  tray = new Tray(image)
  tray.on('double-click', showWindow)
  refreshTrayMenu()
  logLine('tray ready')
}

/** Create the main window (no content yet; {@link showEngineWindow} or {@link showPreparingWindow} loads it). */
function createWindow(): BrowserWindow {
  const main = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 960,
    minHeight: 640,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#16181d',
    title: 'DeepSeek Harness',
    icon: join(app.getAppPath(), 'build', 'icon.png'),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })
  main.webContents.setWindowOpenHandler(({ url: target }) => {
    if (/^https:\/\//.test(target)) {
      void shell.openExternal(target).catch((error: unknown) => {
        // Opening an external browser can fail (no default handler); the window stays.
        logLine(`opening external URL failed: ${describeError(error)}`)
      })
    }
    return { action: 'deny' }
  })
  main.once('ready-to-show', () => { window?.show() })
  main.webContents.on('did-fail-load', (_event, code, description, validatedUrl) => {
    // The engine died or moved; keep the shell alive and say so in the log.
    logLine(`window load failed (${code} ${description}) for ${validatedUrl}`)
  })
  main.on('close', (event) => {
    if (quitting || settings === undefined || !settings.minimizeToTray) return
    event.preventDefault()
    window?.hide()
  })
  main.on('closed', () => { window = undefined })
  window = main
  return main
}

/** Load the engine URL into the main window, creating it when needed. */
function showEngineWindow(url: string): void {
  const main = window ?? createWindow()
  void main.loadURL(url).catch((error: unknown) => {
    logLine(`window failed to load the engine page: ${describeError(error)}`)
  })
}

/** Load the first-run provisioning page into the main window. */
function showPreparingWindow(): void {
  const main = window ?? createWindow()
  void main.loadFile(join(app.getAppPath(), 'market', 'preparing.html')).catch((error: unknown) => {
    logLine(`window failed to load the preparing page: ${describeError(error)}`)
  })
}

/** Handle the engine process exit after a successful start. */
function handleEngineExit(exit: EngineExit): void {
  logLine(`engine exited with code ${String(exit.code)}`)
  if (quitting) return
  fatal('DeepSeek Harness', `The dsh engine exited unexpectedly (code ${String(exit.code)}).\n\nLogs: ${join(logDir, 'engine.log')}`)
}

/** Stop the current engine and start a fresh one, reloading the window. */
async function restartEngine(): Promise<void> {
  const location = engineLocation
  const previous = engine
  if (restarting || location === undefined || previous === undefined) return
  restarting = true
  refreshTrayMenu()
  logLine('restarting engine')
  engine = undefined
  previous.stop()
  await previous.exited
  try {
    engine = await startEngine({ location, onLine: logLine })
    logLine(`engine restarted at ${engine.url}`)
    void engine.exited.then(handleEngineExit)
    if (window !== undefined) await window.loadURL(engine.url)
    notify('DeepSeek Harness', 'Engine restarted.')
  } catch (error) {
    fatal('DeepSeek Harness', `The dsh engine failed to restart.\n\n${error instanceof Error ? error.message : String(error)}\n\nLogs: ${join(logDir, 'engine.log')}`)
  } finally {
    restarting = false
    refreshTrayMenu()
  }
}

/** The last-good engine location when the current pointer's engine failed. */
async function lastGoodEngineLocation(): Promise<{ current: string | undefined; version: string; location: EngineLocation } | undefined> {
  const root = defaultEngineStoreRoot()
  if (root === undefined) return undefined
  const paths = engineStorePaths(root)
  const current = await readPointer(paths.currentPointer)
  const fallback = await fallbackVersion(paths, current)
  if (fallback === undefined) return undefined
  try {
    return { current, version: fallback, location: versionEngineLocation(paths, join(paths.versionsDir, fallback)) }
  } catch {
    // The fallback's node is unresolvable; the caller reports the original failure.
    return undefined
  }
}

/** Run one engine-store update against the current settings; throws on failure. */
async function provisionEngineStore(): Promise<EngineUpdateResult> {
  if (settings === undefined) throw new Error('settings are not loaded yet')
  const root = defaultEngineStoreRoot()
  if (root === undefined) throw new Error('engine store root unavailable')
  return await updateEngine(engineStorePaths(root), {
    channel: settings.updateChannel,
    registry: settings.registry,
    nodeMirror: settings.nodeMirror,
    onLine: logLine,
  })
}

/** Update the managed engine store to the newest channel version. */
async function checkEngineUpdates(): Promise<void> {
  try {
    const result = await provisionEngineStore()
    if (result.outcome === 'updated') {
      logLine(`engine updated from ${String(result.from)} to ${result.to}; Restart Engine applies it`)
      notify('Engine update ready', `DeepSeek Harness engine ${result.to} installed — restart the engine to apply.`)
    } else if (result.outcome === 'unhealthy') {
      notify('Engine update failed', result.reason)
    }
  } catch (error) {
    logLine(`engine update check failed: ${error instanceof Error ? error.message : String(error)}`)
  }
}

/** The managed engine's package version, or undefined when unknown. */
function enginePackageVersion(versionDir: string): string | undefined {
  try {
    const raw = readFileSync(join(versionDir, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'), 'utf8')
    const manifest = JSON.parse(raw) as { version?: unknown }
    return typeof manifest.version === 'string' ? manifest.version : undefined
  } catch {
    return undefined
  }
}

/** Resolve the marketplace operations, provisioning the pnpm sidecar lazily. */
async function ensureMarket(): Promise<MarketOperations> {
  if (marketOperations !== undefined) return marketOperations
  const current = settings
  if (current === undefined) throw new Error('settings are not loaded yet')
  const root = defaultEngineStoreRoot()
  if (root === undefined) throw new Error('engine store root unavailable')
  const paths = engineStorePaths(root)
  if (!existsSync(paths.nodeExe)) throw new Error('engine store has no node sidecar yet — check for engine updates first')
  const pointer = await readPointer(paths.currentPointer)
  if (pointer === undefined) throw new Error('engine store has no current version')
  const versionDir = join(paths.versionsDir, pointer)
  const engineBin = join(versionDir, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
  if (!existsSync(engineBin)) throw new Error(`engine ${pointer} is not installed`)
  const pnpmBinDir = await ensurePnpmSidecar(paths, current.registry, { onLine: logLine })
  const profileDir = resolveProfileDir('web')
  const runPlugin = async (args: readonly string[]): Promise<number> => {
    logLine(`dsh plugin --profile web ${args.join(' ')}`)
    const env = {
      ...process.env,
      PATH: `${pnpmBinDir}${delimiter}${paths.nodeDir}${delimiter}${process.env.PATH ?? ''}`,
    }
    const lines: string[] = []
    const run = async (pluginArgs: readonly string[]): Promise<number> =>
      await runStoreCommand(paths.nodeExe, [engineBin, 'plugin', '--profile', 'web', ...pluginArgs], {
        env,
        cwd: versionDir,
        onLine: (line) => {
          lines.push(line)
          logLine(line)
        },
      })
    const code = await run(args)
    // pnpm ≥10 blocks unreviewed build scripts; the marketplace carries the
    // reviewed policy (cloudflared allowed, ssh2/cpu-features denied), so the
    // retry runs the same arguments with the policy in place.
    const blocked = parseIgnoredBuilds(lines)
    if (code !== 0 && blocked.length > 0) {
      if (await ensureProfileBuildPolicy(profileDir)) {
        logLine('wrote the reviewed build-script policy into the profile workspace')
      }
      logLine(`retrying install with the reviewed build policy (pnpm blocked: ${blocked.join(', ')})`)
      return await run(args)
    }
    return code
  }
  marketOperations = createMarket({
    profileDir,
    engineVersion: enginePackageVersion(versionDir),
    feedUrl: current.pluginFeedUrl,
    runPlugin,
  })
  return marketOperations
}

/** Open (or focus) the plugin marketplace window. */
function openMarketWindow(): void {
  if (marketWindow !== undefined) {
    marketWindow.show()
    marketWindow.focus()
    return
  }
  marketWindow = new BrowserWindow({
    width: 920,
    height: 680,
    minWidth: 680,
    minHeight: 480,
    title: 'Plugin Marketplace — DeepSeek Harness',
    autoHideMenuBar: true,
    backgroundColor: '#16181d',
    icon: join(app.getAppPath(), 'build', 'icon.png'),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: join(app.getAppPath(), 'market', 'preload.cjs'),
    },
  })
  marketWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//.test(url)) {
      void shell.openExternal(url).catch((error: unknown) => {
        logLine(`opening external URL failed: ${describeError(error)}`)
      })
    }
    return { action: 'deny' }
  })
  marketWindow.on('closed', () => { marketWindow = undefined })
  void marketWindow.loadFile(join(app.getAppPath(), 'market', 'index.html')).catch((error: unknown) => {
    logLine(`marketplace page failed to load: ${describeError(error)}`)
  })
}

// The marketplace IPC surface: every handler validates its argument at the
// wire boundary and surfaces failures to the page through the invoke rejection.
ipcMain.handle('market:list', async (): Promise<{ readonly engineVersion: string | undefined; readonly plugins: PluginState[] }> => (await ensureMarket()).list())
ipcMain.handle('market:install', async (_event, spec: unknown) => {
  if (typeof spec !== 'string' || spec.trim() === '') throw new Error('install needs a package spec')
  await (await ensureMarket()).install(spec)
})
ipcMain.handle('market:uninstall', async (_event, name: unknown) => {
  if (typeof name !== 'string' || name.trim() === '') throw new Error('uninstall needs a package name')
  await (await ensureMarket()).uninstall(name)
})
ipcMain.handle('market:update', async (_event, name: unknown) => {
  if (typeof name !== 'string' || name.trim() === '') throw new Error('update needs a package name')
  await (await ensureMarket()).update(name)
})
ipcMain.handle('market:rollback', async () => (await ensureMarket()).rollback())
ipcMain.handle('market:open-external', (_event, url: unknown) => {
  if (typeof url === 'string' && /^https:\/\//.test(url)) {
    void shell.openExternal(url).catch((error: unknown) => {
      logLine(`opening external URL failed: ${describeError(error)}`)
    })
  }
})

/** Boot the engine and open the window over its URL. */
async function boot(): Promise<void> {
  try {
    mkdirSync(logDir, { recursive: true })
  } catch {
    // Logging is best-effort; continue booting with console echo only.
  }
  settings = await readShellSettings(settingsPath)
  try {
    mkdirSync(userDataDir, { recursive: true })
  } catch {
    // The settings reader already fell back to defaults; a missing home is not fatal.
  }

  let location: EngineLocation | undefined
  try {
    location = locateEngine()
  } catch {
    // First run on a fresh install: no engine exists anywhere. Provision the
    // store (node sidecar + engine install) while the preparing page shows.
    location = undefined
  }
  if (location === undefined) {
    logLine('no engine found; provisioning the engine store on first run')
    showPreparingWindow()
    try {
      await provisionEngineStore()
      location = locateEngine()
    } catch (error) {
      fatal(
        'DeepSeek Harness',
        `Engine provisioning failed.\n\n${error instanceof Error ? error.message : String(error)}\n\nLogs: ${join(logDir, 'engine.log')}`,
      )
      return
    }
    logLine(`engine provisioned: ${location.script}`)
  }
  engineLocation = location
  logLine(`launching engine via ${location.node} ${[...location.nodeArgs, location.script].join(' ')} (${describeKind(location.kind)})`)

  try {
    engine = await startEngine({ location, onLine: logLine })
  } catch (error) {
    const fallback = await lastGoodEngineLocation()
    if (fallback === undefined) {
      fatal(
        'DeepSeek Harness',
        `The dsh engine failed to start.\n\n${error instanceof Error ? error.message : String(error)}\n\nLogs: ${join(logDir, 'engine.log')}`,
      )
      return
    }
    logLine(`engine ${String(fallback.current)} failed to start; falling back to last-good ${fallback.version}`)
    notify('DeepSeek Harness', `Engine ${String(fallback.current)} failed to start — using last-good ${fallback.version}.`)
    try {
      engine = await startEngine({ location: fallback.location, onLine: logLine })
    } catch (fallbackError) {
      fatal(
        'DeepSeek Harness',
        'The dsh engine failed to start, and the last-good fallback also failed.\n\n'
        + `${fallbackError instanceof Error ? fallbackError.message : String(fallbackError)}\n\nLogs: ${join(logDir, 'engine.log')}`,
      )
      return
    }
  }
  logLine(`engine ready at ${engine.url}`)
  void engine.exited.then(handleEngineExit)

  try {
    wiredUpdater = wireUpdater(autoUpdater, {
      log: logLine,
      onAvailable: (version) => { logLine(`shell update available: ${version}`) },
      onDownloaded: (version) => {
        logLine(`shell update ${version} downloaded; it installs on quit`)
        notify('Update ready', `DeepSeek Harness ${version} downloaded — restart the app to install.`)
      },
      onError: (message) => { logLine(`shell update check failed: ${message}`) },
    }, settings.updateChannel)
  } catch (error) {
    // The updater itself is optional chrome; a broken update feed must not
    // stop the shell from serving the engine.
    logLine(`shell updater wiring failed: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (app.isPackaged) {
    // Silent background checks; a packaged shell is the only place feeds exist.
    setTimeout(() => { void wiredUpdater?.check() }, 30_000)
    setTimeout(() => { void checkEngineUpdates() }, 60_000)
  }

  createTray()
  showEngineWindow(engine.url)
}

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', showWindow)
  app.on('window-all-closed', () => { app.quit() })
  app.on('before-quit', () => { quitting = true })
  app.on('will-quit', () => { engine?.stop() })
  void app.whenReady().then(boot).catch((error: unknown) => { reportProcessError('boot failure', error) })
}
