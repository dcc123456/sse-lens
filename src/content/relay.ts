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
 * ## Lifecycle
 *
 * The relay asks the worker for the arm state as soon as it loads, which covers
 * the case where the panel is already open and the page is merely reloading. An
 * `Extension context invalidated` failure (the extension was reloaded or removed
 * while this page stayed open) is treated as a permanent disarm rather than
 * logged repeatedly: the page is now orphaned and there is nothing to reconnect
 * to until it reloads.
 *
 * @module content/relay
 */

import {
  BRIDGE_MARKER,
  type PageEnvelope,
  type PageMessage,
  type RelayHello,
  type RelayMessage,
  type RelayToWorker,
} from '../lib/messages'

/** Set once the extension context is gone, to stop pointless retries. */
let orphaned = false

/** Pushes an arm instruction down to the MAIN world. */
function toPage(message: RelayMessage): void {
  const envelope: PageEnvelope = {
    [BRIDGE_MARKER]: true,
    direction: 'toPage',
    message,
  }
  window.postMessage(envelope, '/')
}

function isContextGone(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return (
    message.includes('Extension context invalidated') ||
    message.includes('Receiving end does not exist') ||
    message.includes('message port closed')
  )
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
  } catch (error) {
    if (isContextGone(error)) {
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
    }
    // Any other failure (the worker is asleep and waking) is transient; the next
    // message will carry the state.
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
 * Worker-initiated arm changes.
 *
 * Needed because arming happens when the *panel* opens, which is not triggered
 * by any page activity — without this the page would stay disarmed until it
 * happened to make a request.
 */
chrome.runtime.onMessage.addListener((message: unknown) => {
  if (!message || typeof message !== 'object') return
  const candidate = message as RelayMessage
  if (candidate.type !== 'arm') return
  toPage(candidate)
})

// Announce immediately, so a reload of an already-inspected tab re-arms without
// waiting for the page to make a request.
void toWorker({ type: 'relay.hello' })
