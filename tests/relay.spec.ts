/**
 * @vitest-environment jsdom
 *
 * Relay lifecycle tests: what the ISOLATED script does when the worker does not
 * answer.
 *
 * ## Why this is worth its own file
 *
 * The relay used to infer "the extension is gone" from the *text* of a messaging
 * error and treat that as permanent: it disarmed the page and sent nothing
 * further. But a page that has not streamed yet sends nothing else — the MAIN-world
 * hook holds its messages while the arm state is unknown — so one lost
 * announcement (an evicted worker dropping a message mid-delivery, or a cold-start
 * race) cost that tab every capture until it was reloaded. These assert the two
 * cases that inference used to merge: a transient miss, which must self-heal, and a
 * real context loss, which must not keep polling.
 *
 * Every test removes the window listeners the relay installed, because the relay is
 * a side-effect module: re-importing it per test would otherwise leave several
 * copies forwarding the same page traffic.
 *
 * What a page posts to the relay is *not* asserted here: the relay requires
 * `event.source === window`, and jsdom delivers a self-posted message with a
 * different Window object than the `window` global, so that guard cannot pass
 * outside a real browser. The successful retry in the first case is what shows a
 * transient miss leaves the relay able to reach the worker again.
 *
 * @module tests/relay.spec
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  BRIDGE_MARKER,
  type PageEnvelope,
  type RelayMessage
} from '../src/lib/messages'

/** The arm answer the worker gives a relay. */
function armReply(armed: boolean): RelayMessage {
  return {
    type: 'arm',
    armed,
    captureMode: 'loose',
    maxBodyChars: 4096,
    redactHeaders: []
  }
}

interface RelayStub {
  sendMessage: ReturnType<typeof vi.fn>
  /** Messages the relay pushed down to the page. */
  toPage: RelayMessage[]
}

const settle = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms))

/** Longer than the first resync delay, shorter than the second. */
const FIRST_RESYNC_MS = 700

const addListener = window.addEventListener.bind(window)
const removeListener = window.removeEventListener.bind(window)

/**
 * Makes `postMessage(msg, '/')` behave as browsers do.
 *
 * jsdom compares that argument against the literal string, so a same-origin-only
 * post — which is exactly what the relay and the page hook use to keep from
 * broadcasting captures to another origin — is silently dropped. Without this
 * shim there is no way to observe the relay's page-bound traffic at all.
 */
const nativePostMessage = window.postMessage

/** The two-argument overload, named so it can be called with a receiver. */
type PostToOrigin = (
  this: Window,
  message: unknown,
  targetOrigin: string
) => void
const postToOrigin = nativePostMessage as unknown as PostToOrigin

function allowSlashOrigin(): void {
  window.postMessage = ((message: unknown, targetOrigin?: string) => {
    postToOrigin.call(
      window,
      message,
      targetOrigin === '/' ? window.location.origin : (targetOrigin ?? '*')
    )
  }) as typeof window.postMessage
}

function forbidSlashOrigin(): void {
  window.postMessage = nativePostMessage
}

let tracked: { type: string; handler: EventListener }[] = []

/**
 * Points `chrome` at a stub and records window listeners for cleanup.
 *
 * `runtimeId` mirrors Chrome's real behaviour: it is blanked the moment the
 * extension is reloaded or removed, and only then.
 */
function installChrome(runtimeId: string | undefined): RelayStub {
  const sendMessage = vi.fn()
  const stub: RelayStub = { sendMessage, toPage: [] }
  vi.stubGlobal('chrome', {
    runtime: {
      id: runtimeId,
      sendMessage,
      onMessage: { addListener: () => {} }
    }
  })
  allowSlashOrigin()

  tracked = []
  vi.spyOn(window, 'addEventListener').mockImplementation(
    (...args: Parameters<typeof addListener>) => {
      const [type, handler] = args
      if (typeof handler === 'function')
        tracked.push({ type: String(type), handler })
      addListener(...args)
    }
  )

  // Observe the relay's own toPage traffic through the same tracked listener.
  const observer = (event: Event): void => {
    const data = (event as MessageEvent<unknown>).data as PageEnvelope | null
    if (!data || typeof data !== 'object') return
    if (data[BRIDGE_MARKER] !== true || data.direction !== 'toPage') return
    stub.toPage.push(data.message as RelayMessage)
  }
  addListener('message', observer)
  tracked.push({ type: 'message', handler: observer })

  return stub
}

/** Imports a fresh copy of the relay, which announces itself on load. */
async function bootRelay(stub: RelayStub): Promise<RelayStub> {
  vi.resetModules()
  await import('../src/content/relay')
  await settle(0)
  return stub
}

afterEach(() => {
  for (const listener of tracked)
    removeListener(listener.type, listener.handler)
  tracked = []
  vi.mocked(window.addEventListener).mockRestore()
  forbidSlashOrigin()
  vi.unstubAllGlobals()
})

describe('relay: worker reachability', () => {
  it('re-announces itself when the first hello is lost', async () => {
    // The reported symptom in its harshest form: the worker had been evicted while
    // the page sat idle, the wake-up message never landed, and the page was then
    // treated as permanently uncapturable.
    const stub = installChrome('abcdefghijklmnopabcdefghijklmnop')
    stub.sendMessage
      .mockRejectedValueOnce(
        new Error(
          'Could not establish connection. Receiving end does not exist.'
        )
      )
      .mockResolvedValue(armReply(true))

    const relay = await bootRelay(stub)
    expect(relay.sendMessage).toHaveBeenCalledTimes(1)
    expect(relay.toPage).toHaveLength(0)

    await settle(FIRST_RESYNC_MS)

    expect(
      relay.sendMessage.mock.calls.map(
        (call) => (call[0] as { type: string }).type
      )
    ).toEqual(['relay.hello', 'relay.hello'])
    expect(relay.toPage.at(-1)).toMatchObject({ type: 'arm', armed: true })
  }, 10000)

  it('disarms the page and stops retrying once the context is gone', async () => {
    const stub = installChrome(undefined)
    stub.sendMessage.mockRejectedValue(
      new Error('Extension context invalidated.')
    )

    const relay = await bootRelay(stub)
    await settle(FIRST_RESYNC_MS * 4)

    expect(relay.sendMessage).toHaveBeenCalledTimes(1)
    expect(relay.toPage).toHaveLength(1)
    expect(relay.toPage[0]).toMatchObject({ type: 'arm', armed: false })
  }, 10000)

  it('bounds the retries when the worker never answers', async () => {
    const stub = installChrome('abcdefghijklmnopabcdefghijklmnop')
    stub.sendMessage.mockRejectedValue(
      new Error('The message port closed before a response was received.')
    )

    const relay = await bootRelay(stub)
    // Covers the 500ms, 1s and 2s backoff steps, then some.
    await settle(4000)

    expect(relay.sendMessage).toHaveBeenCalledTimes(4)
    expect(relay.toPage).toHaveLength(0)
  }, 10000)
})
