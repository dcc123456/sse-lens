/**
 * The stream list.
 *
 * Each row must convey, in two lines within ~360px: what the request was, whether
 * it is still running, and how much has arrived. That budget is why the URL shows
 * its *tail* rather than its head — `/v1/chat/completions` identifies a stream and
 * `https://api.openai...` does not, and every stream in a capture usually shares
 * the host anyway.
 *
 * @module panel/StreamList
 */

import type { ReactNode } from 'react'
import { Badge } from './components'
import { formatBytes, formatClock, shortenUrl, stateLabel, urlHost } from './format'
import type { Translate } from '../lib/i18n'
import type { StreamRecord } from '../lib/types'

/** Tone for the state badge. `open` is the only one that reads as good news. */
function toneFor(state: StreamRecord['state']): 'open' | 'error' | 'aborted' | undefined {
  switch (state) {
    case 'open':
      return 'open'
    case 'error':
      return 'error'
    case 'aborted':
      return 'aborted'
    default:
      return undefined
  }
}

function StreamRow({
  stream,
  selected,
  onSelect,
  t,
}: {
  stream: StreamRecord
  selected: boolean
  onSelect: () => void
  t: Translate
}): ReactNode {
  const host = urlHost(stream.url)
  const short = shortenUrl(stream.url)

  return (
    <button type="button" className="stream-row" aria-current={selected} onClick={onSelect}>
      <div className="stream-row-head">
        <span className="stream-method">{stream.method}</span>
        {/*
         * The full URL goes in `title`: the visible text is clipped, and a
         * debugging tool must never make a value unreachable.
         */}
        <span className="stream-url" title={stream.url}>
          {/* Bidi isolation, so an RTL character in a path cannot reorder the row. */}
          &#8296;{short}&#8297;
        </span>
      </div>

      <div className="stream-row-meta">
        <Badge tone={toneFor(stream.state)}>{stateLabel(stream.state, t)}</Badge>

        {stream.status !== undefined && stream.status >= 400 && (
          <Badge tone="error">{stream.status}</Badge>
        )}

        {/* Labelled only when it is not the ordinary case, to save width. */}
        {stream.kind === 'eventsource' && (
          <Badge tone="info" title={t('eventSourceCaveat')}>
            ES
          </Badge>
        )}
        {stream.kind === 'xhr' && <Badge>XHR</Badge>}

        <span className="mono">
          {stream.eventCount} {t('events')}
        </span>
        <span className="faint mono">{formatBytes(stream.bytes, t)}</span>
        <span className="topbar-spacer" />
        <span className="faint mono">{formatClock(stream.startedAt)}</span>
      </div>

      {host !== '' && (
        <div className="stream-row-meta faint clip" title={host}>
          {host}
        </div>
      )}
    </button>
  )
}

export function StreamList({
  streams,
  selectedId,
  onSelect,
  t,
}: {
  streams: readonly StreamRecord[]
  selectedId: string | null
  onSelect: (streamId: string) => void
  t: Translate
}): ReactNode {
  return (
    <div className="stream-list">
      {streams.map((stream) => (
        <StreamRow
          key={stream.id}
          stream={stream}
          selected={stream.id === selectedId}
          onSelect={() => onSelect(stream.id)}
          t={t}
        />
      ))}
    </div>
  )
}
