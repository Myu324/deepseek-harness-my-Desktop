// Plugin marketplace page logic: renders the feed merged with profile state
// and drives the market IPC surface exposed by the preload bridge. All page
// strings come from STRINGS in the shell's locale; the language selector
// persists the choice through market:set-locale.
'use strict'

const STRINGS = {
  zh: {
    title: '插件市场', engine: '引擎', refresh: '刷新',
    installFamily: '安装全家桶', install: '安装', update: '更新', uninstall: '卸载',
    rollback: '回滚上次更改', rollbackHint: '恢复上次安装/卸载/更新前记录的 profile 清单。',
    loading: '正在加载市场…', loadingFailed: '加载失败：', done: '完成。', failed: '失败：',
    installing: '正在安装', updating: '正在更新', uninstalling: '正在卸载', rollingBack: '正在回滚',
    badges: { official: '官方', community: '社区', bundle: '家族聚合包', compatible: '兼容', incompatible: '不兼容', installed: '已安装' },
    requires: '要求 dsh', source: '源码',
  },
  en: {
    title: 'Plugin Marketplace', engine: 'Engine', refresh: 'Refresh',
    installFamily: 'Install family', install: 'Install', update: 'Update', uninstall: 'Uninstall',
    rollback: 'Roll back last change', rollbackHint: 'Restores the profile manifest recorded before the last install / uninstall / update.',
    loading: 'Loading feed…', loadingFailed: 'Loading failed: ', done: 'done.', failed: 'failed: ',
    installing: 'Installing', updating: 'Updating', uninstalling: 'Uninstalling', rollingBack: 'Rollback',
    badges: { official: 'Official', community: 'Community', bundle: 'Family bundle', compatible: 'Compatible', incompatible: 'Incompatible', installed: 'Installed' },
    requires: 'requires dsh', source: 'source',
  },
}

let currentLocale = 'zh'
const str = () => STRINGS[currentLocale]
const pluginTitle = plugin => currentLocale === 'zh' && plugin.titleZh ? plugin.titleZh : plugin.title
const pluginDescription = plugin => currentLocale === 'zh' && plugin.descriptionZh ? plugin.descriptionZh : plugin.description

const statusEl = document.getElementById('status')
const pluginsEl = document.getElementById('plugins')
const rollbackSection = document.getElementById('rollback-section')
const langSelect = document.getElementById('lang')

/** One plugin card. */
function card(plugin) {
  const s = str()
  const el = document.createElement('article')
  el.className = 'card'
  const badges = [
    plugin.official ? badge(s.badges.official, 'official') : badge(s.badges.community, 'community'),
    plugin.bundles ? badge(s.badges.bundle, 'bundle') : '',
    plugin.compatible ? badge(s.badges.compatible, 'ok') : badge(s.badges.incompatible, 'bad'),
    plugin.installed ? badge(s.badges.installed, 'ok') : '',
  ].filter(Boolean).join(' ')
  el.innerHTML = `
    <div class="head">
      <h2>${escapeHtml(pluginTitle(plugin))}</h2>
      <div class="badges">${badges}</div>
    </div>
    <p class="description">${escapeHtml(pluginDescription(plugin))}</p>
    <p class="meta">
      <code>${escapeHtml(plugin.package)}</code> ·
      <a href="#" data-source="${escapeHtml(plugin.source)}">${escapeHtml(s.source)}</a> ·
      ${escapeHtml(s.requires)} ${escapeHtml(plugin.compatibility)}
    </p>
    <div class="actions" data-package="${escapeHtml(plugin.package)}">
      ${plugin.installed ? '' : `<button class="install">${escapeHtml(plugin.bundles ? s.installFamily : s.install)}</button>`}
      ${plugin.installed ? `<button class="update">${escapeHtml(s.update)}</button>` : ''}
      ${plugin.installed ? `<button class="danger uninstall">${escapeHtml(s.uninstall)}</button>` : ''}
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

/** Apply one locale to every static element of the page. */
function applyLocale() {
  const s = str()
  document.title = `${s.title} — DeepSeek Harness`
  document.getElementById('page-title').textContent = s.title
  document.getElementById('engine-label').textContent = s.engine
  document.getElementById('refresh').textContent = s.refresh
  document.getElementById('rollback').textContent = s.rollback
  document.getElementById('rollback-hint').textContent = s.rollbackHint
  langSelect.value = currentLocale
}

/** Run one market operation, refreshing afterwards and surfacing failures. */
async function operate(verb, promise) {
  const s = str()
  setStatus(`${verb}…`)
  try {
    await promise
    await refresh()
    setStatus(`${verb}${s.done}`)
  } catch (error) {
    setStatus(`${verb}${s.failed}${String(error instanceof Error ? error.message : error)}`, true)
  }
}

async function refresh() {
  const s = str()
  setStatus(s.loading)
  try {
    const state = await window.market.list()
    currentLocale = state.locale === 'en' ? 'en' : 'zh'
    applyLocale()
    document.getElementById('engine-version').textContent = state.engineVersion ?? 'unknown'
    pluginsEl.replaceChildren(...state.plugins.map(card))
    rollbackSection.hidden = !state.plugins.some(plugin => plugin.rollbackAvailable)
    setStatus('')
  } catch (error) {
    setStatus(`${s.loadingFailed}${String(error instanceof Error ? error.message : error)}`, true)
  }
}

document.getElementById('refresh').addEventListener('click', () => { void refresh() })

document.getElementById('rollback').addEventListener('click', () => {
  void operate(str().rollingBack, window.market.rollback())
})

langSelect.addEventListener('change', async () => {
  const next = langSelect.value
  try {
    currentLocale = await window.market.setLocale(next)
    await refresh()
  } catch (error) {
    setStatus(`${str().failed}${String(error instanceof Error ? error.message : error)}`, true)
  }
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
  const s = str()
  if (target.classList.contains('install')) void operate(`${s.installing} ${spec}`, window.market.install(spec))
  if (target.classList.contains('update')) void operate(`${s.updating} ${spec}`, window.market.update(spec))
  if (target.classList.contains('uninstall')) void operate(`${s.uninstalling} ${spec}`, window.market.uninstall(spec))
})

void refresh()
