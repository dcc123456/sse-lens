/**
 * Delta-merge tests.
 *
 * Written against the real wire shapes of the major streaming APIs, because the
 * merge works by *discovering* the delta path rather than matching a vendor
 * table — and a discovery heuristic is only trustworthy if it is checked against
 * the actual variety it claims to handle. Each case below is a shape a real server
 * emits, plus the failure modes that a naive implementation falls into:
 * concatenating a cumulative stream, mistaking a repeated `role` for content, or
 * picking a reasoning trace over the answer.
 */

import { describe, expect, it } from 'vitest'
import { formatEventData, mergeDeltas, parseEventJson } from '../src/lib/deltas'
import type { SseEvent } from '../src/lib/types'

/** Builds frames from raw data strings. */
function frames(...data: string[]): SseEvent[] {
  return data.map((value, index) => ({
    seq: index,
    at: 1_000 + index,
    event: 'message',
    data: value,
  }))
}

/** Builds frames from objects, the common case. */
function jsonFrames(...payloads: unknown[]): SseEvent[] {
  return frames(...payloads.map((payload) => JSON.stringify(payload)))
}

describe('mergeDeltas · OpenAI chat completions', () => {
  const stream = jsonFrames(
    {
      id: 'chatcmpl-1',
      object: 'chat.completion.chunk',
      model: 'gpt-4o',
      choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }],
    },
    { id: 'chatcmpl-1', choices: [{ index: 0, delta: { content: 'Hello' } }] },
    { id: 'chatcmpl-1', choices: [{ index: 0, delta: { content: ', ' } }] },
    { id: 'chatcmpl-1', choices: [{ index: 0, delta: { content: 'world' } }] },
    { id: 'chatcmpl-1', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
  )

  it('assembles the message text', () => {
    expect(mergeDeltas(stream)?.text).toBe('Hello, world')
  })

  it('reports the discovered path with collapsed array indices', () => {
    // Collapsed, because the index varies and naming one would be misleading.
    expect(mergeDeltas(stream)?.path).toBe('choices[].delta.content')
  })

  it('classifies the stream as incremental', () => {
    expect(mergeDeltas(stream)?.style).toBe('incremental')
  })

  it('ignores the [DONE] sentinel', () => {
    const withDone = [...stream, ...frames('[DONE]')]
    expect(mergeDeltas(withDone)?.text).toBe('Hello, world')
  })

  it('does not mistake the repeated role for content', () => {
    // `role: 'assistant'` recurs in some implementations; a constant is not a delta.
    expect(mergeDeltas(stream)?.text).not.toContain('assistant')
  })
})

describe('mergeDeltas · Anthropic content blocks', () => {
  const stream = [
    ...jsonFrames(
      { type: 'message_start', message: { id: 'msg_1', model: 'claude-3' } },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'The ' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'answer ' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'is 42.' } },
      { type: 'content_block_stop', index: 0 },
    ),
  ]

  it('assembles the text from delta.text', () => {
    const result = mergeDeltas(stream)
    expect(result?.text).toBe('The answer is 42.')
    expect(result?.path).toBe('delta.text')
  })
})

describe('mergeDeltas · Gemini candidates', () => {
  it('reaches through the nested parts array', () => {
    const stream = jsonFrames(
      { candidates: [{ content: { parts: [{ text: 'Bonjour' }], role: 'model' } }] },
      { candidates: [{ content: { parts: [{ text: ' le' }] } }] },
      { candidates: [{ content: { parts: [{ text: ' monde' }] } }] },
    )
    const result = mergeDeltas(stream)
    expect(result?.text).toBe('Bonjour le monde')
    expect(result?.path).toBe('candidates[].content.parts[].text')
  })
})

describe('mergeDeltas · Ollama', () => {
  it('merges the response field', () => {
    const stream = jsonFrames(
      { model: 'llama3', created_at: '2026-01-01T00:00:00Z', response: 'Once', done: false },
      { model: 'llama3', response: ' upon', done: false },
      { model: 'llama3', response: ' a time', done: false },
      { model: 'llama3', response: '', done: true },
    )
    expect(mergeDeltas(stream)?.text).toBe('Once upon a time')
  })
})

describe('mergeDeltas · cumulative streams', () => {
  const stream = jsonFrames(
    { text: 'Hel' },
    { text: 'Hello' },
    { text: 'Hello wo' },
    { text: 'Hello world' },
  )

  it('takes the last value instead of concatenating', () => {
    // Concatenating would give 'HelHelloHello woHello world' — quadratic garbage.
    expect(mergeDeltas(stream)?.text).toBe('Hello world')
  })

  it('labels the style so the UI can explain itself', () => {
    expect(mergeDeltas(stream)?.style).toBe('cumulative')
  })

  it('does not treat a coincidental prefix in two frames as cumulative', () => {
    // 'ab' extends 'a', but two frames is not a pattern.
    const short = jsonFrames({ content: 'a' }, { content: 'ab' })
    expect(mergeDeltas(short)?.style).toBe('incremental')
  })
})

describe('mergeDeltas · reasoning models', () => {
  it('prefers the answer over the reasoning trace', () => {
    // Both are incremental; picking by frame count alone would surface the
    // scratchpad as the answer.
    const stream = jsonFrames(
      { choices: [{ delta: { reasoning_content: 'Let me think. ' } }] },
      { choices: [{ delta: { reasoning_content: 'Two plus two. ' } }] },
      { choices: [{ delta: { reasoning_content: 'That is four. ' } }] },
      { choices: [{ delta: { content: 'The answer ' } }] },
      { choices: [{ delta: { content: 'is 4.' } }] },
    )
    const result = mergeDeltas(stream)
    expect(result?.path).toBe('choices[].delta.content')
    expect(result?.text).toBe('The answer is 4.')
  })
})

describe('mergeDeltas · in-house shapes', () => {
  it('discovers an unknown field name from its behaviour', () => {
    // The whole point of discovery: no vendor table would contain this.
    const stream = jsonFrames(
      { payload: { fragment: 'alpha' } },
      { payload: { fragment: '-beta' } },
      { payload: { fragment: '-gamma' } },
      { payload: { fragment: '-delta' } },
    )
    const result = mergeDeltas(stream)
    expect(result?.text).toBe('alpha-beta-gamma-delta')
    expect(result?.path).toBe('payload.fragment')
  })

  it('prefers a high-coverage in-house field over a sparse known name', () => {
    const stream = jsonFrames(
      { blob: 'a', text: 'ignore me' },
      { blob: 'b' },
      { blob: 'c' },
      { blob: 'd' },
      { blob: 'e' },
    )
    expect(mergeDeltas(stream)?.path).toBe('blob')
  })
})

describe('mergeDeltas · raw text streams', () => {
  it('concatenates non-JSON frames', () => {
    expect(mergeDeltas(frames('Hello', ' ', 'world'))?.text).toBe('Hello world')
  })

  it('reports how many frames were plain text', () => {
    expect(mergeDeltas(frames('a', 'b', 'c'))?.plainTextEvents).toBe(3)
  })

  it('declines a single plain-text frame, which is not a stream', () => {
    expect(mergeDeltas(frames('just one'))).toBeUndefined()
  })

  it('declines whitespace-only content', () => {
    expect(mergeDeltas(frames(' ', '  ', '\t'))).toBeUndefined()
  })
})

describe('mergeDeltas · declining to guess', () => {
  it('returns undefined for an empty stream', () => {
    expect(mergeDeltas([])).toBeUndefined()
  })

  it('returns undefined when only sentinels arrived', () => {
    expect(mergeDeltas(frames('[DONE]', '{}', ''))).toBeUndefined()
  })

  it('returns undefined for status frames with no text field', () => {
    const stream = jsonFrames(
      { progress: 0.1, elapsed: 12 },
      { progress: 0.5, elapsed: 30 },
      { progress: 1, elapsed: 61 },
    )
    expect(mergeDeltas(stream)).toBeUndefined()
  })

  it('returns undefined when every frame carries only metadata', () => {
    const stream = jsonFrames(
      { id: 'a', model: 'm', role: 'assistant' },
      { id: 'a', model: 'm', role: 'assistant' },
      { id: 'a', model: 'm', role: 'assistant' },
    )
    expect(mergeDeltas(stream)).toBeUndefined()
  })

  it('ignores comment frames', () => {
    // Heartbeats are framing, never content.
    const stream: SseEvent[] = [
      { seq: 0, at: 1, event: 'comment', data: '', comment: 'keep-alive' },
      { seq: 1, at: 2, event: 'comment', data: '', comment: 'keep-alive' },
      { seq: 2, at: 3, event: 'comment', data: '', comment: 'keep-alive' },
    ]
    expect(mergeDeltas(stream)).toBeUndefined()
  })
})

describe('mergeDeltas · robustness', () => {
  it('survives a malformed frame in the middle of a good stream', () => {
    const stream = [
      ...jsonFrames({ choices: [{ delta: { content: 'good ' } }] }),
      ...frames('{"choices":[{"delta":{"content":"trunc'),
      ...jsonFrames({ choices: [{ delta: { content: 'again' } }] }),
    ]
    // The valid frames still merge; the broken one is not silently absorbed.
    expect(mergeDeltas(stream)?.text).toBe('good again')
  })

  it('does not recurse without bound on deeply nested data', () => {
    let nested: unknown = { content: 'deep' }
    for (let depth = 0; depth < 200; depth += 1) nested = { wrap: nested }
    expect(() => mergeDeltas(jsonFrames(nested, nested))).not.toThrow()
  })

  it('counts a frame with parallel choices once', () => {
    const stream = jsonFrames(
      { choices: [{ index: 0, delta: { content: 'a' } }, { index: 1, delta: { content: 'z' } }] },
      { choices: [{ index: 0, delta: { content: 'b' } }, { index: 1, delta: { content: 'y' } }] },
    )
    // First value per frame wins, so choice 0 reads cleanly.
    expect(mergeDeltas(stream)?.text).toBe('ab')
  })
})

describe('formatEventData', () => {
  it('pretty-prints JSON', () => {
    const result = formatEventData('{"a":1,"b":[2,3]}')
    expect(result.isJson).toBe(true)
    expect(result.text).toBe('{\n  "a": 1,\n  "b": [\n    2,\n    3\n  ]\n}')
  })

  it('returns malformed input verbatim', () => {
    // A malformed frame is exactly what someone opened this tool to see.
    const broken = '{"a":1,'
    const result = formatEventData(broken)
    expect(result.isJson).toBe(false)
    expect(result.text).toBe(broken)
  })

  it('leaves plain text alone', () => {
    expect(formatEventData('[DONE]')).toEqual({ text: '[DONE]', isJson: false })
  })
})

describe('parseEventJson', () => {
  it('parses an object', () => {
    expect(parseEventJson('{"a":1}')).toEqual({ a: 1 })
  })

  it('parses an array', () => {
    expect(parseEventJson('[1,2]')).toEqual([1, 2])
  })

  it('returns undefined for a bare scalar, which needs no tree view', () => {
    expect(parseEventJson('42')).toBeUndefined()
    expect(parseEventJson('"text"')).toBeUndefined()
  })

  it('returns undefined for malformed JSON', () => {
    expect(parseEventJson('{oops')).toBeUndefined()
  })
})
