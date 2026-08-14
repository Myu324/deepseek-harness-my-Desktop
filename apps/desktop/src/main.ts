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
import { SHELL_LOCALES, shellT, type ShellMessageKey, type ShellLocale } from './shell-i18n.ts'
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

/** The shell UI locale, synced from settings at boot and on every save. */
let locale: ShellLocale = 'zh'

/** Render one shell message in the current locale. */
function t(key: ShellMessageKey, params: Readonly<Record<string, string>> = {}): string {
  return shellT(locale, key, params)
}

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

/** The log-path line every fatal dialog appends. */
function logsSuffix(): string {
  return t('dialog.logsAt', { path: join(logDir, 'engine.log') })
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
  locale = next.locale
  await writeShellSettings(settingsPath, next)
  if (app.isPackaged) {
    app.setLoginItemSettings({ openAtLogin: next.openAtLogin })
  } else {
    logLine('openAtLogin is stored but only applies to the OS in a packaged install')
  }
  refreshTrayMenu()
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
  tray.setToolTip(engine === undefined
    ? `DeepSeek Harness — ${t('tray.engineStopped')}`
    : `DeepSeek Harness — ${t('tray.engineOn', { port: String(engine.port) })}`)
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: t('menu.open'), click: showWindow },
    {
      label: t('menu.restartEngine'),
      enabled: engine !== undefined && !restarting,
      click: () => { void restartEngine() },
    },
    { type: 'separator' },
    {
      label: t('menu.launchAtLogin'),
      type: 'checkbox',
      checked: current.openAtLogin,
      click: (item) => {
        void saveSettings({ ...current, openAtLogin: item.checked }).catch((error: unknown) => {
          logLine(`saving settings failed: ${describeError(error)}`)
        })
      },
    },
    {
      label: t('menu.language'),
      submenu: SHELL_LOCALES.map(option => ({
        label: option === 'zh' ? '中文' : 'English',
        type: 'radio' as const,
        checked: current.locale === option,
        click: () => {
          void saveSettings({ ...current, locale: option }).catch((error: unknown) => {
            logLine(`saving settings failed: ${describeError(error)}`)
          })
        },
      })),
    },
    {
      label: t('menu.checkShellUpdates'),
      click: () => { void wiredUpdater?.check() },
    },
    {
      label: t('menu.checkEngineUpdates'),
      click: () => { void checkEngineUpdates() },
    },
    {
      label: t('menu.marketplace'),
      click: openMarketWindow,
    },
    { type: 'separator' },
    {
      label: t('menu.quit'),
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
      preload: join(app.getAppPath(), 'market', 'main-preload.cjs'),
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
  fatal('DeepSeek Harness', `${t('dialog.engineUnexpectedExit', { code: String(exit.code) })}\n\n${logsSuffix()}`)
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
    notify('DeepSeek Harness', t('notify.engineRestartedBody'))
  } catch (error) {
    fatal('DeepSeek Harness', `${t('dialog.restartFailed')}\n\n${error instanceof Error ? error.message : String(error)}\n\n${logsSuffix()}`)
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
      notify(t('notify.engineUpdateReady'), t('notify.engineUpdateReadyBody', { version: result.to }))
    } else if (result.outcome === 'unhealthy') {
      notify(t('notify.engineUpdateFailed'), result.reason)
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
  const emitMarketLine = (line: string): void => {
    if (marketWindow !== undefined && !marketWindow.isDestroyed()) {
      marketWindow.webContents.send('market:command-output', line)
    }
  }
  const runPlugin = async (args: readonly string[]): Promise<number> => {
    logLine(`dsh plugin --profile web ${args.join(' ')}`)
    emitMarketLine(`$ dsh plugin --profile web ${args.join(' ')}`)
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
          emitMarketLine(line)
        },
      })
    const code = await run(args)
    // pnpm ≥10 blocks unreviewed build scripts; the marketplace carries the
    // reviewed policy (cloudflared allowed, ssh2/cpu-features denied, the
    // user-consented rest allowed), so the retry runs the same arguments.
    const blocked = parseIgnoredBuilds(lines)
    if (code !== 0 && blocked.length > 0) {
      if (await ensureProfileBuildPolicy(profileDir)) {
        logLine('wrote the reviewed build-script policy into the profile workspace')
        emitMarketLine('• build-script policy written; retrying')
      }
      logLine(`retrying install with the reviewed build policy (pnpm blocked: ${blocked.join(', ')})`)
      return await run(args)
    }
    return code
  }
  marketOperations = createMarket({
    profileDir,
    engineVersion: enginePackageVersion(versionDir),
    feedPath: join(app.getAppPath(), 'plugin-feed.json'),
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
    width: 1080,
    height: 760,
    minWidth: 760,
    minHeight: 560,
    title: 'Plugin Marketplace — DeepSeek Harness',
    autoHideMenuBar: true,
    backgroundColor: '#16181d',
    icon: join(app.getAppPath(), 'build', 'icon.png'),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: true,
      preload: join(app.getAppPath(), 'market', 'preload.cjs'),
    },
  })
  marketWindow.on('closed', () => { marketWindow = undefined })
  void marketWindow.loadFile(join(app.getAppPath(), 'market', 'index.html')).catch((error: unknown) => {
    logLine(`marketplace page failed to load: ${describeError(error)}`)
  })
}

// The shell overlay IPC surface for the main window's bottom-left settings.
ipcMain.handle('shell:state', () => ({
  locale,
  openAtLogin: settings?.openAtLogin ?? false,
  engineRunning: engine !== undefined,
  port: engine?.port ?? 0,
}))
ipcMain.handle('shell:set-locale', async (_event, next: unknown) => {
  if (next !== 'zh' && next !== 'en') throw new Error('locale must be zh or en')
  if (settings === undefined) throw new Error('settings are not loaded yet')
  await saveSettings({ ...settings, locale: next })
  return locale
})
ipcMain.handle('shell:set-login-item', async (_event, value: unknown) => {
  if (typeof value !== 'boolean') throw new Error('openAtLogin must be a boolean')
  if (settings === undefined) throw new Error('settings are not loaded yet')
  await saveSettings({ ...settings, openAtLogin: value })
  return value
})
ipcMain.handle('shell:restart-engine', () => { void restartEngine() })
ipcMain.handle('shell:check-shell-updates', () => { void wiredUpdater?.check() })
ipcMain.handle('shell:check-engine-updates', () => { void checkEngineUpdates() })
ipcMain.handle('shell:open-market', () => { openMarketWindow() })
ipcMain.handle('shell:quit', () => {
  quitting = true
  app.quit()
})

// The marketplace IPC surface: every handler validates its argument at the
// wire boundary and surfaces failures to the page through the invoke rejection.
ipcMain.handle('market:init', async (): Promise<{ readonly locale: ShellLocale; readonly communityPageUrl: string; readonly engineVersion: string | undefined; readonly plugins: PluginState[] }> => {
  const listing = await (await ensureMarket()).list()
  return { locale, communityPageUrl: settings?.communityPageUrl ?? 'https://github.com/topics/dsh-plugin', ...listing }
})
ipcMain.handle('market:set-locale', async (_event, next: unknown) => {
  if (next !== 'zh' && next !== 'en') throw new Error('locale must be zh or en')
  if (settings === undefined) throw new Error('settings are not loaded yet')
  await saveSettings({ ...settings, locale: next })
  return locale
})
ipcMain.handle('market:run-command', async (_event, command: unknown) => {
  if (typeof command !== 'string' || command.trim() === '') throw new Error('command must be a non-empty string')
  return await (await ensureMarket()).runCommand(command)
})
ipcMain.handle('market:restart-app', () => {
  quitting = true
  engine?.stop()
  app.relaunch()
  app.exit(0)
})

/** Boot the engine and open the window over its URL. */
async function boot(): Promise<void> {
  try {
    mkdirSync(logDir, { recursive: true })
  } catch {
    // Logging is best-effort; continue booting with console echo only.
  }
  settings = await readShellSettings(settingsPath)
  locale = settings.locale
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
        `${t('dialog.provisioningFailed')}\n\n${error instanceof Error ? error.message : String(error)}\n\n${logsSuffix()}`,
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
        `${t('dialog.engineStartFailed')}\n\n${error instanceof Error ? error.message : String(error)}\n\n${logsSuffix()}`,
      )
      return
    }
    logLine(`engine ${String(fallback.current)} failed to start; falling back to last-good ${fallback.version}`)
    notify(t('notify.engineFallback'), t('notify.engineFallbackBody', { current: String(fallback.current), version: fallback.version }))
    try {
      engine = await startEngine({ location: fallback.location, onLine: logLine })
    } catch (fallbackError) {
      fatal(
        'DeepSeek Harness',
        `${t('dialog.engineFallbackFailed')}\n\n`
        + `${fallbackError instanceof Error ? fallbackError.message : String(fallbackError)}\n\n${logsSuffix()}`,
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
        notify(t('notify.updateReady'), t('notify.updateReadyBody', { version }))
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
