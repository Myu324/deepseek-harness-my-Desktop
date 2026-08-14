// Sandboxed preload bridge for the plugin marketplace page: exposes the
// market IPC surface as window.market. Sandboxed preloads may only require
// the electron renderer bridge subset, so this file stays CJS and tiny.
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('market', {
  init: () => ipcRenderer.invoke('market:init'),
  setLocale: locale => ipcRenderer.invoke('market:set-locale', locale),
  runCommand: command => ipcRenderer.invoke('market:run-command', command),
  restartApp: () => ipcRenderer.invoke('market:restart-app'),
  onCommandOutput: callback => ipcRenderer.on('market:command-output', (_event, line) => callback(line)),
})
