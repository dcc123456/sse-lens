/**
 * End-to-end check against the demo server.
 *
 * Not part of `pnpm test`: it needs `node demo/server.mjs` running, and a test
 * suite that fails when a server is absent is a test suite people learn to ignore.
 * Its purpose is to close the one gap the unit tests cannot — every one of those
 * feeds the parser text that *this repository* wrote, so a mistaken assumption
 * about real SSE framing would be invisible. Here the bytes come off a socket.
 *
 * Run: `node demo/verify.mjs` (with the server already up).
 */

import { SseParser, NdjsonParser, looksLikeSse } from '../src/lib/sse.ts'
import { mergeDeltas } from '../src/lib/deltas.ts'

const BASE = `http://127.0.0.1:${process.env.PORT ?? 8787}`

let failures = 0

function check(label, condition, detail = '') {
  const mark = condition ? 'PASS' : 'FAIL'
  if (!condition) failures += 1
  process.stdout.write(`  [${mark}] ${label}${detail ? ` — ${detail}` : ''}\n`)
}

/** Streams a URL through the real parser, exactly as the worker does. */
async function capture(path, { ndjson = false } = {}) {
  const response = await fetch(`${BASE}${path}`)
  const parser = ndjson ? new NdjsonParser() : new SseParser()
  const decoder = new TextDecoder()
  const reader = response.body.getReader()
  const events = []
  let raw = ''

  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    const text = decoder.decode(value, { stream: true })
    raw += text
    events.push(...parser.push(text))
  }
  const { events: flushed, tail } = parser.flush()
  events.push(...flushed)

  return { response, events, tail, raw }
}

process.stdout.write('\n/sse — framing, comments, ids, retry\n')
{
  const { response, events, raw } = await capture('/sse')
  check('content-type is text/event-stream', response.headers.get('content-type') === 'text/event-stream')
  check('raw text is recognised as SSE', looksLikeSse(raw))

  const messages = events.filter((event) => event.event === 'message' && event.comment === undefined)
  const comments = events.filter((event) => event.comment !== undefined)
  const dataFrames = messages.filter((event) => event.data.startsWith('frame '))

  check('12 numbered frames parsed', dataFrames.length === 12, `got ${dataFrames.length}`)
  check('frames are in order', dataFrames.every((event, index) => event.data === `frame ${index + 1} of 12`))
  check('ids captured', dataFrames[0]?.id === '1' && dataFrames[11]?.id === '12')
  check('retry directive captured', events.some((event) => event.retry === 3000))
  check('comments captured (fetch keeps them)', comments.length >= 4, `got ${comments.length}`)
  check('[DONE] sentinel present', messages.some((event) => event.data === '[DONE]'))
  check('sequence numbers are unique and ascending', events.every((event, index) => event.seq === index))
}

process.stdout.write('\n/deltas — merge reassembles the sentence\n')
{
  const { events } = await capture('/deltas')
  const merged = mergeDeltas(events)
  check('a merge was found', merged !== undefined)
  check(
    'delta path discovered',
    merged?.path === 'choices[].delta.content',
    merged?.path ?? 'none',
  )
  check('style is incremental', merged?.style === 'incremental')
  const expected =
    'Server-sent events arrive one frame at a time, which is exactly why they are hard to read raw.'
  check('text reassembled exactly', merged?.text === expected, JSON.stringify(merged?.text ?? ''))
}

process.stdout.write('\n/sse?as=text/plain — mislabelled stream still parses\n')
{
  const { response, events, raw } = await capture('/sse?as=text/plain')
  check('served as text/plain', response.headers.get('content-type') === 'text/plain')
  check('sniffing recognises it anyway', looksLikeSse(raw))
  check('frames parsed', events.filter((event) => event.data.startsWith('frame ')).length === 12)
}

process.stdout.write('\n/ndjson — line framing\n')
{
  const { events } = await capture('/ndjson', { ndjson: true })
  check('8 lines parsed', events.length === 8, `got ${events.length}`)
  check('each line is valid JSON', events.every((event) => {
    try {
      JSON.parse(event.data)
      return true
    } catch {
      return false
    }
  }))
  check('last line marks done', JSON.parse(events[7]?.data ?? '{}').done === true)
}

process.stdout.write('\n/truncated — unterminated tail is surfaced\n')
{
  const { events, tail } = await capture('/truncated')
  check('two complete frames parsed', events.length === 2, `got ${events.length}`)
  check('tail holds the unterminated remainder', tail === 'data: this frame never term', JSON.stringify(tail))
  check('tail is NOT parsed as a frame', !events.some((event) => event.data.includes('never term')))
}

process.stdout.write('\n/json — control: not a stream\n')
{
  const response = await fetch(`${BASE}/json`)
  const raw = await response.text()
  check('not recognised as SSE', !looksLikeSse(raw))
}

process.stdout.write(
  failures === 0 ? '\nAll end-to-end checks passed.\n\n' : `\n${failures} check(s) FAILED.\n\n`,
)
process.exit(failures === 0 ? 0 : 1)
