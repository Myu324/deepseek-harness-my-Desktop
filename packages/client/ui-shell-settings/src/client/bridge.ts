/**
 * The window.shell bridge the desktop main window's preload exposes; absent
 * in a plain browser, which is what hides the section outside the desktop
 * client. This is the wire edge between the GUI and the Electron shell —
 * values are validated here, not trusted.
 */

/** What the desktop preload exposes as window.shell. */
export interface ShellBridge {
  /** Current shell state: locale, login item, engine liveness, and port. */
  state(): Promise<{ locale: string; openAtLogin: boolean; engineRunning: boolean; port: number }>
  /** Persist the shell UI locale and return the accepted value. */
  setLocale(locale: string): Promise<string>
  /** Persist the launch-at-login preference and return the accepted value. */
  setLoginItem(openAtLogin: boolean): Promise<boolean>
  restartEngine(): Promise<void>
  checkShellUpdates(): Promise<void>
  checkEngineUpdates(): Promise<void>
  openMarket(): Promise<void>
  quit(): Promise<void>
}

declare global {
  interface Window {
    /** Present only when the page runs inside the desktop client's main window. */
    shell?: ShellBridge
  }
}

/**
 * Read the bridge the desktop preload exposes.
 * @returns the bridge when the page runs inside the desktop client's main
 *   window; undefined in a plain browser or a windowless environment.
 */
export function readShellBridge(): ShellBridge | undefined {
  return typeof window === 'undefined' ? undefined : window.shell
}
