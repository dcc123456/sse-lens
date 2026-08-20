/**
 * SSE framing tests.
 *
 * The cases below are the WHATWG stream-processing rules restated as
 * assertions, plus the chunk-boundary hazards a real network produces. They are
 * written against behaviour a naive `split('\n\n')` implementation gets wrong,
 * so a future "simplification" of the parser fails here instead of silently
 * mis-framing a user's capture.
 */

import { describe, expect, it } from 'vitest'
import { NdjsonParser, SseParser, looksLikeNdjson, looksLikeSse } from '../src/lib/sse'
import type { SseEvent } from '../src/lib/types'

/** Feeds a whole document and returns every dispatched frame. */
function parseAll(text: string, options?: { maxEventBytes?: number }): SseEvent[] {
  const parser = new SseParser({ now: () => 1000, ...options })
  const events = parser.push(text)
  return [...events, ...parser.flush().events]
}

/** Payloads only, for the many cases where framing is the whole question. */
function dataOf(text: string): string[] {
  return parseAll(text)
    .filter((event) => event.event !== 'comment')
    .map((event) => event.data)
}

describe('SseParser · framing', () => {
  it('dispatches one event per blank line', () => {
    expect(dataOf('data: a\n\ndata: b\n\n')).toEqual(['a', 'b'])
  })

  it('joins repeated data fields with a newline, not a space', () => {
    // One event with an embedded newline — not two events, and not "a b".
    expect(dataOf('data: line one\ndata: line two\n\n')).toEqual(['line one\nline two'])
  })

  it('treats a bare data line as an empty payload line', () => {
    // A field with no colon has an empty value, so this is a blank middle line.
    expect(dataOf('data: a\ndata\ndata: b\n\n')).toEqual(['a\n\nb'])
  })

  it('does not dispatch a frame that has no data field', () => {
    // `event:` alone carries nothing; the spec resets and dispatches nothing.
    expect(parseAll('event: ping\n\n')).toEqual([])
  })

  it('ignores unknown fields rather than dropping the frame', () => {
    expect(dataOf('foo: bar\ndata: kept\n\n')).toEqual(['kept'])
  })

  it('defaults the event type to "message"', () => {
    expect(parseAll('data: x\n\n')[0]?.event).toBe('message')
  })

  it('uses an explicit event name', () => {
    expect(parseAll('event: delta\ndata: x\n\n')[0]?.event).toBe('delta')
  })

  it('does not leak an event name into the following frame', () => {
    const events = parseAll('event: delta\ndata: 1\n\ndata: 2\n\n')
    expect(events.map((event) => event.event)).toEqual(['delta', 'message'])
  })
})

describe('SseParser · value parsing', () => {
  it('strips exactly one space after the colon', () => {
    expect(dataOf('data:  two spaces\n\n')).toEqual([' two spaces'])
  })

  it('accepts a field with no space after the colon', () => {
    expect(dataOf('data:tight\n\n')).toEqual(['tight'])
  })

  it('preserves trailing whitespace in the payload', () => {
    // Trimming here would corrupt any payload where whitespace is meaningful.
    expect(dataOf('data: keep me  \n\n')).toEqual(['keep me  '])
  })

  it('preserves interior JSON formatting', () => {
    const json = '{"a":  1, "b": "  x  "}'
    expect(dataOf(`data: ${json}\n\n`)).toEqual([json])
  })
})

describe('SseParser · line terminators', () => {
  it('handles LF', () => {
    expect(dataOf('data: a\n\n')).toEqual(['a'])
  })

  it('handles CRLF', () => {
    expect(dataOf('data: a\r\n\r\n')).toEqual(['a'])
  })

  it('handles a bare CR as a terminator', () => {
    // The case `split('\n\n')` cannot see at all.
    expect(dataOf('data: a\r\rdata: b\r\r')).toEqual(['a', 'b'])
  })

  it('does not emit a phantom frame when a chunk ends between CR and LF', () => {
    const parser = new SseParser({ now: () => 1 })
    const first = parser.push('data: a\r')
    // The frame's line is complete, but the blank line that dispatches it has
    // not arrived; the dangling \n must not be read as that blank line.
    expect(first).toEqual([])
    const second = parser.push('\n\r\n')
    expect(second.map((event) => event.data)).toEqual(['a'])
  })

  it('mixes terminators within one stream', () => {
    expect(dataOf('data: a\r\n\ndata: b\n\r\n')).toEqual(['a', 'b'])
  })
})

describe('SseParser · chunk boundaries', () => {
  it('reassembles a frame split at every possible offset', () => {
    const document = 'event: delta\ndata: {"v":42}\nid: 7\n\n'
    for (let cut = 0; cut <= document.length; cut += 1) {
      const parser = new SseParser({ now: () => 1 })
      const events = [
        ...parser.push(document.slice(0, cut)),
        ...parser.push(document.slice(cut)),
      ]
      expect(events, `split at ${cut}`).toHaveLength(1)
      expect(events[0]?.data, `split at ${cut}`).toBe('{"v":42}')
      expect(events[0]?.event, `split at ${cut}`).toBe('delta')
      expect(events[0]?.id, `split at ${cut}`).toBe('7')
    }
  })

  it('handles one chunk containing many frames', () => {
    expect(dataOf('data: a\n\ndata: b\n\ndata: c\n\n')).toEqual(['a', 'b', 'c'])
  })

  it('emits nothing for a frame that is still open', () => {
    const parser = new SseParser({ now: () => 1 })
    expect(parser.push('data: incomplete\n')).toEqual([])
  })

  it('feeds one character at a time', () => {
    const parser = new SseParser({ now: () => 1 })
    const document = 'data: a\n\nevent: x\ndata: b\n\n'
    const events: SseEvent[] = []
    for (const char of document) events.push(...parser.push(char))
    expect(events.map((event) => event.data)).toEqual(['a', 'b'])
    expect(events.map((event) => event.event)).toEqual(['message', 'x'])
  })

  it('ignores an empty chunk', () => {
    const parser = new SseParser({ now: () => 1 })
    expect(parser.push('')).toEqual([])
    expect(parser.push('data: a\n\n').map((event) => event.data)).toEqual(['a'])
  })
})

describe('SseParser · BOM', () => {
  it('strips a single leading BOM from the stream', () => {
    expect(dataOf('\ufeffdata: a\n\n')).toEqual(['a'])
  })

  it('strips the BOM when it arrives in its own chunk', () => {
    const parser = new SseParser({ now: () => 1 })
    parser.push('\ufeff')
    expect(parser.push('data: a\n\n').map((event) => event.data)).toEqual(['a'])
  })

  it('keeps a BOM that appears later in the stream', () => {
    // Only a stream-leading BOM is a marker; a later one is payload.
    expect(dataOf('data: a\n\ndata: \ufeffb\n\n')).toEqual(['a', '\ufeffb'])
  })
})

describe('SseParser · id', () => {
  it('reports the id on its frame', () => {
    expect(parseAll('id: 1\ndata: a\n\n')[0]?.id).toBe('1')
  })

  it('persists the last id across later frames, per spec', () => {
    const events = parseAll('id: 1\ndata: a\n\ndata: b\n\n')
    expect(events.map((event) => event.id)).toEqual(['1', '1'])
  })

  it('ignores an id containing NUL', () => {
    expect(parseAll('id: bad\u0000id\ndata: a\n\n')[0]?.id).toBeUndefined()
  })

  it('accepts an empty id, clearing the previous one', () => {
    const events = parseAll('id: 1\ndata: a\n\nid\ndata: b\n\n')
    expect(events.map((event) => event.id)).toEqual(['1', ''])
  })
})

describe('SseParser · retry', () => {
  it('parses an all-digit retry', () => {
    expect(parseAll('retry: 3000\ndata: a\n\n')[0]?.retry).toBe(3000)
  })

  it('ignores a non-numeric retry', () => {
    expect(parseAll('retry: 3s\ndata: a\n\n')[0]?.retry).toBeUndefined()
  })

  it('ignores a signed or fractional retry', () => {
    expect(parseAll('retry: -5\ndata: a\n\n')[0]?.retry).toBeUndefined()
    expect(parseAll('retry: 1.5\ndata: a\n\n')[0]?.retry).toBeUndefined()
  })

  it('surfaces a retry-only frame, since it is a real directive', () => {
    const events = parseAll('retry: 5000\n\n')
    expect(events).toHaveLength(1)
    expect(events[0]?.retry).toBe(5000)
    expect(events[0]?.event).toBe('comment')
  })
})

describe('SseParser · comments', () => {
  it('surfaces a comment-only frame as a heartbeat', () => {
    const events = parseAll(': keep-alive\n\n')
    expect(events).toHaveLength(1)
    expect(events[0]?.comment).toBe('keep-alive')
    expect(events[0]?.data).toBe('')
    expect(events[0]?.event).toBe('comment')
  })

  it('attaches a comment that precedes a data frame to that frame', () => {
    const events = parseAll(': note\ndata: a\n\n')
    expect(events).toHaveLength(1)
    expect(events[0]?.data).toBe('a')
    expect(events[0]?.comment).toBe('note')
  })

  it('joins several comments in one frame', () => {
    expect(parseAll(': one\n: two\n\n')[0]?.comment).toBe('one\ntwo')
  })

  it('preserves an empty comment, which is the common heartbeat form', () => {
    const events = parseAll(':\n\n')
    expect(events).toHaveLength(1)
    expect(events[0]?.comment).toBe('')
  })

  it('does not confuse a comment with a field', () => {
    expect(dataOf(':data: not-data\ndata: real\n\n')).toEqual(['real'])
  })
})

describe('SseParser · sequence and timing', () => {
  it('numbers frames monotonically from zero', () => {
    expect(parseAll('data: a\n\ndata: b\n\ndata: c\n\n').map((event) => event.seq)).toEqual([0, 1, 2])
  })

  it('continues numbering from startSeq', () => {
    const parser = new SseParser({ startSeq: 10, now: () => 1 })
    expect(parser.push('data: a\n\n')[0]?.seq).toBe(10)
    expect(parser.nextSeq).toBe(11)
  })

  it('stamps each frame with the clock at dispatch', () => {
    let time = 100
    const parser = new SseParser({ now: () => (time += 50) })
    const events = parser.push('data: a\n\ndata: b\n\n')
    expect(events.map((event) => event.at)).toEqual([150, 200])
  })
})

describe('SseParser · truncation', () => {
  it('cuts an oversized payload and flags it', () => {
    const events = parseAll(`data: ${'x'.repeat(50)}\n\n`, { maxEventBytes: 10 })
    expect(events[0]?.data).toBe('x'.repeat(10))
    expect(events[0]?.truncated).toBe(true)
  })

  it('leaves a payload at the limit unflagged', () => {
    const events = parseAll(`data: ${'x'.repeat(10)}\n\n`, { maxEventBytes: 10 })
    expect(events[0]?.truncated).toBeUndefined()
  })
})

describe('SseParser · flush', () => {
  it('reports an unterminated final frame as tail instead of dispatching it', () => {
    const parser = new SseParser({ now: () => 1 })
    expect(parser.push('data: complete\n\ndata: cut off')).toHaveLength(1)
    const { events, tail } = parser.flush()
    expect(events).toEqual([])
    expect(tail).toBe('data: cut off')
  })

  it('has an empty tail for a cleanly terminated stream', () => {
    const parser = new SseParser({ now: () => 1 })
    parser.push('data: a\n\n')
    expect(parser.flush()).toEqual({ events: [], tail: '' })
  })

  it('emits a trailing comment-only run', () => {
    const parser = new SseParser({ now: () => 1 })
    parser.push(': bye\n')
    const { events } = parser.flush()
    expect(events[0]?.comment).toBe('bye')
  })
})

describe('looksLikeSse', () => {
  it('recognises a data line at the start', () => {
    expect(looksLikeSse('data: {"a":1}\n\n')).toBe(true)
  })

  it('recognises framing fields after a newline', () => {
    expect(looksLikeSse('\nevent: delta\n')).toBe(true)
    expect(looksLikeSse('\r\nid: 4\r\n')).toBe(true)
    expect(looksLikeSse('\nretry: 1000\n')).toBe(true)
  })

  it('rejects prose and HTML', () => {
    expect(looksLikeSse('<!doctype html><html>')).toBe(false)
    expect(looksLikeSse('just some text about data: maybe')).toBe(false)
  })

  it('rejects JSON that merely contains the word data', () => {
    expect(looksLikeSse('{"data": 1}')).toBe(false)
  })
})

describe('looksLikeNdjson', () => {
  it('recognises a complete JSON object on the first line', () => {
    expect(looksLikeNdjson('{"a":1}\n{"a":2}\n')).toBe(true)
  })

  it('rejects a first line that is not yet complete', () => {
    expect(looksLikeNdjson('{"a":')).toBe(false)
  })

  it('rejects SSE', () => {
    expect(looksLikeNdjson('data: {"a":1}\n\n')).toBe(false)
  })

  it('rejects empty input', () => {
    expect(looksLikeNdjson('')).toBe(false)
  })
})

describe('NdjsonParser', () => {
  it('emits one event per line', () => {
    const parser = new NdjsonParser({ now: () => 1 })
    const events = parser.push('{"a":1}\n{"a":2}\n')
    expect(events.map((event) => event.data)).toEqual(['{"a":1}', '{"a":2}'])
  })

  it('buffers a partial final line until its newline arrives', () => {
    const parser = new NdjsonParser({ now: () => 1 })
    expect(parser.push('{"a":')).toEqual([])
    expect(parser.push('1}\n').map((event) => event.data)).toEqual(['{"a":1}'])
  })

  it('emits a complete final line with no trailing newline on flush', () => {
    const parser = new NdjsonParser({ now: () => 1 })
    parser.push('{"a":1}')
    const { events, tail } = parser.flush()
    expect(events.map((event) => event.data)).toEqual(['{"a":1}'])
    expect(tail).toBe('')
  })

  it('reports an incomplete final line as tail', () => {
    const parser = new NdjsonParser({ now: () => 1 })
    parser.push('{"a":')
    expect(parser.flush()).toEqual({ events: [], tail: '{"a":' })
  })

  it('skips blank lines', () => {
    const parser = new NdjsonParser({ now: () => 1 })
    expect(parser.push('{"a":1}\n\n  \n{"a":2}\n')).toHaveLength(2)
  })

  it('handles CRLF', () => {
    const parser = new NdjsonParser({ now: () => 1 })
    expect(parser.push('{"a":1}\r\n{"a":2}\r\n').map((event) => event.data)).toEqual([
      '{"a":1}',
      '{"a":2}',
    ])
  })

  it('truncates an oversized line', () => {
    const parser = new NdjsonParser({ maxEventBytes: 5, now: () => 1 })
    const events = parser.push(`${'x'.repeat(20)}\n`)
    expect(events[0]?.data).toBe('xxxxx')
    expect(events[0]?.truncated).toBe(true)
  })
})
