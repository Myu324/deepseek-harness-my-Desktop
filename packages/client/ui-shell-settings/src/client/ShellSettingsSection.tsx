/** The desktop-shell settings section: engine status, login item, shell language, and shell actions. */
import { useEffect, useState } from 'react'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { ShellSectionInjected, ShellSnapshot } from './contract.ts'
import css from './ShellSettingsSection.module.css'

/** Full component props: the section owner share plus the spread shell inject face. */
export type ShellSettingsSectionComponentProps =
  PropsRuntime<'settings.section'> & ShellSectionInjected

/**
 * Render the desktop-shell settings rows. All actions and facts arrive
 * through the spread inject face over the window.shell bridge; the panel
 * itself owns no state beyond the local snapshot refresh.
 * @param props - composed slot props.
 * @returns the section element tree.
 */
export function ShellSettingsSection(props: ShellSettingsSectionComponentProps) {
  const { t, getState, setLocale, setLoginItem, restartEngine, checkShellUpdates, checkEngineUpdates, openMarket, quit } = props
  const [snapshot, setSnapshot] = useState<ShellSnapshot | undefined>(undefined)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let stale = false
    void getState().then((state) => {
      if (!stale) setSnapshot(state)
    }).catch(() => {
      // The bridge is advisory; the section renders with defaults when it fails.
      if (!stale) setSnapshot({ locale: 'zh', openAtLogin: false, engineRunning: false, port: 0 })
    })
    return () => { stale = true }
  }, [getState])

  const run = async (operation: () => Promise<unknown>): Promise<void> => {
    setBusy(true)
    try {
      await operation()
    } catch {
      // Action failures surface in the shell log; the section keeps its state.
    } finally {
      setBusy(false)
    }
  }

  const statusText = snapshot === undefined
    ? '…'
    : snapshot.engineRunning
      ? t('running').replace('{port}', String(snapshot.port))
      : t('stopped')

  return (
    <div className={css.section}>
      <div className={css.row}>
        <span className={css.label}>{t('status')}</span>
        <span className={css.value}>{statusText}</span>
      </div>
      <div className={css.row}>
        <span className={css.label}>{t('restart')}</span>
        <button
          className={css.button}
          disabled={busy || !(snapshot?.engineRunning ?? false)}
          onClick={() => { void run(restartEngine) }}
        >
          {t('restart')}
        </button>
      </div>
      <div className={css.row}>
        <label className={css.check}>
          <input
            type="checkbox"
            checked={snapshot?.openAtLogin ?? false}
            onChange={(event) => {
              void run(async () => {
                const accepted = await setLoginItem(event.target.checked)
                setSnapshot(previous => previous === undefined ? previous : { ...previous, openAtLogin: accepted })
              })
            }}
          />
          <span>{t('login')}</span>
        </label>
      </div>
      <div className={css.row}>
        <span className={css.label}>{t('language')}</span>
        <select
          className={css.select}
          value={snapshot?.locale ?? 'zh'}
          onChange={(event) => {
            const locale = event.target.value === 'en' ? 'en' : 'zh'
            void run(async () => {
              await setLocale(locale)
              setSnapshot(previous => previous === undefined ? previous : { ...previous, locale })
            })
          }}
        >
          <option value="zh">中文</option>
          <option value="en">English</option>
        </select>
      </div>
      <div className={css.row}>
        <button className={css.button} disabled={busy} onClick={() => { void run(checkShellUpdates) }}>
          {t('shellUpdates')}
        </button>
      </div>
      <div className={css.row}>
        <button className={css.button} disabled={busy} onClick={() => { void run(checkEngineUpdates) }}>
          {t('engineUpdates')}
        </button>
      </div>
      <div className={css.row}>
        <button className={css.button} disabled={busy} onClick={() => { void run(openMarket) }}>
          {t('market')}
        </button>
      </div>
      <div className={css.row}>
        <button className={css.danger} disabled={busy} onClick={() => { void run(quit) }}>
          {t('quit')}
        </button>
      </div>
    </div>
  )
}
