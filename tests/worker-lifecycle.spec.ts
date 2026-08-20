/**
 * Worker integration tests: the tab-switching lifecycle.
 *
 * ## Why these exist
 *
 * A user reported: "capture works when the panel is first opened, but after
 * switching a few pages nothing is captured any more." The existing 316 tests all
 * passed, because every one of them exercised `CaptureStore` or `ArmController`
 * *directly*. Nothing had ever executed `background/index.ts`, which is the module
 * that wires those classes to Chrome's events — so every bug in the wiring was
 * invisible.
 *
 * These tests load the real worker against {@link ChromeHarness} and assert on the
 * user-visible symptom: after switching tabs, does an SSE frame from the newly
 * active tab reach the panel?
 *
 * @module tests/worker-lifecycle.spec
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ChromeHarness } from './harness'

/** Loads a fresh copy of the worker against a fresh harness. */
async function bootWorker(harness: ChromeHarness): Promise<void> {
  vi.stubGlobal('chrome', harness.api)
  vi.resetModules()
  await import('../src/background/index')
  // Registration is synchronous, but the module's own async setup is not.
  await harness.settle()
}

/** A minimal SSE capture sequence from one tab, as the hook really sends it. */
async function streamSse(
  harness: ChromeHarness,
  tabId: number,
  localId = 's1',
): Promise<void> {
  await harness.sendPage(tabId, {
    type: 'stream.open',
    localId,
    streamKind: 'fetch',
    method: 'GET',
    url: `https://tab-${tabId}.example.com/v1/stream`,
    requestHeaders: {},
    startedAt: Date.now(),
  })
  await harness.sendPage(tabId, {
    type: 'stream.headers',
    localId,
    status: 200,
    statusText: 'OK',
    responseHeaders: { 'content-type': 'text/event-stream' },
    contentType: 'text/event-stream',
    firstByteAt: Date.now(),
  })
  await harness.sendPage(tabId, {
    type: 'stream.chunk',
    localId,
    text: 'data: hello\n\n',
  })
}

describe('worker lifecycle: following the active tab', () => {
  let harness: ChromeHarness

  beforeEach(() => {
    harness = new ChromeHarness()
    harness.addTab({ id: 1, active: true })
    harness.addTab({ id: 2 })
    harness.addTab({ id: 3 })
    harness.addTab({ id: 4 })
  })

  it('registers every lifecycle listener it depends on', async () => {
    // A missing listener is silent in production: the worker simply never learns
    // that the user moved, and the panel appears to freeze on an old tab.
    await bootWorker(harness)
    for (const event of [
      'runtime.onMessage',
      'runtime.onConnect',
      'tabs.onActivated',
      'tabs.onRemoved',
      'tabs.onUpdated',
      'windows.onFocusChanged',
    ]) {
      expect(harness.hasListener(event), event).toBe(true)
    }
  })

  it('captures from the first tab once the panel opens', async () => {
    await bootWorker(harness)
    await harness.connectPanel()

    expect(harness.isArmed(1)).toBe(true)

    harness.clearRecorded()
    await streamSse(harness, 1)

    const events = harness.toPanel.filter((event) => event.type === 'stream.events')
    expect(events.length).toBeGreaterThan(0)
  })

  /**
   * The reported bug, stated as an assertion.
   *
   * Switching tabs must arm the new tab and disarm the old one, and a frame from
   * the new tab must reach the panel.
   */
  it('still captures after switching through several tabs', async () => {
    await bootWorker(harness)
    await harness.connectPanel()
    await streamSse(harness, 1)

    for (const tabId of [2, 3, 4]) {
      await harness.emitTabActivated(tabId)

      expect(harness.isArmed(tabId), `tab ${tabId} should be armed`).toBe(true)

      harness.clearRecorded()
      await streamSse(harness, tabId, `s-${tabId}`)

      const captured = harness.toPanel.filter((event) => event.type === 'stream.events')
      expect(captured.length, `tab ${tabId} frames should reach the panel`).toBeGreaterThan(0)
    }
  })

  it('disarms the tab it moved away from', async () => {
    // Otherwise a page keeps capturing traffic nobody is watching, which is the
    // privacy rule this design exists to enforce.
    await bootWorker(harness)
    await harness.connectPanel()
    expect(harness.isArmed(1)).toBe(true)

    await harness.emitTabActivated(2)
    expect(harness.isArmed(1)).toBe(false)
    expect(harness.isArmed(2)).toBe(true)
  })

  it('ignores frames from a tab that is not armed', async () => {
    await bootWorker(harness)
    await harness.connectPanel()
    await harness.emitTabActivated(2)

    harness.clearRecorded()
    // Tab 1 is no longer armed; its hook may still be draining a stream.
    await streamSse(harness, 1, 'stale')

    expect(harness.toPanel.filter((event) => event.type === 'stream.events')).toHaveLength(0)
  })

  it('re-arms a tab whose relay announces itself after a reload', async () => {
    await bootWorker(harness)
    await harness.connectPanel()
    await harness.emitTabActivated(2)
    harness.clearRecorded()

    const reply = (await harness.sendRelayHello(2)) as { type: string; armed: boolean }
    expect(reply.type).toBe('arm')
    expect(reply.armed).toBe(true)
  })

  it('tells a non-active tab it is not armed when it announces itself', async () => {
    await bootWorker(harness)
    await harness.connectPanel()

    const reply = (await harness.sendRelayHello(3)) as { armed: boolean }
    expect(reply.armed).toBe(false)
  })

  it('follows the user across a window switch', async () => {
    // `tabs.onActivated` does not fire for a window change, so without a focus
    // listener the panel would keep showing the previous window's tab.
    const secondWindow = harness.newWindowId()
    harness.addTab({ id: 9, windowId: secondWindow, active: true })

    await bootWorker(harness)
    await harness.connectPanel()
    expect(harness.isArmed(1)).toBe(true)

    await harness.emitWindowFocus(secondWindow)
    expect(harness.isArmed(9)).toBe(true)
    expect(harness.isArmed(1)).toBe(false)
  })

  it('moves to the active tab when the armed tab closes', async () => {
    await bootWorker(harness)
    await harness.connectPanel()

    harness.activate(2)
    await harness.emitTabRemoved(1)

    expect(harness.isArmed(2)).toBe(true)
  })

  it('stops capturing everywhere when the panel closes', async () => {
    await bootWorker(harness)
    const panel = await harness.connectPanel()
    await harness.emitTabActivated(2)
    expect(harness.isArmed(2)).toBe(true)

    await panel.disconnect()
    expect(harness.isArmed(2)).toBe(false)
  })

  it('does not arm on a tab switch while no panel is open', async () => {
    await bootWorker(harness)
    await harness.emitTabActivated(2)
    expect(harness.lastArm(2)).toBeUndefined()
  })

  it('survives a deaf tab without losing the arm state', async () => {
    // A restricted page has no relay, so `sendMessage` rejects. That must not
    // prevent the next real tab from being armed.
    harness.deafTabs.add(2)
    await bootWorker(harness)
    await harness.connectPanel()

    await harness.emitTabActivated(2)
    await harness.emitTabActivated(3)

    expect(harness.isArmed(3)).toBe(true)
  })
})

describe('worker lifecycle: surviving eviction', () => {
  let harness: ChromeHarness

  beforeEach(() => {
    harness = new ChromeHarness()
    harness.addTab({ id: 1, active: true })
    harness.addTab({ id: 2 })
  })

  it('captures again after the worker restarts and the port reconnects', async () => {
    await bootWorker(harness)
    await harness.connectPanel()
    expect(harness.isArmed(1)).toBe(true)

    // MV3 evicts the worker; storage survives, listeners do not.
    harness.evict()
    await bootWorker(harness)

    // The panel notices the disconnect and reconnects.
    await harness.connectPanel()
    harness.clearRecorded()
    await streamSse(harness, 1, 'after-evict')

    expect(
      harness.toPanel.filter((event) => event.type === 'stream.events').length,
    ).toBeGreaterThan(0)
  })

  it('arms the next tab after an eviction', async () => {
    await bootWorker(harness)
    await harness.connectPanel()

    harness.evict()
    await bootWorker(harness)
    await harness.connectPanel()

    await harness.emitTabActivated(2)
    expect(harness.isArmed(2)).toBe(true)
  })
})

/**
 * Navigation within one tab.
 *
 * The user's report is about switching *pages*, which is not the same event as
 * switching tabs: navigating re-creates the content scripts, so the page comes
 * back disarmed and must re-arm itself via `relay.hello`. The tests above never
 * navigated, so this whole path was untested.
 */
describe('worker lifecycle: navigation within a tab', () => {
  let harness: ChromeHarness

  beforeEach(() => {
    harness = new ChromeHarness()
    harness.addTab({ id: 1, active: true, url: 'https://app.example.com/one' })
  })

  it('re-arms the page after navigating to a new URL', async () => {
    await bootWorker(harness)
    await harness.connectPanel()
    expect(harness.isArmed(1)).toBe(true)

    await harness.emitTabUpdated(1, { url: 'https://app.example.com/two' })

    // The new document's relay announces itself; it must be told it is armed.
    const reply = (await harness.sendRelayHello(1)) as { armed: boolean }
    expect(reply.armed).toBe(true)
  })

  it('captures a stream from the page after navigating', async () => {
    await bootWorker(harness)
    await harness.connectPanel()

    await harness.emitTabUpdated(1, { url: 'https://app.example.com/two' })
    await harness.sendRelayHello(1)

    harness.clearRecorded()
    await streamSse(harness, 1, 'after-nav')

    expect(
      harness.toPanel.filter((event) => event.type === 'stream.events').length,
      'frames after navigation must reach the panel',
    ).toBeGreaterThan(0)
  })

  it('captures after several navigations in a row', async () => {
    await bootWorker(harness)
    await harness.connectPanel()

    for (let step = 2; step <= 6; step += 1) {
      await harness.emitTabUpdated(1, { url: `https://app.example.com/page-${step}` })
      await harness.sendRelayHello(1)

      harness.clearRecorded()
      await streamSse(harness, 1, `nav-${step}`)

      expect(
        harness.toPanel.filter((event) => event.type === 'stream.events').length,
        `navigation ${step} should still capture`,
      ).toBeGreaterThan(0)
    }
  })

  it('captures when a stream starts during page load, racing relay.hello', async () => {
    // The real-world shape: a streaming app opens a request during bootstrap, so
    // `relay.hello` and the first frames arrive in the same tick. The worker's
    // lazy initialisation must be safe under that interleaving.
    await bootWorker(harness)
    await harness.connectPanel()
    await harness.emitTabUpdated(1, { url: 'https://app.example.com/chat' })

    harness.clearRecorded()
    await harness.sendConcurrently([
      { tabId: 1, message: { type: 'relay.hello' } },
      {
        tabId: 1,
        message: {
          type: 'stream.open',
          localId: 'race',
          streamKind: 'fetch',
          method: 'POST',
          url: 'https://app.example.com/v1/chat',
          requestHeaders: {},
          startedAt: Date.now(),
        },
      },
      {
        tabId: 1,
        message: {
          type: 'stream.headers',
          localId: 'race',
          status: 200,
          statusText: 'OK',
          responseHeaders: { 'content-type': 'text/event-stream' },
          contentType: 'text/event-stream',
          firstByteAt: Date.now(),
        },
      },
      { tabId: 1, message: { type: 'stream.chunk', localId: 'race', text: 'data: hi\n\n' } },
    ])

    expect(
      harness.toPanel.filter((event) => event.type === 'stream.events').length,
      'a stream racing relay.hello must still be captured',
    ).toBeGreaterThan(0)
  })

  it('applies a concurrent burst in arrival order, dropping nothing', async () => {
    // The sharpest form of the same assertion: every frame must arrive, and the
    // reassembled text must be in order. Out-of-order processing shows up either
    // as missing events or as scrambled data.
    await bootWorker(harness)
    await harness.connectPanel()

    const words = ['alpha', 'beta', 'gamma', 'delta', 'epsilon']
    harness.clearRecorded()

    await harness.sendConcurrently([
      { tabId: 1, message: { type: 'relay.hello' } },
      {
        tabId: 1,
        message: {
          type: 'stream.open',
          localId: 'burst',
          streamKind: 'fetch',
          method: 'GET',
          url: 'https://app.example.com/v1/burst',
          requestHeaders: {},
          startedAt: Date.now(),
        },
      },
      {
        tabId: 1,
        message: {
          type: 'stream.headers',
          localId: 'burst',
          status: 200,
          statusText: 'OK',
          responseHeaders: { 'content-type': 'text/event-stream' },
          contentType: 'text/event-stream',
          firstByteAt: Date.now(),
        },
      },
      ...words.map((word) => ({
        tabId: 1,
        message: { type: 'stream.chunk', localId: 'burst', text: `data: ${word}\n\n` },
      })),
    ])
    await harness.settle(60)

    const delivered = harness.toPanel
      .filter((event) => event.type === 'stream.events')
      .flatMap((event) => (event as unknown as { events: { data: string }[] }).events)
      .map((sseEvent) => sseEvent.data)

    expect(delivered, 'every frame must survive the burst').toEqual(words)
  })
})
