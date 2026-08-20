/**
 * The panel shell.
 *
 * Two views — a stream list and one stream's detail — rather than a master/detail
 * split, because at ~360px there is no room for both. The list gives way to the
 * detail and comes back via an explicit back button.
 *
 * The empty state gets unusual care. "No streams" has several very different
 * causes, and a single generic message would send someone hunting for a bug that
 * is really a restricted page, a disabled capture, or a hook that attached after
 * the page had already opened its stream. Each cause is named, with the action
 * that fixes it.
 *
 * @module panel/App
 */

import { useMemo, type ReactNode } from 'react'
import { ConfirmButton, EmptyState, Notice } from './components'
import { SettingsTab } from './SettingsTab'
import { StreamDetail } from './StreamDetail'
import { StreamList } from './StreamList'
import { usePanelState } from './usePanelState'
import { browserLanguages, createTranslate, resolveLocale } from '../lib/i18n'
import { useState } from 'react'

type Screen = 'streams' | 'settings'

export function App(): ReactNode {
  const controller = usePanelState()
  const [screen, setScreen] = useState<Screen>('streams')

  const { state, loading, error, selected, selectedId } = controller

  // The browser language list never changes within a session, so resolving it once
  // avoids re-deriving the translator on every render.
  const languages = useMemo(() => browserLanguages(), [])
  const locale = resolveLocale(state.settings.locale, languages)
  const t = useMemo(() => createTranslate(locale), [locale])

  const capturing = state.settings.captureEnabled && state.unavailableReason === undefined

  /** Names the specific reason nothing is listed, with the fix for it. */
  const emptyExplanation = (): ReactNode => {
    if (state.tab === null) {
      return <EmptyState title={t('unavailableNoTab')} />
    }
    switch (state.unavailableReason) {
      case 'restricted':
        return (
          <Notice tone="warn" title={t('unavailableRestricted')}>
            {t('unavailableRestrictedHint')}
          </Notice>
        )
      case 'disabled':
        return (
          <Notice title={t('unavailableDisabled')}>{t('unavailableDisabledHint')}</Notice>
        )
      default:
        // Nothing is wrong; the page simply has not streamed yet. The reload hint
        // matters because a hook that attached after the page captured `fetch`
        // cannot see anything, and that is invisible without being told.
        return <EmptyState title={t('noStreams')} hint={t('noStreamsHint')} />
    }
  }

  if (selected !== undefined && screen === 'streams') {
    return (
      <StreamDetail
        stream={selected}
        raw={selected.rawTail ?? ''}
        rawTruncated={selected.rawTruncated === true}
        onBack={() => controller.select(null)}
        onClear={() => controller.clearStream(selected.id)}
        t={t}
      />
    )
  }

  return (
    <div className="app">
      <div className="topbar">
        <span className={capturing ? 'status-dot live' : 'status-dot'} />
        <span className="topbar-title">{t('appName')}</span>
        <span className="topbar-spacer" />

        {screen === 'streams' && state.streams.length > 0 && (
          <ConfirmButton
            label={t('clearAll')}
            confirmLabel={t('clearAllConfirm')}
            onConfirm={controller.clearAll}
          />
        )}

        <button
          type="button"
          className="btn ghost"
          onClick={() => setScreen(screen === 'settings' ? 'streams' : 'settings')}
          title={t('settings')}
          aria-pressed={screen === 'settings'}
        >
          {screen === 'settings' ? '←' : '⚙'}
        </button>
      </div>

      {screen === 'settings' ? (
        <div className="scroll">
          <SettingsTab settings={state.settings} onChange={controller.updateSettings} t={t} />
        </div>
      ) : (
        <>
          {state.tab !== null && (
            <div className="topbar" style={{ borderBottom: '1px solid var(--border)' }}>
              <span className="clip small dim" title={state.tab.url}>
                {state.tab.title === '' ? state.tab.url : state.tab.title}
              </span>
            </div>
          )}

          <div className="scroll">
            {error !== null && (
              <Notice tone="warn" title="Service worker unavailable">
                {error}
              </Notice>
            )}

            {/* `loading` is checked before the empty state so a slow first
                snapshot never flashes a misleading "nothing captured". */}
            {loading ? (
              <EmptyState title={t('waitingForStreams')} />
            ) : state.streams.length === 0 ? (
              emptyExplanation()
            ) : (
              <StreamList
                streams={state.streams}
                selectedId={selectedId}
                onSelect={controller.select}
                t={t}
              />
            )}
          </div>
        </>
      )}
    </div>
  )
}
