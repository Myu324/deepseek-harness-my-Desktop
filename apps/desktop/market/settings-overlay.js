// Settings overlay injected into the engine's Web GUI (bottom-left gear).
// Talks to the shell through the window.shell bridge exposed by the main
// window's preload. Idempotent: the wrapper guard runs this once per load.
window.__dshShellOverlay = true

const LABELS = {
  zh: {
    settings: '设置', engine: '引擎', running: '运行中（端口 {port}）', stopped: '已停止',
    restart: '重启引擎', login: '开机自启', language: '语言', shellUpdates: '检查壳更新',
    engineUpdates: '检查引擎更新', market: '插件市场', quit: '退出', gear: '设置 / Settings',
  },
  en: {
    settings: 'Settings', engine: 'Engine', running: 'running on {port}', stopped: 'stopped',
    restart: 'Restart Engine', login: 'Launch at login', language: 'Language',
    shellUpdates: 'Check for Shell Updates', engineUpdates: 'Check for Engine Updates',
    market: 'Plugin Marketplace', quit: 'Quit', gear: 'Settings / 设置',
  },
}

let locale = 'zh'
let openAtLogin = false
let engineRunning = false
let enginePort = 0

function t(key, params) {
  const table = LABELS[locale] || LABELS.zh
  const text = table[key] || key
  if (params === undefined) return text
  return Object.keys(params).reduce((acc, name) => acc.replace('{' + name + '}', String(params[name])), text)
}

const style = document.createElement('style')
style.textContent = '#dsh-shell-gear{position:fixed;left:14px;bottom:14px;width:34px;height:34px;border-radius:50%;border:1px solid rgba(255,255,255,.18);background:rgba(22,24,29,.92);color:#e6e8ee;cursor:pointer;z-index:2147483000;font-size:15px;line-height:1;display:flex;align-items:center;justify-content:center}#dsh-shell-gear:hover{background:#2b2f3a}#dsh-shell-panel{position:fixed;left:14px;bottom:56px;width:300px;max-height:70vh;overflow:auto;background:#1e2129;border:1px solid #2b2f3a;border-radius:10px;color:#e6e8ee;font:13px/1.6 system-ui,sans-serif;z-index:2147483001;padding:12px;display:none}#dsh-shell-panel.open{display:block}#dsh-shell-panel h3{margin:0 0 8px;font-size:14px}#dsh-shell-panel .row{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:5px 0}#dsh-shell-panel label{display:flex;align-items:center;gap:6px}#dsh-shell-panel button{background:#4c7dff;color:#fff;border:0;border-radius:6px;padding:4px 10px;font:inherit;cursor:pointer}#dsh-shell-panel button.secondary{background:#2b2f3a}#dsh-shell-panel .dim{color:#9aa0ad}#dsh-shell-panel select{background:#2b2f3a;color:#e6e8ee;border:1px solid #3a3f4c;border-radius:6px;padding:2px 6px;font:inherit}'
document.head.appendChild(style)

const gear = document.createElement('button')
gear.id = 'dsh-shell-gear'
gear.textContent = '⚙'
const panel = document.createElement('div')
panel.id = 'dsh-shell-panel'

function buildPanel() {
  panel.innerHTML = ''
  const title = document.createElement('h3')
  title.textContent = t('settings')
  panel.appendChild(title)

  const engineRow = document.createElement('div')
  engineRow.className = 'row'
  const engineText = engineRunning ? t('running', { port: enginePort }) : t('stopped')
  engineRow.innerHTML = '<span class="dim">' + t('engine') + '</span><span>' + engineText + '</span>'
  panel.appendChild(engineRow)

  const restartRow = document.createElement('div')
  restartRow.className = 'row'
  restartRow.innerHTML = '<span class="dim">' + t('engine') + '</span>'
  const restart = document.createElement('button')
  restart.textContent = t('restart')
  restart.addEventListener('click', () => { void window.shell.restartEngine() })
  restartRow.appendChild(restart)
  panel.appendChild(restartRow)

  const loginRow = document.createElement('div')
  loginRow.className = 'row'
  const loginLabel = document.createElement('label')
  const loginBox = document.createElement('input')
  loginBox.type = 'checkbox'
  loginBox.checked = openAtLogin
  loginBox.addEventListener('change', () => {
    void window.shell.setLoginItem(loginBox.checked).then(next => { openAtLogin = next })
  })
  loginLabel.appendChild(loginBox)
  loginLabel.appendChild(document.createTextNode(t('login')))
  loginRow.appendChild(loginLabel)
  panel.appendChild(loginRow)

  const langRow = document.createElement('div')
  langRow.className = 'row'
  const langLabel = document.createElement('span')
  langLabel.textContent = t('language')
  langLabel.className = 'dim'
  const langSelect = document.createElement('select')
  const zhOption = document.createElement('option')
  zhOption.value = 'zh'
  zhOption.textContent = '中文'
  const enOption = document.createElement('option')
  enOption.value = 'en'
  enOption.textContent = 'English'
  langSelect.appendChild(zhOption)
  langSelect.appendChild(enOption)
  langSelect.value = locale
  langSelect.addEventListener('change', () => {
    void window.shell.setLocale(langSelect.value).then(next => {
      locale = next
      buildPanel()
    })
  })
  langRow.appendChild(langLabel)
  langRow.appendChild(langSelect)
  panel.appendChild(langRow)

  const shellUpdates = document.createElement('button')
  shellUpdates.className = 'secondary'
  shellUpdates.textContent = t('shellUpdates')
  shellUpdates.style.width = '100%'
  shellUpdates.style.marginTop = '6px'
  shellUpdates.addEventListener('click', () => { void window.shell.checkShellUpdates() })
  panel.appendChild(shellUpdates)

  const engineUpdates = document.createElement('button')
  engineUpdates.className = 'secondary'
  engineUpdates.textContent = t('engineUpdates')
  engineUpdates.style.width = '100%'
  engineUpdates.style.marginTop = '6px'
  engineUpdates.addEventListener('click', () => { void window.shell.checkEngineUpdates() })
  panel.appendChild(engineUpdates)

  const market = document.createElement('button')
  market.textContent = t('market')
  market.style.width = '100%'
  market.style.marginTop = '6px'
  market.addEventListener('click', () => { void window.shell.openMarket() })
  panel.appendChild(market)

  const quit = document.createElement('button')
  quit.className = 'secondary'
  quit.textContent = t('quit')
  quit.style.width = '100%'
  quit.style.marginTop = '6px'
  quit.style.borderColor = '#c93a3a'
  quit.style.color = '#ff8f8f'
  quit.style.background = '#2b1b1e'
  quit.addEventListener('click', () => { void window.shell.quit() })
  panel.appendChild(quit)
}

async function refreshAndRender() {
  try {
    const state = await window.shell.state()
    locale = state.locale
    openAtLogin = state.openAtLogin
    engineRunning = state.engineRunning
    enginePort = state.port
    gear.title = LABELS[locale].gear
  } catch (error) {
    // State is advisory; defaults render fine without it.
  }
  buildPanel()
}

gear.addEventListener('click', () => {
  panel.classList.toggle('open')
  if (panel.classList.contains('open')) void refreshAndRender()
})

document.body.appendChild(gear)
document.body.appendChild(panel)
