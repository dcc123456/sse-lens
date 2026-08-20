/**
 * MAIN-world content-script entry.
 *
 * Deliberately tiny. All logic lives in `hook-install.ts` so it can be unit
 * tested against a fake global; this file only wires that logic to the real
 * `window` and to `window.postMessage`.
 *
 * Runs at `document_start` in the MAIN world of every frame. Two consequences
 * shape the code below:
 *
 * 1. There is no `chrome.*` here, so the only way to reach the extension is
 *    `postMessage` to the ISOLATED relay sitting on the same `window`.
 * 2. This shares a global scope with the page. So the guard flag is the only
 *    thing added to `window`, and it is non-enumerable so a page iterating its
 *    own globals does not trip over it.
 *
 * @module inpage/hook
 */

import { BRIDGE_MARKER, type PageEnvelope, type PageMessage, type RelayMessage } from '../lib/messages'
import { installHook } from './hook-install'

/**
 * Idempotence guard.
 *
 * An extension update re-injects into existing frames, and a same-document
 * navigation can re-run a `document_start` script. Patching twice would build a
 * chain of wrappers, double-reporting every frame.
 */
const GUARD = '__sseLensHooked'

interface GuardedWindow extends Window {
  [GUARD]?: boolean
}

const self_ = window as GuardedWindow

if (!self_[GUARD]) {
  Object.defineProperty(self_, GUARD, { value: true, enumerable: false, configurable: true })

  const relayHandlers: ((message: RelayMessage) => void)[] = []

  window.addEventListener('message', (event: MessageEvent<unknown>) => {
    // Only same-window messages are trusted. An `iframe` or an opener posting
    // the same shape must not be able to steer this hook.
    if (event.source !== window) return
    const data = event.data as PageEnvelope | null
    if (!data || typeof data !== 'object') return
    if (data[BRIDGE_MARKER] !== true || data.direction !== 'toPage') return
    const message = data.message as RelayMessage
    if (!message || typeof message !== 'object') return
    for (const handler of relayHandlers) {
      try {
        handler(message)
      } catch {
        // One bad handler must not stop the others.
      }
    }
  })

  installHook({
    target: window,
    transport: {
      send(message: PageMessage): void {
        const envelope: PageEnvelope = {
          [BRIDGE_MARKER]: true,
          direction: 'toRelay',
          message,
        }
        // Target origin is '/' — same-origin only — so a capture is never
        // broadcast to a page on another origin that happens to be listening.
        window.postMessage(envelope, '/')
      },
      onRelay(handler: (message: RelayMessage) => void): void {
        relayHandlers.push(handler)
      },
    },
  })
}
