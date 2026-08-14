/** Dictionary keys for the desktop-shell settings section. */
export type ShellSettingsKey =
  | 'nav'
  | 'status'
  | 'running'
  | 'stopped'
  | 'restart'
  | 'login'
  | 'language'
  | 'shellUpdates'
  | 'engineUpdates'
  | 'market'
  | 'quit'

/** Chinese copy for the desktop-shell settings section. */
export const zh: Readonly<Record<ShellSettingsKey, string>> = {
  nav: '桌面客户端',
  status: '引擎状态',
  running: '运行中（端口 {port}）',
  stopped: '已停止',
  restart: '重启引擎',
  login: '开机自启',
  language: '客户端界面语言',
  shellUpdates: '检查壳更新',
  engineUpdates: '检查引擎更新',
  market: '插件市场',
  quit: '退出客户端',
}

/** English copy for the desktop-shell settings section. */
export const en: Readonly<Record<ShellSettingsKey, string>> = {
  nav: 'Desktop Client',
  status: 'Engine status',
  running: 'running on {port}',
  stopped: 'stopped',
  restart: 'Restart Engine',
  login: 'Launch at login',
  language: 'Client language',
  shellUpdates: 'Check for Shell Updates',
  engineUpdates: 'Check for Engine Updates',
  market: 'Plugin Marketplace',
  quit: 'Quit Client',
}
