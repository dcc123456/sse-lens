/**
 * The stream detail view.
 *
 * Four tabs, each answering a different question:
 *
 * | Tab     | Question it answers                                   |
 * | ------- | ----------------------------------------------------- |
 * | Events  | What frames arrived, in what order, how far apart?     |
 * | Merged  | What did the stream actually *say*?                    |
 * | Raw     | Exactly what bytes came down the wire?                 |
 * | Request | What did we ask for, and what did the server reply?    |
 *
 * The Events tab is the one with a hard engineering constraint: a stream can hold
 * thousands of frames, and rendering them all makes the panel unusable. It is
 * windowed — a slice around the current position, with explicit controls to reach
 * the rest. A plain `.slice(-N)` was rejected because silently hiding earlier
 * frames in a debugging tool invites wrong conclusions.
 *
 * @module panel/StreamDetail
 */

import { useMemo, useState, type ReactNode } from 'react'
import {
  Badge,
  Button,
  CopyButton,
  EmptyState,
  HeaderTable,
  JsonTree,
  Notice,
} from './components'
import {
  allRowsOpen,
  isRowOpen,
  nextBulk,
  setAllRows,
  toggleRow,
  COLLAPSED,
  NO_BULK,
  type BulkSelection,
  type BulkToggle,
} from './bulk'
import { formatBytes, formatDuration, formatOffset, summariseEvent } from './format'
import {
  framingFor,
  frameEvents,
  splitRawFrames,
  type RawFraming,
  type RawFrame,
} from './rawFrames'
import { formatEventData, mergeDeltas, parseEventJson } from '../lib/deltas'
import { exportAsCurl, exportAsJson, exportAsNdjson, suggestFilename } from '../lib/export'
import { ALWAYS_REDACTED_HEADERS } from '../lib/redact'
import { downloadText } from './format'
import type { Translate } from '../lib/i18n'
import type { SseEvent, StreamRecord } from '../lib/types'

type DetailTab = 'events' | 'merged' | 'raw' | 'request'

/**
 * Frames rendered at once.
 *
 * Chosen by feel against a real completion stream: enough that scrolling feels
 * continuous, few enough that expanding several JSON payloads stays responsive.
 */
const WINDOW_SIZE = 80

// --- Events tab --------------------------------------------------------------

/**
 * One frame.
 *
 * Deliberately stateless about being open: `EventsTab` owns that, because a single
 * toggle whose label reflects reality has to be able to ask "is everything open?",
 * and it cannot ask rows that each hold their own answer.
 */
function EventRow({
  event,
  startedAt,
  open,
  onToggle,
  bulk,
  t,
}: {
  event: SseEvent
  startedAt: number
  open: boolean
  onToggle: () => void
  /** Drives the JSON tree inside this row, which does keep local state. */
  bulk: BulkToggle
  t: Translate
}): ReactNode {
  const [asTree, setAsTree] = useState(true)

  /*
   * Parsing stays deferred until the row is open, which is what makes expand-all
   * affordable: a closed row costs nothing, and only the windowed rows can be open.
   */
  const parsed = useMemo(() => (open ? parseEventJson(event.data) : undefined), [open, event.data])
  const formatted = useMemo(() => (open ? formatEventData(event.data) : undefined), [open, event.data])
  const isComment = event.comment !== undefined

  return (
    <div className="event">
      <button type="button" className="event-head" onClick={onToggle} aria-expanded={open}>
        <span className="event-seq">{event.seq}</span>
        {event.event !== 'message' && !isComment && <Badge>{event.event}</Badge>}
        {isComment && <Badge tone="info">{t('eventComment')}</Badge>}
        {event.truncated === true && (
          <Badge tone="warn" title={t('truncatedHint')}>
            {t('truncated')}
          </Badge>
        )}
        <span className="event-summary">{summariseEvent(event.data, event.comment)}</span>
        <span className="event-offset">{formatOffset(event.at, startedAt, t)}</span>
      </button>

      {open && (
        <div className="event-body">
          <div className="event-fields">
            {event.id !== undefined && (
              <Badge>
                {t('eventId')}: {event.id}
              </Badge>
            )}
            {event.retry !== undefined && (
              <Badge>
                {t('eventRetry')}: {event.retry}
              </Badge>
            )}
            <span className="topbar-spacer" />
            {parsed !== undefined && (
              <Button
                onClick={() => setAsTree(!asTree)}
                variant="ghost"
                size="tiny"
                title={asTree ? t('showText') : t('showJson')}
              >
                {asTree ? t('showText') : t('showJson')}
              </Button>
            )}
            <CopyButton text={event.data} label={t('copyEvent')} t={t} size="tiny" />
          </div>

          {isComment ? (
            <pre className="payload plain">{event.comment}</pre>
          ) : parsed !== undefined && asTree ? (
            // The same instruction drives the tree, so one click reveals the
            // payload itself rather than just the row containing it.
            <JsonTree value={parsed} bulk={bulk} />
          ) : (
            <pre className="payload">{formatted?.text ?? event.data}</pre>
          )}
        </div>
      )}
    </div>
  )
}

function EventsTab({ stream, t }: { stream: StreamRecord; t: Translate }): ReactNode {
  /** How many frames beyond the newest window the user has asked to see. */
  const [expanded, setExpanded] = useState(0)

  /**
   * Which rows are open, owned here rather than by each row.
   *
   * Lifting this is what lets one button report the truth: the label can only say
   * "collapse all" if something can actually be asked whether everything is open.
   */
  const [rows, setRows] = useState<BulkSelection>(COLLAPSED)

  /** Drives the JSON tree *inside* each open row; see `bulk.ts` for why it differs. */
  const [treeBulk, setTreeBulk] = useState<BulkToggle>(NO_BULK)

  const total = stream.events.length
  const visibleCount = Math.min(total, WINDOW_SIZE + expanded)
  const start = total - visibleCount
  const visible = stream.events.slice(start)

  const visibleIds = useMemo(() => visible.map((event) => event.seq), [visible])
  const everythingOpen = allRowsOpen(rows, visibleIds)

  /** One button: it does whatever its label says. */
  const toggleAll = (): void => {
    const open = !everythingOpen
    setRows(setAllRows(open))
    setTreeBulk((current) => nextBulk(current, open))
  }

  if (total === 0) {
    return (
      <EmptyState
        title={stream.state === 'open' ? t('waitingForStreams') : t('noStreams')}
        hint={stream.unreadableReason === undefined ? undefined : t('unreadable', {
          reason: stream.unreadableReason,
        })}
      />
    )
  }

  return (
    <div>
      {/*
       * Sticky: the point of this button is reaching it without scrolling back up
       * through the frames it just opened.
       */}
      <div className="event-toolbar">
        <Button
          onClick={toggleAll}
          variant="ghost"
          size="tiny"
          title={t('bulkScope', { shown: visible.length, total })}
        >
          {/* The caret states the resulting direction, so the button reads as an
              action rather than as a description of the present state. */}
          {everythingOpen ? `▴ ${t('collapseAll')}` : `▾ ${t('expandAll')}`}
        </Button>
        <span className="topbar-spacer" />
        {/* States how many rows the button actually affects: a long stream is
            windowed, and the frames outside the window are not mounted. */}
        <span className="faint small mono" title={t('bulkScope', { shown: visible.length, total })}>
          {visible.length}/{total}
        </span>
      </div>

      {stream.droppedEvents > 0 && (
        <Notice tone="warn" title={t('droppedEvents', { count: stream.droppedEvents })}>
          {t('droppedEventsHint')}
        </Notice>
      )}

      {stream.kind === 'eventsource' && <Notice tone="info">{t('eventSourceCaveat')}</Notice>}

      {/* Explicit rather than silent: hidden frames must be reachable. */}
      {start > 0 && (
        <button
          type="button"
          className="window-toggle"
          onClick={() => setExpanded(expanded + WINDOW_SIZE)}
        >
          {t('olderEventsHidden', { count: start })}
        </button>
      )}

      {visible.map((event) => (
        <EventRow
          key={event.seq}
          event={event}
          startedAt={stream.startedAt}
          open={isRowOpen(rows, event.seq)}
          onToggle={() => setRows((current) => toggleRow(current, event.seq))}
          bulk={treeBulk}
          t={t}
        />
      ))}

      {stream.tail !== undefined && (
        <Notice tone="warn" title={t('tailPending')}>
          <div>{t('tailPendingHint')}</div>
          <pre className="payload plain">{stream.tail}</pre>
        </Notice>
      )}
    </div>
  )
}

// --- Merged tab --------------------------------------------------------------

function MergedTab({ stream, t }: { stream: StreamRecord; t: Translate }): ReactNode {
  const merged = useMemo(() => mergeDeltas(stream.events), [stream.events])

  if (!merged) {
    return <EmptyState title={t('mergedEmpty')} hint={t('mergedEmptyHint')} />
  }

  return (
    <div style={{ padding: 10 }}>
      <div className="row wrap" style={{ marginBottom: 8 }}>
        {/* Naming the source path is what makes an automatic merge trustworthy:
            the reader can check the guess rather than taking it on faith. */}
        <Badge tone="info" title={merged.path}>
          {t('mergedFrom', { path: merged.path })}
        </Badge>
        {merged.style === 'cumulative' && <Badge tone="warn">cumulative</Badge>}
        <span className="faint small mono">
          {merged.contributingEvents} {t('events')}
        </span>
        <span className="topbar-spacer" />
        <CopyButton text={merged.text} label={t('copyMerged')} t={t} size="tiny" />
      </div>
      <pre className="payload plain" style={{ maxHeight: 'none' }}>
        {merged.text}
      </pre>
    </div>
  )
}

// --- Raw tab -----------------------------------------------------------------

/**
 * One frame of the retained raw text, in the Raw tab's JSON view.
 *
 * The row is the Events tab's row: same classes, same caret, same tree, because
 * the two views show the same payload and reading them differently would be a
 * puzzle for no benefit. It differs in what it is built from — this frame is cut
 * out of the wire text here, not handed over already parsed — and in showing the
 * block's own text whenever the format yields no payload for it.
 */
function RawFrameRow({
  frame,
  framing,
  index,
  open,
  onToggle,
  bulk,
  t,
}: {
  frame: RawFrame
  framing: RawFraming
  index: number
  open: boolean
  onToggle: () => void
  bulk: BulkToggle
  t: Translate
}): ReactNode {
  const [asTree, setAsTree] = useState(true)

  /*
   * Parsing waits for the click. The retained tail can hold thousands of frames,
   * and an expand-all that JSON.parsed every one of them is the cost the Events
   * tab windows to avoid — so a closed row here stays as cheap as one there.
   */
  const parsed = useMemo(
    () => (open ? frameEvents(frame, framing)[0] : undefined),
    [open, frame, framing],
  )
  const json = useMemo(
    () => (open && parsed !== undefined ? parseEventJson(parsed.data) : undefined),
    [open, parsed],
  )
  const isComment = parsed?.comment !== undefined

  return (
    <div className="event">
      <button type="button" className="event-head" onClick={onToggle} aria-expanded={open}>
        <span className="event-seq">{index}</span>
        {parsed !== undefined && parsed.event !== 'message' && !isComment && (
          <Badge>{parsed.event}</Badge>
        )}
        {isComment && <Badge tone="info">{t('eventComment')}</Badge>}
        {/* Stated on the row: this block never ended, so anything inside it is
            what the stream got to, not a frame the server completed. */}
        {!frame.complete && <Badge tone="warn">{t('tailPending')}</Badge>}
        <span className="event-summary">
          {summariseEvent(parsed?.data ?? frame.text, parsed?.comment)}
        </span>
      </button>

      {open && (
        <div className="event-body">
          <div className="event-fields">
            {parsed?.id !== undefined && (
              <Badge>
                {t('eventId')}: {parsed.id}
              </Badge>
            )}
            {parsed?.retry !== undefined && (
              <Badge>
                {t('eventRetry')}: {parsed.retry}
              </Badge>
            )}
            <span className="topbar-spacer" />
            {json !== undefined && (
              <Button
                onClick={() => setAsTree(!asTree)}
                variant="ghost"
                size="tiny"
                title={asTree ? t('showText') : t('showJson')}
              >
                {asTree ? t('showText') : t('showJson')}
              </Button>
            )}
            <CopyButton text={frame.text} label={t('copyEvent')} t={t} size="tiny" />
          </div>

          {isComment ? (
            <pre className="payload plain">{parsed?.comment}</pre>
          ) : json !== undefined && asTree ? (
            <JsonTree value={json} bulk={bulk} />
          ) : (
            // Not JSON, or the bytes themselves: either way this is the block as
            // it arrived, which is the one thing this tab guarantees.
            <pre className="payload">{frame.text}</pre>
          )}
        </div>
      )}
    </div>
  )
}

function RawTab({
  stream,
  raw,
  rawTruncated,
  t,
}: {
  stream: StreamRecord
  raw: string
  rawTruncated: boolean
  t: Translate
}): ReactNode {
  /*
   * Bytes are the default. This tab exists to answer "what actually came down
   * the wire", and reformatting it by default would make the answer a summary —
   * which is the other tab. JSON is one click away.
   */
  const [asTree, setAsTree] = useState(false)
  const [rows, setRows] = useState<BulkSelection>(COLLAPSED)
  const [treeBulk, setTreeBulk] = useState<BulkToggle>(NO_BULK)
  const [expanded, setExpanded] = useState(0)

  const framing = useMemo(() => framingFor(raw), [raw])
  const frames = useMemo(
    () => (asTree ? splitRawFrames(raw, framing) : []),
    [asTree, raw, framing],
  )

  const total = frames.length
  const visibleCount = Math.min(total, WINDOW_SIZE + expanded)
  const start = total - visibleCount
  const visibleIds = useMemo(() => frames.slice(start).map((_, i) => i + start), [frames, start])
  const everythingOpen = allRowsOpen(rows, visibleIds)

  const toggleAll = (): void => {
    const open = !everythingOpen
    setRows(setAllRows(open))
    setTreeBulk((current) => nextBulk(current, open))
  }

  if (stream.kind === 'eventsource') {
    return <Notice tone="info" title={t('tabRaw')}>{t('eventSourceCaveat')}</Notice>
  }
  if (raw === '') {
    return <EmptyState title={t('rawEmpty')} />
  }

  if (!asTree) {
    return (
      <div style={{ padding: 10 }}>
        <div className="row" style={{ marginBottom: 8 }}>
          <span className="faint small mono">{formatBytes(stream.bytes, t)}</span>
          <span className="topbar-spacer" />
          <Button
            onClick={() => setAsTree(true)}
            variant="ghost"
            size="tiny"
            title={t('showJson')}
          >
            {t('showJson')}
          </Button>
          <CopyButton text={raw} label={t('copyMerged')} t={t} size="tiny" />
        </div>
        {/* Stated rather than implied: a slice presented as the whole response
            would make someone conclude the server sent less than it did. */}
        {rawTruncated && <Notice tone="warn">{t('rawTruncatedHead')}</Notice>}
        <pre className="payload" style={{ maxHeight: 'none' }}>
          {raw}
        </pre>
      </div>
    )
  }

  return (
    <div>
      <div className="event-toolbar">
        <Button
          onClick={toggleAll}
          variant="ghost"
          size="tiny"
          title={t('bulkScope', { shown: visibleIds.length, total })}
        >
          {everythingOpen ? `▴ ${t('collapseAll')}` : `▾ ${t('expandAll')}`}
        </Button>
        {/* Back to the bytes. Its own button rather than a second label on the
            bulk one, because the two answer different questions. */}
        <Button onClick={() => setAsTree(false)} variant="ghost" size="tiny" title={t('showText')}>
          {t('showText')}
        </Button>
        <span className="topbar-spacer" />
        <span
          className="faint small mono"
          title={t('bulkScope', { shown: visibleIds.length, total })}
        >
          {visibleIds.length}/{total}
        </span>
      </div>

      {rawTruncated && <Notice tone="warn">{t('rawTruncatedHead')}</Notice>}

      {/* Frame numbers are within the retained text, which the notice above is
          the reason for: an absolute index would imply a cut tail starts at 0. */}
      {start > 0 && (
        <button
          type="button"
          className="window-toggle"
          onClick={() => setExpanded(expanded + WINDOW_SIZE)}
        >
          {t('olderEventsHidden', { count: start })}
        </button>
      )}

      {frames.slice(start).map((frame, offset) => {
        const index = start + offset
        return (
          <RawFrameRow
            key={index}
            frame={frame}
            framing={framing}
            index={index}
            open={isRowOpen(rows, index)}
            onToggle={() => setRows((current) => toggleRow(current, index))}
            bulk={treeBulk}
            t={t}
          />
        )
      })}
    </div>
  )
}

// --- Request tab -------------------------------------------------------------

function RequestTab({ stream, t }: { stream: StreamRecord; t: Translate }): ReactNode {
  return (
    <div style={{ padding: 10 }}>
      <div className="row wrap" style={{ marginBottom: 10 }}>
        <CopyButton
          text={() => exportAsCurl(stream, { multiline: true })}
          label={t('copyAsCurl')}
          t={t}
          size="tiny"
        />
        <Button
          onClick={() => downloadText(suggestFilename(stream, 'json'), exportAsJson(stream), 'application/json')}
          variant="ghost"
          size="tiny"
        >
          {t('exportJson')}
        </Button>
        <Button
          onClick={() =>
            downloadText(suggestFilename(stream, 'ndjson'), exportAsNdjson(stream), 'application/x-ndjson')
          }
          variant="ghost"
          size="tiny"
        >
          {t('exportNdjson')}
        </Button>
      </div>

      <Notice tone="info">{t('redactedNote')}</Notice>

      <div className="settings-group">
        <div className="settings-group-title">{t('requestHeaders')}</div>
        <HeaderTable headers={stream.requestHeaders} emptyLabel={t('noHeaders')} />
      </div>

      <div className="settings-group">
        <div className="settings-group-title">{t('requestBody')}</div>
        {stream.requestBody === undefined || stream.requestBody === '' ? (
          <div className="dim small">{t('noRequestBody')}</div>
        ) : (
          <pre className="payload">{stream.requestBody}</pre>
        )}
      </div>

      <div className="settings-group">
        <div className="settings-group-title">{t('responseHeaders')}</div>
        <HeaderTable headers={stream.responseHeaders} emptyLabel={t('noHeaders')} />
      </div>

      <div className="faint small">
        {t('settingsAlwaysRedacted')}: {ALWAYS_REDACTED_HEADERS.join(', ')}
      </div>
    </div>
  )
}

// --- Shell -------------------------------------------------------------------

export function StreamDetail({
  stream,
  raw,
  rawTruncated,
  onBack,
  onClear,
  t,
}: {
  stream: StreamRecord
  raw: string
  rawTruncated: boolean
  onBack: () => void
  onClear: () => void
  t: Translate
}): ReactNode {
  const [tab, setTab] = useState<DetailTab>('events')

  const duration =
    stream.endedAt === undefined ? undefined : stream.endedAt - stream.startedAt
  const ttfb =
    stream.firstByteAt === undefined ? undefined : stream.firstByteAt - stream.startedAt

  return (
    <div className="app">
      <div className="detail-head">
        <div className="row">
          <Button onClick={onBack} variant="ghost" size="tiny">
            ← {stream.method}
          </Button>
          {stream.status !== undefined && (
            <Badge tone={stream.status >= 400 ? 'error' : undefined}>
              {stream.status} {stream.statusText}
            </Badge>
          )}
          <span className="topbar-spacer" />
          <Button onClick={onClear} variant="ghost" size="tiny" title={t('clearAll')}>
            ✕
          </Button>
        </div>

        <div className="detail-url" title={stream.url}>
          {stream.url}
        </div>

        <div className="stat-grid">
          <div>
            <span className="stat-label">{t('events')}: </span>
            <span className="stat-value">{stream.eventCount}</span>
          </div>
          <div>
            <span className="stat-label">{t('bytes')}: </span>
            <span className="stat-value">{formatBytes(stream.bytes, t)}</span>
          </div>
          {ttfb !== undefined && (
            <div>
              <span className="stat-label">{t('timeToFirstByte')}: </span>
              <span className="stat-value">{formatDuration(ttfb, t)}</span>
            </div>
          )}
          {duration !== undefined && (
            <div>
              <span className="stat-label">{t('duration')}: </span>
              <span className="stat-value">{formatDuration(duration, t)}</span>
            </div>
          )}
        </div>

        {stream.errorMessage !== undefined && (
          <div className="small" style={{ marginTop: 6, color: 'var(--danger)' }}>
            {stream.errorMessage}
          </div>
        )}
        {stream.unreadableReason !== undefined && (
          <div className="small" style={{ marginTop: 6, color: 'var(--warn)' }}>
            {t('unreadable', { reason: stream.unreadableReason })}
          </div>
        )}
      </div>

      <div className="tabbar" role="tablist">
        {(
          [
            ['events', t('tabEvents')],
            ['merged', t('tabMerged')],
            ['raw', t('tabRaw')],
            ['request', t('tabRequest')],
          ] as const
        ).map(([key, label]) => (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={tab === key}
            onClick={() => setTab(key)}
          >
            {label}
          </button>
        ))}
      </div>

      <div className="scroll">
        {tab === 'events' && <EventsTab stream={stream} t={t} />}
        {tab === 'merged' && <MergedTab stream={stream} t={t} />}
        {tab === 'raw' && <RawTab stream={stream} raw={raw} rawTruncated={rawTruncated} t={t} />}
        {tab === 'request' && <RequestTab stream={stream} t={t} />}
      </div>
    </div>
  )
}
