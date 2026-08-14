/**
 * Shell i18n catalog: locale parity, placeholder parity, and interpolation.
 * @module @deepseek-ai/dsh-desktop/tests/shell-i18n
 */

import { describe, expect, it } from 'vitest'
import { isShellLocale, SHELL_LOCALES, SHELL_MESSAGE_KEYS, shellT } from '../src/shell-i18n.ts'

/** Every placeholder name a message template uses. */
function placeholders(template: string): Set<string> {
  return new Set(
    [...template.matchAll(/\{(\w+)\}/g)]
      .map(match => match[1])
      .filter((name): name is string => name !== undefined),
  )
}

describe('shellT', () => {
  it('renders both locales for a known key', () => {
    expect(shellT('zh', 'menu.open')).toBe('打开 DeepSeek Harness')
    expect(shellT('en', 'menu.open')).toBe('Open DeepSeek Harness')
  })

  it('substitutes placeholders and keeps unknown ones verbatim', () => {
    expect(shellT('zh', 'tray.engineOn', { port: '6123' })).toBe('引擎运行中（端口 6123）')
    expect(shellT('en', 'dialog.engineUnexpectedExit', { code: '1' }))
      .toBe('The dsh engine exited unexpectedly (code 1).')
    expect(shellT('zh', 'dialog.engineUnexpectedExit')).toContain('{code}')
  })

  it('exports exactly the two supported locales', () => {
    expect(SHELL_LOCALES).toEqual(['zh', 'en'])
  })

  it('accepts only zh and en', () => {
    expect(isShellLocale('zh')).toBe(true)
    expect(isShellLocale('en')).toBe(true)
    expect(isShellLocale('fr')).toBe(false)
  })
})

describe('catalog parity', () => {
  it('carries non-empty messages with the same placeholders in both locales for every key', () => {
    for (const key of SHELL_MESSAGE_KEYS) {
      const zh = shellT('zh', key)
      const en = shellT('en', key)
      expect(zh, `zh message for ${key}`).not.toBe('')
      expect(en, `en message for ${key}`).not.toBe('')
      expect(placeholders(zh), `placeholders for ${key}`).toEqual(placeholders(en))
    }
  })
})
