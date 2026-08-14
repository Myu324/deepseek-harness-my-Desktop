/**
 * Shell UI strings in Chinese and English. The shell chrome (tray menu,
 * notifications, dialogs) renders through {@link shellT}; the marketplace
 * page carries its own string table in market/market.js and receives the
 * locale through the list payload. Diagnostics stay English — they are log
 * lines, not product UI.
 * @module @deepseek-ai/dsh-desktop/shell-i18n
 */

/** The locales the shell supports. */
export type ShellLocale = 'zh' | 'en'

/** Every locale the shell supports, for radio menus. */
export const SHELL_LOCALES: readonly ShellLocale[] = ['zh', 'en']

/** Whether a value is a supported shell locale. */
export function isShellLocale(value: unknown): value is ShellLocale {
  return value === 'zh' || value === 'en'
}

/** One message in both supported locales. */
interface ShellMessage {
  readonly zh: string
  readonly en: string
}

/** The shell message catalog; every key must carry both locales. */
const MESSAGES = {
  'menu.open': { zh: '打开 DeepSeek Harness', en: 'Open DeepSeek Harness' },
  'menu.restartEngine': { zh: '重启引擎', en: 'Restart Engine' },
  'menu.launchAtLogin': { zh: '开机自启', en: 'Launch at login' },
  'menu.checkShellUpdates': { zh: '检查壳更新', en: 'Check for Shell Updates' },
  'menu.installUpdate': { zh: '安装更新并重启', en: 'Install Update and Restart' },
  'menu.checkEngineUpdates': { zh: '检查引擎更新', en: 'Check for Engine Updates' },
  'menu.marketplace': { zh: '插件市场', en: 'Plugin Marketplace' },
  'menu.language': { zh: '语言 / Language', en: 'Language / 语言' },
  'menu.quit': { zh: '退出', en: 'Quit' },
  'tray.engineStopped': { zh: '引擎已停止', en: 'engine stopped' },
  'tray.engineOn': { zh: '引擎运行中（端口 {port}）', en: 'engine on {port}' },
  'notify.updateReady': { zh: '更新就绪', en: 'Update ready' },
  'notify.updateReadyBody': {
    zh: 'DeepSeek Harness {version} 已下载，重启应用完成安装。',
    en: 'DeepSeek Harness {version} downloaded — restart the app to install.',
  },
  'notify.engineUpdateReady': { zh: '引擎更新就绪', en: 'Engine update ready' },
  'notify.engineUpdateReadyBody': {
    zh: 'DeepSeek Harness 引擎 {version} 已安装，重启引擎后生效。',
    en: 'DeepSeek Harness engine {version} installed — restart the engine to apply.',
  },
  'notify.engineUpdateFailed': { zh: '引擎更新失败', en: 'Engine update failed' },
  'notify.engineRestarted': { zh: '引擎已重启', en: 'Engine restarted' },
  'notify.engineRestartedBody': { zh: 'DeepSeek Harness 引擎已重启。', en: 'DeepSeek Harness engine restarted.' },
  'notify.engineFallback': { zh: '引擎回退', en: 'Engine fallback' },
  'notify.engineFallbackBody': {
    zh: '引擎 {current} 启动失败，已回退到 last-good 版本 {version}。',
    en: 'Engine {current} failed to start — using last-good {version}.',
  },
  'dialog.cannotFindEngine': { zh: '找不到 dsh 引擎。', en: 'Cannot find the dsh engine.' },
  'dialog.engineStartFailed': { zh: 'dsh 引擎启动失败。', en: 'The dsh engine failed to start.' },
  'dialog.engineUnexpectedExit': {
    zh: 'dsh 引擎意外退出（代码 {code}）。',
    en: 'The dsh engine exited unexpectedly (code {code}).',
  },
  'dialog.engineFallbackFailed': {
    zh: 'dsh 引擎启动失败，且 last-good 回退也失败。',
    en: 'The dsh engine failed to start, and the last-good fallback also failed.',
  },
  'dialog.provisioningFailed': { zh: '引擎预置失败。', en: 'Engine provisioning failed.' },
  'dialog.restartFailed': { zh: 'dsh 引擎重启失败。', en: 'The dsh engine failed to restart.' },
  'dialog.logsAt': { zh: '日志：{path}', en: 'Logs: {path}' },
} satisfies Readonly<Record<string, ShellMessage>>

/** A shell message key. */
export type ShellMessageKey = keyof typeof MESSAGES

/** Every shell message key, for catalog-wide checks. */
export const SHELL_MESSAGE_KEYS: readonly ShellMessageKey[] = Object.keys(MESSAGES) as ShellMessageKey[]

/**
 * Render one shell message in a locale, substituting `{name}` placeholders.
 * @param locale - the target locale.
 * @param key - the message key.
 * @param params - placeholder values; missing ones stay verbatim.
 * @returns the rendered message.
 */
export function shellT(locale: ShellLocale, key: ShellMessageKey, params: Readonly<Record<string, string>> = {}): string {
  const message = MESSAGES[key]
  const template = locale === 'zh' ? message.zh : message.en
  return template.replaceAll(/\{(\w+)\}/g, (whole, name: string) => params[name] ?? whole)
}
