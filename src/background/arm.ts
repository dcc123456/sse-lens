/**
 * Which tab is being captured.
 *
 * The user asked for capture scoped to the *current* page, and that turns out to
 * need explicit state rather than a query at each message. Two reasons:
 *
 * 1. `chrome.tabs.query({active: true})` answers "which tab is active now",
 *    which is not the same question as "which tab did the user open the panel
 *    for". A background tab that is still streaming must not be recorded merely
 *    because the user switched to it and back.
 * 2. The page hook cannot ask. It lives in the MAIN world with no `chrome.*`, so
 *    it has to be *told*, which means something has to know when the answer
 *    changes and push it.
 *
 * The rule implemented here: exactly one tab is armed at a time, it is the tab
 * that was active when the side panel last opened or when the user last switched
 * tabs with the panel open, and it is disarmed when the panel closes, the tab
 * closes, or capture is switched off.
 *
 * A page can only be armed if it is injectable at all. `chrome://`, the Web
 * Store, `file://` and other extensions' pages forbid content scripts, so no
 * hook exists there — a fact the panel has to state rather than showing an empty
 * list that looks like a bug.
 *
 * @module background/arm
 */

import type { RelayMessage } from '../lib/messages'
import type { Settings } from '../lib/types'

/**
 * URLs where no content script can run.
 *
 * Chrome blocks injection into its own UI, the Web Store (both the old and new
 * domains), and other extensions. `file://` additionally needs a user-granted
 * per-extension permission, so it is treated as restricted rather than probed.
 */
export function isInjectablePage(url: string | undefined): boolean {
  if (!url) return false
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return false
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false
  const host = parsed.hostname.toLowerCase()
  if (host === 'chrome.google.com' && parsed.pathname.startsWith('/webstore')) return false
  if (host === 'chromewebstore.google.com') return false
  return true
}

/** Builds the instruction sent to a page's relay. */
export function armMessage(armed: boolean, settings: Settings): RelayMessage {
  return {
    type: 'arm',
    armed: armed && settings.captureEnabled,
    captureMode: settings.captureMode,
    // The page truncates a request body before sending it, so this bound has to
    // travel with the arm state rather than being applied later in the worker.
    maxBodyChars: 4096,
    redactHeaders: settings.redactHeaders,
  }
}

/** Serialisable arm state, so it can survive worker eviction. */
export interface ArmSnapshot {
  panelOpen: boolean
  armedTabId: number | null
}

/**
 * Tracks the armed tab and reports transitions.
 *
 * Kept free of `chrome.*` calls so the whole policy is testable; `index.ts` binds
 * it to the real events and performs the messaging.
 *
 * ## Why this state must be persisted
 *
 * MV3 evicts an idle worker after ~30 seconds, and an SSE stream is idle between
 * frames far longer than that. A controller that only lived in memory would come
 * back from eviction believing no panel was open, and would then refuse to arm the
 * next tab the user selected — the panel would sit on "no page selected" until it
 * was closed and reopened. {@link snapshot} and {@link hydrate} exist so the
 * worker can restore this across a restart, which is what makes tab switching
 * survive eviction.
 */
export class ArmController {
  /** The tab being inspected, or null when the panel is closed. */
  private armedTabId: number | null = null
  /** Whether a side panel is connected. Driven by a port, not inferred. */
  private panelOpen = false

  /** The currently armed tab, if any. */
  get tabId(): number | null {
    return this.armedTabId
  }

  get isPanelOpen(): boolean {
    return this.panelOpen
  }

  /** Captures the state for persistence. */
  snapshot(): ArmSnapshot {
    return { panelOpen: this.panelOpen, armedTabId: this.armedTabId }
  }

  /**
   * Restores persisted state after a worker restart.
   *
   * Validated rather than trusted: a stored value from an older version, or a
   * tab id that no longer exists, must not leave the controller believing it has
   * armed something it has not.
   */
  hydrate(snapshot: unknown): void {
    if (!snapshot || typeof snapshot !== 'object') return
    const input = snapshot as Partial<ArmSnapshot>
    this.panelOpen = input.panelOpen === true
    this.armedTabId =
      typeof input.armedTabId === 'number' && Number.isInteger(input.armedTabId)
        ? input.armedTabId
        : null
  }

  /**
   * Records that the panel opened for a tab.
   *
   * @returns tabs whose arm state changed, so the caller can notify each
   */
  openPanel(tabId: number | null): { armed: number | null; disarmed: number[] } {
    this.panelOpen = true
    return this.setArmed(tabId)
  }

  /** Records that the panel closed; nothing stays armed afterwards. */
  closePanel(): { armed: number | null; disarmed: number[] } {
    this.panelOpen = false
    return this.setArmed(null)
  }

  /**
   * The user switched tabs, or switched windows.
   *
   * Ignored when the panel is closed: with nothing watching, arming would record
   * traffic nobody asked for.
   *
   * When the panel *is* open, this follows the user unconditionally. That is the
   * behaviour someone expects from a panel scoped to "the current page", and it
   * is safe because captures are stored per tab — switching away disarms a tab
   * but never discards what it already collected, so switching back restores it.
   */
  activateTab(tabId: number | null): { armed: number | null; disarmed: number[] } {
    if (!this.panelOpen) return { armed: null, disarmed: [] }
    return this.setArmed(tabId)
  }

  /** A tab closed. Returns true when it was the armed one. */
  removeTab(tabId: number): boolean {
    if (this.armedTabId !== tabId) return false
    this.armedTabId = null
    return true
  }

  /** Whether a message from this tab should be accepted. */
  accepts(tabId: number | undefined): boolean {
    return tabId !== undefined && tabId === this.armedTabId
  }

  private setArmed(tabId: number | null): { armed: number | null; disarmed: number[] } {
    const previous = this.armedTabId
    if (previous === tabId) return { armed: tabId, disarmed: [] }
    this.armedTabId = tabId
    // The previous tab must be told explicitly: its hook keeps capturing until
    // it hears otherwise, and buffered data in an unwatched tab is exactly the
    // privacy problem this design avoids.
    return { armed: tabId, disarmed: previous === null ? [] : [previous] }
  }
}
