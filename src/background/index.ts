/**
 * Service worker: message routing and lifecycle.
 *
 * The worker is the only component that holds a complete picture, and it has to
 * do so across its own eviction. MV3 stops an idle worker after ~30 seconds, and
 * an SSE stream can easily be idle longer than that between frames, so nothing
 * important may live only in memory. The pattern used here is:
 *
 * - In-memory {@link CaptureStore} for speed and for the parser state.
 * - A debounced mirror into `chrome.storage.session`, which survives eviction but
 *   not a browser restart — the right lifetime for captured payloads.
 * - Lazy rehydration on the first message after a restart, so a panel reopened
 *   after eviction shows the streams it had rather than an empty list.
 *
 * Parsers are deliberately *not* rehydrated: a stream cut off mid-frame cannot be
 * resumed correctly, and a fresh parser primed with an empty buffer would
 * mis-frame the continuation. Recorded frames survive; the in-flight frame does
 * not.
 *
 * @module background/index
 */

import { ArmController, armMessage, isInjectablePage } from './arm'
import { CaptureStore } from './store'
import { loadSettings, normalizeSettings, saveSettings } from './settings'
import {
  PANEL_PORT_NAME,
  type PageMessage,
  type PanelRequest,
  type PanelResponse,
  type PanelState,
  type RelayMessage,
  type RelayToWorker,
  type WorkerEvent,
} from '../lib/messages'
import { DEFAULT_SETTINGS, type Settings, type StreamRecord } from '../lib/types'

/** Prefix for per-tab capture keys in `chrome.storage.session`. */
const SESSION_PREFIX = 'streams:'

/**
 * Key holding the arm state in `chrome.storage.session`.
 *
 * The arm state has to outlive worker eviction. Without this, a worker that was
 * evicted while the panel sat idle would restart believing no panel was open, and
 * would then refuse to follow the user to the next tab they selected — leaving the
 * panel stuck on "no page selected" until it was closed and reopened.
 */
const ARM_KEY = 'arm'

/**
 * Persistence debounce.
 *
 * A token-by-token stream would otherwise write to storage on every frame. The
 * window is short enough that an eviction loses at most a moment of data, and
 * long enough to collapse a burst of frames into one write.
 */
const PERSIST_DEBOUNCE_MS = 400

let settings: Settings = { ...DEFAULT_SETTINGS }
const arm = new ArmController()
const store = new CaptureStore({ settings })

/** Tabs whose persisted data has already been pulled back into memory. */
const hydrated = new Set<number>()
let settingsLoaded = false
/** False until the arm state has been restored after a worker restart. */
let armLoaded = false

const persistTimers = new Map<number, ReturnType<typeof setTimeout>>()

/**
 * Last committed URL per tab.
 *
 * Used to tell a real navigation from a same-URL reload tick, so a capture the
 * user is mid-way through reading is not wiped by an unrelated `onUpdated` event.
 */
const lastUrlByTab = new Map<number, string>()

/**
 * Serialises page-message handling per tab.
 *
 * ## Why this is required, not merely tidy
 *
 * Chrome delivers messages from one content script in order, but
 * `handlePageMessage` is `async`: it awaits settings, arm state and tab hydration
 * before it touches the store. Those awaits are suspension points, so several
 * messages from the same tab can be *in flight simultaneously* and resume in any
 * order.
 *
 * That is fatal because the store is order-dependent. `stream.headers` and
 * `stream.chunk` resolve a record created by `stream.open`; if `open` has not
 * finished, they find nothing and are silently dropped. The observed failure was
 * exactly this — replies came back in the order `headers`, `chunk`, `open`, and
 * the stream reached the panel with no frames at all.
 *
 * It only shows up when a page opens a stream during bootstrap, because then the
 * first messages arrive while the worker is still doing its lazy first-message
 * initialisation. A page that streams after settling awaits nothing and stays in
 * order by luck — which is why capture worked on a page that was already loaded
 * and broke after navigating.
 *
 * Chaining per tab (not globally) keeps one slow tab from delaying another while
 * still guaranteeing that a tab's own messages are applied in arrival order.
 */
const pageQueues = new Map<number, Promise<void>>()

/**
 * Runs `task` after every earlier task for this tab has finished.
 *
 * The returned promise resolves when *this* task is done, so the caller can still
 * reply to the sender at the right moment.
 */
function enqueueForTab(tabId: number, task: () => Promise<void>): Promise<void> {
  const previous = pageQueues.get(tabId) ?? Promise.resolve()
  // `catch` before chaining: one failed message must not poison the queue and
  // silently drop every later frame for that tab.
  const next = previous.then(task, task)
  pageQueues.set(
    tabId,
    next.catch(() => {}),
  )
  return next
}

// --- Persistence -------------------------------------------------------------

function sessionKey(tabId: number): string {
  return `${SESSION_PREFIX}${tabId}`
}

function schedulePersist(tabId: number): void {
  const existing = persistTimers.get(tabId)
  if (existing !== undefined) clearTimeout(existing)
  persistTimers.set(
    tabId,
    setTimeout(() => {
      persistTimers.delete(tabId)
      void persistTab(tabId)
    }, PERSIST_DEBOUNCE_MS),
  )
}

async function persistTab(tabId: number): Promise<void> {
  try {
    const streams = store.list(tabId)
    if (streams.length === 0) {
      await chrome.storage.session.remove(sessionKey(tabId))
      return
    }
    // Stored newest-first exactly as the panel wants it, so a rehydrated read
    // needs no reordering.
    await chrome.storage.session.set({ [sessionKey(tabId)]: streams })
  } catch {
    // Over quota or unavailable. Capture continues in memory; the trimming rules
    // in the store are what keep this from recurring indefinitely.
  }
}

async function hydrateTab(tabId: number): Promise<void> {
  if (hydrated.has(tabId)) return
  hydrated.add(tabId)
  try {
    const stored = await chrome.storage.session.get(sessionKey(tabId))
    const streams = stored[sessionKey(tabId)] as StreamRecord[] | undefined
    if (Array.isArray(streams) && streams.length > 0) {
      // `list()` returns newest-first and `hydrate` re-reverses, so this round
      // trips without changing order.
      store.hydrate(tabId, streams)
    }
  } catch {
    // Nothing to restore; an empty list is the correct fallback.
  }
}

async function ensureSettings(): Promise<void> {
  if (settingsLoaded) return
  settingsLoaded = true
  settings = await loadSettings()
  store.updateSettings(settings)
}

/** Writes the arm state so it survives eviction. */
async function persistArm(): Promise<void> {
  try {
    await chrome.storage.session.set({ [ARM_KEY]: arm.snapshot() })
  } catch {
    // Losing this degrades to "the panel needs reopening after an eviction",
    // which is exactly the bug it exists to prevent — but it must not throw.
  }
}

/**
 * Restores the arm state after a worker restart.
 *
 * The stored tab id is verified to still exist. A tab closed while the worker was
 * evicted would otherwise leave the controller pointing at nothing, and the panel
 * would report a page that is gone.
 */
async function ensureArm(): Promise<void> {
  if (armLoaded) return
  armLoaded = true
  try {
    const stored = await chrome.storage.session.get(ARM_KEY)
    const snapshot = stored[ARM_KEY] as { panelOpen?: boolean; armedTabId?: number } | undefined
    if (!snapshot) return
    arm.hydrate(snapshot)

    const tabId = arm.tabId
    if (tabId === null) return
    try {
      await chrome.tabs.get(tabId)
    } catch {
      // The tab is gone. Fall back to whatever is active now, so the panel
      // recovers by itself rather than showing a dead reference.
      arm.removeTab(tabId)
      if (arm.isPanelOpen) applyArmTransition(arm.activateTab(await activeTabId()))
    }
  } catch {
    // Nothing to restore; a closed panel is the safe default.
  }
}

/** Loads everything the worker needs before it can answer a message. */
async function ensureReady(): Promise<void> {
  await ensureSettings()
  await ensureArm()
}

// --- Notifications -----------------------------------------------------------

/**
 * Pushes an event to the panel.
 *
 * Failure is expected and ignored: when no panel is open there is no receiver,
 * and `sendMessage` rejects. That is not an error worth surfacing.
 */
function notifyPanel(event: WorkerEvent): void {
  chrome.runtime.sendMessage(event).catch(() => {})
}

/** Tells one tab's relay whether to capture. */
function sendArm(tabId: number, armed: boolean): void {
  chrome.tabs.sendMessage(tabId, armMessage(armed, settings)).catch(() => {
    // No relay in that tab (restricted page, or not yet loaded). Nothing to do:
    // a relay that loads later announces itself and gets the state then.
  })
}

function applyArmTransition(transition: { armed: number | null; disarmed: number[] }): void {
  for (const tabId of transition.disarmed) sendArm(tabId, false)
  if (transition.armed !== null) sendArm(transition.armed, true)
  // Persisted on every transition rather than only at open/close: a tab switch
  // must survive the eviction that may follow it moments later.
  void persistArm()
}

// --- Page traffic ------------------------------------------------------------

/**
 * Handles one message from a page.
 *
 * `tabId`/`frameId` are taken from `sender` and never from the payload: the page
 * is untrusted, and letting it name its own tab would let any site plant records
 * in another tab's capture list.
 */
async function handlePageMessage(
  message: PageMessage,
  sender: chrome.runtime.MessageSender,
): Promise<void> {
  const tabId = sender.tab?.id
  if (tabId === undefined) return
  if (!arm.accepts(tabId)) return
  if (!settings.captureEnabled) return

  const frameId = sender.frameId ?? 0
  const frameUrl = sender.url ?? ''

  await hydrateTab(tabId)

  switch (message.type) {
    case 'stream.open': {
      const record = store.open({
        tabId,
        frameId,
        frameUrl,
        localId: message.localId,
        streamKind: message.streamKind,
        method: message.method,
        url: message.url,
        requestHeaders: message.requestHeaders,
        requestBody: message.requestBody,
        startedAt: message.startedAt,
      })
      if (record) {
        notifyPanel({ type: 'stream.upsert', stream: record })
        schedulePersist(tabId)
      }
      return
    }

    case 'stream.headers': {
      const record = store.headers(tabId, frameId, message.localId, {
        status: message.status,
        statusText: message.statusText,
        responseHeaders: message.responseHeaders,
        contentType: message.contentType,
        firstByteAt: message.firstByteAt,
      })
      if (record) {
        notifyPanel({ type: 'stream.upsert', stream: record })
        schedulePersist(tabId)
      }
      return
    }

    case 'stream.chunk': {
      const result = store.chunk(tabId, frameId, message.localId, message.text)
      if (!result) return
      if (result.events.length > 0) {
        notifyPanel({
          type: 'stream.events',
          streamId: result.record.id,
          events: result.events,
          bytes: result.record.bytes,
          eventCount: result.record.eventCount,
        })
      }
      schedulePersist(tabId)
      return
    }

    case 'stream.event': {
      const result = store.event(tabId, frameId, message.localId, message.event)
      if (!result) return
      notifyPanel({
        type: 'stream.events',
        streamId: result.record.id,
        events: result.events,
        bytes: result.record.bytes,
        eventCount: result.record.eventCount,
      })
      schedulePersist(tabId)
      return
    }

    case 'stream.unreadable': {
      const record = store.markUnreadable(tabId, frameId, message.localId, message.reason)
      if (record) {
        notifyPanel({ type: 'stream.upsert', stream: record })
        schedulePersist(tabId)
      }
      return
    }

    case 'stream.close': {
      const result = store.close(tabId, frameId, message.localId, {
        endedAt: message.endedAt,
        state: message.state,
        errorMessage: message.errorMessage,
      })
      if (!result) return
      notifyPanel({ type: 'stream.closed', stream: result.record })
      schedulePersist(tabId)
      return
    }

    case 'hook.ready':
      return

    default:
      return
  }
}

// --- Panel state -------------------------------------------------------------

async function buildPanelState(): Promise<PanelState> {
  await ensureSettings()

  const tabId = arm.tabId
  if (tabId === null) {
    return { settings, streams: [], tab: null }
  }

  let tab: chrome.tabs.Tab | undefined
  try {
    tab = await chrome.tabs.get(tabId)
  } catch {
    // The tab vanished between arming and now.
    return { settings, streams: [], tab: null }
  }

  await hydrateTab(tabId)

  const state: PanelState = {
    settings,
    streams: store.list(tabId),
    tab: { id: tabId, url: tab.url ?? '', title: tab.title ?? '' },
  }

  if (!isInjectablePage(tab.url)) {
    state.unavailableReason = 'restricted'
  } else if (!settings.captureEnabled) {
    state.unavailableReason = 'disabled'
  }
  return state
}

/** The active tab of the focused window, which is what the panel opened over. */
async function activeTabId(): Promise<number | null> {
  try {
    const [focused] = await chrome.tabs.query({ active: true, lastFocusedWindow: true })
    if (focused?.id !== undefined) return focused.id
    const [any] = await chrome.tabs.query({ active: true })
    return any?.id ?? null
  } catch {
    return null
  }
}

// --- Message routing ---------------------------------------------------------

type IncomingMessage = PanelRequest | RelayToWorker | { type: 'relay.hello' }

chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
  if (!message || typeof message !== 'object') return false
  const incoming = message as IncomingMessage

  switch (incoming.type) {
    /**
     * A relay announced itself, or forwarded page traffic.
     *
     * Both are answered with the current arm state, which is what makes a
     * settings change or a tab switch take effect without a separate broadcast.
     */
    case 'relay.hello':
    case 'page': {
      void (async () => {
        const tabId = sender.tab?.id
        await ensureReady()

        if (incoming.type === 'page' && tabId !== undefined) {
          // Queued per tab so a burst that arrives during page bootstrap is
          // applied in arrival order; see `enqueueForTab`.
          await enqueueForTab(tabId, () => handlePageMessage(incoming.message, sender))
        }

        const armed = arm.accepts(tabId)
        const reply: RelayMessage = armMessage(armed, settings)
        sendResponse(reply)
      })()
      return true
    }

    case 'panel.opened': {
      void (async () => {
        await ensureReady()
        const tabId = await activeTabId()
        applyArmTransition(arm.openPanel(tabId))
        sendResponse({ ok: true, state: await buildPanelState() } satisfies PanelResponse)
      })()
      return true
    }

    case 'panel.getState': {
      void (async () => {
        // `ensureReady` matters here too: this is the request a panel sends after
        // the worker was evicted, and answering it from an unhydrated controller
        // is exactly what produced a spurious "no page selected".
        await ensureReady()
        sendResponse({ ok: true, state: await buildPanelState() } satisfies PanelResponse)
      })()
      return true
    }

    case 'panel.clear': {
      void (async () => {
        await ensureReady()
        const tabId = arm.tabId
        if (tabId !== null) {
          store.clearTab(tabId)
          await chrome.storage.session.remove(sessionKey(tabId))
        }
        sendResponse({ ok: true, state: await buildPanelState() } satisfies PanelResponse)
      })()
      return true
    }

    case 'panel.clearStream': {
      void (async () => {
        await ensureReady()
        store.clearStream(incoming.streamId)
        const tabId = arm.tabId
        if (tabId !== null) await persistTab(tabId)
        sendResponse({ ok: true, state: await buildPanelState() } satisfies PanelResponse)
      })()
      return true
    }

    case 'panel.setSettings': {
      void (async () => {
        await ensureReady()
        settings = normalizeSettings({ ...settings, ...incoming.patch })
        store.updateSettings(settings)
        await saveSettings(settings)
        // The page hook holds `captureMode`, the body cap and the redaction list,
        // so a settings change has to be pushed rather than waited for.
        const tabId = arm.tabId
        if (tabId !== null) sendArm(tabId, true)
        sendResponse({ ok: true, state: await buildPanelState() } satisfies PanelResponse)
      })()
      return true
    }

    default:
      return false
  }
})

/**
 * Panel lifetime, observed rather than inferred.
 *
 * The panel opens a port and holds it for as long as it is mounted, so
 * `onDisconnect` is a genuine "the panel closed" signal. Chrome provides no side
 * panel close event, and the previous design guessed at it from message traffic —
 * which meant a worker restart lost the fact that a panel was open, and tab
 * switches then stopped arming.
 *
 * A port also keeps the worker alive while the panel is open, which incidentally
 * removes most evictions during an active debugging session.
 */
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== PANEL_PORT_NAME) return

  void (async () => {
    await ensureReady()
    // Re-arm on connect: this is the authoritative "a panel exists now" moment,
    // and it repairs the state after an eviction without the user doing anything.
    applyArmTransition(arm.openPanel(await activeTabId()))
    notifyPanel({ type: 'state.changed' })
  })()

  port.onDisconnect.addListener(() => {
    // Nothing is watching any more, so every armed page must be told to stop.
    applyArmTransition(arm.closePanel())
  })
})

// --- Tab lifecycle -----------------------------------------------------------

chrome.tabs.onActivated.addListener((info) => {
  void (async () => {
    await ensureReady()
    applyArmTransition(arm.activateTab(info.tabId))
    notifyPanel({ type: 'state.changed' })
  })()
})

/**
 * The user moved to another window.
 *
 * `tabs.onActivated` does not fire for this, so without it the panel would keep
 * showing the previous window's tab after a window switch — the same "wrong page"
 * symptom by a different route.
 */
chrome.windows.onFocusChanged.addListener((windowId) => {
  if (windowId === chrome.windows.WINDOW_ID_NONE) return
  void (async () => {
    await ensureReady()
    if (!arm.isPanelOpen) return
    applyArmTransition(arm.activateTab(await activeTabId()))
    notifyPanel({ type: 'state.changed' })
  })()
})

chrome.tabs.onRemoved.addListener((tabId) => {
  store.clearTab(tabId)
  hydrated.delete(tabId)
  lastUrlByTab.delete(tabId)
  pageQueues.delete(tabId)
  const wasArmed = arm.removeTab(tabId)
  void chrome.storage.session.remove(sessionKey(tabId)).catch(() => {})
  if (!wasArmed) return

  // The armed tab is gone. Follow the user to whatever is now active instead of
  // leaving the panel pointing at nothing.
  void (async () => {
    await ensureReady()
    if (arm.isPanelOpen) applyArmTransition(arm.activateTab(await activeTabId()))
    else await persistArm()
    notifyPanel({ type: 'state.changed' })
  })()
})

/**
 * Top-frame navigation.
 *
 * A new document means the old captures belong to a page that is gone. Clearing
 * is the default because a stale list showing another page's streams is
 * misleading; `keepAcrossNavigation` exists for comparing before and after.
 *
 * `tabs.onUpdated` is used rather than `webNavigation.onCommitted` specifically
 * to avoid requesting the `webNavigation` permission for a signal the `tabs`
 * permission already provides. It fires for sub-resource-free URL changes too,
 * so the URL is compared against the last one seen: a `status: 'loading'` tick
 * without a URL change is a reload of the same document and must not wipe a
 * capture the user is mid-way through reading.
 */
chrome.tabs.onUpdated.addListener((tabId, change) => {
  if (tabId !== arm.tabId) return
  if (change.url === undefined) return
  const previous = lastUrlByTab.get(tabId)
  lastUrlByTab.set(tabId, change.url)
  if (previous === undefined || previous === change.url) return

  void (async () => {
    await ensureReady()
    if (!settings.keepAcrossNavigation) {
      store.clearTab(tabId)
      try {
        await chrome.storage.session.remove(sessionKey(tabId))
      } catch {
        // Nothing persisted for this tab.
      }
    }
    notifyPanel({ type: 'state.changed' })
  })()
})

/**
 * Clicking the toolbar icon opens the panel.
 *
 * `setPanelBehavior` is the supported way to make the action button open the side
 * panel; without it the click is a no-op because no popup is declared.
 */
chrome.sidePanel
  ?.setPanelBehavior?.({ openPanelOnActionClick: true })
  ?.catch?.(() => {
    // Older Chrome without the behaviour API: the user can still open the panel
    // from the extensions menu.
  })

/** Settings changed in another context (a second panel) — keep in step. */
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes.settings) return
  settings = normalizeSettings(changes.settings.newValue)
  store.updateSettings(settings)
})
