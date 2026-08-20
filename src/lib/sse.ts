/**
 * Server-Sent Events framing.
 *
 * This is the one place in the extension that decides what a "frame" is, and it
 * follows the WHATWG `EventSource` stream-processing rules rather than the
 * pragmatic `split('\n\n')` shortcut most clients use. The shortcut is wrong in
 * ways that matter to a debugging tool:
 *
 * - A lone `\r` is a valid line terminator, so `data: a\rdata: b\r\r` is two
 *   fields and one dispatch. Splitting on `\n\n` sees a single unterminated line.
 * - `field:value` with no space is legal; exactly *one* leading space after the
 *   colon is stripped, and further spaces are payload. Trimming instead (as an
 *   LLM client can get away with) silently corrupts indented JSON and any
 *   payload with meaningful trailing whitespace.
 * - A line with no colon is a field with an empty value, so a bare `data` line
 *   appends an empty string — visible as a blank line in a multi-line payload.
 * - `id` containing NUL must be ignored, and `retry` must be all ASCII digits.
 *
 * The parser is a pure, incremental state machine: {@link SseParser.push} takes
 * arbitrarily-cut chunks and returns only the frames that completed. It has no
 * DOM or network dependency, which is what makes the framing rules testable
 * without a server.
 *
 * @module lib/sse
 */

import type { SseEvent } from './types'

/** Options that need to match the user's quota settings. */
export interface SseParserOptions {
  /** Payload bytes kept per frame; longer payloads are cut and flagged. */
  maxEventBytes?: number
  /** First `seq` to assign. Lets a resumed parser continue a numbering run. */
  startSeq?: number
  /** Injectable clock, so tests can assert inter-frame deltas. */
  now?: () => number
}

const DEFAULT_MAX_EVENT_BYTES = 32 * 1024

export class SseParser {
  /** Bytes of an incomplete trailing line, held until its terminator arrives. */
  private buffer = ''
  private seq: number
  private readonly maxEventBytes: number
  private readonly now: () => number

  /**
   * True until the first character is examined.
   *
   * The spec strips one leading U+FEFF from the *stream*, not from each chunk, so
   * this has to be remembered across `push` calls.
   */
  private atStreamStart = true

  /**
   * A `\r` may be a bare terminator or the first half of `\r\n`, and the two are
   * indistinguishable until the next character arrives — which may be in the next
   * network chunk. When a chunk ends on `\r`, the line is dispatched and this flag
   * makes the following `\n` a no-op instead of a spurious blank line (which
   * would dispatch an empty frame).
   */
  private pendingCr = false

  // --- Fields of the event under construction --------------------------------
  private dataLines: string[] = []
  private hasData = false
  private eventName = ''
  private lastEventId: string | undefined
  private idForThisEvent: string | undefined
  private retryForThisEvent: number | undefined
  private comments: string[] = []

  constructor(options: SseParserOptions = {}) {
    this.maxEventBytes = options.maxEventBytes ?? DEFAULT_MAX_EVENT_BYTES
    this.seq = options.startSeq ?? 0
    this.now = options.now ?? Date.now
  }

  /**
   * Feeds one raw chunk and returns the frames it completed.
   *
   * Safe to call with a chunk cut anywhere, including mid-UTF-8-sequence
   * (decoding happens upstream), mid-field, or between `\r` and `\n`.
   */
  push(chunk: string): SseEvent[] {
    if (chunk.length === 0) return []

    let text = chunk
    if (this.atStreamStart) {
      this.atStreamStart = false
      if (text.charCodeAt(0) === 0xfeff) text = text.slice(1)
      if (text.length === 0) return []
    }

    const events: SseEvent[] = []
    let line = this.buffer
    this.buffer = ''

    for (let index = 0; index < text.length; index += 1) {
      const char = text[index]

      if (this.pendingCr) {
        this.pendingCr = false
        // The `\n` completing a CRLF whose line was already processed.
        if (char === '\n') continue
      }

      if (char === '\n' || char === '\r') {
        if (char === '\r') this.pendingCr = true
        const event = this.consumeLine(line)
        if (event) events.push(event)
        line = ''
        continue
      }

      line += char
    }

    this.buffer = line
    return events
  }

  /**
   * Ends the stream.
   *
   * Returns any events still completable plus the unterminated remainder. The
   * spec discards an incomplete final frame, and so does this parser — but it
   * *reports* the remainder as `tail` rather than dropping it silently, because a
   * truncated final frame is a real server bug and hiding it would defeat the
   * purpose of the tool.
   */
  flush(): { events: SseEvent[]; tail: string } {
    const tail = this.buffer
    this.buffer = ''
    this.pendingCr = false

    // A trailing comment-only run carries no payload but does prove the
    // connection was alive, so it is emitted if nothing else is pending.
    if (!this.hasData && this.eventName === '' && this.comments.length > 0) {
      const event = this.dispatch()
      return { events: event ? [event] : [], tail }
    }

    return { events: [], tail }
  }

  /** Frames emitted so far, for a caller that continues the numbering. */
  get nextSeq(): number {
    return this.seq
  }

  /**
   * Processes one complete line.
   *
   * @returns the event, when this line was the blank line that dispatches one.
   */
  private consumeLine(line: string): SseEvent | null {
    if (line.length === 0) return this.dispatch()

    if (line.startsWith(':')) {
      // Comment. One leading space after the colon is conventionally cosmetic.
      this.comments.push(stripOneSpace(line.slice(1)))
      return null
    }

    const colon = line.indexOf(':')
    const field = colon === -1 ? line : line.slice(0, colon)
    // No colon means an empty value — not a malformed line to be skipped.
    const value = colon === -1 ? '' : stripOneSpace(line.slice(colon + 1))

    switch (field) {
      case 'event':
        this.eventName = value
        break
      case 'data':
        this.dataLines.push(value)
        this.hasData = true
        break
      case 'id':
        // NUL in an id is required to be ignored outright.
        if (!value.includes('\u0000')) this.idForThisEvent = value
        break
      case 'retry':
        if (value.length > 0 && /^\d+$/.test(value)) {
          this.retryForThisEvent = Number(value)
        }
        break
      default:
        // Unknown field: ignored by the spec, and by us. Servers do send them.
        break
    }
    return null
  }

  /** Dispatches the buffered fields, or nothing if there is nothing to report. */
  private dispatch(): SseEvent | null {
    const comments = this.comments
    this.comments = []

    if (!this.hasData) {
      /**
       * No data. The spec resets and dispatches nothing — but a frame carrying
       * only comments is exactly a heartbeat, and a frame carrying only `retry`
       * is a reconnection directive. Both are surfaced, because "the server said
       * nothing for 30s but did send five heartbeats" is diagnostic information.
       */
      const retry = this.retryForThisEvent
      const hadEventName = this.eventName !== ''
      this.resetEvent()

      if (comments.length > 0 || retry !== undefined) {
        const event: SseEvent = {
          seq: this.seq++,
          at: this.now(),
          event: 'comment',
          data: '',
        }
        if (comments.length > 0) event.comment = comments.join('\n')
        if (retry !== undefined) event.retry = retry
        return event
      }
      // A stray `event:` with no data is a server bug worth seeing, but an
      // entirely empty frame is just a blank line and is not reported.
      if (!hadEventName) return null
      return null
    }

    const joined = this.dataLines.join('\n')
    const truncated = joined.length > this.maxEventBytes
    const data = truncated ? joined.slice(0, this.maxEventBytes) : joined

    const event: SseEvent = {
      seq: this.seq++,
      at: this.now(),
      // The spec's default type when `event:` is absent.
      event: this.eventName === '' ? 'message' : this.eventName,
      data,
    }
    if (this.idForThisEvent !== undefined) {
      this.lastEventId = this.idForThisEvent
    }
    if (this.lastEventId !== undefined) event.id = this.lastEventId
    if (this.retryForThisEvent !== undefined) event.retry = this.retryForThisEvent
    if (comments.length > 0) event.comment = comments.join('\n')
    if (truncated) event.truncated = true

    this.resetEvent()
    return event
  }

  private resetEvent(): void {
    this.dataLines = []
    this.hasData = false
    this.eventName = ''
    this.idForThisEvent = undefined
    this.retryForThisEvent = undefined
  }
}

/**
 * Removes exactly one leading space, per spec.
 *
 * `trim()` would be wrong: `data:  {"a": 1}` has a meaningful second space, and
 * trailing whitespace can be significant in a text payload.
 */
function stripOneSpace(value: string): string {
  return value.startsWith(' ') ? value.slice(1) : value
}

/**
 * Whether a blob of text looks like SSE framing.
 *
 * Used by `loose` capture mode to sniff a response whose content type is not
 * `text/event-stream`. Kept conservative: a `data:` or `event:` line at the start
 * of a line is the signal. NDJSON is accepted separately by
 * {@link looksLikeNdjson} because it needs different handling in the UI.
 */
export function looksLikeSse(text: string): boolean {
  return /(^|[\r\n])(data|event|id|retry):/.test(text)
}

/** Whether the text looks like newline-delimited JSON. */
export function looksLikeNdjson(text: string): boolean {
  const firstLine = text.split(/\r\n|\n|\r/, 1)[0]?.trim()
  if (!firstLine) return false
  if (!firstLine.startsWith('{') && !firstLine.startsWith('[')) return false
  try {
    JSON.parse(firstLine)
    return true
  } catch {
    // An incomplete first line is normal mid-stream; treat it as a maybe-no and
    // let a later chunk decide.
    return false
  }
}

/**
 * Wraps NDJSON lines as SSE events so one renderer handles both formats.
 *
 * NDJSON has no event types or ids, so each line becomes a `message` frame. This
 * is a presentation convenience and is labelled as such in the UI.
 */
export class NdjsonParser {
  private buffer = ''
  private seq: number
  private readonly maxEventBytes: number
  private readonly now: () => number

  constructor(options: SseParserOptions = {}) {
    this.maxEventBytes = options.maxEventBytes ?? DEFAULT_MAX_EVENT_BYTES
    this.seq = options.startSeq ?? 0
    this.now = options.now ?? Date.now
  }

  push(chunk: string): SseEvent[] {
    this.buffer += chunk
    const events: SseEvent[] = []
    let newline = this.buffer.search(/\r\n|\n|\r/)
    while (newline !== -1) {
      const raw = this.buffer.slice(0, newline)
      const skip = this.buffer.startsWith('\r\n', newline) ? 2 : 1
      this.buffer = this.buffer.slice(newline + skip)
      const event = this.makeEvent(raw)
      if (event) events.push(event)
      newline = this.buffer.search(/\r\n|\n|\r/)
    }
    return events
  }

  flush(): { events: SseEvent[]; tail: string } {
    const remainder = this.buffer
    this.buffer = ''
    // Unlike SSE, a final NDJSON line without a newline is usually complete.
    if (remainder.trim().length === 0) return { events: [], tail: '' }
    try {
      JSON.parse(remainder)
    } catch {
      return { events: [], tail: remainder }
    }
    const event = this.makeEvent(remainder)
    return { events: event ? [event] : [], tail: '' }
  }

  get nextSeq(): number {
    return this.seq
  }

  private makeEvent(raw: string): SseEvent | null {
    if (raw.trim().length === 0) return null
    const truncated = raw.length > this.maxEventBytes
    const event: SseEvent = {
      seq: this.seq++,
      at: this.now(),
      event: 'message',
      data: truncated ? raw.slice(0, this.maxEventBytes) : raw,
    }
    if (truncated) event.truncated = true
    return event
  }
}
