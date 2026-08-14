// Plugin marketplace page logic: renders the feed merged with profile state
// and drives the market IPC surface exposed by the preload bridge.
'use strict'

const statusEl = document.getElementById('status')
const pluginsEl = document.getElementById('plugins')
const rollbackSection = document.getElementById('rollback-section')

/** One plugin card. */
function card(plugin) {
  const el = document.createElement('article')
  el.className = 'card'
  const badges = [
    plugin.official ? badge('Official', 'official') : badge('Community', 'community'),
    plugin.bundles ? badge('Family bundle', 'bundle') : '',
    plugin.compatible ? badge('Compatible', 'ok') : badge('Incompatible', 'bad'),
    plugin.installed ? badge('Installed', 'ok') : '',
  ].filter(Boolean).join(' ')
  el.innerHTML = `
    <div class="head">
      <h2>${escapeHtml(plugin.title)}</h2>
      <div class="badges">${badges}</div>
    </div>
    <p class="description">${escapeHtml(plugin.description)}</p>
    <p class="meta">
      <code>${escapeHtml(plugin.package)}</code> ·
      <a href="#" data-source="${escapeHtml(plugin.source)}">source</a> ·
      requires dsh ${escapeHtml(plugin.compatibility)}
    </p>
    <div class="actions" data-package="${escapeHtml(plugin.package)}">
      ${plugin.installed ? '' : `<button class="install">${plugin.bundles ? 'Install family' : 'Install'}</button>`}
      ${plugin.installed ? '<button class="update">Update</button>' : ''}
      ${plugin.installed ? '<button class="danger uninstall">Uninstall</button>' : ''}
    </div>`
  return el
}

function badge(text, kind) {
  return `<span class="badge ${kind}">${escapeHtml(text)}</span>`
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

function setStatus(text, isError = false) {
  statusEl.textContent = text
  statusEl.className = isError ? 'error' : ''
}

/** Run one market operation, refreshing afterwards and surfacing failures. */
async function operate(label, promise) {
  setStatus(`${label}…`)
  try {
    await promise
    await refresh()
    setStatus(`${label} done.`)
  } catch (error) {
    setStatus(`${label} failed: ${String(error instanceof Error ? error.message : error)}`, true)
  }
}

async function refresh() {
  setStatus('Loading feed…')
  try {
    const state = await window.market.list()
    document.getElementById('engine-version').textContent = state.engineVersion ?? 'unknown'
    pluginsEl.replaceChildren(...state.plugins.map(card))
    rollbackSection.hidden = !state.plugins.some(plugin => plugin.rollbackAvailable)
    setStatus('')
  } catch (error) {
    setStatus(`Loading failed: ${String(error instanceof Error ? error.message : error)}`, true)
  }
}

document.getElementById('refresh').addEventListener('click', () => { void refresh() })

document.getElementById('rollback').addEventListener('click', () => {
  void operate('Rollback', window.market.rollback())
})

pluginsEl.addEventListener('click', (event) => {
  const target = event.target
  if (!(target instanceof HTMLElement)) return
  const source = target.dataset.source
  if (source !== undefined) {
    event.preventDefault()
    void window.market.openExternal(source)
    return
  }
  const actions = target.closest('.actions')
  if (actions === null) return
  const spec = actions.dataset.package ?? ''
  if (target.classList.contains('install')) void operate(`Installing ${spec}`, window.market.install(spec))
  if (target.classList.contains('update')) void operate(`Updating ${spec}`, window.market.update(spec))
  if (target.classList.contains('uninstall')) void operate(`Uninstalling ${spec}`, window.market.uninstall(spec))
})

void refresh()
