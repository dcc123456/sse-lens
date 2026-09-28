/**
 * Shared domain types.
 *
 * These shapes cross three boundaries — page (MAIN world) → service worker →
 * side panel — so they are deliberately plain data: no class instances, no
 * `Map`, no `undefined`-only distinctions that would not survive
 * `structuredClone` through `chrome.runtime` messaging.
 *
 * @module lib/types
 */

/** How the stream was observed. Each has different fidelity — see below. */
export type StreamKind = 'fetch' | 'xhr' | 'eventsource'

export type StreamState = 'open' | 'closed' | 'error' | 'aborted'

/**
 * One dispatched SSE frame.
 *
 * `data` holds the *joined* payload: the spec concatenates repeated `data:`
 * fields with `\n`, so a multi-line frame is one event, not several.
 */
export interface SseEvent {
  /** Monotonic index within its stream; stable across quota trimming. */
  seq: number
  /** `Date.now()` at dispatch, which the UI turns into an inter-frame delta. */
  at: number
  /** The `event:` field, defaulting to `message` as the spec requires. */
  event: string
  data: string
  id?: string
  retry?: number
  /**
   * A `:`-prefixed comment line.
   *
   * Kept rather than dropped because comments are how servers send keep-alive
   * heartbeats, and "is the connection still breathing?" is a question this tool
   * exists to answer. Carried as its own field so the UI can style it as
   * background noise instead of mixing it into real payloads.
   */
  comment?: string
  /** Set when the payload hit `maxEventBytes` and was cut. */
  truncated?: boolean
}

/**
 * One observed stream, from request to close.
 *
 * Note the fidelity difference `kind` implies: `fetch` and `xhr` are captured as
 * raw bytes and parsed here, so comments and exact framing survive. An
 * `eventsource` stream is reconstructed from the browser's already-parsed
 * events, so it has no comments and no raw text. The UI states this rather than
 * letting the user assume the server sent no heartbeats.
 */
export interface StreamRecord {
  /** `${tabId}:${frameId}:${counter}` — unique without coordination. */
  id: string
  /**
   * The id the page's own hook uses to name this stream.
   *
   * Stored on the record, and so in `chrome.storage.session`, because it is the
   * only key a restarted worker has for re-linking incoming frames to a record it
   * rehydrated. Without it every stream still open across an eviction orphans its
   * own later frames and silently stops recording — which is what happens whenever
   * a stream idles longer than the ~30s MV3 worker lifetime between frames.
   */
  localId?: string
  tabId: number
  frameId: number
  /** Frame that opened the stream; differs from the tab URL inside an iframe. */
  frameUrl: string
  kind: StreamKind
  method: string
  url: string
  /** Redacted before it ever leaves the page. */
  requestHeaders?: Record<string, string>
  /** Redacted and truncated before it ever leaves the page. */
  requestBody?: string
  status?: number
  statusText?: string
  responseHeaders?: Record<string, string>
  contentType?: string
  startedAt: number
  /** First byte of the response body, for a real TTFB rather than total time. */
  firstByteAt?: number
  endedAt?: number
  state: StreamState
  errorMessage?: string
  /** Response-body bytes seen, including data dropped by quota trimming. */
  bytes: number
  /** Frames dispatched, including any since trimmed. */
  eventCount: number
  events: SseEvent[]
  /** Frames discarded to stay inside quota, so the UI never implies completeness. */
  droppedEvents: number
  /** Text left in the parser at close: an unterminated final frame. */
  tail?: string
  /**
   * Recent raw response text, for the Raw view.
   *
   * Kept on the record rather than in a side map so it survives worker eviction
   * and reaches the panel with the rest of the snapshot. Only the newest slice is
   * retained — the tail is what anyone reads, and holding a whole long stream
   * verbatim would defeat the byte quotas. Absent for `eventsource`, where the
   * browser consumed the bytes before they could be observed.
   */
  rawTail?: string
  /** True when earlier raw text was dropped, so the view can say so. */
  rawTruncated?: boolean
  /**
   * Why this stream could not be parsed, if it could not be.
   *
   * A `blob`/`arraybuffer` XHR is visible but unreadable as text. Recording it
   * with an explanation is strictly better than omitting it, which would look
   * like the tool had missed the request.
   */
  unreadableReason?: string
}

/**
 * What counts as a stream worth capturing.
 *
 * `strict` takes only `text/event-stream`. `loose` additionally considers
 * streaming content types that are conventionally used for SSE-shaped or
 * line-delimited payloads, and confirms by sniffing the first chunk — many LLM
 * gateways serve `text/plain` or `application/octet-stream` while emitting
 * perfectly ordinary `data:` frames.
 */
export type CaptureMode = 'strict' | 'loose'

export type LocaleSetting = 'auto' | 'en' | 'zh-CN'

export interface Settings {
  locale: LocaleSetting
  /** Master switch; when false the page hook stays installed but reports nothing. */
  captureEnabled: boolean
  captureMode: CaptureMode
  /**
   * Substring or `/regex/flags` filter on the request URL. Empty captures all.
   *
   * Applied in the worker, not the page: the page must not have to re-parse a
   * setting on every request, and a filter change should re-apply to what is
   * already recorded rather than only to future streams.
   */
  urlFilter: string
  /** Extra header names to mask, on top of the always-masked built-ins. */
  redactHeaders: string[]
  maxEventsPerStream: number
  maxEventBytes: number
  maxStreamsPerTab: number
  maxTabBytes: number
  /** When false, a top-frame navigation clears that tab's captures. */
  keepAcrossNavigation: boolean
  /** Pre-select the merged-text view for streams that look like LLM deltas. */
  autoMergeDeltas: boolean
}

/**
 * Defaults.
 *
 * The quotas are sized so a pathological stream cannot exhaust
 * `chrome.storage.session` (~10MB) or make the panel unresponsive, while still
 * covering a normal long chat completion (a few thousand tiny frames) without
 * dropping anything.
 */
export const DEFAULT_SETTINGS: Settings = {
  locale: 'auto',
  captureEnabled: true,
  captureMode: 'loose',
  urlFilter: '',
  redactHeaders: [],
  maxEventsPerStream: 2000,
  maxEventBytes: 32 * 1024,
  maxStreamsPerTab: 50,
  maxTabBytes: 8 * 1024 * 1024,
  keepAcrossNavigation: false,
  autoMergeDeltas: true,
}
