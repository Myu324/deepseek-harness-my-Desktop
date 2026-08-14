/**
 * Browser-half apply: dictionary registration, bridge gating, section
 * registration, and injected-face routing.
 * @module @deepseek-ai/dsh-client-ui-shell-settings/tests/apply
 */
// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import { readShellBridge, type ShellBridge } from '../src/client/bridge.ts'
import type { ShellSectionInjected } from '../src/client/contract.ts'
import { ShellSettingsSection } from '../src/client/ShellSettingsSection.tsx'
import { apply } from '../src/client/index.ts'

afterEach(() => { delete window.shell })

/** A fake shell bridge recording every call. */
function fakeBridge(): { bridge: ShellBridge; calls: string[] } {
  const calls: string[] = []
  const bridge: ShellBridge = {
    state: async () => ({ locale: 'zh', openAtLogin: true, engineRunning: true, port: 6123 }),
    setLocale: async (locale) => {
      calls.push(`locale:${locale}`)
      return locale
    },
    setLoginItem: async (openAtLogin) => {
      calls.push(`login:${String(openAtLogin)}`)
      return openAtLogin
    },
    restartEngine: async () => { calls.push('restart') },
    checkShellUpdates: async () => { calls.push('shellUpdates') },
    checkEngineUpdates: async () => { calls.push('engineUpdates') },
    openMarket: async () => { calls.push('market') },
    quit: async () => { calls.push('quit') },
  }
  return { bridge, calls }
}

/** A minimal client context whose registrations are recorded. */
function fakeCtx(): {
  ctx: ClientContext
  slotInjectCalls: Array<{ name: string; factory: () => unknown }>
  register: ReturnType<typeof vi.fn<(options: unknown, component: unknown) => unknown>>
  localeRegister: ReturnType<typeof vi.fn<(ns: string, dictionaries: Record<string, unknown>) => unknown>>
  effectLabels: string[]
} {
  const slotInjectCalls: Array<{ name: string; factory: () => unknown }> = []
  const register = vi.fn<(options: unknown, component: unknown) => unknown>((options, component) => ({ options, component }))
  const localeRegister = vi.fn<(ns: string, dictionaries: Record<string, unknown>) => unknown>()
  const effectLabels: string[] = []
  const ctx = {
    effect: vi.fn((factory: () => unknown, label: string) => {
      effectLabels.push(label)
      factory()
      return () => {}
    }),
    locale: {
      register: localeRegister,
      bind: vi.fn(() => (key: string) => `t:${key}`),
    },
    slots: {
      inject: vi.fn((name: string, factory: () => unknown) => {
        slotInjectCalls.push({ name, factory })
        return () => {}
      }),
      register,
    },
  } as unknown as ClientContext
  return { ctx, slotInjectCalls, register, localeRegister, effectLabels }
}

describe('apply', () => {
  it('registers the copy dictionaries through an effect', () => {
    const { ctx, effectLabels, localeRegister } = fakeCtx()
    apply(ctx)
    expect(effectLabels).toEqual(['ui-shell-settings: copy dictionaries'])
    expect(localeRegister).toHaveBeenCalledTimes(1)
    const [ns, dictionaries] = localeRegister.mock.calls[0]!
    expect(ns).toBe('shellSettings')
    expect(Object.keys(dictionaries)).toEqual(['zh', 'en'])
  })

  it('registers the section with its identity and the section component', () => {
    const { ctx, slotInjectCalls, register } = fakeCtx()
    window.shell = fakeBridge().bridge
    apply(ctx)
    expect(slotInjectCalls.map(call => call.name)).toEqual(['settings.section'])
    const result = slotInjectCalls[0]?.factory()
    expect(register).toHaveBeenCalledTimes(1)
    const [options, component] = register.mock.calls[0] as [Record<string, unknown>, unknown]
    expect(options.name).toBe('settings.section')
    expect(options.id).toBe('shell')
    expect(options.order).toBe(20)
    expect(typeof options.label).toBe('function')
    expect((options.label as () => string)()).toBe('t:nav')
    expect(component).toBe(ShellSettingsSection)
    expect(options.inject).toBeTypeOf('function')
    void result
  })

  it('routes the injected face through the shell bridge', async () => {
    const { ctx, slotInjectCalls } = fakeCtx()
    const { bridge, calls } = fakeBridge()
    window.shell = bridge
    apply(ctx)
    const record = slotInjectCalls[0]?.factory() as { options: { inject: () => ShellSectionInjected } }
    const injected = record.options.inject()
    await expect(injected.getState()).resolves.toEqual({ locale: 'zh', openAtLogin: true, engineRunning: true, port: 6123 })
    await injected.setLocale('en')
    await injected.setLoginItem(false)
    await injected.restartEngine()
    await injected.checkShellUpdates()
    await injected.checkEngineUpdates()
    await injected.openMarket()
    await injected.quit()
    expect(calls).toEqual(['locale:en', 'login:false', 'restart', 'shellUpdates', 'engineUpdates', 'market', 'quit'])
  })

  it('skips the section registration without the desktop bridge', () => {
    const { ctx, slotInjectCalls } = fakeCtx()
    apply(ctx)
    expect(slotInjectCalls).toEqual([])
  })
})

describe('readShellBridge', () => {
  it('reads the bridge when the preload exposed one', () => {
    const { bridge } = fakeBridge()
    window.shell = bridge
    expect(readShellBridge()).toBe(bridge)
  })

  it('returns undefined without the bridge', () => {
    expect(readShellBridge()).toBeUndefined()
  })
})
