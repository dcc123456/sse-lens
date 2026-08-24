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
import { Button, ConfirmButton, EmptyState, Notice } from './components'
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

  /**
   * What the last attach attempt achieved.
   *
   * Deliberately three outcomes, not two. "Already listening" is reported plainly
   * because it means a missed stream had a *different* cause — the page captured
   * `fetch` before the hook ran — and only a reload can fix that. Collapsing it
   * into a cheerful "attached" would send the user to trigger the stream again and
   * watch it be missed a second time with no explanation.
   */
  const attachOutcome = (): ReactNode => {
    const result = controller.attachResult
    if (result === null) return null

    if (!result.ok) {
      return (
        <Notice tone="warn" title={t('attachFailed')}>
          {result.reason === 'restricted' ? t('attachFailedRestricted') : t('attachLimits')}
        </Notice>
      )
    }
    return result.attached ? (
      <Notice tone="info" title={t('attachOk')}>
        {t('attachOkHint')}
      </Notice>
    ) : (
      <Notice tone="warn" title={t('attachAlready')}>
        {t('attachAlreadyHint')}
      </Notice>
    )
  }

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
      case 'noHook':
        /*
         * Recoverable, unlike the cases above: Chrome never injected into this
         * tab because it predates the extension. Previously this looked like an
         * ordinary empty list, so the extension appeared broken.
         */
        return (
          <>
            <Notice tone="warn" title={t('unavailableNoHook')}>
              {t('unavailableNoHookHint')}
            </Notice>
            <div className="attach-actions">
              <Button onClick={controller.attach} disabled={controller.attaching}>
                {controller.attaching ? t('attaching') : t('attachNow')}
              </Button>
              <Button variant="ghost" onClick={() => void chrome.tabs.reload()}>
                {t('reloadHint')}
              </Button>
            </div>
            {/* The limits are stated up front, not only after a failure: a user
                who expects a running stream to be recovered would otherwise read
                a successful attach as a bug. */}
            <p className="faint small attach-note">{t('attachLimits')}</p>
          </>
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

        {/*
         * Always reachable, not only on the empty state: a page that *was*
         * captured can still be re-attached after an extension reload, and the
         * empty-state button is invisible once the first stream has arrived.
         */}
        {screen === 'streams' &&
          state.tab !== null &&
          state.unavailableReason !== 'restricted' &&
          state.unavailableReason !== 'disabled' && (
            <Button
              variant="ghost"
              size="tiny"
              onClick={controller.attach}
              disabled={controller.attaching}
              title={t('attachNow')}
            >
              {controller.attaching ? t('attaching') : '⊕'}
            </Button>
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

            {/* Outside the empty-state branch: once an attach succeeds and a
                stream arrives, the outcome still explains why the list changed. */}
            {attachOutcome()}

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
