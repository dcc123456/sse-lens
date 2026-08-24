/**
 * Wire protocol across all four contexts.
 *
 * There are three hops, each with a different transport and different trust:
 *
 * 1. **MAIN world → ISOLATED relay** — `window.postMessage`. This is the only
 *    channel available (the MAIN world has no `chrome.*`), and it is also the
 *    least trustworthy: any page script can post the same shape. Every message
 *    carries {@link BRIDGE_MARKER} and the relay additionally checks
 *    `event.source === window`, so a message from an iframe or an opener is
 *    rejected. A hostile page can still forge a capture; it cannot read one,
 *    which is the property that actually matters.
 * 2. **relay → service worker** — `chrome.runtime.sendMessage`, which supplies a
 *    trustworthy `sender.tab.id` / `sender.frameId`. The page never gets to name
 *    its own tab id; the worker takes those from the sender only.
 * 3. **worker ↔ side panel** — `sendMessage` for request/response, plus
 *    unsolicited worker→panel events. No long-lived port: unlike a streaming LLM
 *    turn, nothing here needs the worker held open beyond delivering a message,
 *    and `storage.session` already survives eviction.
 *
 * @module lib/messages
 */

import type { Settings, SseEvent, StreamKind, StreamRecord } from './types'

/**
 * Tag on every page-boundary message.
 *
 * Named with a `__` prefix and a version suffix so a future protocol change can
 * be distinguished from this one rather than silently misread by a stale content
 * script still in a long-lived tab after an extension update.
 */
export const BRIDGE_MARKER = '__sseLensV1'

// --- MAIN world → ISOLATED relay --------------------------------------------

/**
 * Metadata known when a stream begins, before any body arrives.
 *
 * Note `streamKind` rather than `kind`: `kind` is the discriminator on
 * {@link PageMessage}, and reusing it here for {@link StreamKind} made the union
 * unnarrowable. The worker maps this onto `StreamRecord.kind`.
 */
export interface StreamOpenPayload {
  /** Page-local id; the worker namespaces it with the real tab and frame. */
  localId: string
  streamKind: StreamKind
  method: string
  url: string
  requestHeaders?: Record<string, string>
  requestBody?: string
  startedAt: number
}

/** Response metadata, available once headers arrive. */
export interface StreamHeadersPayload {
  localId: string
  status: number
  statusText: string
  responseHeaders?: Record<string, string>
  contentType?: string
  firstByteAt: number
}

export type PageMessage =
  | ({ type: 'stream.open' } & StreamOpenPayload)
  | ({ type: 'stream.headers' } & StreamHeadersPayload)
  /** Raw response text. Framing is the worker's job, not the page's. */
  | { type: 'stream.chunk'; localId: string; text: string }
  /**
   * An already-parsed event.
   *
   * Only `EventSource` uses this: the browser consumed the bytes, so there is no
   * raw text to forward and the frames have to be reconstructed semantically.
   */
  | { type: 'stream.event'; localId: string; event: SseEvent }
  | {
      type: 'stream.close'
      localId: string
      endedAt: number
      state: 'closed' | 'error' | 'aborted'
      errorMessage?: string
    }
  | { type: 'stream.unreadable'; localId: string; reason: string }
  /** Sent on relay startup so the page can be told whether to report. */
  | { type: 'hook.ready' }

/** Envelope as it appears on the page's `window`. */
export interface PageEnvelope {
  [BRIDGE_MARKER]: true
  /** Distinguishes page→relay traffic from relay→page traffic on one channel. */
  direction: 'toRelay' | 'toPage'
  message: PageMessage | RelayMessage
}

// --- ISOLATED relay → MAIN world --------------------------------------------

/**
 * Capture instruction for the page hook.
 *
 * `armed` is the whole point of the design: the hook is installed in every frame
 * of every page, but reports nothing until the worker says this tab is the one
 * being inspected. `captureMode` rides along so the page can decide whether a
 * non-`text/event-stream` response is worth tee-ing at all — asking the worker
 * per request would add a round trip to every `fetch` on the page.
 */
export type RelayMessage = {
  type: 'arm'
  armed: boolean
  captureMode: Settings['captureMode']
  maxBodyChars: number
  redactHeaders: string[]
}

/**
 * A no-op sent to a tab purely to learn whether a relay is there.
 *
 * Needed because "this tab has no content script" and "this page has not streamed
 * yet" are otherwise indistinguishable, and only the first one is recoverable.
 * `tabs.sendMessage` rejects with "Receiving end does not exist" when no content
 * script is present and resolves when one is, which is the signal.
 *
 * It carries no fields and the relay ignores it deliberately. An earlier version
 * probed with `armMessage(false)`, reusing an existing message rather than adding
 * one — which **disarmed the tab on every state refresh**, so capture silently
 * stopped working. A probe must not be an instruction.
 */
export interface RelayProbe {
  type: 'probe'
}

// --- relay → service worker -------------------------------------------------

/** What the relay forwards, with the page's claims still unverified. */
export interface RelayToWorker {
  type: 'page'
  message: PageMessage
}

/** The relay asking for the current arm state, e.g. right after a reload. */
export interface RelayHello {
  type: 'relay.hello'
}

// --- side panel ↔ service worker --------------------------------------------

/**
 * Name of the long-lived port the panel holds while it is mounted.
 *
 * Its purpose is lifetime signalling, not data: Chrome fires no side-panel close
 * event, so `onConnect`/`onDisconnect` on this port is the only truthful source
 * for "is a panel watching right now?".
 */
export const PANEL_PORT_NAME = 'sse-lens-panel'

/**
 * How long to wait before reconnecting a port the worker dropped.
 *
 * A disconnect normally means the worker was evicted, and reconnecting instantly
 * would spin if it is still shutting down. One tick is enough to let the new
 * worker start.
 */
export const RECONNECT_DELAY_MS = 250

export type PanelRequest =
  | { type: 'panel.getState' }
  | { type: 'panel.clear' }
  | { type: 'panel.clearStream'; streamId: string }
  | { type: 'panel.setSettings'; patch: Partial<Settings> }
  /** Opening the panel is what arms a tab, so the panel announces itself. */
  | { type: 'panel.opened' }
  /**
   * Inject the content scripts into the current tab.
   *
   * For tabs that predate the extension: Chrome never injects into those
   * retroactively, so without this the tab can never be captured at all. Takes
   * effect for later requests only — see `background/attach.ts`.
   */
  | { type: 'panel.attach' }

/** Everything the panel renders, in one snapshot. */
export interface PanelState {
  settings: Settings
  /** Streams for the inspected tab, newest first. */
  streams: StreamRecord[]
  /** The tab being inspected, or null when it is not inspectable. */
  tab: { id: number; url: string; title: string } | null
  /**
   * Why capture is not possible on this tab, if it is not.
   *
   * Distinct from an empty stream list: "nothing streamed yet" and "this page
   * can never be captured" look identical otherwise, and the second one needs an
   * explanation plus a reload button.
   *
   * `noHook` means the tab has no content script — it was open before the
   * extension loaded. That one is recoverable, so the panel offers an attach
   * action for it rather than only suggesting a reload.
   */
  unavailableReason?: 'restricted' | 'noHook' | 'disabled'
}

/**
 * The result of an attach attempt, pushed to the panel so it can explain itself.
 *
 * `attached` distinguishes a fresh injection from a hook that was already there;
 * reporting them identically would tell a user whose real problem is an early
 * `fetch` alias that everything is now fine.
 */
export interface AttachResult {
  ok: boolean
  attached: boolean
  reason?: 'restricted' | 'noTab' | 'injectionFailed'
}

/**
 * Every successful panel request answers with a full state snapshot.
 *
 * There is deliberately no bare `{ ok: true }` variant. A mutation the panel just
 * made (clear, settings change) alters what the next render must show, so making
 * the snapshot mandatory means the panel can never be left displaying state it has
 * already invalidated — and callers need no narrowing to reach `state`.
 *
 * `attach` rides along on the one request that needs to report more than the new
 * state: whether the hook was injected, was already there, or could not be placed
 * at all. Those three outcomes look the same in a state snapshot.
 */
export type PanelResponse =
  | { ok: true; state: PanelState; attach?: AttachResult }
  | { ok: false; error: string }

/** Unsolicited worker → panel pushes. */
export type WorkerEvent =
  /** A stream was created or its metadata changed. Carries the whole record. */
  | { type: 'stream.upsert'; stream: StreamRecord }
  /**
   * New frames only.
   *
   * Deliberately not the whole record: a chat completion emits hundreds of
   * one-token frames, and resending a growing array on each would be quadratic
   * in both messaging and rendering.
   */
  | { type: 'stream.events'; streamId: string; events: SseEvent[]; bytes: number; eventCount: number }
  | { type: 'stream.closed'; stream: StreamRecord }
  | { type: 'state.changed' }

/** Typed `sendMessage` for the panel; throws when the worker reports failure. */
export async function sendToWorker(request: PanelRequest): Promise<PanelResponse> {
  const response = (await chrome.runtime.sendMessage(request)) as PanelResponse | undefined
  if (!response) throw new Error('No response from the SSE Lens service worker.')
  return response
}

/** Structural check before a `chrome.runtime` message is trusted as an event. */
export function isWorkerEvent(message: unknown): message is WorkerEvent {
  if (!message || typeof message !== 'object') return false
  const type = (message as { type?: unknown }).type
  return (
    type === 'stream.upsert' ||
    type === 'stream.events' ||
    type === 'stream.closed' ||
    type === 'state.changed'
  )
}
