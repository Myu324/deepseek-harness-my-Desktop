/**
 * Shell auto-update wiring over electron-updater. The wrapper owns only the
 * event → shell-hook mapping and the channel selection; the injected updater
 * surface makes the wiring unit-testable without a real update feed. The
 * shell checks for updates only in packaged installs, downloads silently, and
 * installs on app quit.
 * @module @deepseek-ai/dsh-desktop/shell-updater
 */

import type { UpdateInfo } from 'electron-updater'

/** Shell-side reactions the wiring reports to. */
export interface UpdaterHooks {
  /** Shell log sink. */
  log(line: string): void
  /** An update was found and its download has started. */
  onAvailable(version: string): void
  /** An update finished downloading and installs on the next quit. */
  onDownloaded(version: string): void
  /** An update flow failed; the shell keeps the current version. */
  onError(message: string): void
}

/** The electron-updater surface this wiring needs; injectable for tests. */
export interface UpdaterLike {
  /** The release channel tag (`stable`/`beta`), readable and writable. */
  channel: string | null
  on(event: 'update-available' | 'update-downloaded', listener: (info: UpdateInfo) => void): unknown
  on(event: 'error', listener: (error: Error) => void): unknown
  checkForUpdates(): Promise<unknown>
  quitAndInstall(): void
}

/** The wired updater surface the shell uses. */
export interface WiredUpdater {
  /** Trigger one update check; failures land on {@link UpdaterHooks.onError}. */
  check(): Promise<void>
  /** Install the downloaded update now (quits and restarts the shell). */
  installNow(): void
}

/**
 * Bind the updater to shell hooks and the engine update channel.
 * @param updater - the electron-updater surface.
 * @param hooks - shell reactions to update events.
 * @param channel - the release channel tag.
 * @returns the check/install surface.
 */
export function wireUpdater(updater: UpdaterLike, hooks: UpdaterHooks, channel: 'stable' | 'beta'): WiredUpdater {
  updater.channel = channel
  updater.on('update-available', (info) => { hooks.onAvailable(info.version) })
  updater.on('update-downloaded', (info) => { hooks.onDownloaded(info.version) })
  updater.on('error', (error) => { hooks.onError(error.message) })
  return {
    async check(): Promise<void> {
      try {
        await updater.checkForUpdates()
      } catch (error) {
        hooks.onError(error instanceof Error ? error.message : String(error))
      }
    },
    installNow(): void {
      updater.quitAndInstall()
    },
  }
}
