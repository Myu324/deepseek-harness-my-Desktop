/**
 * Desktop-shell settings plugin, browser half: registers the Desktop Client
 * section into the native settings page when — and only when — the page runs
 * inside the desktop client (the window.shell preload bridge exists), so a
 * plain browser session never sees desktop-only chrome.
 * Export discipline: packages/client/AGENTS.md.
 */
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
// Type-only: pulls the `settings.section` slot declaration and the locale
// service merge into this program.
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import { readShellBridge } from './bridge.ts'
import { normalizeShellState, type ShellSectionInjected } from './contract.ts'
import { en, zh, type ShellSettingsKey } from './locales.ts'
import { ShellSettingsSection } from './ShellSettingsSection.tsx'

export type { ShellSectionInjected, ShellSnapshot } from './contract.ts'
export type { ShellSettingsKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Desktop-client settings section copy. */
    shellSettings: ShellSettingsKey
  }
}

/** Dictionary namespace owned by this plugin. */
const NS = 'shellSettings'

/** Services the registration reads. */
export const inject = ['slots', 'locale']

/**
 * Register the `shellSettings` dictionaries and the Desktop Client section.
 * The section registers only when the desktop preload bridge exists; its
 * actions are plain callbacks over that bridge, and the shell main process
 * owns every engine-side behavior they trigger.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-shell-settings: copy dictionaries')
  const shell = readShellBridge()
  if (shell === undefined) return
  const t = ctx.locale.bind(NS) as ShellSectionInjected['t']
  const injected = (): ShellSectionInjected => ({
    getState: async () => normalizeShellState(await shell.state()),
    setLocale: async (locale) => { await shell.setLocale(locale) },
    setLoginItem: async openAtLogin => await shell.setLoginItem(openAtLogin),
    restartEngine: async () => { await shell.restartEngine() },
    checkShellUpdates: async () => { await shell.checkShellUpdates() },
    checkEngineUpdates: async () => { await shell.checkEngineUpdates() },
    openMarket: async () => { await shell.openMarket() },
    quit: async () => { await shell.quit() },
    t,
  })
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'shell',
    order: 20,
    label: () => t('nav'),
    inject: injected,
  }, ShellSettingsSection))
}
