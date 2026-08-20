/**
 * The MAIN-world network hook.
 *
 * ## Why this exists at all
 *
 * MV3 gives an extension no way to read a response body: `webRequest` sees
 * headers only, `declarativeNetRequest` cannot observe, and `chrome.debugger`
 * would banner the tab and evict DevTools. So the only seam is the page's own
 * network primitives, patched before any page script can capture a reference to
 * them.
 *
 * ## The rule everything here obeys
 *
 * **The page must behave exactly as it would have without this extension.** A
 * debugging tool that changes the thing being debugged is worse than no tool. In
 * practice that means:
 *
 * - Every wrapper is guarded, and every failure path falls back to the native
 *   behaviour. A bug in this file must degrade to "no capture", never to "the
 *   page broke".
 * - Non-captured requests return the *original* object, not a copy, so identity
 *   comparisons and non-standard properties survive untouched.
 * - `response.body.tee()` is used rather than `response.clone()`. `clone()`
 *   buffers without bound when one consumer reads slower than the other, which
 *   on a long-lived SSE connection is an unbounded memory leak inside the user's
 *   page. `tee()` has the same hazard in principle, but this side always drains
 *   as fast as the network delivers, so its buffer stays near zero.
 * - Reconstructing a `Response` loses `url`, `redirected` and `type`, which are
 *   prototype getters with no constructor equivalent. They are restored with
 *   `defineProperty`, because a page that resolves links against `response.url`
 *   after a redirect must not suddenly see an empty string.
 *
 * ## Fidelity, by transport
 *
 * `fetch` and `XMLHttpRequest` yield raw response text, so framing is preserved
 * exactly and parsing happens in the worker. `EventSource` does not: the browser
 * has already consumed the bytes, so events are reconstructed from the parsed
 * DOM events and comments/heartbeats are structurally invisible. The UI labels
 * that difference rather than letting the user infer the server sent none.
 *
 * This module is separate from `hook.ts` purely so tests can install it onto a
 * fake global with a fake transport; `hook.ts` is the content-script entry that
 * installs it onto the real `window`.
 *
 * @module inpage/install
 */

import { looksLikeNdjson, looksLikeSse } from '../lib/sse'
import { redactBody, redactHeaders } from '../lib/redact'
import type { PageMessage, RelayMessage } from '../lib/messages'
import type { CaptureMode, SseEvent } from '../lib/types'

/** Content type captured in `strict` mode. */
const SSE_CONTENT_TYPE = 'text/event-stream'

/**
 * Content types `loose` mode will *consider*, subject to sniffing the payload.
 *
 * Many LLM gateways and proxies serve genuine `data:`-framed SSE as `text/plain`
 * or `application/octet-stream`; refusing those would make the tool useless
 * against exactly the endpoints people most want to inspect. Sniffing keeps the
 * false-positive rate down, so an HTML document served as `text/plain` is not
 * captured because it contains no framing.
 */
const LOOSE_CONTENT_TYPES = [
  'text/plain',
  'application/x-ndjson',
  'application/ndjson',
  'application/jsonl',
  'application/stream+json',
  'application/octet-stream',
]

/**
 * Coalescing window for response text.
 *
 * A token-by-token completion produces one chunk per token, often 50+/s. One
 * `postMessage` each would put avoidable pressure on the page's event loop for
 * no visible benefit, since nobody can perceive 25ms of added latency in a log
 * view. Batching here rather than in the worker keeps the cost off the page.
 */
const CHUNK_FLUSH_MS = 25

/**
 * Characters sniffed before giving up on an undecided response.
 *
 * If framing has not appeared within this much text, the response is not SSE and
 * further buffering would just hold page memory.
 */
const SNIFF_LIMIT = 8192

/**
 * Messages buffered before the arm state is known.
 *
 * The hook runs at `document_start`, but the arm state has to arrive
 * asynchronously from the worker (the MAIN world cannot read `chrome.storage`).
 * A page that opens a stream during its own bootstrap would otherwise be missed
 * entirely, which is the single most common case for a streaming app. So early
 * traffic is held, then flushed or discarded once the answer arrives. Bounded,
 * because an unarmed tab must not accumulate a page's whole network history.
 */
const PREARM_MAX_MESSAGES = 400
const PREARM_MAX_CHARS = 512 * 1024

/** How this hook talks to the outside world; swapped out in tests. */
export interface HookTransport {
  send(message: PageMessage): void
  /** Registers the arm-state listener. Called once at install. */
  onRelay(handler: (message: RelayMessage) => void): void
}

/**
 * The subset of `window` the hook touches.
 *
 * Typed structurally rather than as `Window` so a test can pass a bare object
 * with just these members, and so it is obvious at a glance exactly which
 * globals this file replaces.
 */
export interface HookTarget {
  fetch?: typeof fetch
  XMLHttpRequest?: typeof XMLHttpRequest
  EventSource?: typeof EventSource
  location?: { href: string }
  setTimeout: (handler: () => void, timeout?: number) => unknown
  clearTimeout: (handle: never) => void
  TextDecoder?: typeof TextDecoder
  Response?: typeof Response
  Headers?: typeof Headers
}

export interface HookOptions {
  target: HookTarget
  transport: HookTransport
  now?: () => number
  /** Overrides the coalescing window; tests set it to 0 for determinism. */
  flushMs?: number
}

/** Handle for tests and for a clean uninstall. */
export interface InstalledHook {
  uninstall(): void
  /** Current arm state, exposed for assertions. */
  readonly armed: boolean
}

interface ArmState {
  armed: boolean
  /** False until the relay answers; distinct from `armed: false`. */
  known: boolean
  captureMode: CaptureMode
  maxBodyChars: number
  redactHeaders: string[]
}

/**
 * Decides whether a response is worth capturing.
 *
 * Exported for direct testing: the content-type matrix is the most
 * behaviour-defining rule in this file, and it deserves assertions that do not
 * have to go through a fake network.
 *
 * @param contentType raw header value, possibly with parameters and mixed casing
 * @param sniff first decoded text of the body, when available
 */
export function shouldCapture(
  contentType: string | null,
  mode: CaptureMode,
  sniff?: string,
): boolean {
  const base = (contentType ?? '').split(';')[0]?.trim().toLowerCase() ?? ''

  if (base === SSE_CONTENT_TYPE) return true
  if (mode === 'strict') return false
  // A missing content type is common on streaming proxies, so it stays eligible
  // and the payload gets the deciding vote.
  if (base !== '' && !LOOSE_CONTENT_TYPES.includes(base)) return false
  if (sniff === undefined || sniff === '') return false
  return looksLikeSse(sniff) || looksLikeNdjson(sniff)
}

/** Whether loose mode could still decide yes once it has sniffed the payload. */
export function mightCapture(contentType: string | null, mode: CaptureMode): boolean {
  const base = (contentType ?? '').split(';')[0]?.trim().toLowerCase() ?? ''
  if (base === SSE_CONTENT_TYPE) return true
  if (mode === 'strict') return false
  return base === '' || LOOSE_CONTENT_TYPES.includes(base)
}

/** Whether a status code is allowed to carry a body at all. */
function statusAllowsBody(status: number): boolean {
  // Reconstructing a Response with one of these throws a TypeError, and none of
  // them can carry a stream anyway.
  return status !== 101 && status !== 204 && status !== 205 && status !== 304
}

export function installHook(options: HookOptions): InstalledHook {
  const { target, transport } = options
  const now = options.now ?? Date.now
  const flushMs = options.flushMs ?? CHUNK_FLUSH_MS

  const arm: ArmState = {
    armed: false,
    known: false,
    captureMode: 'loose',
    maxBodyChars: 4096,
    redactHeaders: [],
  }

  /** Messages held until the arm state is known. */
  let prearm: PageMessage[] = []
  let prearmChars = 0

  let idCounter = 0
  const idPrefix = Math.random().toString(36).slice(2, 8)

  function nextId(): string {
    idCounter += 1
    return `${idPrefix}-${idCounter}`
  }

  /**
   * Emits a message, or buffers it while the arm state is unknown.
   *
   * Once known and unarmed, messages are dropped here. The wrappers stay
   * installed (they cannot be removed per-tab without a page reload) but cost
   * nothing beyond a boolean check, because `capturing()` is consulted before any
   * tee or body read happens.
   */
  function emit(message: PageMessage): void {
    if (!arm.known) {
      if (prearm.length >= PREARM_MAX_MESSAGES || prearmChars >= PREARM_MAX_CHARS) return
      prearm.push(message)
      if (message.type === 'stream.chunk') prearmChars += message.text.length
      return
    }
    if (!arm.armed) return
    try {
      transport.send(message)
    } catch {
      // A closed relay (extension reloaded) must not break the page.
    }
  }

  transport.onRelay((message) => {
    if (message.type !== 'arm') return
    const firstAnswer = !arm.known
    arm.known = true
    arm.armed = message.armed
    arm.captureMode = message.captureMode
    arm.maxBodyChars = message.maxBodyChars
    arm.redactHeaders = message.redactHeaders

    if (!firstAnswer) return
    const held = prearm
    prearm = []
    prearmChars = 0
    if (!message.armed) return
    for (const buffered of held) {
      try {
        transport.send(buffered)
      } catch {
        break
      }
    }
  })

  /** True when capture is either on, or not yet ruled out. */
  function capturing(): boolean {
    return !arm.known || arm.armed
  }

  // --- Chunk coalescing ------------------------------------------------------

  const pending = new Map<string, string>()
  let flushHandle: unknown = null

  function flushChunks(): void {
    flushHandle = null
    if (pending.size === 0) return
    const entries = [...pending.entries()]
    pending.clear()
    for (const [localId, text] of entries) {
      if (text.length > 0) emit({ type: 'stream.chunk', localId, text })
    }
  }

  function queueChunk(localId: string, text: string): void {
    if (text.length === 0) return
    pending.set(localId, (pending.get(localId) ?? '') + text)
    if (flushMs <= 0) {
      flushChunks()
      return
    }
    if (flushHandle === null) flushHandle = target.setTimeout(flushChunks, flushMs)
  }

  /** Forces out any buffered text for a stream that is about to close. */
  function flushStream(localId: string): void {
    const text = pending.get(localId)
    pending.delete(localId)
    if (text !== undefined && text.length > 0) {
      emit({ type: 'stream.chunk', localId, text })
    }
  }

  // --- Header helpers --------------------------------------------------------

  function headersToObject(headers: Headers | undefined): Record<string, string> | undefined {
    if (!headers) return undefined
    const out: Record<string, string> = {}
    try {
      headers.forEach((value, name) => {
        out[name] = value
      })
    } catch {
      return undefined
    }
    return out
  }

  function safeRedactHeaders(
    headers: Record<string, string> | undefined,
  ): Record<string, string> | undefined {
    if (!headers) return undefined
    try {
      return redactHeaders(headers, arm.redactHeaders)
    } catch {
      // Never forward unredacted headers after a failure; drop them instead.
      return undefined
    }
  }

  function safeRedactBody(body: string): string | undefined {
    try {
      return redactBody(body, arm.maxBodyChars).body
    } catch {
      return undefined
    }
  }

  function absolute(url: string): string {
    try {
      const base = target.location?.href
      return base ? new URL(url, base).href : url
    } catch {
      return url
    }
  }

  // --- fetch -----------------------------------------------------------------

  const nativeFetch = target.fetch
  const NativeResponse = target.Response
  const NativeTextDecoder = target.TextDecoder

  interface RequestMeta {
    method: string
    url: string
    headers?: Record<string, string>
    body?: string
  }

  function normalizeHeaders(source: HeadersInit): Headers | undefined {
    const NativeHeaders = target.Headers
    if (!NativeHeaders) return undefined
    try {
      return source instanceof NativeHeaders ? source : new NativeHeaders(source)
    } catch {
      return undefined
    }
  }

  function describeRequest(input: RequestInfo | URL, init?: RequestInit): RequestMeta {
    let url: string
    let method = 'GET'
    let headers: Record<string, string> | undefined
    let body: string | undefined

    if (typeof input === 'string') {
      url = input
    } else if (input instanceof URL) {
      url = input.href
    } else {
      // A Request. Its properties are safe to read; its *body* is not, because
      // consuming it would break the page's own request, so it is never touched.
      url = input.url
      method = input.method
      headers = headersToObject(input.headers)
    }

    if (init) {
      if (typeof init.method === 'string') method = init.method
      if (init.headers) headers = headersToObject(normalizeHeaders(init.headers))
      // Only a plain string body is recorded. A stream, Blob, FormData or
      // ArrayBuffer would have to be consumed to read, which would break the
      // request; those are reported as absent rather than risked.
      if (typeof init.body === 'string') body = init.body
      else if (init.body instanceof URLSearchParams) body = init.body.toString()
    }

    return {
      method: method.toUpperCase(),
      url: absolute(url),
      headers: safeRedactHeaders(headers),
      body: body === undefined ? undefined : safeRedactBody(body),
    }
  }

  function rebuildResponse(response: Response, stream: ReadableStream<Uint8Array>): Response {
    const ResponseCtor = NativeResponse as typeof Response
    const rebuilt = new ResponseCtor(stream, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    })

    // `url`, `redirected` and `type` are prototype getters with no constructor
    // equivalent, so a naive rebuild reports `url: ''` and `redirected: false`.
    // A page that resolves relative links against `response.url`, or checks
    // `redirected` for a login bounce, would silently misbehave.
    defineQuietly(rebuilt, 'url', response.url)
    defineQuietly(rebuilt, 'redirected', response.redirected)
    defineQuietly(rebuilt, 'type', response.type)
    return rebuilt
  }

  async function drain(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<void> {
    try {
      for (;;) {
        const { done } = await reader.read()
        if (done) return
      }
    } catch {
      // Nothing to report: this branch was already judged uninteresting.
    }
  }

  async function consumeFetchBranch(input: {
    branch: ReadableStream<Uint8Array>
    localId: string
    meta: RequestMeta
    startedAt: number
    response: Response
    preDecided: boolean
    opened: { value: boolean }
  }): Promise<void> {
    const { branch, localId, meta, startedAt, response, preDecided, opened } = input
    const reader = branch.getReader()
    const decoder = new (NativeTextDecoder as typeof TextDecoder)('utf-8')
    const contentType = response.headers.get('content-type')

    let decided = preDecided
    let announced = false
    let sniff = ''

    const announce = (): void => {
      if (announced) return
      announced = true
      opened.value = true
      emit({
        type: 'stream.open',
        localId,
        streamKind: 'fetch',
        method: meta.method,
        url: meta.url,
        requestHeaders: meta.headers,
        requestBody: meta.body,
        startedAt,
      })
      emit({
        type: 'stream.headers',
        localId,
        status: response.status,
        statusText: response.statusText,
        responseHeaders: safeRedactHeaders(headersToObject(response.headers)),
        contentType: contentType ?? undefined,
        firstByteAt: now(),
      })
    }

    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        if (!value) continue
        // `stream: true` so a multi-byte character split across chunks is not
        // decoded as two replacement characters.
        const text = decoder.decode(value, { stream: true })
        if (text.length === 0) continue

        if (!decided) {
          sniff += text
          if (!shouldCapture(contentType, arm.captureMode, sniff)) {
            if (sniff.length > SNIFF_LIMIT) {
              // Settled: not a stream worth recording. Drain so the page's
              // branch is never starved by an unread tee.
              await drain(reader)
              return
            }
            continue
          }
          decided = true
          announce()
          queueChunk(localId, sniff)
          sniff = ''
          continue
        }

        announce()
        queueChunk(localId, text)
      }

      if (!decided) return
      const tail = decoder.decode()
      if (tail.length > 0) queueChunk(localId, tail)
      flushStream(localId)
      emit({ type: 'stream.close', localId, endedAt: now(), state: 'closed' })
    } catch (error) {
      if (!decided) return
      flushStream(localId)
      emit({
        type: 'stream.close',
        localId,
        endedAt: now(),
        state: isAbortError(error) ? 'aborted' : 'error',
        errorMessage: describeError(error),
      })
    } finally {
      try {
        reader.releaseLock()
      } catch {
        // Already released; nothing to do.
      }
    }
  }

  function handleFetchResponse(
    response: Response,
    localId: string,
    meta: RequestMeta,
    startedAt: number,
    opened: { value: boolean },
  ): Response {
    const body = response.body
    if (!body || !statusAllowsBody(response.status)) return response

    const contentType = response.headers.get('content-type')
    // Bail before touching the body when loose mode could not say yes either.
    // This is the path every ordinary request on the page takes.
    if (!mightCapture(contentType, arm.captureMode)) return response

    const decided = shouldCapture(contentType, arm.captureMode)
    const [pageBranch, ourBranch] = body.tee()

    void consumeFetchBranch({
      branch: ourBranch,
      localId,
      meta,
      startedAt,
      response,
      preDecided: decided,
      opened,
    })

    return rebuildResponse(response, pageBranch)
  }

  if (nativeFetch && NativeResponse && NativeTextDecoder) {
    const wrappedFetch = function (
      input: RequestInfo | URL,
      init?: RequestInit,
    ): Promise<Response> {
      // Called through the target rather than bare, because some pages invoke
      // `fetch` detached from `window` and the native function requires a
      // Window/WorkerGlobalScope receiver.
      const call = (): Promise<Response> =>
        nativeFetch.call(target as unknown as typeof globalThis, input, init)

      if (!capturing()) return call()

      let meta: RequestMeta
      try {
        meta = describeRequest(input, init)
      } catch {
        return call()
      }

      const localId = nextId()
      const startedAt = now()
      const opened = { value: false }

      return call().then(
        (response) => {
          try {
            return handleFetchResponse(response, localId, meta, startedAt, opened)
          } catch {
            // Any failure in our own handling: hand the page the untouched
            // response. It must not care that this extension exists.
            return response
          }
        },
        (error: unknown) => {
          if (opened.value) {
            emit({
              type: 'stream.close',
              localId,
              endedAt: now(),
              state: isAbortError(error) ? 'aborted' : 'error',
              errorMessage: describeError(error),
            })
          }
          throw error
        },
      )
    }

    // Preserve the observable shape of the function itself. A page that checks
    // `fetch.name`/`fetch.length`, or stringifies it looking for "[native code]",
    // should not be able to detect the patch trivially.
    defineQuietly(wrappedFetch, 'name', 'fetch')
    defineQuietly(wrappedFetch, 'length', 1)
    defineQuietly(wrappedFetch, 'toString', function toString(): string {
      return 'function fetch() { [native code] }'
    })

    target.fetch = wrappedFetch as typeof fetch
  }

  // --- XMLHttpRequest --------------------------------------------------------

  const NativeXhr = target.XMLHttpRequest
  const xhrPatches: {
    open?: typeof XMLHttpRequest.prototype.open
    send?: typeof XMLHttpRequest.prototype.send
    setRequestHeader?: typeof XMLHttpRequest.prototype.setRequestHeader
  } = {}

  if (NativeXhr) {
    interface XhrEntry {
      localId: string
      method: string
      url: string
      headers: Record<string, string>
      body?: string
      startedAt: number
      /** Characters of `responseText` already forwarded. */
      seen: number
      decided: boolean
      announced: boolean
      finished: boolean
    }

    /**
     * Per-instance capture state.
     *
     * A `WeakMap` rather than a property on the instance: a page that enumerates
     * or serialises its own XHR objects must not see this extension's
     * bookkeeping, and entries must not keep dead requests alive.
     */
    const state = new WeakMap<XMLHttpRequest, XhrEntry>()

    const nativeOpen = NativeXhr.prototype.open
    const nativeSend = NativeXhr.prototype.send
    const nativeSetHeader = NativeXhr.prototype.setRequestHeader
    xhrPatches.open = nativeOpen
    xhrPatches.send = nativeSend
    xhrPatches.setRequestHeader = nativeSetHeader

    const announceXhr = (xhr: XMLHttpRequest, entry: XhrEntry): void => {
      if (entry.announced) return
      entry.announced = true
      emit({
        type: 'stream.open',
        localId: entry.localId,
        streamKind: 'xhr',
        method: entry.method,
        url: entry.url,
        requestHeaders: safeRedactHeaders(entry.headers),
        requestBody: entry.body,
        startedAt: entry.startedAt,
      })
      emit({
        type: 'stream.headers',
        localId: entry.localId,
        status: xhr.status,
        statusText: xhr.statusText,
        responseHeaders: parseRawHeaders(safeGetAllHeaders(xhr)),
        contentType: safeGetHeader(xhr, 'content-type') ?? undefined,
        firstByteAt: now(),
      })
    }

    const attachXhrListeners = (xhr: XMLHttpRequest, entry: XhrEntry): void => {
      const onProgress = (): void => {
        if (entry.finished) return

        let text: string
        try {
          text = xhr.responseText
        } catch {
          // `responseText` throws for a `blob`/`arraybuffer` responseType, which
          // is a legitimate choice a page may make. Reporting it as unreadable
          // is strictly better than omitting the stream, which would look like
          // the tool had simply missed the request.
          if (!entry.announced) {
            const contentType = safeGetHeader(xhr, 'content-type')
            if (mightCapture(contentType, arm.captureMode)) {
              entry.decided = true
              announceXhr(xhr, entry)
              emit({
                type: 'stream.unreadable',
                localId: entry.localId,
                reason: `responseType="${xhr.responseType}"`,
              })
            }
          }
          entry.finished = true
          return
        }

        if (!entry.decided) {
          const contentType = safeGetHeader(xhr, 'content-type')
          if (!shouldCapture(contentType, arm.captureMode, text)) {
            if (text.length > SNIFF_LIMIT) entry.finished = true
            return
          }
          entry.decided = true
        }
        announceXhr(xhr, entry)
        const fresh = text.slice(entry.seen)
        entry.seen = text.length
        queueChunk(entry.localId, fresh)
      }

      const onEnd =
        (endState: 'closed' | 'error' | 'aborted') =>
        (): void => {
          if (entry.finished) return
          onProgress()
          if (!entry.decided) {
            entry.finished = true
            return
          }
          entry.finished = true
          flushStream(entry.localId)
          emit({ type: 'stream.close', localId: entry.localId, endedAt: now(), state: endState })
        }

      xhr.addEventListener('progress', onProgress)
      xhr.addEventListener('load', onEnd('closed'))
      xhr.addEventListener('error', onEnd('error'))
      xhr.addEventListener('abort', onEnd('aborted'))
      xhr.addEventListener('timeout', onEnd('error'))
    }

    NativeXhr.prototype.open = function (
      this: XMLHttpRequest,
      method: string,
      url: string | URL,
      ...rest: unknown[]
    ): void {
      try {
        state.set(this, {
          localId: nextId(),
          method: String(method).toUpperCase(),
          url: absolute(typeof url === 'string' ? url : url.href),
          headers: {},
          startedAt: now(),
          seen: 0,
          decided: false,
          announced: false,
          finished: false,
        })
      } catch {
        // Capture is optional; the request is not.
      }
      ;(nativeOpen as unknown as (...args: unknown[]) => void).apply(this, [method, url, ...rest])
    } as typeof XMLHttpRequest.prototype.open

    NativeXhr.prototype.setRequestHeader = function (
      this: XMLHttpRequest,
      name: string,
      value: string,
    ): void {
      try {
        const entry = state.get(this)
        if (entry) entry.headers[name] = value
      } catch {
        // Bookkeeping only.
      }
      nativeSetHeader.call(this, name, value)
    }

    NativeXhr.prototype.send = function (
      this: XMLHttpRequest,
      body?: Document | XMLHttpRequestBodyInit | null,
    ): void {
      try {
        const entry = state.get(this)
        if (entry && capturing()) {
          if (typeof body === 'string') entry.body = safeRedactBody(body)
          else if (body instanceof URLSearchParams) entry.body = safeRedactBody(body.toString())
          attachXhrListeners(this, entry)
        }
      } catch {
        // Bookkeeping only.
      }
      ;(nativeSend as (this: XMLHttpRequest, b?: unknown) => void).call(this, body)
    } as typeof XMLHttpRequest.prototype.send
  }

  // --- EventSource -----------------------------------------------------------

  const NativeEventSource = target.EventSource
  if (NativeEventSource) {
    /**
     * `EventSource` is reconstructed, not intercepted.
     *
     * The browser owns the socket and the parser, so there are no raw bytes to
     * observe. What *is* observable is the parsed events, but only for the types
     * someone listens to. So the wrapper listens to `message` and mirrors every
     * type the page later subscribes to. Comments and exact framing are
     * structurally unavailable; the record is tagged `eventsource` so the UI can
     * say so rather than implying the server sent no heartbeats.
     */
    const Wrapped = function (url: string | URL, config?: EventSourceInit): EventSource {
      const instance = new (NativeEventSource as typeof EventSource)(url, config)
      if (!capturing()) return instance

      const localId = nextId()
      const startedAt = now()
      let seq = 0
      let announced = false
      let closed = false

      const announce = (): void => {
        if (announced) return
        announced = true
        emit({
          type: 'stream.open',
          localId,
          streamKind: 'eventsource',
          method: 'GET',
          url: absolute(typeof url === 'string' ? url : url.href),
          startedAt,
        })
      }

      const record = (event: Event): void => {
        try {
          const messageEvent = event as MessageEvent<unknown>
          if (typeof messageEvent.data !== 'string') return
          announce()
          const parsed: SseEvent = {
            seq: seq++,
            at: now(),
            event: event.type,
            data: messageEvent.data,
          }
          if (messageEvent.lastEventId) parsed.id = messageEvent.lastEventId
          emit({ type: 'stream.event', localId, event: parsed })
        } catch {
          // Recording is best effort; the page's own listeners are unaffected.
        }
      }

      const nativeAdd = instance.addEventListener.bind(instance)
      const subscribed = new Set<string>(['message', 'open', 'error'])

      nativeAdd('message', record)
      nativeAdd('open', () => {
        announce()
      })
      nativeAdd('error', () => {
        // `error` also fires on every reconnect attempt, so it is only terminal
        // once the browser has actually given up.
        if (instance.readyState !== 2) return
        if (closed) return
        closed = true
        if (announced) emit({ type: 'stream.close', localId, endedAt: now(), state: 'error' })
      })

      // Mirror the page's own subscriptions so custom event types are captured.
      defineQuietly(
        instance,
        'addEventListener',
        function (
          type: string,
          listener: EventListenerOrEventListenerObject | null,
          opts?: boolean | AddEventListenerOptions,
        ): void {
          if (!subscribed.has(type)) {
            subscribed.add(type)
            nativeAdd(type, record)
          }
          nativeAdd(type, listener as EventListener, opts)
        },
      )

      const nativeClose = instance.close.bind(instance)
      defineQuietly(instance, 'close', function (): void {
        if (!closed) {
          closed = true
          if (announced) emit({ type: 'stream.close', localId, endedAt: now(), state: 'closed' })
        }
        nativeClose()
      })

      return instance
    } as unknown as typeof EventSource

    // Keep the constructor usable as one: `instanceof`, the readyState constants
    // and subclassing all have to keep working.
    Wrapped.prototype = NativeEventSource.prototype
    defineQuietly(Wrapped, 'name', 'EventSource')
    defineQuietly(Wrapped, 'CONNECTING', 0)
    defineQuietly(Wrapped, 'OPEN', 1)
    defineQuietly(Wrapped, 'CLOSED', 2)
    target.EventSource = Wrapped
  }

  transport.send({ type: 'hook.ready' })

  return {
    uninstall(): void {
      if (nativeFetch) target.fetch = nativeFetch
      if (NativeEventSource) target.EventSource = NativeEventSource
      if (NativeXhr) {
        if (xhrPatches.open) NativeXhr.prototype.open = xhrPatches.open
        if (xhrPatches.send) NativeXhr.prototype.send = xhrPatches.send
        if (xhrPatches.setRequestHeader) {
          NativeXhr.prototype.setRequestHeader = xhrPatches.setRequestHeader
        }
      }
      if (flushHandle !== null) target.clearTimeout(flushHandle as never)
    },
    get armed(): boolean {
      return arm.armed
    },
  }
}

/** `defineProperty` that never throws, for shimming read-only members. */
function defineQuietly(object: object, key: string, value: unknown): void {
  try {
    Object.defineProperty(object, key, { value, configurable: true, writable: true })
  } catch {
    // Non-configurable: the shim is cosmetic, so carry on without it.
  }
}

function isAbortError(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === 'object' &&
    (error as { name?: unknown }).name === 'AbortError'
  )
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  return 'Unknown stream failure'
}

function safeGetAllHeaders(xhr: XMLHttpRequest): string {
  try {
    return xhr.getAllResponseHeaders()
  } catch {
    return ''
  }
}

function safeGetHeader(xhr: XMLHttpRequest, name: string): string | null {
  try {
    return xhr.getResponseHeader(name)
  } catch {
    return null
  }
}

/**
 * Parses `getAllResponseHeaders()` output.
 *
 * The format is CRLF-delimited `name: value`, and a value may legitimately
 * contain a colon (a `Date` header always does), so only the first colon splits.
 */
export function parseRawHeaders(raw: string): Record<string, string> | undefined {
  if (raw.length === 0) return undefined
  const out: Record<string, string> = {}
  for (const line of raw.split(/\r?\n/)) {
    if (line.length === 0) continue
    const colon = line.indexOf(':')
    if (colon === -1) continue
    out[line.slice(0, colon).trim()] = line.slice(colon + 1).trim()
  }
  return Object.keys(out).length > 0 ? out : undefined
}
