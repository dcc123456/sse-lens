/**
 * Frame cutting for the Raw view.
 *
 * These tests exist because the splitter is the one place the Raw tab's promise
 * ("these are the bytes") could quietly become a lie: a boundary rule that is
 * wrong by one character either merges two frames or invents an empty one, and
 * both read as plausible content.
 */

import { describe, expect, it } from 'vitest'
import {
  frameEvents,
  framingFor,
  splitRawFrames,
  type RawFraming,
  type RawFrame,
} from '../src/panel/rawFrames'

const framesOf = (raw: string, framing: RawFraming = framingFor(raw)) =>
  splitRawFrames(raw, framing)

const texts = (raw: string, framing: RawFraming = framingFor(raw)) =>
  framesOf(raw, framing).map((frame) => frame.text)

/** A frame by position, failing loudly rather than handing back an undefined. */
function frameAt(raw: string, index: number, framing: RawFraming = framingFor(raw)): RawFrame {
  const frame = framesOf(raw, framing)[index]
  if (frame === undefined) throw new Error(`no frame ${index} in ${JSON.stringify(raw)}`)
  return frame
}

/** The one frame a body is expected to hold. */
function onlyFrame(raw: string, framing: RawFraming = framingFor(raw)): RawFrame {
  expect(framesOf(raw, framing)).toHaveLength(1)
  return frameAt(raw, 0, framing)
}

/** The payload a body is expected to yield: its first parsed frame's data. */
function payloadOf(raw: string, framing: RawFraming = framingFor(raw)): string | undefined {
  return frameEvents(frameAt(raw, 0, framing), framing)[0]?.data
}

describe('rawFrames · SSE boundaries', () => {
  it('splits at a blank line', () => {
    expect(framesOf('data: one\n\ndata: two\n\n', 'sse')).toEqual([
      { text: 'data: one', complete: true },
      { text: 'data: two', complete: true },
    ])
  })

  it('treats CRLF and a lone CR as one break each', () => {
    expect(texts('data: a\r\n\r\ndata: b\r\rdata: c\n\n', 'sse')).toEqual([
      'data: a',
      'data: b',
      'data: c',
    ])
  })

  it('keeps a multi-line payload inside one frame', () => {
    // A body the server spread over several data: lines is still one event.
    expect(texts('data: {\ndata: "a": 1\n}\n\ndata: last\n\n', 'sse')).toEqual([
      'data: {\ndata: "a": 1\n}',
      'data: last',
    ])
  })

  it('does not invent an empty frame for a run of blank lines', () => {
    expect(framesOf('data: a\n\n\n\ndata: b\n\n', 'sse')).toEqual([
      { text: 'data: a', complete: true },
      { text: 'data: b', complete: true },
    ])
  })

  it('marks a block the stream never terminated', () => {
    expect(framesOf('data: a\n\ndata: cut mid', 'sse')).toEqual([
      { text: 'data: a', complete: true },
      { text: 'data: cut mid', complete: false },
    ])
  })

  it('is empty only when the text is', () => {
    expect(framesOf('', 'sse')).toEqual([])
    expect(framesOf('\n\n', 'sse')).toEqual([])
  })

  it('leaves a frame of only unknown fields as one block', () => {
    // The spec ignores such fields, but the raw view must still show the bytes.
    expect(texts('vendor: x\n\ndata: y\n\n', 'sse')).toEqual(['vendor: x', 'data: y'])
  })
})

describe('rawFrames · NDJSON boundaries', () => {
  it('splits one record per line', () => {
    expect(framesOf('{"a":1}\n{"b":2}\n', 'ndjson')).toEqual([
      { text: '{"a":1}', complete: true },
      { text: '{"b":2}', complete: true },
    ])
  })

  it('marks a final line with no newline as unterminated', () => {
    expect(framesOf('{"a":1}\n{"b":', 'ndjson')).toEqual([
      { text: '{"a":1}', complete: true },
      { text: '{"b":', complete: false },
    ])
  })

  it('ignores blank lines between records', () => {
    expect(texts('{"a":1}\n\n\n{"b":2}\n', 'ndjson')).toEqual(['{"a":1}', '{"b":2}'])
  })
})

describe('rawFrames · framing detection', () => {
  it('reads blank-line framing as SSE', () => {
    expect(framingFor('data: {"a":1}\n\ndata: {"b":2}\n\n')).toBe('sse')
  })

  it('reads a whole-JSON-per-line body as NDJSON', () => {
    expect(framingFor('{"a":1}\n{"b":2}\n')).toBe('ndjson')
  })

  it('falls back to SSE when the tail cut the only parseable line', () => {
    // The raw view keeps a slice, so a first line can start mid-payload and no
    // longer parse; guessing NDJSON from that would split SSE frames per line.
    expect(framingFor('{"b":2} tail of a stream, not one object')).toBe('sse')
  })

  it('does not mistake one complete SSE frame for NDJSON', () => {
    // A single terminated frame is a short stream, not a JSON line: its `data:`
    // prefix must not be parsed away as if it were a field of the payload.
    expect(framingFor('data: {"a":1}\n\n')).toBe('sse')
  })
})

describe('rawFrames · parsing a frame', () => {
  it('yields the payload a JSON tree can be built from', () => {
    expect(payloadOf('data: {"created_at":1,"event":"node_started"}\n\n')).toBe(
      '{"created_at":1,"event":"node_started"}',
    )
  })

  it('keeps a payload with no space after the colon', () => {
    expect(payloadOf('data:{"a":1}\n\n')).toBe('{"a":1}')
  })

  it('does not cut a payload at the capture quota', () => {
    // 32 KiB is a storage limit; a frame this tab shows in full must stay parseable.
    const big = `"${'x'.repeat(40 * 1024)}"`
    const data = payloadOf(`data: {"big": ${big}}\n\n`)
    expect(data).not.toBeUndefined()
    expect(JSON.parse(data ?? '{}').big).toHaveLength(40 * 1024)
  })

  it('reports an unterminated block as nothing rather than as a finished frame', () => {
    // Synthesising the boundary would make a cut payload look valid, which is the
    // one thing a raw view must never do.
    expect(frameEvents(onlyFrame('data: {"a":', 'sse'), 'sse')).toEqual([])
  })

  it('still parses a complete frame beside an unterminated one', () => {
    const raw = 'data: {"a":1}\n\ndata: {"b":'
    expect(payloadOf(raw, 'sse')).toBe('{"a":1}')
    expect(frameEvents(frameAt(raw, 1, 'sse'), 'sse')).toEqual([])
  })

  it('carries the fields the row header shows', () => {
    const [event] = frameEvents(
      onlyFrame('id: 7\nevent: node_finished\ndata: {"ok":true}\n\n'),
      'sse',
    )
    expect(event).toMatchObject({ event: 'node_finished', id: '7', data: '{"ok":true}' })
  })

  it('parses an NDJSON record', () => {
    expect(payloadOf('{"seq":1,"text":"line 1"}\n', 'ndjson')).toBe(
      '{"seq":1,"text":"line 1"}',
    )
  })

  it('surfaces a heartbeat instead of hiding it', () => {
    const [event] = frameEvents(onlyFrame(': keep-alive\n\n'), 'sse')
    expect(event?.comment).toBe('keep-alive')
    expect(event?.data).toBe('')
  })

  it('leaves a frame with nothing recognisable empty', () => {
    expect(frameEvents(onlyFrame('vendor: x\n\n'), 'sse')).toEqual([])
  })
})
