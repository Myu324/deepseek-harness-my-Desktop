/**
 * Desktop-shell settings section: renders shell facts and drives shell
 * actions through the injected face.
 * @module @deepseek-ai/dsh-client-ui-shell-settings/tests/section
 */
// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import type { ShellSectionInjected } from '../src/client/contract.ts'
import type { ShellSettingsSectionComponentProps } from '../src/client/ShellSettingsSection.tsx'
import { ShellSettingsSection } from '../src/client/ShellSettingsSection.tsx'

afterEach(cleanup)

const COPY: Record<string, string> = {
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

/** An injected face recording calls; each override replaces one callback. */
function face(overrides: Partial<ShellSectionInjected> = {}) {
  const calls: string[] = []
  const injected: ShellSectionInjected = {
    getState: async () => ({ locale: 'zh', openAtLogin: false, engineRunning: true, port: 6123 }),
    setLocale: async () => { calls.push('setLocale') },
    setLoginItem: async (openAtLogin) => {
      calls.push(`login:${String(openAtLogin)}`)
      return openAtLogin
    },
    restartEngine: async () => { calls.push('restart') },
    checkShellUpdates: async () => { calls.push('shellUpdates') },
    checkEngineUpdates: async () => { calls.push('engineUpdates') },
    openMarket: async () => { calls.push('market') },
    quit: async () => { calls.push('quit') },
    t: key => COPY[key] ?? key,
    ...overrides,
  }
  return { injected, calls }
}

function renderSection(injected: ShellSectionInjected) {
  // The framework hooks are uncalled by this section; stub them as the
  // standard kit and cast the flat object to the composed props type.
  const props = {
    ...injected,
    close: () => {},
    useSessions: () => undefined,
    useWorkspaces: () => undefined,
  } as unknown as ShellSettingsSectionComponentProps
  return render(<ShellSettingsSection {...props} />)
}

describe('ShellSettingsSection', () => {
  it('renders the running status with the engine port', async () => {
    renderSection(face().injected)
    expect(await screen.findByText('运行中（端口 6123）')).toBeTruthy()
  })

  it('renders the stopped status when the engine is not running', async () => {
    const { injected } = face({ getState: async () => ({ locale: 'zh', openAtLogin: false, engineRunning: false, port: 0 }) })
    renderSection(injected)
    expect(await screen.findByText('已停止')).toBeTruthy()
  })

  it('falls back to defaults when the state fetch fails', async () => {
    const { injected } = face({ getState: async () => { throw new Error('bridge down') } })
    renderSection(injected)
    expect(await screen.findByText('已停止')).toBeTruthy()
    const box = (await screen.findByRole('checkbox')) as HTMLInputElement
    expect(box.checked).toBe(false)
  })

  it('restarts the engine from the running state', async () => {
    const { injected, calls } = face()
    renderSection(injected)
    const button = await screen.findByRole('button', { name: '重启引擎' })
    expect((button as HTMLButtonElement).disabled).toBe(false)
    fireEvent.click(button)
    await waitFor(() => { expect(calls).toContain('restart') })
  })

  it('disables the restart button while the engine is stopped', async () => {
    const { injected } = face({ getState: async () => ({ locale: 'zh', openAtLogin: false, engineRunning: false, port: 0 }) })
    renderSection(injected)
    const button = await screen.findByRole('button', { name: '重启引擎' })
    expect((button as HTMLButtonElement).disabled).toBe(true)
  })

  it('persists the login-item checkbox and updates the snapshot', async () => {
    const { injected, calls } = face()
    renderSection(injected)
    const box = (await screen.findByRole('checkbox')) as HTMLInputElement
    fireEvent.click(box)
    await waitFor(() => { expect(calls).toContain('login:true') })
    expect(box.checked).toBe(true)
  })

  it('switches the shell language through the select', async () => {
    const { injected, calls } = face()
    renderSection(injected)
    const select = (await screen.findByDisplayValue('中文')) as HTMLSelectElement
    fireEvent.change(select, { target: { value: 'en' } })
    await waitFor(() => { expect(calls).toContain('setLocale') })
    await waitFor(() => { expect(select.value).toBe('en') })
    fireEvent.change(select, { target: { value: 'zh' } })
    await waitFor(() => { expect(calls).toHaveLength(2) })
    await waitFor(() => { expect(select.value).toBe('zh') })
  })

  it('ignores a login-item change while the initial state is still loading', async () => {
    const { injected, calls } = face({ getState: async () => await new Promise(() => {}) })
    renderSection(injected)
    const box = (await screen.findByRole('checkbox')) as HTMLInputElement
    fireEvent.click(box)
    await waitFor(() => { expect(calls).toContain('login:true') })
    expect(box.checked).toBe(false)
  })

  it('ignores a language change while the initial state is still loading', async () => {
    const { injected, calls } = face({ getState: async () => await new Promise(() => {}) })
    renderSection(injected)
    const select = (await screen.findByDisplayValue('中文')) as HTMLSelectElement
    fireEvent.change(select, { target: { value: 'en' } })
    await waitFor(() => { expect(calls).toContain('setLocale') })
    expect(select.value).toBe('zh')
  })

  it('drives the remaining shell actions', async () => {
    const { injected, calls } = face()
    renderSection(injected)
    for (const label of ['检查壳更新', '检查引擎更新', '插件市场', '退出客户端']) {
      fireEvent.click(await screen.findByRole('button', { name: label }))
    }
    await waitFor(() => { expect(calls).toEqual(['shellUpdates', 'engineUpdates', 'market', 'quit']) })
  })

  it('survives an action failure and re-enables the buttons', async () => {
    const { injected } = face({ restartEngine: async () => { throw new Error('boom') } })
    renderSection(injected)
    const button = await screen.findByRole('button', { name: '重启引擎' })
    fireEvent.click(button)
    await waitFor(() => { expect((button as HTMLButtonElement).disabled).toBe(false) })
  })

  it('ignores a state update that resolves after unmount', async () => {
    let resolveState: (value: { locale: 'zh'; openAtLogin: boolean; engineRunning: boolean; port: number }) => void = () => {}
    const { injected } = face({
      getState: async () => await new Promise((resolve) => {
        resolveState = resolve
      }),
    })
    const { unmount } = renderSection(injected)
    unmount()
    resolveState({ locale: 'zh', openAtLogin: false, engineRunning: true, port: 1 })
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(screen.queryByText('运行中（端口 1）')).toBeNull()
  })

  it('ignores a state fetch rejection after unmount', async () => {
    let rejectState: (reason?: unknown) => void = () => {}
    const { injected } = face({
      getState: async () => await new Promise((_, reject) => {
        rejectState = reject
      }),
    })
    const { unmount } = renderSection(injected)
    unmount()
    rejectState(new Error('bridge down'))
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(screen.queryByText('已停止')).toBeNull()
  })
})
