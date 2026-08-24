/**
 * A `chrome` stand-in that actually dispatches events.
 *
 * ## Why this exists
 *
 * An earlier fake (`fake-chrome.ts`, since deleted) stubbed every `addListener` as
 * a no-op. That was fine for testing `CaptureStore` and `ArmController` directly,
 * but it meant `background/index.ts` — the module that wires those two to Chrome's
 * lifecycle — was never executed by a test at all. Every bug in the *wiring* was
 * therefore invisible, which is exactly where a reported "capture stops after
 * switching tabs" fault lived.
 *
 * So this harness records listeners and lets a test fire the real events:
 * `emitTabActivated`, `connectPanel`, `sendRelayHello`, and so on. Assertions can
 * then be made about what the worker actually did, not about what its helper
 * classes would do in isolation.
 *
 * ## Modelled faithfully on purpose
 *
 * Three Chrome behaviours are reproduced because the code under test depends on
 * them, and a fake that smoothed them over would hide real bugs:
 *
 * - **`sendMessage` rejects when nothing is listening.** A restricted page, or a
 *   tab whose content script has not loaded, is the normal case — not an error.
 * - **`onMessage` listeners may answer asynchronously** by returning `true` and
 *   calling `sendResponse` later. All of this worker's handlers do that, and a
 *   fake that only supported synchronous replies would test a different program.
 * - **`storage.session` and `storage.local` are separate areas**, so a test can
 *   prove captures never reach the disk-backed one.
 *
 * @module tests/harness
 */

export interface HarnessTab {
  id: number
  url: string
  title: string
  active: boolean
  windowId: number
}

type Listener = (...args: unknown[]) => unknown

/** A message the worker sent to a tab's relay. */
export interface SentToTab {
  tabId: number
  message: { type: string; armed?: boolean; [key: string]: unknown }
}

export class ChromeHarness {
  readonly local = new Map<string, unknown>()
  readonly session = new Map<string, unknown>()
  readonly tabs = new Map<number, HarnessTab>()

  /** Arm instructions and other messages delivered to tabs, in order. */
  readonly toTabs: SentToTab[] = []
  /** Events broadcast to the panel, in order. */
  readonly toPanel: { type: string; [key: string]: unknown }[] = []
  /** Tabs with no content script listening, so `sendMessage` rejects. */
  readonly deafTabs = new Set<number>()

  /** True once a panel port is connected, so `runtime.sendMessage` can succeed. */
  private panelConnected = false

  private readonly listeners = new Map<string, Listener[]>()
  private readonly portDisconnects: Listener[] = []

  private nextWindowId = 1
  focusedWindowId = 1

  // --- listener plumbing ------------------------------------------------------

  private on(event: string): { addListener: (fn: Listener) => void } {
    return {
      addListener: (fn: Listener) => {
        const list = this.listeners.get(event) ?? []
        list.push(fn)
        this.listeners.set(event, list)
      },
      // The worker never removes listeners, but the shape must match.
      removeListener: () => {},
      hasListener: () => false,
    } as unknown as { addListener: (fn: Listener) => void }
  }

  private emit(event: string, ...args: unknown[]): unknown[] {
    return (this.listeners.get(event) ?? []).map((fn) => fn(...args))
  }

  /** Whether the worker registered a listener for an event at all. */
  hasListener(event: string): boolean {
    return (this.listeners.get(event) ?? []).length > 0
  }

  // --- test-facing event triggers --------------------------------------------

  addTab(tab: Partial<HarnessTab> & { id: number }): HarnessTab {
    const full: HarnessTab = {
      url: `https://tab-${tab.id}.example.com/`,
      title: `Tab ${tab.id}`,
      active: false,
      windowId: tab.windowId ?? 1,
      ...tab,
    }
    this.tabs.set(full.id, full)
    return full
  }

  /** Makes one tab active within its window, as Chrome does. */
  activate(tabId: number): void {
    const tab = this.tabs.get(tabId)
    if (!tab) throw new Error(`No tab ${tabId}`)
    for (const other of this.tabs.values()) {
      if (other.windowId === tab.windowId) other.active = other.id === tabId
    }
    this.focusedWindowId = tab.windowId
  }

  /** The user switched to a tab: activate it and fire the event. */
  async emitTabActivated(tabId: number): Promise<void> {
    this.activate(tabId)
    this.emit('tabs.onActivated', { tabId, windowId: this.tabs.get(tabId)?.windowId ?? 1 })
    await this.settle()
  }

  async emitWindowFocus(windowId: number): Promise<void> {
    this.focusedWindowId = windowId
    this.emit('windows.onFocusChanged', windowId)
    await this.settle()
  }

  async emitTabRemoved(tabId: number): Promise<void> {
    this.tabs.delete(tabId)
    this.emit('tabs.onRemoved', tabId, { windowId: 1, isWindowClosing: false })
    await this.settle()
  }

  async emitTabUpdated(tabId: number, change: { url?: string; status?: string }): Promise<void> {
    const tab = this.tabs.get(tabId)
    if (tab && change.url !== undefined) tab.url = change.url
    this.emit('tabs.onUpdated', tabId, change, tab)
    await this.settle()
  }

  /** Connects a panel port and returns a handle that can disconnect it. */
  async connectPanel(name = 'sse-lens-panel'): Promise<{ disconnect: () => Promise<void> }> {
    this.panelConnected = true
    const disconnects: Listener[] = []
    const port = {
      name,
      onDisconnect: {
        addListener: (fn: Listener) => {
          disconnects.push(fn)
          this.portDisconnects.push(fn)
        },
      },
      onMessage: { addListener: () => {} },
      postMessage: () => {},
      disconnect: () => {},
    }
    this.emit('runtime.onConnect', port)
    await this.settle()

    return {
      disconnect: async () => {
        this.panelConnected = false
        for (const fn of disconnects) fn()
        await this.settle()
      },
    }
  }

  /**
   * Sends a message to the worker as a relay or panel would, and resolves with
   * the worker's reply.
   *
   * Models the `return true` + async `sendResponse` protocol, because every
   * handler in this worker uses it.
   */
  async sendToWorker(
    message: unknown,
    sender: { tab?: { id: number; url?: string }; frameId?: number; url?: string } = {},
  ): Promise<unknown> {
    const listeners = this.listeners.get('runtime.onMessage') ?? []
    for (const listener of listeners) {
      let reply: unknown
      let replied = false
      const sendResponse = (value: unknown): void => {
        reply = value
        replied = true
      }
      const keepAlive = listener(message, sender, sendResponse)
      if (keepAlive === true) {
        // Async handler: give its promise chain a chance to run.
        await this.settle()
        if (replied) return reply
        continue
      }
      if (replied) return reply
    }
    return undefined
  }

  /** Convenience: a relay announcing itself from a tab. */
  async sendRelayHello(tabId: number): Promise<unknown> {
    const tab = this.tabs.get(tabId)
    return this.sendToWorker(
      { type: 'relay.hello' },
      { tab: { id: tabId, url: tab?.url }, frameId: 0, url: tab?.url },
    )
  }

  /** Convenience: a page message forwarded by a relay. */
  async sendPage(tabId: number, message: unknown, frameId = 0): Promise<unknown> {
    const tab = this.tabs.get(tabId)
    return this.sendToWorker(
      { type: 'page', message },
      { tab: { id: tabId, url: tab?.url }, frameId, url: tab?.url },
    )
  }

  /**
   * Delivers several messages *concurrently*, as Chrome really does.
   *
   * `sendToWorker` awaits each reply, which serialises the worker's async
   * handlers. Real traffic does not: a waking worker receives `relay.hello` and a
   * burst of stream frames in the same tick, and their promise chains interleave.
   * Any lazy-initialisation latch that is not concurrency-safe only misbehaves
   * under this pattern, so a test that never uses it cannot see the fault.
   */
  async sendConcurrently(
    messages: { tabId: number; message: unknown; frameId?: number }[],
  ): Promise<unknown[]> {
    const listeners = this.listeners.get('runtime.onMessage') ?? []

    const calls = messages.map(({ tabId, message, frameId = 0 }) => {
      const tab = this.tabs.get(tabId)
      const sender = { tab: { id: tabId, url: tab?.url }, frameId, url: tab?.url }
      const envelope =
        (message as { type?: string }).type === 'relay.hello'
          ? message
          : { type: 'page', message }

      return new Promise<unknown>((resolve) => {
        for (const listener of listeners) {
          const keepAlive = listener(envelope, sender, resolve)
          if (keepAlive === true) return
        }
        resolve(undefined)
      })
    })

    // Every handler was invoked before any of them was awaited: that is the
    // interleaving being tested.
    const settled = Promise.all(calls)
    await this.settle()
    return settled
  }

  /** Lets pending promise chains and debounced writes complete. */
  async settle(ms = 0): Promise<void> {
    if (ms > 0) await new Promise((resolve) => setTimeout(resolve, ms))
    // Several awaits deep: the worker's handlers chain a few promises before
    // replying, and one microtask tick is not always enough.
    for (let index = 0; index < 12; index += 1) await Promise.resolve()
  }

  // --- assertions helpers ----------------------------------------------------

  /** The most recent arm instruction sent to a tab, if any. */
  lastArm(tabId: number): SentToTab | undefined {
    // Probe messages (`{type:'probe'}`) also travel through tabs.sendMessage but
    // are not arm instructions. Filter them: without this, the presence probe
    // that buildPanelState sends becomes the "last arm" and makes isArmed report
    // false on a tab that is genuinely armed.
    return [...this.toTabs]
      .reverse()
      .find(
        (sent) => sent.tabId === tabId && (sent.message as { type?: string }).type === 'arm',
      )
  }

  /** Whether a tab was last told to capture. */
  isArmed(tabId: number): boolean {
    return this.lastArm(tabId)?.message.armed === true
  }

  clearRecorded(): void {
    this.toTabs.length = 0
    this.toPanel.length = 0
  }

  // --- the API surface -------------------------------------------------------

  get api(): typeof chrome {
    const self = this
    return {
      runtime: {
        sendMessage: async (message: unknown) => {
          if (!self.panelConnected) {
            // No panel listening: Chrome rejects, and the worker must tolerate it.
            throw new Error('Could not establish connection. Receiving end does not exist.')
          }
          self.toPanel.push(message as { type: string })
          return undefined
        },
        onMessage: self.on('runtime.onMessage'),
        onConnect: self.on('runtime.onConnect'),
        onInstalled: self.on('runtime.onInstalled'),
        onStartup: self.on('runtime.onStartup'),
        lastError: undefined,
      },
      tabs: {
        get: async (tabId: number) => {
          const tab = self.tabs.get(tabId)
          if (!tab) throw new Error(`No tab with id ${tabId}`)
          return tab
        },
        query: async (query: { active?: boolean; lastFocusedWindow?: boolean }) => {
          let all = [...self.tabs.values()]
          if (query.active === true) all = all.filter((tab) => tab.active)
          if (query.lastFocusedWindow === true) {
            all = all.filter((tab) => tab.windowId === self.focusedWindowId)
          }
          return all
        },
        sendMessage: async (tabId: number, message: unknown) => {
          if (!self.tabs.has(tabId) || self.deafTabs.has(tabId)) {
            throw new Error('Could not establish connection. Receiving end does not exist.')
          }
          self.toTabs.push({ tabId, message: message as SentToTab['message'] })
          return undefined
        },
        onActivated: self.on('tabs.onActivated'),
        onRemoved: self.on('tabs.onRemoved'),
        onUpdated: self.on('tabs.onUpdated'),
      },
      windows: {
        WINDOW_ID_NONE: -1,
        getCurrent: async () => ({ id: self.focusedWindowId }),
        onFocusChanged: self.on('windows.onFocusChanged'),
      },
      storage: {
        local: {
          get: async (key: string) => ({ [key]: self.local.get(key) }),
          set: async (items: Record<string, unknown>) => {
            for (const [key, value] of Object.entries(items)) self.local.set(key, value)
          },
          remove: async (key: string) => {
            self.local.delete(key)
          },
        },
        session: {
          get: async (key: string) => ({ [key]: self.session.get(key) }),
          set: async (items: Record<string, unknown>) => {
            for (const [key, value] of Object.entries(items)) self.session.set(key, value)
          },
          remove: async (key: string) => {
            self.session.delete(key)
          },
        },
        onChanged: self.on('storage.onChanged'),
      },
      sidePanel: {
        setPanelBehavior: async () => undefined,
      },
      action: {
        onClicked: self.on('action.onClicked'),
      },
    } as unknown as typeof chrome
  }

  /** Simulates worker eviction: keeps storage, drops all in-memory listeners. */
  evict(): void {
    this.listeners.clear()
    this.portDisconnects.length = 0
    this.panelConnected = false
  }

  /** Allocates a fresh window id, for multi-window tests. */
  newWindowId(): number {
    this.nextWindowId += 1
    return this.nextWindowId
  }
}
