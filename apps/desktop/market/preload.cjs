// Sandboxed preload bridge for the plugin marketplace page: exposes the
// market IPC surface as window.market. Sandboxed preloads may only require
// the electron renderer bridge subset, so this file stays CJS and tiny.
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('market', {
  list: () => ipcRenderer.invoke('market:list'),
  setLocale: locale => ipcRenderer.invoke('market:set-locale', locale),
  readme: (spec, source) => ipcRenderer.invoke('market:readme', spec, source),
  install: spec => ipcRenderer.invoke('market:install', spec),
  uninstall: name => ipcRenderer.invoke('market:uninstall', name),
  update: name => ipcRenderer.invoke('market:update', name),
  rollback: () => ipcRenderer.invoke('market:rollback'),
  openExternal: url => ipcRenderer.invoke('market:open-external', url),
})
