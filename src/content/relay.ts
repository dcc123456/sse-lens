/**
 * ISOLATED-world relay.
 *
 * The MAIN-world hook can see the page's network but not `chrome.*`; this script
 * can see `chrome.*` but not the page's network. So it exists purely to carry
 * messages between them, and its whole value is in what it refuses to carry.
 *
 * ## Trust
 *
 * `window.postMessage` is a public channel: any page script can post the same
 * shape. Two checks apply before anything is forwarded:
 *
 * - `event.source === window`, so a message from an embedded iframe or an opener
 *   is dropped. Each frame has its own relay, and each relay only serves its own
 *   frame.
 * - The {@link BRIDGE_MARKER} tag must be present with `direction: 'toRelay'`.
 *
 * A hostile page can still *forge* a capture record. It cannot read one, and it
 * cannot escalate: the worker takes `tabId`/`frameId` from `sender`, never from
 * the message, so a forged record can only ever appear in the panel for the tab
 * that forged it. That is an acceptable floor for a debugging tool — the
 * alternative (a private channel) does not exist across the MAIN/ISOLATED
 * boundary.
 *
/**
 * ## Lifecycle
 *
 * The relay asks the worker for the arm state as soon as it loads, which covers
 * the case where the panel is already open and the page is merely reloading. That
 * one announcement is the only traffic a page that has not streamed yet sends:
 * while the arm state is unknown, the MAIN-world hook buffers messages instead of
 * forwarding them, so if this request fails, nothing else will reach the worker
 * until the page reloads. Hence the bounded retry in {@link scheduleResync} —
 * without it a cold-start race with an evicted worker silently cost the tab all of
 * its captures.
 *
 * An `Extension context invalidated` failure (the extension was reloaded or removed
 * while this page stayed open) is treated as a permanent disarm rather than
 * logged repeatedly: the page is now orphaned and there is nothing to reconnect
 * to until it reloads. That is decided by `chrome.runtime.id`, which Chrome blanks
 * only when the context is genuinely gone — a message-level error alone does not
 * distinguish "reloaded" from "the worker was still waking up".
 *
 * @module content/relay
 */

import {
  BRIDGE_MARKER,
  type PageEnvelope,
  type PageMessage,
  type RelayHello,
  type RelayMessage,
  type RelayProbe,
  type RelayToWorker,
} from '../lib/messages'

/** Set once the extension context is gone, to stop pointless retries. */
let orphaned = false

/**
 * Backoff for re-announcing after a message the worker never answered.
 *
 * Bounded on purpose: if the worker truly cannot be reached, a page must not be
 * left polling it forever.
 */
const RESYNC_BASE_DELAY_MS = 500
const RESYNC_MAX_ATTEMPTS = 3
let resyncAttempts = 0
let resyncTimer: number | null = null

/** Pushes an arm instruction down to the MAIN world. */
function toPage(message: RelayMessage): void {
  const envelope: PageEnvelope = {
    [BRIDGE_MARKER]: true,
    direction: 'toPage',
    message,
  }
  window.postMessage(envelope, '/')
}

/**
 * Whether this content script still belongs to a live extension.
 *
 * Chrome blanks `runtime.id` when the extension is reloaded, updated or removed,
 * which is the only authoritative signal available on this side of the boundary.
 */
function contextIsLive(): boolean {
  return Boolean(chrome.runtime?.id)
}

/**
 * Re-asks for the arm state after a delivery failure.
 *
 * Needed because a page that has not streamed yet sends nothing else: the hook
 * holds its messages while the arm state is unknown, so a lost {@link RelayHello}
 * would otherwise leave the tab permanently deaf.
 */
function scheduleResync(): void {
  if (resyncTimer !== null || resyncAttempts >= RESYNC_MAX_ATTEMPTS) return
  const delay = RESYNC_BASE_DELAY_MS * 2 ** resyncAttempts
  resyncAttempts += 1
  resyncTimer = window.setTimeout(() => {
    resyncTimer = null
    void toWorker({ type: 'relay.hello' })
  }, delay)
}

/**
 * Sends to the worker and applies any arm state it returns.
 *
 * The worker answers `sendMessage` with the current arm state, so every
 * forwarded capture doubles as a state refresh. That is why a settings change
 * takes effect without the relay subscribing to storage.
 */
async function toWorker(payload: RelayToWorker | RelayHello): Promise<void> {
  if (orphaned) return
  try {
    const reply = (await chrome.runtime.sendMessage(payload)) as RelayMessage | undefined
    if (reply && reply.type === 'arm') toPage(reply)
    resyncAttempts = 0
  } catch {
    if (!contextIsLive()) {
      orphaned = true
      // Tell the page to stop capturing: nothing is listening any more, and the
      // hook would otherwise keep buffering into a void.
      toPage({
        type: 'arm',
        armed: false,
        captureMode: 'strict',
        maxBodyChars: 0,
        redactHeaders: [],
      })
      return
    }
    // Transient — the worker was still starting, or was evicted mid-delivery.
    // Retry the announcement, since a missed one is not recovered by anything
    // else on this page. The forwarded payload itself is lost; the next one
    // carries the state again.
    scheduleResync()
  }
}

window.addEventListener('message', (event: MessageEvent<unknown>) => {
  if (event.source !== window) return
  const data = event.data as PageEnvelope | null
  if (!data || typeof data !== 'object') return
  if (data[BRIDGE_MARKER] !== true || data.direction !== 'toRelay') return

  const message = data.message as PageMessage
  if (!message || typeof message !== 'object' || typeof message.type !== 'string') return

  void toWorker({ type: 'page', message })
})

/**
 * Worker-initiated arm changes, plus the presence probe.
 *
 * Arming is needed because it happens when the *panel* opens, which is not
 * triggered by any page activity — without this the page would stay disarmed until
 * it happened to make a request.
 *
 * The probe is answered explicitly rather than relying on the implicit resolution
 * of a listener that returns nothing: the worker uses "did sendMessage resolve?"
 * to decide whether this tab has a content script at all, and an answer that
 * depends on listener-return subtleties would make that signal fragile.
 */
chrome.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
  if (!message || typeof message !== 'object') return false

  const candidate = message as RelayMessage | RelayProbe
  if (candidate.type === 'probe') {
    sendResponse({ present: true })
    return false
  }
  if (candidate.type !== 'arm') return false
  toPage(candidate)
  return false
})

// Announce immediately, so a reload of an already-inspected tab re-arms without
// waiting for the page to make a request.
void toWorker({ type: 'relay.hello' })
