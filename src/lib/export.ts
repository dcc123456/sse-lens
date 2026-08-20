/**
 * Exporting a capture.
 *
 * Three formats, each answering a different question:
 *
 * - **JSON** — the whole record, for filing in a bug report or diffing two runs.
 * - **NDJSON** — one frame per line, for piping into `jq` or a script.
 * - **curl** — reproduce the request outside the browser, which is what someone
 *   wants the moment they suspect the client rather than the server.
 *
 * The curl builder has the sharpest constraint: the headers in a record are
 * *already masked*, so the command it produces cannot work as-is. Emitting it
 * silently would waste someone's time debugging a 401. So masked values are
 * replaced with an obvious placeholder and the command carries a comment saying
 * so — an export that announces what it is missing is far more useful than one
 * that looks complete and is not.
 *
 * @module lib/export
 */

import type { SseEvent, StreamRecord } from './types'

/** Marker the redaction layer leaves in place of a secret. */
const MASK_HINT = '•'

/** What the placeholder for a masked header looks like in a curl command. */
const PLACEHOLDER = '<REDACTED — fill in the real value>'

/** A record, minus the fields that only make sense inside the extension. */
export interface ExportedStream {
  url: string
  method: string
  kind: StreamRecord['kind']
  state: StreamRecord['state']
  status?: number
  statusText?: string
  contentType?: string
  requestHeaders?: Record<string, string>
  requestBody?: string
  responseHeaders?: Record<string, string>
  startedAt: string
  firstByteAt?: string
  endedAt?: string
  durationMs?: number
  bytes: number
  eventCount: number
  droppedEvents: number
  errorMessage?: string
  unreadableReason?: string
  tail?: string
  events: ExportedEvent[]
  note: string
}

export interface ExportedEvent {
  seq: number
  /** Milliseconds since the stream started, which is what matters when reading. */
  offsetMs: number
  event: string
  data: string
  id?: string
  retry?: number
  comment?: string
  truncated?: boolean
}

function iso(at: number | undefined): string | undefined {
  if (at === undefined) return undefined
  try {
    return new Date(at).toISOString()
  } catch {
    return undefined
  }
}

/**
 * Describes what this export does and does not contain.
 *
 * Embedded in the file rather than only shown in the UI, because an export
 * outlives the session it came from — the person reading it later, possibly in a
 * bug tracker, has no other way to know that headers were masked or that an
 * `EventSource` capture cannot include comments.
 */
function buildNote(record: StreamRecord): string {
  const parts = [
    'Captured by SSE Lens. Sensitive header and body values were masked before leaving the page.',
  ]
  if (record.kind === 'eventsource') {
    parts.push(
      'Captured via EventSource: comments, retry directives and exact framing are absent because the browser had already parsed the stream.',
    )
  }
  if (record.droppedEvents > 0) {
    parts.push(
      `${record.droppedEvents} earlier events were dropped to stay within the configured limit; eventCount reflects the true total.`,
    )
  }
  if (record.tail !== undefined) {
    parts.push('The stream ended mid-event; the unterminated remainder is in "tail".')
  }
  return parts.join(' ')
}

/** Converts a record into its serialisable form. */
export function toExportedStream(record: StreamRecord): ExportedStream {
  const exported: ExportedStream = {
    url: record.url,
    method: record.method,
    kind: record.kind,
    state: record.state,
    startedAt: iso(record.startedAt) ?? String(record.startedAt),
    bytes: record.bytes,
    eventCount: record.eventCount,
    droppedEvents: record.droppedEvents,
    events: record.events.map((event) => toExportedEvent(event, record.startedAt)),
    note: buildNote(record),
  }

  if (record.status !== undefined) exported.status = record.status
  if (record.statusText !== undefined) exported.statusText = record.statusText
  if (record.contentType !== undefined) exported.contentType = record.contentType
  if (record.requestHeaders) exported.requestHeaders = record.requestHeaders
  if (record.requestBody !== undefined) exported.requestBody = record.requestBody
  if (record.responseHeaders) exported.responseHeaders = record.responseHeaders
  if (record.firstByteAt !== undefined) exported.firstByteAt = iso(record.firstByteAt)
  if (record.endedAt !== undefined) {
    exported.endedAt = iso(record.endedAt)
    exported.durationMs = record.endedAt - record.startedAt
  }
  if (record.errorMessage !== undefined) exported.errorMessage = record.errorMessage
  if (record.unreadableReason !== undefined) exported.unreadableReason = record.unreadableReason
  if (record.tail !== undefined) exported.tail = record.tail

  return exported
}

function toExportedEvent(event: SseEvent, startedAt: number): ExportedEvent {
  const exported: ExportedEvent = {
    seq: event.seq,
    // Relative, because absolute timestamps are unreadable when what you care
    // about is the gap between two frames.
    offsetMs: Math.max(0, event.at - startedAt),
    event: event.event,
    data: event.data,
  }
  if (event.id !== undefined) exported.id = event.id
  if (event.retry !== undefined) exported.retry = event.retry
  if (event.comment !== undefined) exported.comment = event.comment
  if (event.truncated) exported.truncated = true
  return exported
}

/** Serialises one stream as indented JSON. */
export function exportAsJson(record: StreamRecord): string {
  return JSON.stringify(toExportedStream(record), null, 2)
}

/** Serialises several streams as one JSON document. */
export function exportAllAsJson(records: readonly StreamRecord[]): string {
  return JSON.stringify(
    {
      exportedAt: new Date().toISOString(),
      tool: 'SSE Lens',
      streamCount: records.length,
      streams: records.map(toExportedStream),
    },
    null,
    2,
  )
}

/**
 * Serialises the frames as NDJSON, one object per line.
 *
 * The stream metadata leads as a `meta` line rather than being omitted: a bare
 * list of frames loses the URL and status, which is the first thing anyone asks
 * when handed one. Consumers that only want frames can filter on the `type` key.
 */
export function exportAsNdjson(record: StreamRecord): string {
  const lines: string[] = [
    JSON.stringify({
      type: 'meta',
      url: record.url,
      method: record.method,
      kind: record.kind,
      status: record.status,
      state: record.state,
      startedAt: iso(record.startedAt),
      eventCount: record.eventCount,
      droppedEvents: record.droppedEvents,
      note: buildNote(record),
    }),
  ]
  for (const event of record.events) {
    lines.push(JSON.stringify({ type: 'event', ...toExportedEvent(event, record.startedAt) }))
  }
  if (record.tail !== undefined) {
    lines.push(JSON.stringify({ type: 'tail', data: record.tail }))
  }
  return `${lines.join('\n')}\n`
}

/** True when a value has been masked and cannot be used verbatim. */
function isMasked(value: string): boolean {
  return value.includes(MASK_HINT)
}

/**
 * Quotes a value for a POSIX shell.
 *
 * Single quotes, with the standard `'\''` escape for embedded single quotes.
 * Double quotes would leave `$`, backticks and `\` live, so a JSON body
 * containing any of them would be mangled by the shell — or, worse, execute.
 */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

export interface CurlOptions {
  /** Emits `\` line continuations. Off for a one-line copy. */
  multiline?: boolean
}

/**
 * Builds a curl command for a captured request.
 *
 * `--no-buffer` is included because without it curl buffers the output and a
 * streaming response appears to hang — the single most confusing thing that can
 * happen when someone reproduces an SSE request on the command line.
 */
export function exportAsCurl(record: StreamRecord, options: CurlOptions = {}): string {
  const parts: string[] = ['curl']
  let hasMaskedHeader = false

  if (record.method !== 'GET') parts.push('-X', record.method)
  parts.push(shellQuote(record.url))

  for (const [name, value] of Object.entries(record.requestHeaders ?? {})) {
    const lower = name.toLowerCase()
    // Curl sets these itself, and a stale value breaks the request.
    if (lower === 'content-length' || lower === 'host') continue
    if (isMasked(value)) {
      hasMaskedHeader = true
      parts.push('-H', shellQuote(`${name}: ${PLACEHOLDER}`))
      continue
    }
    parts.push('-H', shellQuote(`${name}: ${value}`))
  }

  if (record.requestBody !== undefined && record.requestBody !== '') {
    if (isMasked(record.requestBody)) hasMaskedHeader = true
    parts.push('--data-raw', shellQuote(record.requestBody))
  }

  // Without this, curl buffers and the stream looks like it has hung.
  parts.push('--no-buffer')

  const command = options.multiline ? parts.join(' \\\n  ') : parts.join(' ')
  if (!hasMaskedHeader) return command

  // A command that silently cannot work wastes more time than no command at all.
  return `# Redacted values must be filled in before this will work.\n${command}`
}

/** A filename that sorts chronologically and survives every filesystem. */
export function suggestFilename(record: StreamRecord, extension: 'json' | 'ndjson'): string {
  let host = 'stream'
  try {
    host = new URL(record.url).hostname.replace(/[^a-z0-9.-]/gi, '-')
  } catch {
    // Keep the fallback.
  }
  const stamp = new Date(record.startedAt).toISOString().replace(/[:.]/g, '-').slice(0, 19)
  return `sse-${host}-${stamp}.${extension}`
}
