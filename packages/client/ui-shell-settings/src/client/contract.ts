/** The validated shell snapshot the settings section renders. */
import type { ShellSettingsKey } from './locales.ts'

/** Validated shell facts the section renders: locale, login item, engine liveness, and port. */
export interface ShellSnapshot {
  /** The shell UI locale. */
  readonly locale: 'zh' | 'en'
  /** Whether the shell launches at Windows login. */
  readonly openAtLogin: boolean
  /** Whether an engine process is currently running. */
  readonly engineRunning: boolean
  /** The engine's loopback port when running, else 0. */
  readonly port: number
}

/** The settings section's injected face: plain data callbacks over the shell bridge. */
export interface ShellSectionInjected {
  /** Fetch the current shell state. */
  readonly getState: () => Promise<ShellSnapshot>
  /** Persist the shell UI locale. */
  readonly setLocale: (locale: 'zh' | 'en') => Promise<void>
  /** Persist the launch-at-login preference. */
  readonly setLoginItem: (openAtLogin: boolean) => Promise<boolean>
  readonly restartEngine: () => Promise<void>
  readonly checkShellUpdates: () => Promise<void>
  readonly checkEngineUpdates: () => Promise<void>
  readonly openMarket: () => Promise<void>
  readonly quit: () => Promise<void>
  /** The section's bound translator. */
  readonly t: (key: ShellSettingsKey) => string
}

/** Whether a bridge value is a supported shell locale. */
function isShellLocale(value: unknown): value is 'zh' | 'en' {
  return value === 'zh' || value === 'en'
}

/**
 * Validate one raw bridge state response into a snapshot, falling back per
 * field — the preload is a wire edge, never trusted.
 * @param state - the raw bridge response.
 * @returns the validated snapshot.
 */
export function normalizeShellState(state: {
  locale: unknown
  openAtLogin: unknown
  engineRunning: unknown
  port: unknown
}): ShellSnapshot {
  return {
    locale: isShellLocale(state.locale) ? state.locale : 'zh',
    openAtLogin: state.openAtLogin === true,
    engineRunning: state.engineRunning === true,
    port: typeof state.port === 'number' && state.port > 0 ? state.port : 0,
  }
}
