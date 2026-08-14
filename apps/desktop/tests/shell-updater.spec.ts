/**
 * Shell updater wiring against a fake updater surface: channel selection,
 * event mapping, and check-failure containment.
 * @module @deepseek-ai/dsh-desktop/tests/shell-updater
 */

import { describe, expect, it } from 'vitest'
import { wireUpdater, type UpdaterHooks, type UpdaterLike } from '../src/shell-updater.ts'
import type { UpdateInfo } from 'electron-updater'

/** A fake updater surface: records listeners, check results, and install calls. */
function fakeUpdater(): {
  updater: UpdaterLike
  listeners: Map<string, (payload: unknown) => void>
  state: { checkError: Error | undefined; checkCalls: number; installCalls: number }
} {
  const listeners = new Map<string, (payload: unknown) => void>()
  const state = { checkError: undefined as Error | undefined, checkCalls: 0, installCalls: 0 }
  const updater: UpdaterLike = {
    channel: null,
    on(event, listener) {
      listeners.set(event, listener as (payload: unknown) => void)
      return {}
    },
    async checkForUpdates() {
      state.checkCalls += 1
      if (state.checkError !== undefined) throw state.checkError
    },
    quitAndInstall() { state.installCalls += 1 },
  }
  return { updater, listeners, state }
}

/** A hooks recorder asserting the shell reactions were invoked once each. */
function fakeHooks(): { hooks: UpdaterHooks; available: string[]; downloaded: string[]; errors: string[] } {
  const available: string[] = []
  const downloaded: string[] = []
  const errors: string[] = []
  return {
    hooks: {
      log: () => {},
      onAvailable: (version) => { available.push(version) },
      onDownloaded: (version) => { downloaded.push(version) },
      onError: (message) => { errors.push(message) },
    },
    available, downloaded, errors,
  }
}

/** A minimal UpdateInfo carrying only the version the wiring reads. */
function updateInfo(version: string): UpdateInfo {
  return { version } as UpdateInfo
}

describe('wireUpdater', () => {
  it('sets the channel from the shell settings', () => {
    const { updater } = fakeUpdater()
    wireUpdater(updater, fakeHooks().hooks, 'beta')
    expect(updater.channel).toBe('beta')
  })

  it('maps update-available and update-downloaded to shell hooks', () => {
    const { updater, listeners } = fakeUpdater()
    const recorded = fakeHooks()
    wireUpdater(updater, recorded.hooks, 'stable')
    listeners.get('update-available')?.(updateInfo('9.1.0'))
    listeners.get('update-downloaded')?.(updateInfo('9.1.0'))
    expect(recorded.available).toEqual(['9.1.0'])
    expect(recorded.downloaded).toEqual(['9.1.0'])
  })

  it('maps updater errors to the error hook', () => {
    const { updater, listeners } = fakeUpdater()
    const recorded = fakeHooks()
    wireUpdater(updater, recorded.hooks, 'stable')
    listeners.get('error')?.(new Error('network down'))
    expect(recorded.errors).toEqual(['network down'])
  })

  it('reports a rejected check through the error hook', async () => {
    const fake = fakeUpdater()
    const recorded = fakeHooks()
    const wired = wireUpdater(fake.updater, recorded.hooks, 'stable')
    fake.state.checkError = new Error('not packaged')
    await wired.check()
    expect(recorded.errors).toEqual(['not packaged'])
  })

  it('stays silent on a successful check', async () => {
    const fake = fakeUpdater()
    const recorded = fakeHooks()
    const wired = wireUpdater(fake.updater, recorded.hooks, 'stable')
    await wired.check()
    expect(fake.state.checkCalls).toBe(1)
    expect(recorded.errors).toEqual([])
  })

  it('installs through the updater surface', () => {
    const fake = fakeUpdater()
    const wired = wireUpdater(fake.updater, fakeHooks().hooks, 'stable')
    wired.installNow()
    expect(fake.state.installCalls).toBe(1)
  })
})
