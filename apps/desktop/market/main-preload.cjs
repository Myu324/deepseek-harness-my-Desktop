// Sandboxed preload bridge for the MAIN window: exposes the shell settings
// overlay surface as window.shell. Sandboxed preloads may only require the
// electron renderer bridge subset, so this file stays CJS and tiny.
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('shell', {
  state: () => ipcRenderer.invoke('shell:state'),
  setLocale: locale => ipcRenderer.invoke('shell:set-locale', locale),
  setLoginItem: openAtLogin => ipcRenderer.invoke('shell:set-login-item', openAtLogin),
  restartEngine: () => ipcRenderer.invoke('shell:restart-engine'),
  checkShellUpdates: () => ipcRenderer.invoke('shell:check-shell-updates'),
  checkEngineUpdates: () => ipcRenderer.invoke('shell:check-engine-updates'),
  openMarket: () => ipcRenderer.invoke('shell:open-market'),
  quit: () => ipcRenderer.invoke('shell:quit'),
})
