/**
 * @vitest-environment jsdom
 *
 * Network-hook tests.
 *
 * The assertions are organised around the one invariant that matters most: **the
 * page behaves identically whether or not this hook is installed**. So alongside
 * "does it capture", there are cases for response-object fidelity, identity
 * preservation on non-captured requests, error propagation, and degradation when
 * the hook's own code throws.
 *
 * jsdom supplies `ReadableStream`, `Response`, `Headers` and `TextDecoder`, so
 * the fetch path runs against real stream plumbing rather than a hand-rolled
 * fake — `tee()` semantics are exactly what is under test and a fake would prove
 * nothing.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  installHook,
  mightCapture,
  parseRawHeaders,
  shouldCapture,
  type HookTarget,
  type HookTransport,
  type InstalledHook,
} from '../src/inpage/hook-install'
import type { PageMessage, RelayMessage } from '../src/lib/messages'

// --- Harness ----------------------------------------------------------------

/** Collects everything the hook emits and lets a test drive the arm state. */
class FakeTransport implements HookTransport {
  readonly sent: PageMessage[] = []
  private handler: ((message: RelayMessage) => void) | null = null
  /** Set to throw from `send`, modelling a reloaded extension. */
  failing = false

  send(message: PageMessage): void {
    if (this.failing) throw new Error('Extension context invalidated')
    this.sent.push(message)
  }

  onRelay(handler: (message: RelayMessage) => void): void {
    this.handler = handler
  }

  arm(armed: boolean, overrides: Partial<RelayMessage> = {}): void {
    this.handler?.({
      type: 'arm',
      armed,
      captureMode: 'loose',
      maxBodyChars: 4096,
      redactHeaders: [],
      ...overrides,
    } as RelayMessage)
  }

  of<T extends PageMessage['type']>(type: T): Extract<PageMessage, { type: T }>[] {
    return this.sent.filter((message) => message.type === type) as Extract<
      PageMessage,
      { type: T }
    >[]
  }

  /** All captured response text for one stream, in order. */
  textFor(localId?: string): string {
    return this.of('stream.chunk')
      .filter((message) => localId === undefined || message.localId === localId)
      .map((message) => message.text)
      .join('')
  }
}

/** Builds a streaming `Response` that emits the given chunks. */
function streamingResponse(
  chunks: string[],
  init: { status?: number; headers?: Record<string, string>; url?: string } = {},
): Response {
  const encoder = new TextEncoder()
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
      controller.close()
    },
  })
  const response = new Response(body, {
    status: init.status ?? 200,
    statusText: 'OK',
    headers: init.headers ?? { 'content-type': 'text/event-stream' },
  })
  if (init.url) Object.defineProperty(response, 'url', { value: init.url, configurable: true })
  return response
}

interface Harness {
  target: HookTarget & { fetch: typeof fetch }
  transport: FakeTransport
  hook: InstalledHook
  /** The `fetch` the hook replaced, for identity assertions. */
  nativeFetch: ReturnType<typeof vi.fn>
}

/**
 * Installs the hook over a fake global whose `fetch` returns `response`.
 *
 * `flushMs: 0` makes chunk emission synchronous, so tests assert on content
 * rather than racing a coalescing timer.
 */
function harness(options: {
  response?: Response | (() => Response | Promise<Response>)
  rejectWith?: unknown
  armed?: boolean
  captureMode?: 'strict' | 'loose'
} = {}): Harness {
  const nativeFetch = vi.fn(async () => {
    if (options.rejectWith !== undefined) throw options.rejectWith
    const source = options.response
    if (typeof source === 'function') return await source()
    return source ?? streamingResponse(['data: x\n\n'])
  })

  const target = {
    fetch: nativeFetch as unknown as typeof fetch,
    location: { href: 'https://example.test/app' },
    setTimeout: globalThis.setTimeout.bind(globalThis),
    clearTimeout: globalThis.clearTimeout.bind(globalThis),
    TextDecoder,
    Response,
    Headers,
  } as HookTarget & { fetch: typeof fetch }

  const transport = new FakeTransport()
  const hook = installHook({ target, transport, flushMs: 0, now: () => 1_000 })
  if (options.armed !== false) {
    transport.arm(true, { captureMode: options.captureMode ?? 'loose' } as Partial<RelayMessage>)
  }
  return { target, transport, hook, nativeFetch }
}

/** Reads a whole response body as text. */
async function readAll(response: Response): Promise<string> {
  return await response.text()
}

/** Lets queued microtasks and stream reads settle. */
async function settle(times = 8): Promise<void> {
  for (let index = 0; index < times; index += 1) await Promise.resolve()
  await new Promise((resolve) => setTimeout(resolve, 0))
}

beforeEach(() => {
  vi.restoreAllMocks()
})

// --- shouldCapture ----------------------------------------------------------

describe('shouldCapture', () => {
  it('accepts text/event-stream in both modes', () => {
    expect(shouldCapture('text/event-stream', 'strict')).toBe(true)
    expect(shouldCapture('text/event-stream', 'loose')).toBe(true)
  })

  it('ignores content-type parameters and casing', () => {
    expect(shouldCapture('Text/Event-Stream; charset=utf-8', 'strict')).toBe(true)
  })

  it('rejects everything else in strict mode, however SSE-shaped', () => {
    expect(shouldCapture('text/plain', 'strict', 'data: x\n\n')).toBe(false)
    expect(shouldCapture(null, 'strict', 'data: x\n\n')).toBe(false)
  })

  it('accepts a loose content type only when the payload shows framing', () => {
    expect(shouldCapture('text/plain', 'loose', 'data: x\n\n')).toBe(true)
    expect(shouldCapture('text/plain', 'loose', 'hello world')).toBe(false)
  })

  it('accepts NDJSON on a streaming content type', () => {
    expect(shouldCapture('application/x-ndjson', 'loose', '{"a":1}\n')).toBe(true)
  })

  it('treats a missing content type as eligible in loose mode', () => {
    // Common on streaming proxies, so the payload decides.
    expect(shouldCapture(null, 'loose', 'data: x\n\n')).toBe(true)
    expect(shouldCapture(null, 'loose', '<html>')).toBe(false)
  })

  it('rejects a non-streaming content type even with SSE-looking text', () => {
    // An HTML page that happens to contain "data:" is not a stream.
    expect(shouldCapture('text/html', 'loose', 'data: x\n\n')).toBe(false)
    expect(shouldCapture('application/json', 'loose', 'data: x\n\n')).toBe(false)
  })

  it('says no without a sniff sample', () => {
    expect(shouldCapture('text/plain', 'loose')).toBe(false)
    expect(shouldCapture('text/plain', 'loose', '')).toBe(false)
  })
})

describe('mightCapture', () => {
  it('is true for eligible types before any payload is seen', () => {
    expect(mightCapture('text/plain', 'loose')).toBe(true)
    expect(mightCapture(null, 'loose')).toBe(true)
    expect(mightCapture('text/event-stream', 'strict')).toBe(true)
  })

  it('is false where capture is already ruled out, so the body is never touched', () => {
    expect(mightCapture('text/html', 'loose')).toBe(false)
    expect(mightCapture('image/png', 'loose')).toBe(false)
    expect(mightCapture('text/plain', 'strict')).toBe(false)
  })
})

// --- Page fidelity ----------------------------------------------------------

describe('fetch · the page still works', () => {
  it('delivers the full body to the page for a captured stream', async () => {
    const chunks = ['data: one\n\n', 'data: two\n\n', 'data: three\n\n']
    const { target } = harness({ response: streamingResponse(chunks) })

    const response = await target.fetch('https://api.test/stream')
    // The page's branch must be byte-identical to what the server sent.
    expect(await readAll(response)).toBe(chunks.join(''))
  })

  it('preserves status, statusText and headers on the rebuilt response', async () => {
    const { target } = harness({
      response: streamingResponse(['data: x\n\n'], {
        status: 201,
        headers: { 'content-type': 'text/event-stream', 'x-trace': 'abc' },
      }),
    })

    const response = await target.fetch('https://api.test/stream')
    expect(response.status).toBe(201)
    expect(response.statusText).toBe('OK')
    expect(response.headers.get('x-trace')).toBe('abc')
    expect(response.headers.get('content-type')).toBe('text/event-stream')
  })

  it('preserves response.url, which a naive rebuild would blank', async () => {
    // A page resolving relative links against response.url would break silently.
    const { target } = harness({
      response: streamingResponse(['data: x\n\n'], { url: 'https://api.test/final' }),
    })
    const response = await target.fetch('https://api.test/stream')
    expect(response.url).toBe('https://api.test/final')
  })

  it('returns the identical response object when nothing is captured', async () => {
    const original = new Response('<html></html>', { headers: { 'content-type': 'text/html' } })
    const { target } = harness({ response: original })

    const response = await target.fetch('https://example.test/page')
    // Not a copy: identity, custom properties and prototype all survive.
    expect(response).toBe(original)
  })

  it('leaves a 204 alone, since rebuilding one throws', async () => {
    const original = new Response(null, { status: 204 })
    const { target } = harness({ response: original })
    expect(await target.fetch('https://api.test/empty')).toBe(original)
  })

  it('propagates a network rejection unchanged', async () => {
    const failure = new TypeError('Failed to fetch')
    const { target } = harness({ rejectWith: failure })
    await expect(target.fetch('https://api.test/down')).rejects.toBe(failure)
  })

  it('propagates an abort unchanged', async () => {
    const abort = Object.assign(new Error('The user aborted a request.'), { name: 'AbortError' })
    const { target } = harness({ rejectWith: abort })
    await expect(target.fetch('https://api.test/slow')).rejects.toBe(abort)
  })

  it('still returns the response when the hook itself throws', async () => {
    // A bug in this extension must degrade to "no capture", never to a broken page.
    const original = streamingResponse(['data: x\n\n'])
    Object.defineProperty(original, 'body', {
      get() {
        throw new Error('boom')
      },
    })
    const { target } = harness({ response: original })
    expect(await target.fetch('https://api.test/stream')).toBe(original)
  })

  it('does not call the native fetch more than once', async () => {
    const { target, nativeFetch } = harness()
    await target.fetch('https://api.test/stream')
    expect(nativeFetch).toHaveBeenCalledTimes(1)
  })

  it('keeps the wrapper indistinguishable at a glance', () => {
    const { target } = harness()
    expect(target.fetch.name).toBe('fetch')
    expect(target.fetch.length).toBe(1)
    expect(String(target.fetch)).toContain('[native code]')
  })

  it('restores the native fetch on uninstall', () => {
    const { target, hook, nativeFetch } = harness()
    expect(target.fetch).not.toBe(nativeFetch)
    hook.uninstall()
    expect(target.fetch).toBe(nativeFetch as unknown as typeof fetch)
  })
})

// --- Capture behaviour ------------------------------------------------------

describe('fetch · capture', () => {
  it('reports open, headers, body text and close', async () => {
    const { target, transport } = harness({
      response: streamingResponse(['data: a\n\n', 'data: b\n\n']),
    })

    await readAll(await target.fetch('https://api.test/stream'))
    await settle()

    const open = transport.of('stream.open')[0]
    expect(open?.streamKind).toBe('fetch')
    expect(open?.method).toBe('GET')
    expect(open?.url).toBe('https://api.test/stream')

    const headers = transport.of('stream.headers')[0]
    expect(headers?.status).toBe(200)
    expect(headers?.contentType).toBe('text/event-stream')

    expect(transport.textFor()).toBe('data: a\n\ndata: b\n\n')
    expect(transport.of('stream.close')[0]?.state).toBe('closed')
  })

  it('captures nothing at all when disarmed', async () => {
    const { target, transport } = harness({ armed: false })
    transport.arm(false)
    await readAll(await target.fetch('https://api.test/stream'))
    await settle()
    expect(transport.of('stream.open')).toHaveLength(0)
    expect(transport.of('stream.chunk')).toHaveLength(0)
  })

  it('records the request method and URL as absolute', async () => {
    const { target, transport } = harness()
    await readAll(await target.fetch('/relative/path', { method: 'post' }))
    await settle()
    const open = transport.of('stream.open')[0]
    expect(open?.url).toBe('https://example.test/relative/path')
    expect(open?.method).toBe('POST')
  })

  it('redacts an Authorization header before it leaves the page', async () => {
    const secret = 'Bearer sk-abcdefghijklmnopqrstuvwxyz'
    const { target, transport } = harness()
    await readAll(
      await target.fetch('https://api.test/stream', {
        headers: { Authorization: secret, 'content-type': 'application/json' },
      }),
    )
    await settle()

    const open = transport.of('stream.open')[0]
    const recorded = JSON.stringify(open?.requestHeaders ?? {})
    expect(recorded).not.toContain('sk-abcdefghijklmnopqrstuvwxyz')
    expect(open?.requestHeaders?.['content-type']).toBe('application/json')
  })

  it('redacts a secret in the request body', async () => {
    const { target, transport } = harness()
    await readAll(
      await target.fetch('https://api.test/stream', {
        method: 'POST',
        body: JSON.stringify({ model: 'gpt-4', api_key: 'sk-abcdefghijklmnopqrst' }),
      }),
    )
    await settle()
    const open = transport.of('stream.open')[0]
    expect(open?.requestBody).not.toContain('sk-abcdefghijklmnopqrst')
    expect(open?.requestBody).toContain('gpt-4')
  })

  it('never reads the body of a Request object', async () => {
    // Consuming it would break the page's own request.
    const request = new Request('https://api.test/stream', { method: 'POST', body: 'payload' })
    const { target, transport } = harness()
    await readAll(await target.fetch(request))
    await settle()
    expect(request.bodyUsed).toBe(false)
    expect(transport.of('stream.open')[0]?.requestBody).toBeUndefined()
  })

  it('captures a loose stream once framing appears', async () => {
    const { target, transport } = harness({
      response: streamingResponse(['data: hi\n\n'], { headers: { 'content-type': 'text/plain' } }),
    })
    await readAll(await target.fetch('https://api.test/plain'))
    await settle()
    expect(transport.of('stream.open')).toHaveLength(1)
    expect(transport.textFor()).toBe('data: hi\n\n')
  })

  it('does not capture a loose type whose payload is not framed', async () => {
    const { target, transport } = harness({
      response: streamingResponse(['plain old text, nothing to see'], {
        headers: { 'content-type': 'text/plain' },
      }),
    })
    const response = await target.fetch('https://api.test/plain')
    expect(await readAll(response)).toBe('plain old text, nothing to see')
    await settle()
    expect(transport.of('stream.open')).toHaveLength(0)
  })

  it('ignores an SSE-shaped payload in strict mode when the type is wrong', async () => {
    const { target, transport } = harness({
      captureMode: 'strict',
      response: streamingResponse(['data: x\n\n'], { headers: { 'content-type': 'text/plain' } }),
    })
    await readAll(await target.fetch('https://api.test/plain'))
    await settle()
    expect(transport.of('stream.open')).toHaveLength(0)
  })

  it('reports an error state when the stream breaks mid-flight', async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('data: partial\n\n'))
        controller.error(new Error('connection reset'))
      },
    })
    const { target, transport } = harness({
      response: new Response(body, { headers: { 'content-type': 'text/event-stream' } }),
    })

    const response = await target.fetch('https://api.test/stream')
    await expect(readAll(response)).rejects.toThrow()
    await settle()

    const close = transport.of('stream.close')[0]
    expect(close?.state).toBe('error')
    expect(close?.errorMessage).toContain('connection reset')
  })

  it('does not emit an open for a body that turns out uninteresting', async () => {
    const { target, transport } = harness({
      response: streamingResponse([`${'x'.repeat(9000)}`], {
        headers: { 'content-type': 'text/plain' },
      }),
    })
    await readAll(await target.fetch('https://api.test/big'))
    await settle()
    expect(transport.sent.filter((message) => message.type !== 'hook.ready')).toHaveLength(0)
  })

  it('reassembles a multi-byte character split across chunks', async () => {
    // The decoder must be streaming, or this arrives as replacement characters.
    const encoded = new TextEncoder().encode('data: 世界\n\n')
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoded.slice(0, 8))
        controller.enqueue(encoded.slice(8))
        controller.close()
      },
    })
    const { target, transport } = harness({
      response: new Response(body, { headers: { 'content-type': 'text/event-stream' } }),
    })

    await readAll(await target.fetch('https://api.test/stream'))
    await settle()
    expect(transport.textFor()).toBe('data: 世界\n\n')
    expect(transport.textFor()).not.toContain('\ufffd')
  })
})

// --- Arm-state buffering ----------------------------------------------------

describe('pre-arm buffering', () => {
  function bareHarness(): { target: HookTarget & { fetch: typeof fetch }; transport: FakeTransport } {
    const nativeFetch = vi.fn(async () => streamingResponse(['data: early\n\n']))
    const target = {
      fetch: nativeFetch as unknown as typeof fetch,
      location: { href: 'https://example.test/app' },
      setTimeout: globalThis.setTimeout.bind(globalThis),
      clearTimeout: globalThis.clearTimeout.bind(globalThis),
      TextDecoder,
      Response,
      Headers,
    } as HookTarget & { fetch: typeof fetch }
    const transport = new FakeTransport()
    installHook({ target, transport, flushMs: 0, now: () => 1_000 })
    return { target, transport }
  }

  it('flushes traffic that happened before the arm state arrived', async () => {
    // The case that matters: a page opens a stream during its own bootstrap,
    // before the worker has answered. Dropping it would miss the main event.
    const { target, transport } = bareHarness()
    await readAll(await target.fetch('https://api.test/stream'))
    await settle()

    expect(transport.of('stream.open')).toHaveLength(0)

    transport.arm(true)
    expect(transport.of('stream.open')).toHaveLength(1)
    expect(transport.textFor()).toBe('data: early\n\n')
  })

  it('discards buffered traffic when the answer is "not armed"', async () => {
    const { target, transport } = bareHarness()
    await readAll(await target.fetch('https://api.test/stream'))
    await settle()

    transport.arm(false)
    expect(transport.of('stream.open')).toHaveLength(0)
    expect(transport.of('stream.chunk')).toHaveLength(0)
  })

  it('stops capturing after a later disarm', async () => {
    const { target, transport } = bareHarness()
    transport.arm(true)
    transport.arm(false)
    await readAll(await target.fetch('https://api.test/stream'))
    await settle()
    expect(transport.of('stream.open')).toHaveLength(0)
  })

  it('survives a transport that throws, without breaking the page', async () => {
    const { target, transport } = bareHarness()
    transport.arm(true)
    transport.failing = true
    const response = await target.fetch('https://api.test/stream')
    // The page's read must still succeed even though reporting fails.
    expect(await readAll(response)).toBe('data: early\n\n')
  })
})

// --- EventSource ------------------------------------------------------------

describe('EventSource', () => {
  /** Minimal EventSource stand-in that a test can drive. */
  class FakeEventSource extends EventTarget {
    static readonly CONNECTING = 0
    static readonly OPEN = 1
    static readonly CLOSED = 2
    readyState = 0
    closed = false

    constructor(
      readonly url: string | URL,
      readonly config?: EventSourceInit,
    ) {
      super()
    }

    close(): void {
      this.closed = true
      this.readyState = 2
    }

    emit(type: string, data: string, lastEventId = ''): void {
      this.dispatchEvent(new MessageEvent(type, { data, lastEventId }))
    }
  }

  function esHarness(): {
    target: HookTarget & { EventSource: typeof EventSource }
    transport: FakeTransport
  } {
    const target = {
      EventSource: FakeEventSource as unknown as typeof EventSource,
      location: { href: 'https://example.test/app' },
      setTimeout: globalThis.setTimeout.bind(globalThis),
      clearTimeout: globalThis.clearTimeout.bind(globalThis),
    } as HookTarget & { EventSource: typeof EventSource }
    const transport = new FakeTransport()
    installHook({ target, transport, flushMs: 0, now: () => 2_000 })
    transport.arm(true)
    return { target, transport }
  }

  it('records message events with the eventsource kind', () => {
    const { target, transport } = esHarness()
    const source = new target.EventSource('/events') as unknown as FakeEventSource
    source.emit('message', 'hello')

    expect(transport.of('stream.open')[0]?.streamKind).toBe('eventsource')
    expect(transport.of('stream.open')[0]?.url).toBe('https://example.test/events')
    expect(transport.of('stream.event')[0]?.event.data).toBe('hello')
  })

  it('numbers reconstructed events in order', () => {
    const { target, transport } = esHarness()
    const source = new target.EventSource('/events') as unknown as FakeEventSource
    source.emit('message', 'a')
    source.emit('message', 'b')
    expect(transport.of('stream.event').map((message) => message.event.seq)).toEqual([0, 1])
  })

  it('carries lastEventId through as the event id', () => {
    const { target, transport } = esHarness()
    const source = new target.EventSource('/events') as unknown as FakeEventSource
    source.emit('message', 'x', '42')
    expect(transport.of('stream.event')[0]?.event.id).toBe('42')
  })

  it('captures a custom event type the page subscribes to', () => {
    // Without mirroring the page's subscription these would be invisible.
    const { target, transport } = esHarness()
    const source = new target.EventSource('/events') as unknown as FakeEventSource
    const seen: string[] = []
    source.addEventListener('delta', (event) => {
      seen.push((event as MessageEvent<string>).data)
    })
    source.emit('delta', 'chunk-1')

    // The page's own listener still fires...
    expect(seen).toEqual(['chunk-1'])
    // ...and the event is recorded.
    const recorded = transport.of('stream.event')[0]?.event
    expect(recorded?.event).toBe('delta')
    expect(recorded?.data).toBe('chunk-1')
  })

  it('delivers events to the page listener exactly once', () => {
    const { target } = esHarness()
    const source = new target.EventSource('/events') as unknown as FakeEventSource
    const listener = vi.fn()
    source.addEventListener('message', listener)
    source.emit('message', 'x')
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('reports a close when the page closes the stream', () => {
    const { target, transport } = esHarness()
    const source = new target.EventSource('/events') as unknown as FakeEventSource
    source.emit('message', 'x')
    source.close()

    expect(transport.of('stream.close')[0]?.state).toBe('closed')
    // The native close must still have run.
    expect(source.closed).toBe(true)
  })

  it('ignores an error that is only a reconnect attempt', () => {
    const { target, transport } = esHarness()
    const source = new target.EventSource('/events') as unknown as FakeEventSource
    source.emit('message', 'x')
    source.readyState = 0 // CONNECTING: the browser will retry.
    source.dispatchEvent(new Event('error'))
    expect(transport.of('stream.close')).toHaveLength(0)
  })

  it('reports an error once the browser gives up', () => {
    const { target, transport } = esHarness()
    const source = new target.EventSource('/events') as unknown as FakeEventSource
    source.emit('message', 'x')
    source.readyState = 2 // CLOSED
    source.dispatchEvent(new Event('error'))
    expect(transport.of('stream.close')[0]?.state).toBe('error')
  })

  it('does not report twice when close follows a terminal error', () => {
    const { target, transport } = esHarness()
    const source = new target.EventSource('/events') as unknown as FakeEventSource
    source.emit('message', 'x')
    source.readyState = 2
    source.dispatchEvent(new Event('error'))
    source.close()
    expect(transport.of('stream.close')).toHaveLength(1)
  })

  it('keeps the readyState constants on the wrapper', () => {
    const { target } = esHarness()
    expect(target.EventSource.CONNECTING).toBe(0)
    expect(target.EventSource.OPEN).toBe(1)
    expect(target.EventSource.CLOSED).toBe(2)
  })

  it('keeps instanceof working', () => {
    const { target } = esHarness()
    const source = new target.EventSource('/events')
    expect(source instanceof FakeEventSource).toBe(true)
  })
})

// --- XMLHttpRequest ---------------------------------------------------------

describe('XMLHttpRequest', () => {
  /**
   * Minimal XHR stand-in a test can drive.
   *
   * Models the two behaviours the hook depends on: `responseText` grows across
   * `progress` events, and it *throws* for a binary `responseType` — which is
   * how the unreadable-stream path is reached.
   */
  class FakeXhr extends EventTarget {
    static readonly opened: FakeXhr[] = []
    method = ''
    requestUrl = ''
    sentBody: unknown = undefined
    requestHeaders: Record<string, string> = {}
    status = 200
    statusText = 'OK'
    responseType: XMLHttpRequestResponseType = ''
    rawHeaders = 'content-type: text/event-stream\r\n'
    private text = ''

    get responseText(): string {
      if (this.responseType !== '' && this.responseType !== 'text') {
        throw new DOMException('responseText is not available', 'InvalidStateError')
      }
      return this.text
    }

    open(method: string, url: string): void {
      this.method = method
      this.requestUrl = url
      FakeXhr.opened.push(this)
    }

    setRequestHeader(name: string, value: string): void {
      this.requestHeaders[name] = value
    }

    send(body?: unknown): void {
      this.sentBody = body
    }

    getAllResponseHeaders(): string {
      return this.rawHeaders
    }

    getResponseHeader(name: string): string | null {
      const match = new RegExp(`^${name}: (.*)$`, 'im').exec(this.rawHeaders)
      return match?.[1] ?? null
    }

    /** Appends text and fires `progress`, as a real streaming XHR does. */
    progress(chunk: string): void {
      this.text += chunk
      this.dispatchEvent(new Event('progress'))
    }

    finish(type: 'load' | 'error' | 'abort' | 'timeout' = 'load'): void {
      this.dispatchEvent(new Event(type))
    }
  }

  function xhrHarness(captureMode: 'strict' | 'loose' = 'loose'): {
    Xhr: typeof FakeXhr
    transport: FakeTransport
    hook: InstalledHook
  } {
    FakeXhr.opened.length = 0
    // A fresh subclass per test, so prototype patches never leak between cases.
    class Scoped extends FakeXhr {}
    const target = {
      XMLHttpRequest: Scoped as unknown as typeof XMLHttpRequest,
      location: { href: 'https://example.test/app' },
      setTimeout: globalThis.setTimeout.bind(globalThis),
      clearTimeout: globalThis.clearTimeout.bind(globalThis),
    } as HookTarget
    const transport = new FakeTransport()
    const hook = installHook({ target, transport, flushMs: 0, now: () => 3_000 })
    transport.arm(true, { captureMode } as Partial<RelayMessage>)
    return { Xhr: Scoped as unknown as typeof FakeXhr, transport, hook }
  }

  it('captures a streaming response and reports its metadata', () => {
    const { Xhr, transport } = xhrHarness()
    const xhr = new Xhr()
    xhr.open('POST', '/v1/stream')
    xhr.setRequestHeader('content-type', 'application/json')
    xhr.send('{"stream":true}')
    xhr.progress('data: a\n\n')
    xhr.finish()

    const open = transport.of('stream.open')[0]
    expect(open?.streamKind).toBe('xhr')
    expect(open?.method).toBe('POST')
    expect(open?.url).toBe('https://example.test/v1/stream')
    expect(open?.requestHeaders?.['content-type']).toBe('application/json')
    expect(transport.textFor()).toBe('data: a\n\n')
    expect(transport.of('stream.close')[0]?.state).toBe('closed')
  })

  it('forwards only the newly arrived text on each progress event', () => {
    // `responseText` is cumulative, so a naive implementation re-sends
    // everything and the panel shows each frame N times.
    const { Xhr, transport } = xhrHarness()
    const xhr = new Xhr()
    xhr.open('GET', '/stream')
    xhr.send()
    xhr.progress('data: a\n\n')
    xhr.progress('data: b\n\n')
    xhr.progress('data: c\n\n')
    xhr.finish()

    expect(transport.textFor()).toBe('data: a\n\ndata: b\n\ndata: c\n\n')
  })

  it('still passes the body through to the native send', () => {
    const { Xhr } = xhrHarness()
    const xhr = new Xhr()
    xhr.open('POST', '/stream')
    xhr.send('payload')
    expect(xhr.sentBody).toBe('payload')
  })

  it('still records the header on the native request', () => {
    const { Xhr } = xhrHarness()
    const xhr = new Xhr()
    xhr.open('GET', '/stream')
    xhr.setRequestHeader('x-trace', 'abc')
    xhr.send()
    expect(xhr.requestHeaders['x-trace']).toBe('abc')
  })

  it('redacts a secret request header', () => {
    const { Xhr, transport } = xhrHarness()
    const xhr = new Xhr()
    xhr.open('GET', '/stream')
    xhr.setRequestHeader('Authorization', 'Bearer sk-abcdefghijklmnopqrst')
    xhr.send()
    xhr.progress('data: a\n\n')

    const recorded = JSON.stringify(transport.of('stream.open')[0]?.requestHeaders ?? {})
    expect(recorded).not.toContain('sk-abcdefghijklmnopqrst')
  })

  it('reports response headers parsed from the raw block', () => {
    const { Xhr, transport } = xhrHarness()
    const xhr = new Xhr()
    xhr.rawHeaders = 'content-type: text/event-stream\r\ncache-control: no-cache\r\n'
    xhr.open('GET', '/stream')
    xhr.send()
    xhr.progress('data: a\n\n')

    expect(transport.of('stream.headers')[0]?.responseHeaders).toEqual({
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
    })
  })

  it('ignores a non-streaming response', () => {
    const { Xhr, transport } = xhrHarness()
    const xhr = new Xhr()
    xhr.rawHeaders = 'content-type: application/json\r\n'
    xhr.open('GET', '/api')
    xhr.send()
    xhr.progress('{"ok":true}')
    xhr.finish()

    expect(transport.of('stream.open')).toHaveLength(0)
    expect(transport.of('stream.close')).toHaveLength(0)
  })

  it('records an unreadable stream rather than omitting it', () => {
    // A binary responseType is a legitimate page choice; silently dropping the
    // stream would look like the tool had missed the request entirely.
    const { Xhr, transport } = xhrHarness()
    const xhr = new Xhr()
    xhr.responseType = 'arraybuffer'
    xhr.open('GET', '/stream')
    xhr.send()
    xhr.progress('ignored')

    expect(transport.of('stream.open')).toHaveLength(1)
    expect(transport.of('stream.unreadable')[0]?.reason).toContain('arraybuffer')
  })

  it('reports an aborted request as aborted', () => {
    const { Xhr, transport } = xhrHarness()
    const xhr = new Xhr()
    xhr.open('GET', '/stream')
    xhr.send()
    xhr.progress('data: a\n\n')
    xhr.finish('abort')
    expect(transport.of('stream.close')[0]?.state).toBe('aborted')
  })

  it('reports a failed request as an error', () => {
    const { Xhr, transport } = xhrHarness()
    const xhr = new Xhr()
    xhr.open('GET', '/stream')
    xhr.send()
    xhr.progress('data: a\n\n')
    xhr.finish('error')
    expect(transport.of('stream.close')[0]?.state).toBe('error')
  })

  it('reports a timeout as an error', () => {
    const { Xhr, transport } = xhrHarness()
    const xhr = new Xhr()
    xhr.open('GET', '/stream')
    xhr.send()
    xhr.progress('data: a\n\n')
    xhr.finish('timeout')
    expect(transport.of('stream.close')[0]?.state).toBe('error')
  })

  it('closes only once even if several terminal events fire', () => {
    const { Xhr, transport } = xhrHarness()
    const xhr = new Xhr()
    xhr.open('GET', '/stream')
    xhr.send()
    xhr.progress('data: a\n\n')
    xhr.finish('load')
    xhr.finish('error')
    expect(transport.of('stream.close')).toHaveLength(1)
  })

  it('captures nothing when disarmed', () => {
    const { Xhr, transport } = xhrHarness()
    transport.arm(false)
    const xhr = new Xhr()
    xhr.open('GET', '/stream')
    xhr.send()
    xhr.progress('data: a\n\n')
    xhr.finish()
    expect(transport.of('stream.open')).toHaveLength(0)
  })

  it('restores the native prototype methods on uninstall', () => {
    const { Xhr, hook } = xhrHarness()
    const patched = Xhr.prototype.open
    hook.uninstall()
    expect(Xhr.prototype.open).not.toBe(patched)
    // And the restored method still works.
    const xhr = new Xhr()
    xhr.open('GET', '/plain')
    expect(xhr.method).toBe('GET')
  })
})

// --- parseRawHeaders --------------------------------------------------------

describe('parseRawHeaders', () => {
  it('parses CRLF-delimited headers', () => {
    expect(parseRawHeaders('content-type: text/event-stream\r\ncache-control: no-cache\r\n')).toEqual({
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
    })
  })

  it('keeps colons inside a value, as a Date header always has', () => {
    expect(parseRawHeaders('date: Mon, 01 Jan 2026 10:20:30 GMT\r\n')).toEqual({
      date: 'Mon, 01 Jan 2026 10:20:30 GMT',
    })
  })

  it('returns undefined for empty input', () => {
    expect(parseRawHeaders('')).toBeUndefined()
  })

  it('skips a line with no colon rather than inventing a key', () => {
    expect(parseRawHeaders('garbage\r\nx: 1\r\n')).toEqual({ x: '1' })
  })
})
