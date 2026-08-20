/**
 * Capture storage and quota enforcement.
 *
 * This module owns every rule about what is kept and what is thrown away, for
 * one reason: a capture is unbounded by nature. An SSE connection can stay open
 * for hours emitting a frame a second, and `chrome.storage.session` has a hard
 * quota (~10MB) that, once exceeded, fails *writes* — meaning an unbounded
 * capture does not degrade gracefully, it silently stops recording. So trimming
 * is not an optimisation here; it is what keeps the tool working at all.
 *
 * Three quotas apply, in this order:
 *
 * 1. `maxEventsPerStream` — oldest frames of one stream are dropped first,
 *    because the newest frames are what someone is watching.
 * 2. `maxTabBytes` — whole *old streams* are evicted, not frames from the live
 *    one. Halving every stream would degrade all of them equally; dropping the
 *    oldest keeps the current investigation intact.
 * 3. `maxStreamsPerTab` — a cap on list length, independent of size.
 *
 * Whenever anything is discarded, `droppedEvents` is incremented so the UI can
 * say "12 frames dropped" rather than presenting a gap as a complete record.
 * Silent loss in a debugging tool produces false conclusions.
 *
 * The store is deliberately pure and synchronous: `chrome.storage` persistence is
 * a separate concern layered on top in `index.ts`, which lets every rule here be
 * tested without a browser.
 *
 * @module background/store
 */

import { NdjsonParser, SseParser, looksLikeNdjson } from '../lib/sse'
import type { Settings, SseEvent, StreamRecord } from '../lib/types'

/** A stream's live parser plus the bookkeeping that outlives a worker restart. */
interface ParserState {
  parser: SseParser | NdjsonParser
  /** Set once the format has been decided; NDJSON needs a different parser. */
  format: 'sse' | 'ndjson'
}

export interface StoreOptions {
  settings: Settings
  now?: () => number
}

/**
 * Per-tab capture state.
 *
 * Keyed by tab id because capture is scoped to one tab at a time, but old tabs'
 * data still has to be evictable on close — a user who inspects twenty tabs in a
 * session must not accumulate twenty tabs' worth of streams.
 */
export class CaptureStore {
  private readonly byTab = new Map<number, StreamRecord[]>()
  /** Maps a page-local stream id to the namespaced record id. */
  private readonly localIds = new Map<string, string>()
  private readonly parsers = new Map<string, ParserState>()
  private counter = 0
  private settings: Settings
  private readonly now: () => number
  /**
   * Messages that named a stream this store has never seen.
   *
   * Counted rather than ignored. An unresolvable `stream.headers` or
   * `stream.chunk` means data was thrown away, and the original bug — page
   * messages processed out of order, so frames arrived before the record that
   * owned them — was invisible precisely because those drops were silent. A
   * non-zero value here is always either a real ordering fault or a stream that
   * was evicted by a quota mid-flight.
   */
  private orphanedMessages = 0

  constructor(options: StoreOptions) {
    this.settings = options.settings
    this.now = options.now ?? Date.now
  }

  /** How many messages could not be matched to a stream. Diagnostics only. */
  get orphanCount(): number {
    return this.orphanedMessages
  }

  updateSettings(settings: Settings): void {
    this.settings = settings
    // Re-apply quotas immediately: lowering a limit should take effect now, not
    // at the next frame, or the user cannot recover from a runaway capture.
    for (const tabId of this.byTab.keys()) this.enforceTabQuotas(tabId)
  }

  /** Streams for one tab, newest first. */
  list(tabId: number): StreamRecord[] {
    const streams = this.byTab.get(tabId) ?? []
    return [...streams].reverse()
  }

  get(streamId: string): StreamRecord | undefined {
    for (const streams of this.byTab.values()) {
      const found = streams.find((stream) => stream.id === streamId)
      if (found) return found
    }
    return undefined
  }

  /** Recent raw response text for a stream, for the Raw view. */
  raw(streamId: string): string {
    return this.get(streamId)?.rawTail ?? ''
  }

  /** Every tab id holding data, for persistence. */
  tabs(): number[] {
    return [...this.byTab.keys()]
  }

  /**
   * Restores persisted state after a worker restart.
   *
   * Parsers are intentionally *not* restored: a stream that was mid-frame when
   * the worker died cannot be resumed correctly, and inventing a parser primed
   * with an empty buffer would mis-frame the continuation. Such a stream keeps
   * its recorded frames and is left in whatever state it had.
   */
  hydrate(tabId: number, streams: StreamRecord[]): void {
    this.byTab.set(tabId, [...streams].reverse())
    for (const stream of streams) {
      // Keep the counter ahead of anything restored, so new ids cannot collide.
      const suffix = Number(stream.id.split(':').pop())
      if (Number.isFinite(suffix) && suffix >= this.counter) this.counter = suffix + 1
    }
  }

  clearTab(tabId: number): void {
    const streams = this.byTab.get(tabId)
    if (streams) {
      // Raw text lives on each record, so dropping the records drops it too.
      for (const stream of streams) this.parsers.delete(stream.id)
    }
    this.byTab.delete(tabId)
    for (const [localId, streamId] of [...this.localIds.entries()]) {
      if (streamId.startsWith(`${tabId}:`)) this.localIds.delete(localId)
    }
  }

  clearStream(streamId: string): void {
    for (const [tabId, streams] of this.byTab.entries()) {
      const index = streams.findIndex((stream) => stream.id === streamId)
      if (index === -1) continue
      streams.splice(index, 1)
      if (streams.length === 0) this.byTab.delete(tabId)
      break
    }
    this.parsers.delete(streamId)
    for (const [localId, id] of [...this.localIds.entries()]) {
      if (id === streamId) this.localIds.delete(localId)
    }
  }

  /**
   * Registers a new stream.
   *
   * `tabId`/`frameId` come from the message *sender*, never from the page, so a
   * page cannot plant a record in another tab's list.
   *
   * @returns the record, or undefined when the URL filter excludes it
   */
  open(input: {
    tabId: number
    frameId: number
    frameUrl: string
    localId: string
    streamKind: StreamRecord['kind']
    method: string
    url: string
    requestHeaders?: Record<string, string>
    requestBody?: string
    startedAt: number
  }): StreamRecord | undefined {
    if (!this.passesFilter(input.url)) return undefined

    const id = `${input.tabId}:${input.frameId}:${this.counter++}`
    const record: StreamRecord = {
      id,
      tabId: input.tabId,
      frameId: input.frameId,
      frameUrl: input.frameUrl,
      kind: input.streamKind,
      method: input.method,
      url: input.url,
      startedAt: input.startedAt,
      state: 'open',
      bytes: 0,
      eventCount: 0,
      events: [],
      droppedEvents: 0,
    }
    if (input.requestHeaders) record.requestHeaders = input.requestHeaders
    if (input.requestBody !== undefined) record.requestBody = input.requestBody

    const streams = this.byTab.get(input.tabId) ?? []
    streams.push(record)
    this.byTab.set(input.tabId, streams)
    this.localIds.set(this.localKey(input.tabId, input.frameId, input.localId), id)
    this.enforceTabQuotas(input.tabId)
    return record
  }

  /** Attaches response metadata. */
  headers(
    tabId: number,
    frameId: number,
    localId: string,
    input: {
      status: number
      statusText: string
      responseHeaders?: Record<string, string>
      contentType?: string
      firstByteAt: number
    },
  ): StreamRecord | undefined {
    const record = this.resolve(tabId, frameId, localId)
    if (!record) return undefined
    record.status = input.status
    record.statusText = input.statusText
    if (input.responseHeaders) record.responseHeaders = input.responseHeaders
    if (input.contentType !== undefined) record.contentType = input.contentType
    record.firstByteAt = input.firstByteAt
    return record
  }

  /**
   * Feeds raw response text and returns the frames it completed.
   *
   * Format detection happens on the first chunk and then sticks: a stream cannot
   * be half SSE and half NDJSON, and re-deciding mid-stream on an unlucky chunk
   * boundary would scramble the framing.
   */
  chunk(
    tabId: number,
    frameId: number,
    localId: string,
    text: string,
  ): { record: StreamRecord; events: SseEvent[] } | undefined {
    const record = this.resolve(tabId, frameId, localId)
    if (!record) return undefined

    let state = this.parsers.get(record.id)
    if (!state) {
      const format = looksLikeNdjson(text) ? 'ndjson' : 'sse'
      const options = { maxEventBytes: this.settings.maxEventBytes, now: this.now }
      state = {
        format,
        parser: format === 'ndjson' ? new NdjsonParser(options) : new SseParser(options),
      }
      this.parsers.set(record.id, state)
    }

    record.bytes += text.length
    this.appendRaw(record, text)

    const events = state.parser.push(text)
    if (events.length > 0) this.appendEvents(record, events)
    return { record, events }
  }

  /** Appends an already-parsed event, for the `EventSource` path. */
  event(
    tabId: number,
    frameId: number,
    localId: string,
    event: SseEvent,
  ): { record: StreamRecord; events: SseEvent[] } | undefined {
    const record = this.resolve(tabId, frameId, localId)
    if (!record) return undefined
    record.bytes += event.data.length
    this.appendEvents(record, [event])
    return { record, events: [event] }
  }

  markUnreadable(
    tabId: number,
    frameId: number,
    localId: string,
    reason: string,
  ): StreamRecord | undefined {
    const record = this.resolve(tabId, frameId, localId)
    if (!record) return undefined
    record.unreadableReason = reason
    return record
  }

  /**
   * Closes a stream, flushing whatever the parser still holds.
   *
   * The unterminated remainder becomes `tail` rather than being dropped: a
   * truncated final frame is a real server bug, and hiding it would defeat the
   * purpose of the tool.
   */
  close(
    tabId: number,
    frameId: number,
    localId: string,
    input: { endedAt: number; state: 'closed' | 'error' | 'aborted'; errorMessage?: string },
  ): { record: StreamRecord; events: SseEvent[] } | undefined {
    const record = this.resolve(tabId, frameId, localId)
    if (!record) return undefined

    const state = this.parsers.get(record.id)
    let flushed: SseEvent[] = []
    if (state) {
      const result = state.parser.flush()
      flushed = result.events
      if (result.tail.length > 0) record.tail = result.tail
      this.parsers.delete(record.id)
    }
    if (flushed.length > 0) this.appendEvents(record, flushed)

    record.endedAt = input.endedAt
    record.state = input.state
    if (input.errorMessage !== undefined) record.errorMessage = input.errorMessage
    this.localIds.delete(this.localKey(tabId, frameId, localId))
    return { record, events: flushed }
  }

  // --- Internals -------------------------------------------------------------

  private localKey(tabId: number, frameId: number, localId: string): string {
    // Namespaced by sender, so two frames using the same page-local counter (they
    // each start at 1) cannot collide.
    return `${tabId}:${frameId}:${localId}`
  }

  /**
   * Finds the record a page-local id refers to.
   *
   * A miss is counted, not merely reported as `undefined`: it means a caller is
   * about to discard real data, and silent discards are what hid the message
   * ordering bug this counter now guards against.
   */
  private resolve(tabId: number, frameId: number, localId: string): StreamRecord | undefined {
    const id = this.localIds.get(this.localKey(tabId, frameId, localId))
    if (!id) {
      this.orphanedMessages += 1
      return undefined
    }
    const record = this.byTab.get(tabId)?.find((stream) => stream.id === id)
    if (!record) this.orphanedMessages += 1
    return record
  }

  /**
   * Applies the URL filter.
   *
   * A `/pattern/flags` value is treated as a regex, anything else as a
   * case-insensitive substring. An invalid regex matches everything rather than
   * nothing: a typo mid-edit should not silently stop all capture, which looks
   * like the extension is broken.
   */
  private passesFilter(url: string): boolean {
    const filter = this.settings.urlFilter.trim()
    if (filter.length === 0) return true

    const asRegex = /^\/(.*)\/([gimsuy]*)$/.exec(filter)
    if (asRegex) {
      try {
        return new RegExp(asRegex[1] ?? '', asRegex[2] ?? '').test(url)
      } catch {
        return true
      }
    }
    return url.toLowerCase().includes(filter.toLowerCase())
  }

  private appendEvents(record: StreamRecord, events: SseEvent[]): void {
    record.events.push(...events)
    record.eventCount += events.length
    this.trimEvents(record)
    this.enforceTabQuotas(record.tabId)
  }

  private trimEvents(record: StreamRecord): void {
    const limit = Math.max(1, this.settings.maxEventsPerStream)
    if (record.events.length <= limit) return
    const excess = record.events.length - limit
    record.events.splice(0, excess)
    // Reported, never silent: a gap presented as a complete record leads someone
    // to conclude the server sent nothing.
    record.droppedEvents += excess
  }

  private appendRaw(record: StreamRecord, text: string): void {
    const limit = Math.max(1024, this.settings.maxEventBytes * 64)
    const combined = (record.rawTail ?? '') + text
    if (combined.length > limit) {
      // Keep the newest text: the tail is what someone is reading, and the flag
      // stops the view from presenting a mid-stream slice as the whole response.
      record.rawTail = combined.slice(-limit)
      record.rawTruncated = true
      return
    }
    record.rawTail = combined
  }

  /**
   * Enforces the tab-level caps by evicting whole old streams.
   *
   * Oldest-first, and never the last remaining stream: if a single stream exceeds
   * the byte budget on its own, dropping it would leave the user with nothing to
   * look at. Its own frame cap already bounds it, so keeping it is safe.
   */
  private enforceTabQuotas(tabId: number): void {
    const streams = this.byTab.get(tabId)
    if (!streams) return

    while (streams.length > Math.max(1, this.settings.maxStreamsPerTab)) {
      const evicted = streams.shift()
      if (evicted) this.forget(evicted)
    }

    let total = streams.reduce((sum, stream) => sum + stream.bytes, 0)
    while (total > this.settings.maxTabBytes && streams.length > 1) {
      const evicted = streams.shift()
      if (!evicted) break
      total -= evicted.bytes
      this.forget(evicted)
    }
  }

  private forget(stream: StreamRecord): void {
    this.parsers.delete(stream.id)
    for (const [localId, id] of [...this.localIds.entries()]) {
      if (id === stream.id) this.localIds.delete(localId)
    }
  }
}
