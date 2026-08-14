/**
 * Shell snapshot normalization: every bridge field falls back safely.
 * @module @deepseek-ai/dsh-client-ui-shell-settings/tests/contract
 */

import { describe, expect, it } from 'vitest'
import { normalizeShellState } from '../src/client/contract.ts'

describe('normalizeShellState', () => {
  it('passes a valid response through', () => {
    expect(normalizeShellState({ locale: 'en', openAtLogin: true, engineRunning: true, port: 6123 }))
      .toEqual({ locale: 'en', openAtLogin: true, engineRunning: true, port: 6123 })
  })

  it('falls back per field on malformed values', () => {
    expect(normalizeShellState({
      locale: 'fr',
      openAtLogin: 'yes',
      engineRunning: 1,
      port: -1,
    })).toEqual({ locale: 'zh', openAtLogin: false, engineRunning: false, port: 0 })
    expect(normalizeShellState({
      locale: 'zh',
      openAtLogin: false,
      engineRunning: false,
      port: Number.NaN,
    })).toEqual({ locale: 'zh', openAtLogin: false, engineRunning: false, port: 0 })
  })
})
