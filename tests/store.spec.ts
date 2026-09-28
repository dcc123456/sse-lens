/**
 * Capture-store tests.
 *
 * The centre of gravity here is quota enforcement, because that is what keeps the
 * tool working rather than merely tidy: `chrome.storage.session` fails *writes*
 * once its quota is exceeded, so an untrimmed capture does not degrade — it
 * silently stops recording. Every eviction path therefore has a test, and so does
 * the `droppedEvents` accounting that stops the UI presenting a gap as a complete
 * record.
 */

import { describe, expect, it } from 'vitest'
import { CaptureStore } from '../src/background/store'
import { DEFAULT_SETTINGS, type Settings } from '../src/lib/types'

function makeStore(overrides: Partial<Settings> = {}): CaptureStore {
  return new CaptureStore({
    settings: { ...DEFAULT_SETTINGS, ...overrides },
    now: () => 1_000,
  })
}

/** Opens a stream with sensible defaults and returns its record. */
function open(
  store: CaptureStore,
  overrides: Partial<Parameters<CaptureStore['open']>[0]> = {},
): ReturnType<CaptureStore['open']> {
  return store.open({
    tabId: 1,
    frameId: 0,
    frameUrl: 'https://example.test/app',
    localId: 'a-1',
    streamKind: 'fetch',
    method: 'POST',
    url: 'https://api.test/v1/chat/completions',
    startedAt: 1_000,
    ...overrides,
  })
}

describe('CaptureStore · open', () => {
  it('creates a record with a tab-namespaced id', () => {
    const store = makeStore()
    const record = open(store, { tabId: 7, frameId: 2 })
    expect(record?.id.startsWith('7:2:')).toBe(true)
    expect(record?.state).toBe('open')
    expect(record?.eventCount).toBe(0)
  })

  it('lists streams newest first', () => {
    const store = makeStore()
    open(store, { localId: 'a', url: 'https://api.test/first' })
    open(store, { localId: 'b', url: 'https://api.test/second' })
    expect(store.list(1).map((stream) => stream.url)).toEqual([
      'https://api.test/second',
      'https://api.test/first',
    ])
  })

  it('keeps different tabs separate', () => {
    const store = makeStore()
    open(store, { tabId: 1, localId: 'a' })
    open(store, { tabId: 2, localId: 'a' })
    expect(store.list(1)).toHaveLength(1)
    expect(store.list(2)).toHaveLength(1)
  })

  it('does not let two frames with the same local id collide', () => {
    // Each frame's hook numbers from 1, so the ids overlap by construction.
    const store = makeStore()
    const first = open(store, { frameId: 0, localId: 'x-1' })
    const second = open(store, { frameId: 1, localId: 'x-1' })
    expect(first?.id).not.toBe(second?.id)

    store.chunk(1, 0, 'x-1', 'data: frame-zero\n\n')
    store.chunk(1, 1, 'x-1', 'data: frame-one\n\n')
    expect(first?.events[0]?.data).toBe('frame-zero')
    expect(second?.events[0]?.data).toBe('frame-one')
  })
})

describe('CaptureStore · URL filter', () => {
  it('captures everything when the filter is empty', () => {
    expect(open(makeStore({ urlFilter: '' }))).toBeDefined()
  })

  it('matches a plain substring, case-insensitively', () => {
    expect(open(makeStore({ urlFilter: 'CHAT/completions' }))).toBeDefined()
    expect(open(makeStore({ urlFilter: 'nope' }))).toBeUndefined()
  })

  it('honours a /regex/ filter', () => {
    expect(open(makeStore({ urlFilter: '/v\\d+\\/chat/' }))).toBeDefined()
    expect(open(makeStore({ urlFilter: '/^https:\\/\\/other/' }))).toBeUndefined()
  })

  it('honours regex flags', () => {
    expect(open(makeStore({ urlFilter: '/API\\.TEST/i' }))).toBeDefined()
  })

  it('captures everything when the regex is invalid', () => {
    // A typo mid-edit must not look like the extension has stopped working.
    expect(open(makeStore({ urlFilter: '/[unclosed/' }))).toBeDefined()
  })
})

describe('CaptureStore · chunks and framing', () => {
  it('parses SSE frames out of raw text', () => {
    const store = makeStore()
    const record = open(store)
    const result = store.chunk(1, 0, 'a-1', 'data: one\n\ndata: two\n\n')
    expect(result?.events.map((event) => event.data)).toEqual(['one', 'two'])
    expect(record?.eventCount).toBe(2)
  })

  it('carries a frame across two chunks', () => {
    const store = makeStore()
    open(store)
    expect(store.chunk(1, 0, 'a-1', 'data: sp')?.events).toHaveLength(0)
    expect(store.chunk(1, 0, 'a-1', 'lit\n\n')?.events.map((event) => event.data)).toEqual(['split'])
  })

  it('accumulates the byte count', () => {
    const store = makeStore()
    const record = open(store)
    store.chunk(1, 0, 'a-1', 'data: one\n\n')
    store.chunk(1, 0, 'a-1', 'data: two\n\n')
    expect(record?.bytes).toBe('data: one\n\n'.length * 2)
  })

  it('detects NDJSON and frames it by line', () => {
    const store = makeStore()
    const record = open(store)
    store.chunk(1, 0, 'a-1', '{"a":1}\n{"a":2}\n')
    expect(record?.events.map((event) => event.data)).toEqual(['{"a":1}', '{"a":2}'])
  })

  it('sticks with the format decided on the first chunk', () => {
    // Re-deciding mid-stream on an unlucky chunk boundary would scramble framing.
    const store = makeStore()
    const record = open(store)
    store.chunk(1, 0, 'a-1', 'data: sse\n\n')
    store.chunk(1, 0, 'a-1', '{"looks":"like ndjson"}\n')
    // Still parsed as SSE, so the JSON line is not a frame of its own.
    expect(record?.events.map((event) => event.data)).toEqual(['sse'])
  })

  it('ignores a chunk for an unknown stream', () => {
    expect(makeStore().chunk(1, 0, 'never-opened', 'data: x\n\n')).toBeUndefined()
  })

  it('exposes raw text for the Raw view', () => {
    const store = makeStore()
    const record = open(store)
    store.chunk(1, 0, 'a-1', 'data: one\n\n')
    expect(store.raw(record?.id ?? '')).toBe('data: one\n\n')
  })
})

describe('CaptureStore · EventSource path', () => {
  it('appends a pre-parsed event', () => {
    const store = makeStore()
    const record = open(store, { streamKind: 'eventsource' })
    store.event(1, 0, 'a-1', { seq: 0, at: 1, event: 'message', data: 'hello' })
    expect(record?.events).toHaveLength(1)
    expect(record?.eventCount).toBe(1)
    expect(record?.bytes).toBe('hello'.length)
  })
})

describe('CaptureStore · close', () => {
  it('records the close state and time', () => {
    const store = makeStore()
    const record = open(store)
    store.chunk(1, 0, 'a-1', 'data: x\n\n')
    store.close(1, 0, 'a-1', { endedAt: 2_000, state: 'closed' })
    expect(record?.state).toBe('closed')
    expect(record?.endedAt).toBe(2_000)
  })

  it('keeps an error message', () => {
    const store = makeStore()
    const record = open(store)
    store.chunk(1, 0, 'a-1', 'data: x\n\n')
    store.close(1, 0, 'a-1', { endedAt: 2_000, state: 'error', errorMessage: 'connection reset' })
    expect(record?.state).toBe('error')
    expect(record?.errorMessage).toBe('connection reset')
  })

  it('reports an unterminated final frame as tail rather than dropping it', () => {
    // A truncated final frame is a real server bug; hiding it defeats the tool.
    const store = makeStore()
    const record = open(store)
    store.chunk(1, 0, 'a-1', 'data: complete\n\ndata: cut')
    store.close(1, 0, 'a-1', { endedAt: 2_000, state: 'closed' })
    expect(record?.tail).toBe('data: cut')
    expect(record?.events.map((event) => event.data)).toEqual(['complete'])
  })

  it('ignores a close for an unknown stream', () => {
    expect(
      makeStore().close(1, 0, 'nope', { endedAt: 1, state: 'closed' }),
    ).toBeUndefined()
  })
})

describe('CaptureStore · per-stream event quota', () => {
  it('drops the oldest frames and counts them', () => {
    const store = makeStore({ maxEventsPerStream: 3 })
    const record = open(store)
    for (const index of [1, 2, 3, 4, 5]) store.chunk(1, 0, 'a-1', `data: ${index}\n\n`)

    // Newest kept, because that is what someone is watching.
    expect(record?.events.map((event) => event.data)).toEqual(['3', '4', '5'])
    expect(record?.droppedEvents).toBe(2)
    // The total still reflects everything that arrived.
    expect(record?.eventCount).toBe(5)
  })

  it('keeps frame sequence numbers stable through trimming', () => {
    // The UI shows seq; renumbering would make two frames look like the same one.
    const store = makeStore({ maxEventsPerStream: 2 })
    const record = open(store)
    for (const index of [0, 1, 2, 3]) store.chunk(1, 0, 'a-1', `data: ${index}\n\n`)
    expect(record?.events.map((event) => event.seq)).toEqual([2, 3])
  })

  it('truncates an oversized payload per the byte setting', () => {
    const store = makeStore({ maxEventBytes: 8 })
    const record = open(store)
    store.chunk(1, 0, 'a-1', `data: ${'x'.repeat(40)}\n\n`)
    expect(record?.events[0]?.data).toBe('x'.repeat(8))
    expect(record?.events[0]?.truncated).toBe(true)
  })
})

describe('CaptureStore · tab quotas', () => {
  it('evicts the oldest stream past the stream cap', () => {
    const store = makeStore({ maxStreamsPerTab: 2 })
    open(store, { localId: 'a', url: 'https://api.test/1' })
    open(store, { localId: 'b', url: 'https://api.test/2' })
    open(store, { localId: 'c', url: 'https://api.test/3' })

    expect(store.list(1).map((stream) => stream.url)).toEqual([
      'https://api.test/3',
      'https://api.test/2',
    ])
  })

  it('evicts whole old streams to satisfy the byte cap', () => {
    // Whole streams, not frames from each: halving everything would degrade all
    // of them equally, while dropping the oldest keeps the live one intact.
    const store = makeStore({ maxTabBytes: 60, maxEventsPerStream: 1000 })
    const first = open(store, { localId: 'a', url: 'https://api.test/old' })
    store.chunk(1, 0, 'a', `data: ${'x'.repeat(50)}\n\n`)
    const second = open(store, { localId: 'b', url: 'https://api.test/new' })
    store.chunk(1, 0, 'b', `data: ${'y'.repeat(50)}\n\n`)

    const remaining = store.list(1).map((stream) => stream.id)
    expect(remaining).toContain(second?.id)
    expect(remaining).not.toContain(first?.id)
  })

  it('never evicts the only stream, however large', () => {
    // Leaving the user with nothing to look at is worse than exceeding a budget
    // the per-stream frame cap already bounds.
    const store = makeStore({ maxTabBytes: 10 })
    const only = open(store, { localId: 'a' })
    store.chunk(1, 0, 'a', `data: ${'x'.repeat(500)}\n\n`)
    expect(store.list(1).map((stream) => stream.id)).toEqual([only?.id])
  })

  it('re-applies quotas immediately when a limit is lowered', () => {
    // A user recovering from a runaway capture needs the new limit to bite now.
    const store = makeStore({ maxStreamsPerTab: 10 })
    open(store, { localId: 'a', url: 'https://api.test/1' })
    open(store, { localId: 'b', url: 'https://api.test/2' })
    open(store, { localId: 'c', url: 'https://api.test/3' })

    store.updateSettings({ ...DEFAULT_SETTINGS, maxStreamsPerTab: 1 })
    expect(store.list(1)).toHaveLength(1)
    expect(store.list(1)[0]?.url).toBe('https://api.test/3')
  })
})

describe('CaptureStore · clearing', () => {
  it('clears one tab without touching another', () => {
    const store = makeStore()
    open(store, { tabId: 1, localId: 'a' })
    open(store, { tabId: 2, localId: 'a' })
    store.clearTab(1)
    expect(store.list(1)).toHaveLength(0)
    expect(store.list(2)).toHaveLength(1)
  })

  it('stops accepting chunks for a cleared stream', () => {
    const store = makeStore()
    open(store, { localId: 'a' })
    store.clearTab(1)
    expect(store.chunk(1, 0, 'a', 'data: x\n\n')).toBeUndefined()
  })

  it('clears a single stream, leaving its siblings', () => {
    const store = makeStore()
    const first = open(store, { localId: 'a', url: 'https://api.test/1' })
    open(store, { localId: 'b', url: 'https://api.test/2' })
    store.clearStream(first?.id ?? '')
    expect(store.list(1).map((stream) => stream.url)).toEqual(['https://api.test/2'])
  })

  it('drops the raw text with the stream', () => {
    const store = makeStore()
    const record = open(store, { localId: 'a' })
    store.chunk(1, 0, 'a', 'data: x\n\n')
    store.clearStream(record?.id ?? '')
    expect(store.raw(record?.id ?? '')).toBe('')
  })
})

describe('CaptureStore · hydration', () => {
  it('restores records after a worker restart', () => {
    const first = makeStore()
    const record = open(first, { localId: 'a' })
    first.chunk(1, 0, 'a', 'data: x\n\n')
    const persisted = first.list(1)

    const revived = makeStore()
    revived.hydrate(1, persisted)
    expect(revived.list(1).map((stream) => stream.id)).toEqual([record?.id])
    expect(revived.get(record?.id ?? '')?.events).toHaveLength(1)
  })

  /**
   * The long-idle-gap case.
   *
   * A stream that idles longer than the ~30s MV3 worker lifetime is still open when
   * the worker comes back, and the page keeps using the id it picked before the
   * restart. If that id is not restored along with the record, every later frame of
   * the stream is an orphan and the stream silently stops growing — permanently,
   * because the page announces `open` only once.
   */
  it('continues an open stream after a restart', () => {
    const first = makeStore()
    const record = open(first, { localId: 'a' })
    first.chunk(1, 0, 'a', 'data: x\n\n')

    const revived = makeStore()
    revived.hydrate(1, first.list(1))
    const result = revived.chunk(1, 0, 'a', 'data: y\n\n')

    expect(result?.events.map((event) => event.data)).toEqual(['y'])
    // Resumed frames continue the record's numbering rather than restarting at 0.
    expect(result?.events.map((event) => event.seq)).toEqual([1])
    expect(revived.get(record?.id ?? '')?.events.map((event) => event.data)).toEqual(['x', 'y'])
  })

  it('loses only the frame that was in flight across a restart', () => {
    const first = makeStore()
    open(first, { localId: 'a' })
    first.chunk(1, 0, 'a', 'data: x\n\ndata: part')

    const revived = makeStore()
    revived.hydrate(1, first.list(1))
    const result = revived.chunk(1, 0, 'a', 'ial\n\ndata: y\n\n')

    // The resumed parser holds no buffer, so `data: partial` never dispatches and
    // its remainder reads as an unknown field. Frames after it are intact.
    expect(result?.events.map((event) => event.data)).toEqual(['y'])
  })

  it('does not re-link a stream that had already closed', () => {
    const first = makeStore()
    const record = open(first, { localId: 'a' })
    first.chunk(1, 0, 'a', 'data: x\n\n')
    first.close(1, 0, 'a', { endedAt: 2_000, state: 'closed' })

    const revived = makeStore()
    revived.hydrate(1, first.list(1))
    expect(revived.chunk(1, 0, 'a', 'data: late\n\n')).toBeUndefined()
    expect(revived.get(record?.id ?? '')?.events).toHaveLength(1)
  })

  it('keeps hydrated order newest-first', () => {
    const first = makeStore()
    open(first, { localId: 'a', url: 'https://api.test/1' })
    open(first, { localId: 'b', url: 'https://api.test/2' })

    const revived = makeStore()
    revived.hydrate(1, first.list(1))
    expect(revived.list(1).map((stream) => stream.url)).toEqual([
      'https://api.test/2',
      'https://api.test/1',
    ])
  })

  it('does not reuse an id after hydration', () => {
    // A colliding id would merge two unrelated streams in the panel.
    const first = makeStore()
    const original = open(first, { localId: 'a' })
    const revived = makeStore()
    revived.hydrate(1, first.list(1))
    const fresh = open(revived, { localId: 'b' })
    expect(fresh?.id).not.toBe(original?.id)
  })
})

describe('CaptureStore · unreadable streams', () => {
  it('records the reason rather than omitting the stream', () => {
    const store = makeStore()
    const record = open(store, { localId: 'a', streamKind: 'xhr' })
    store.markUnreadable(1, 0, 'a', 'responseType="blob"')
    expect(record?.unreadableReason).toBe('responseType="blob"')
    expect(store.list(1)).toHaveLength(1)
  })
})
