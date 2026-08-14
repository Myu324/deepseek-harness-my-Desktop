// Plugin marketplace page: embeds the community page in a webview, keeps a
// curated quick-command strip, and drives plugin installs through the
// terminal at the bottom (streamed output + a restart-client button).
'use strict'

const STRINGS = {
  zh: {
    title: '插件市场', engine: '引擎', restartApp: '重启客户端',
    back: '后退', home: '主页',
    hint: '命令：add <包名或 git 地址> / remove <包名> / update <包名> / install / rollback',
    recommended: '推荐插件（点击填入命令）',
    terminalPlaceholder: '输入插件命令，例如 add @linxin666/dsh-ssh',
    running: '正在执行…', done: '完成', failed: '失败：',
  },
  en: {
    title: 'Plugin Marketplace', engine: 'Engine', restartApp: 'Restart Client',
    back: 'Back', home: 'Home',
    hint: 'Commands: add <package-or-git-url> / remove <name> / update <name> / install / rollback',
    recommended: 'Recommended plugins (click to fill the command)',
    terminalPlaceholder: 'Type a plugin command, e.g. add @linxin666/dsh-ssh',
    running: 'Running…', done: 'done', failed: 'failed: ',
  },
}

let currentLocale = 'zh'
let homeUrl = 'https://github.com/topics/dsh-plugin'
const str = () => STRINGS[currentLocale]
const pluginTitle = plugin => currentLocale === 'zh' && plugin.titleZh ? plugin.titleZh : plugin.title

const outputEl = document.getElementById('terminal-output')
const inputEl = document.getElementById('terminal-input')
const hintEl = document.getElementById('terminal-hint')
const chipsEl = document.getElementById('chips')
const langSelect = document.getElementById('lang')
const webviewEl = document.getElementById('community')

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

function appendLine(text, kind = 'out') {
  const line = document.createElement('div')
  line.className = `line ${kind}`
  line.textContent = text
  outputEl.appendChild(line)
  outputEl.scrollTop = outputEl.scrollHeight
}

function applyLocale() {
  const s = str()
  document.title = `${s.title} — DeepSeek Harness`
  document.getElementById('page-title').textContent = s.title
  document.getElementById('engine-label').textContent = s.engine
  document.getElementById('restart-app').textContent = s.restartApp
  document.getElementById('webview-back').title = s.back
  document.getElementById('webview-home').textContent = s.home
  inputEl.placeholder = s.terminalPlaceholder
  hintEl.textContent = s.hint
  langSelect.value = currentLocale
}

/** Render the curated quick-command chips from the shipped feed. */
function renderChips(plugins) {
  const s = str()
  chipsEl.innerHTML = ''
  const label = document.createElement('span')
  label.className = 'chips-label'
  label.textContent = s.recommended
  chipsEl.appendChild(label)
  for (const plugin of plugins) {
    const chip = document.createElement('button')
    chip.className = 'chip'
    chip.title = plugin.description
    chip.textContent = pluginTitle(plugin)
    chip.addEventListener('click', () => {
      inputEl.value = `add ${plugin.package}`
      inputEl.focus()
    })
    chipsEl.appendChild(chip)
  }
}

window.market.onCommandOutput(line => appendLine(line))

document.getElementById('terminal-form').addEventListener('submit', async (event) => {
  event.preventDefault()
  const command = inputEl.value.trim()
  if (command === '') return
  appendLine(`$ ${command}`, 'in')
  inputEl.value = ''
  try {
    const summary = await window.market.runCommand(command)
    appendLine(`✓ ${summary}`, 'ok')
  } catch (error) {
    appendLine(`✗ ${str().failed}${String(error instanceof Error ? error.message : error)}`, 'err')
  }
})

document.getElementById('restart-app').addEventListener('click', () => {
  void window.market.restartApp()
})

document.getElementById('webview-back').addEventListener('click', () => {
  webviewEl.goBack()
})

document.getElementById('webview-home').addEventListener('click', () => {
  webviewEl.src = homeUrl
})

langSelect.addEventListener('change', async () => {
  try {
    currentLocale = await window.market.setLocale(langSelect.value)
    await init()
  } catch (error) {
    appendLine(`✗ ${str().failed}${String(error instanceof Error ? error.message : error)}`, 'err')
  }
})

async function init() {
  try {
    const state = await window.market.init()
    currentLocale = state.locale === 'en' ? 'en' : 'zh'
    homeUrl = state.communityPageUrl
    applyLocale()
    document.getElementById('engine-version').textContent = state.engineVersion ?? 'unknown'
    renderChips(state.plugins)
    webviewEl.src = homeUrl
  } catch (error) {
    appendLine(`✗ ${str().failed}${String(error instanceof Error ? error.message : error)}`, 'err')
  }
}

void init()
