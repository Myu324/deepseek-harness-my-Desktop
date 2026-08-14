// Plugin marketplace page logic: renders the feed merged with profile state
// and drives the market IPC surface exposed by the preload bridge. All page
// strings come from STRINGS in the shell's locale; the language selector
// persists the choice through market:set-locale. Cards search and open a
// detail view that renders the plugin's README.
'use strict'

const STRINGS = {
  zh: {
    title: '插件市场', engine: '引擎', refresh: '刷新', search: '搜索插件…',
    installFamily: '安装全家桶', install: '安装', update: '更新', uninstall: '卸载',
    rollback: '回滚上次更改', rollbackHint: '恢复上次安装/卸载/更新前记录的 profile 清单。',
    loading: '正在加载市场…', loadingFailed: '加载失败：', done: '完成。', failed: '失败：',
    installing: '正在安装', updating: '正在更新', uninstalling: '正在卸载', rollingBack: '正在回滚',
    back: '返回列表', readme: 'README', readmeLoading: '正在加载 README…', readmeFailed: 'README 加载失败：', readmeMissing: '该插件没有可显示的 README。', truncated: '…（内容过长已截断）',
    author: '作者', compatibilityUnknown: '兼容性未知', notInstalled: '未安装',
    badges: { official: '官方', community: '社区', bundle: '家族聚合包', compatible: '兼容', incompatible: '不兼容', installed: '已安装' },
    requires: '要求 dsh', source: '源码',
  },
  en: {
    title: 'Plugin Marketplace', engine: 'Engine', refresh: 'Refresh', search: 'Search plugins…',
    installFamily: 'Install family', install: 'Install', update: 'Update', uninstall: 'Uninstall',
    rollback: 'Roll back last change', rollbackHint: 'Restores the profile manifest recorded before the last install / uninstall / update.',
    loading: 'Loading feed…', loadingFailed: 'Loading failed: ', done: 'done.', failed: 'failed: ',
    installing: 'Installing', updating: 'Updating', uninstalling: 'Uninstalling', rollingBack: 'Rollback',
    back: 'Back to list', readme: 'README', readmeLoading: 'Loading README…', readmeFailed: 'README failed: ', readmeMissing: 'No README available for this plugin.', truncated: '… (truncated)',
    author: 'Author', compatibilityUnknown: 'Compatibility unknown', notInstalled: 'Not installed',
    badges: { official: 'Official', community: 'Community', bundle: 'Family bundle', compatible: 'Compatible', incompatible: 'Incompatible', installed: 'Installed' },
    requires: 'requires dsh', source: 'source',
  },
}

let currentLocale = 'zh'
let plugins = []
const str = () => STRINGS[currentLocale]
const pluginTitle = plugin => currentLocale === 'zh' && plugin.titleZh ? plugin.titleZh : plugin.title
const pluginDescription = plugin => currentLocale === 'zh' && plugin.descriptionZh ? plugin.descriptionZh : plugin.description

const statusEl = document.getElementById('status')
const pluginsEl = document.getElementById('plugins')
const detailEl = document.getElementById('detail')
const detailContent = document.getElementById('detail-content')
const rollbackSection = document.getElementById('rollback-section')
const langSelect = document.getElementById('lang')
const searchInput = document.getElementById('search')

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

/** One plugin badge row. */
function badgesHtml(plugin) {
  const s = str()
  return [
    plugin.official ? badge(s.badges.official, 'official') : badge(s.badges.community, 'community'),
    plugin.bundles ? badge(s.badges.bundle, 'bundle') : '',
    plugin.compatibility === undefined ? badge(s.compatibilityUnknown, 'bad') : plugin.compatible ? badge(s.badges.compatible, 'ok') : badge(s.badges.incompatible, 'bad'),
    plugin.installed ? badge(s.badges.installed, 'ok') : '',
  ].filter(Boolean).join(' ')
}

function badge(text, kind) {
  return `<span class="badge ${kind}">${escapeHtml(text)}</span>`
}

/** The action buttons one plugin currently offers. */
function actionsHtml(plugin) {
  const s = str()
  return `<div class="actions" data-package="${escapeHtml(plugin.package)}">
    ${plugin.installed ? '' : `<button class="install">${escapeHtml(plugin.bundles ? s.installFamily : s.install)}</button>`}
    ${plugin.installed ? `<button class="update">${escapeHtml(s.update)}</button>` : ''}
    ${plugin.installed ? `<button class="danger uninstall">${escapeHtml(s.uninstall)}</button>` : ''}
  </div>`
}

/** One plugin card (list view). */
function card(plugin) {
  const el = document.createElement('article')
  el.className = 'card'
  el.innerHTML = `
    <div class="head">
      <h2>${escapeHtml(pluginTitle(plugin))}</h2>
      <div class="badges">${badgesHtml(plugin)}</div>
    </div>
    <p class="description">${escapeHtml(pluginDescription(plugin))}</p>
    <p class="meta">
      <code>${escapeHtml(plugin.package)}</code> ·
      <a href="#" data-source="${escapeHtml(plugin.source)}">${escapeHtml(str().source)}</a>
    </p>`
  el.addEventListener('click', (event) => {
    if (event.target instanceof HTMLElement && event.target.dataset.source !== undefined) return
    void openDetail(plugin)
  })
  return el
}

/** Minimal, escaping-only markdown renderer for README text. */
function renderMarkdown(text) {
  const lines = String(text).split('\n')
  const html = []
  let inCode = false
  let code = []
  let list = []
  let paragraph = []
  const flushParagraph = () => {
    if (paragraph.length === 0) return
    html.push(`<p>${inline(paragraph.join(' '))}</p>`)
    paragraph = []
  }
  const flushList = () => {
    if (list.length === 0) return
    html.push(`<ul>${list.map(item => `<li>${inline(item)}</li>`).join('')}</ul>`)
    list = []
  }
  for (const line of lines) {
    if (line.startsWith('```')) {
      if (inCode) {
        html.push(`<pre><code>${escapeHtml(code.join('\n'))}</code></pre>`)
        code = []
      } else {
        flushParagraph()
        flushList()
        code = []
      }
      inCode = !inCode
      continue
    }
    if (inCode) {
      code.push(line)
      continue
    }
    const heading = /^(#{1,4})\s+(.*)$/.exec(line)
    if (heading !== null) {
      flushParagraph()
      flushList()
      const level = heading[1].length
      html.push(`<h${level + 2}>${inline(heading[2])}</h${level + 2}>`)
      continue
    }
    const item = /^[-*]\s+(.*)$/.exec(line)
    if (item !== null) {
      flushParagraph()
      list.push(item[1])
      continue
    }
    if (line.trim() === '') {
      flushParagraph()
      flushList()
      continue
    }
    paragraph.push(line.trim())
  }
  flushParagraph()
  flushList()
  if (inCode) html.push(`<pre><code>${escapeHtml(code.join('\n'))}</code></pre>`)
  return html.join('\n')
}

/** Inline formatting: links, code spans, bold — everything else escaped. */
function inline(text) {
  const escaped = escapeHtml(text)
  return escaped
    .replaceAll(/`([^`]+)`/g, '<code>$1</code>')
    .replaceAll(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replaceAll(/\[([^\]]+)\]\((https:\/\/[^)]+)\)/g, '<a href="#" data-source="$2">$1</a>')
}

/** The detail view for one plugin. */
async function openDetail(plugin) {
  const s = str()
  detailContent.innerHTML = `
    <div class="card detail-card">
      <div class="head">
        <h2>${escapeHtml(pluginTitle(plugin))}</h2>
        <div class="badges">${badgesHtml(plugin)}</div>
      </div>
      <p class="description">${escapeHtml(pluginDescription(plugin))}</p>
      <p class="meta">
        <code>${escapeHtml(plugin.package)}</code> ·
        <a href="#" data-source="${escapeHtml(plugin.source)}">${escapeHtml(s.source)}</a>
        ${plugin.author ? ` · ${escapeHtml(s.author)}：${escapeHtml(plugin.author)}` : ''}
        ${plugin.compatibility ? ` · ${escapeHtml(s.requires)} ${escapeHtml(plugin.compatibility)}` : ''}
      </p>
      ${actionsHtml(plugin)}
    </div>
    <div class="card">
      <h2>${escapeHtml(s.readme)}</h2>
      <div id="readme-body"><p>${escapeHtml(s.readmeLoading)}</p></div>
    </div>`
  pluginsEl.hidden = true
  document.querySelector('.toolbar').hidden = true
  rollbackSection.hidden = true
  detailEl.hidden = false
  const body = document.getElementById('readme-body')
  try {
    const readme = await window.market.readme(plugin.package, plugin.source)
    body.innerHTML = readme.trim() === '' ? `<p>${escapeHtml(s.readmeMissing)}</p>` : renderMarkdown(readme)
  } catch (error) {
    body.innerHTML = `<p>${escapeHtml(s.readmeFailed + String(error instanceof Error ? error.message : error))}</p>`
  }
}

function showList() {
  detailEl.hidden = true
  pluginsEl.hidden = false
  document.querySelector('.toolbar').hidden = false
  rollbackSection.hidden = !plugins.some(plugin => plugin.rollbackAvailable)
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
  document.getElementById('back').textContent = `← ${s.back}`
  searchInput.placeholder = s.search
  langSelect.value = currentLocale
}

/** Render the list filtered by the current search term. */
function renderList() {
  const term = searchInput.value.trim().toLowerCase()
  const visible = term === ''
    ? plugins
    : plugins.filter(plugin => [plugin.title, plugin.titleZh ?? '', plugin.description, plugin.descriptionZh ?? '', plugin.package, plugin.author ?? '']
      .some(field => field.toLowerCase().includes(term)))
  pluginsEl.replaceChildren(...visible.map(card))
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
    plugins = state.plugins
    applyLocale()
    document.getElementById('engine-version').textContent = state.engineVersion ?? 'unknown'
    renderList()
    rollbackSection.hidden = !plugins.some(plugin => plugin.rollbackAvailable)
    setStatus('')
  } catch (error) {
    setStatus(`${s.loadingFailed}${String(error instanceof Error ? error.message : error)}`, true)
  }
}

document.getElementById('refresh').addEventListener('click', () => { void refresh() })
document.getElementById('back').addEventListener('click', showList)
searchInput.addEventListener('input', renderList)

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

detailContent.addEventListener('click', (event) => {
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
